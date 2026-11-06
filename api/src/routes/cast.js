/*
 * routes/cast.js —— 投屏中继（/ws）
 *
 * 三条通道，一个入口按 ?role= 分流：
 *
 *   ctl       教师端：发画面帧（二进制）+ 控制消息（mode）
 *   student   学生观看页：收帧
 *   presence  学生端 SPA 的在场通道：只做认身份 + 收控制消息（cast / follow）
 *
 * 为什么都要令牌：
 *   ctl 的帧是直接转给全班的，谁连上谁就能抢屏幕 → 必须教师令牌；
 *   student 不认身份的话，教师端的「谁在看」就对不上人 → 必须学生令牌。
 *
 * 背压策略（别改，改了差量模式会黑屏）：
 *   整屏关键帧（帧头 flags & 1）单独排队（最多 3 张），排队期间差量帧直接丢。
 *   差量帧画在整屏帧上，整屏帧要是被后来的小帧顶掉、永远发不出去，
 *   学生端就没有基准画面 → 黑屏、只有鼠标动过的地方显示。
 */
import { verify } from '../lib/auth.js'
import * as presence from '../lib/presence.js'

const state = {
  mode: 'idle',
  frames: 0,
  bytesWindow: 0,
  windowAt: Date.now(),
  lan: [],
}

const ctls = new Set() // 已认证的教师控制台
const students = new Set() // 已认证的学生观看连接
const followers = new Set() // 学生端 SPA 的在场通道（收 cast / follow 通知）
let modeOwner = null // 正在投屏的那条 ctl

/** 一条连接上挂一个「只保留最新一帧」的发送器 */
function attachSender(socket) {
  const st = { latest: null, keyQueue: [], flushing: false, closed: false }

  const flush = () => {
    if (st.closed || socket.readyState !== 1) {
      st.latest = null
      st.keyQueue.length = 0
      st.flushing = false
      return
    }
    let buf = null
    if (st.keyQueue.length) buf = st.keyQueue.shift()
    else {
      buf = st.latest
      st.latest = null
    }
    if (!buf) {
      st.flushing = false
      return
    }
    st.flushing = true
    try {
      socket.send(buf, { binary: true }, () => {
        st.flushing = false
        if (st.latest || st.keyQueue.length) flush()
      })
    } catch (e) {
      st.flushing = false
      st.closed = true
    }
  }

  return {
    sendLatest(buf) {
      if (st.closed) return false
      const isKey = !!(buf && buf.length > 1 && (buf[1] & 1))
      if (isKey) {
        if (st.keyQueue.length < 3) st.keyQueue.push(buf)
      } else {
        // 有整屏帧在排队 → 丢掉这个差量帧（保住基准画面）
        if (st.keyQueue.length) return true
        st.latest = buf
      }
      if (!st.flushing) flush()
      return true
    },
    json(obj) {
      if (st.closed || socket.readyState !== 1) return
      try {
        socket.send(JSON.stringify(obj))
      } catch (e) {
        /* ignore */
      }
    },
    close(code) {
      st.closed = true
      try {
        socket.close(code || 1000)
      } catch (e) {
        /* ignore */
      }
    },
  }
}

/** 这条连接代表的学生们（普通学生一条一人；局域网代理一条多人） */
const castWhos = (conn) => (conn.castWhos && conn.castWhos.length ? conn.castWhos : [])

/** 按当前实际在看的人，重新登记 presence 的「在看投屏」 */
function markCast(conn, on) {
  const list = castWhos(conn)
  if (!list.length) return
  for (const w of list) {
    if (on) presence.attachCast(w.classId, w.sid)
    else presence.detachCast(w.classId, w.sid)
  }
}

/** 教师端要看到的「几人在看」：按 (classId, sid) 去重，一个人开两个窗口只算一个 */
function uniqueWatchers() {
  const set = new Set()
  for (const c of students) for (const w of castWhos(c)) set.add(w.classId + ':' + w.sid)
  return set.size
}

function toCtls(msg) {
  for (const c of ctls) c.sender.json(msg)
}

function peersToCtl() {
  toCtls({ t: 'peers', students: uniqueWatchers() })
}

function toFollowers(msg) {
  for (const c of followers) c.sender.json(msg)
}

function setMode(next, propagate) {
  const prev = state.mode
  state.mode = next === 'watch' ? 'watch' : 'idle'
  for (const s of students) {
    markCast(s, state.mode === 'watch')
    if (propagate) s.sender.json({ t: 'mode', mode: state.mode })
  }
  // 开播/停播通知学生端 SPA（它要抢在学生离开标签页之前把投屏页打开）
  if (state.mode !== prev) toFollowers({ t: 'cast', mode: state.mode })
}

/** 给 /api/cast/status 用 */
export function castState() {
  const now = Date.now()
  const dt = Math.max(0.5, (now - state.windowAt) / 1000)
  const mbps = (state.bytesWindow * 8) / dt / 1000000
  if (dt > 1.5) {
    state.bytesWindow = 0
    state.windowAt = now
  }
  return {
    students: uniqueWatchers(),
    controller: ctls.size > 0,
    mode: state.mode,
    frames: state.frames,
    mbps: Math.round(mbps * 100) / 100,
    lan: state.lan,
  }
}

/** 讲义跟随等控制消息：发给学生端 SPA + 观看页 */
export function broadcast(msg) {
  let n = 0
  for (const c of followers) {
    c.sender.json(msg)
    n++
  }
  for (const s of students) s.sender.json(msg)
  return n
}

export function setLan(list) {
  state.lan = Array.isArray(list) ? list : []
}

export default async function castRoutes(app) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    const url = new URL(req.url, 'http://x')
    const role = url.searchParams.get('role')
    const sender = attachSender(socket)
    const conn = { role, sender, ctlOk: false, authed: false, presenceIdent: null, castWhos: null, cid: '' }

    if (!['ctl', 'student', 'presence'].includes(role)) {
      sender.close(1008)
      return
    }

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        // 只有认证过的教师端能推帧
        if (conn.role !== 'ctl' || !conn.ctlOk) return
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
        state.frames++
        state.bytesWindow += buf.length
        for (const s of students) s.sender.sendLatest(buf)
        return
      }

      let msg
      try {
        msg = JSON.parse(data.toString('utf8'))
      } catch (e) {
        return
      }

      /* ---- 在场通道：第一条必须是 auth ---- */
      if (conn.role === 'presence') {
        if (msg.t !== 'auth') return
        const rec = verify(msg.token)
        if (!rec || rec.role !== 'student') {
          sender.json({ t: 'auth-fail' })
          sender.close(1008)
          return
        }
        conn.presenceIdent = { classId: rec.classId, sid: rec.sid }
        presence.attach(rec.classId, rec.sid, rec.name)
        followers.add(conn)
        sender.json({ t: 'auth-ok' })
        // 补发当前投屏状态：刚打开页面/刚重连也要立刻知道老师是不是在投
        sender.json({ t: 'cast', mode: state.mode })
        return
      }

      if (msg.t === 'hello') {
        conn.cid = String(msg.cid || '')

        if (conn.role === 'ctl') {
          const rec = verify(msg.token)
          if (!rec || rec.role !== 'teacher') {
            sender.json({ t: 'error', message: '投屏需要教师登录：请先用教师口令登录，再点开始投屏' })
            sender.close(1008)
            return
          }
          conn.ctlOk = true
          ctls.add(conn)
          peersToCtl()
          return
        }

        /* ---- 学生观看 ---- */
        const rec = verify(msg.token)
        if (!rec || rec.role !== 'student') {
          sender.json({ t: 'error', message: '观看投屏需要先用学号登录' })
          sender.close(1008)
          return
        }

        // 身份：普通学生是本人；局域网代理送来一份名单（for）表示「这条连接代表这些人」
        const list = []
        if (Array.isArray(msg.for)) {
          // 空名单 = 现在没人看了（不能回退成令牌本人，否则留下幽灵观众）
          for (const it of msg.for) {
            if (it && it.sid) list.push({ classId: it.classId || rec.classId, sid: it.sid, name: it.name || '' })
          }
        } else {
          list.push({ classId: rec.classId, sid: rec.sid, name: rec.name || '' })
        }

        const changed =
          !conn.castWhos ||
          conn.castWhos.length !== list.length ||
          conn.castWhos.some((w, i) => w.sid !== list[i].sid || w.classId !== list[i].classId)
        if (changed) {
          markCast(conn, false)
          conn.castWhos = list
        }

        // 同一学生只留一个窗口：新窗口接管、旧窗口退场
        // 只对「代表一个人」的连接生效 —— 代理那条代表很多人，不能把真正在看的学生踢掉
        if (conn.castWhos.length === 1) {
          const me = conn.castWhos[0]
          for (const other of students) {
            if (other === conn || !other.castWhos || other.castWhos.length !== 1) continue
            const o = other.castWhos[0]
            if (o.classId !== me.classId || o.sid !== me.sid) continue
            other.sender.json({ t: 'taken-over' })
            markCast(other, false)
            other.sender.close(1000)
          }
        }

        if (!conn.authed) {
          conn.authed = true
          students.add(conn)
          sender.json({ t: 'mode', mode: state.mode }) // 晚进教室也知道现在是否在投
          toCtls({ t: 'newstudent', cid: conn.cid })
        } else {
          sender.json({ t: 'mode', mode: state.mode })
        }
        markCast(conn, state.mode === 'watch')
        peersToCtl()
        return
      }

      if (msg.t === 'mode') {
        if (conn.role !== 'ctl' || !conn.ctlOk) return
        if (msg.mode === 'watch') {
          modeOwner = conn
          setMode('watch', true)
          return
        }
        // 已经有一条连接在投：忽略这个 idle（它只是自己没开播）
        if (modeOwner && modeOwner !== conn && modeOwner.ctlOk) return
        modeOwner = null
        setMode('idle', true)
        return
      }

      if (msg.t === 'ping') {
        sender.json({ t: 'pong' })
      }
    })

    socket.on('close', () => {
      sender.close(1000)
      if (conn.role === 'presence' && conn.presenceIdent) {
        presence.detach(conn.presenceIdent.classId, conn.presenceIdent.sid)
        followers.delete(conn)
      }
      if (conn.castWhos && conn.castWhos.length) {
        markCast(conn, false)
        conn.castWhos = null
      }
      // 正在投屏的连接断了：必须归零，否则学生端对着最后一帧干等
      if (modeOwner === conn) {
        modeOwner = null
        setMode('idle', true)
      }
      if (conn.role === 'ctl') ctls.delete(conn)
      if (conn.role === 'student') {
        students.delete(conn)
        peersToCtl()
      }
    })
  })
}
