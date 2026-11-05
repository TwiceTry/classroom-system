'use strict'
/*
 * cast.js —— 投屏中继（把原 机房投屏/relay-server.py 的转发职责并入 Node）
 *
 * 协议与老方案完全一致，所以教师端抓屏代码、学生端绘制代码都能直接沿用：
 *   教师 → 中继  二进制图块帧 / 文本控制消息（hello / mode / ping）
 *   中继 → 学生  二进制图块帧（只保留最新一帧，背压丢旧）/ 文本控制消息
 *
 * 三条已在真机踩过的规则，这里原样保留：
 *   1) 教师端连上必须先发 hello —— 否则「学生先上线、控制台后开」时
 *      教师端以为 peers=0，一帧都不推，全班黑屏；
 *   2) 中继要记住当前 mode，并给每个新上线的学生补发一份 —— 否则晚进教室的
 *      学生永远停在「未投屏」占位页；
 *   3) 每帧只保留最新一份，学生机卡住不拖累其他人。
 *
 * 身份：教师控制台（role=ctl）连上后必须在 hello 里带教师令牌才入列。
 * 早先靠「来自 127.0.0.1」认人，等于把教师端钉在 localhost；现在授权不授权看令牌，
 * 于是教师端从局域网 IP / 别台机器 / 映射域名打开都能投屏，而未登录的连不进来。
 */
const { attach } = require('../lib/ws')
const auth = require('../lib/auth')
const presence = require('../lib/presence')

function createCast() {
  const students = new Set()
  // 允许多个教师端页面同时在线：多开一个标签页、或页面刷新后旧连接还没断，
  // 都不该互相踢人（以前只保留最新一条，两边会 2 秒一次地拉锯，谁都投不了）。
  const ctls = new Set()
  // 学生端「跟随讲义」用：认证过的在场通道（学生端 SPA 的那条）
  const followers = new Set()
  let mode = 'idle'
  let frames = 0
  let bytesWindow = 0
  let windowAt = Date.now()
  let lan = []

  /**
   * 这条连接代表的学生们。
   *
   * 正常学生端：一个人（自己的令牌）。
   * 局域网代理：把 N 个学生的观看**合成一条上行连接**（公网下行才是 1 份），
   *   这时名单由 hello 里的 `for` 给出 —— 服务端照样能准确知道「谁在看投屏」。
   */
  function castWhos(conn) {
    if (conn.castWhos && conn.castWhos.length) return conn.castWhos
    if (conn.castWho) return [conn.castWho]
    return []
  }

  /**
   * 「在看投屏」按人算，不按连接算：
   * 同一个学生同时开了应用内投屏和另一个标签页，也只该算 1 个人。
   */
  function uniqueWatchers() {
    const set = new Set()
    for (const c of students) {
      for (const w of castWhos(c)) set.add(w.classId + ':' + w.sid)
    }
    return set.size
  }

  function peersToCtl() {
    const n = uniqueWatchers()
    for (const c of ctls) if (c.isOpen) c.sendJson({ t: 'peers', students: n })
  }

  function toCtls(msg) {
    for (const c of ctls) if (c.isOpen) c.sendJson(msg)
  }

  /**
   * 只发给学生端 SPA 的在场通道（讲义 / 计分 / Playground 那几页）。
   * 观看页不必收：它本来就盯着 mode 消息。
   */
  function toFollowers(msg) {
    for (const c of followers) if (c.isOpen) c.sendJson(msg)
  }

  /**
   * 「在看投屏」只统计真正在收画面的人：
   * 学生开着观看页但老师没开播，只是等着，不算在看；开播/停播时统一更新。
   */
  function markCast(conn, on) {
    const list = castWhos(conn)
    if (!list.length) return
    if (on && !conn.castOn) {
      for (const w of list) presence.attachCast(w.classId, w.sid)
      conn.castOn = true
    } else if (!on && conn.castOn) {
      for (const w of list) presence.detachCast(w.classId, w.sid)
      conn.castOn = false
    }
  }

  // 谁把 mode 设成 watch 的。多开一个教师端标签页时，
  // 那个没在投屏的页面每次重连都会报 idle，不能让它把正在投的班打断。
  let modeOwner = null

  function setMode(next, propagate) {
    const prev = mode
    mode = next === 'watch' ? 'watch' : 'idle'
    for (const s of students) {
      markCast(s, mode === 'watch')
      if (propagate) s.sendJson({ t: 'mode', mode })
    }
    // 开播/停播要通知学生端 SPA：它得抢在「学生已经离开标签页」之前把投屏页打开
    // （或挂一条「老师开始投屏了」的横幅）。只在真的变了时发，避免每 2 秒重连刷屏。
    if (mode !== prev) toFollowers({ t: 'cast', mode })
  }

  const api = {
    attach(server) {
      attach(server, {
        onOpen(conn, url) {
          const role = url.searchParams.get('role')
          conn.role = role

          if (role === 'ctl') {
            // 投屏控制台不再按 IP 限制：教师端从局域网 IP、映射域名、https 隧道
            // 打开都该能用（原来只放行 127.0.0.1，换台机器就「通道断开、一直重连」）。
            // 但不能白放：ctl 的二进制帧是直接转给全班的，谁都能连上来就等于谁都能抢屏幕。
            // 所以改认令牌 —— 教师登录后带 token 连，验过才入列。
            conn.ctlOk = false
            return
          }

          if (role === 'student') {
            // 不在这里入列：观看投屏要身份，等 hello 里的学生令牌校验通过才放行
            conn.authed = false
            return
          }

          // 在场通道：等客户端把令牌发过来再定身份（令牌不放在 URL 里，免得进日志）
          if (role === 'presence') {
            conn.presence = null
            return
          }

          conn.close(1008)
        },

        onMessage(conn, data, isBinary) {
          if (isBinary) {
            if (conn.role !== 'ctl' || !conn.ctlOk) return
            frames++
            bytesWindow += data.length
            for (const s of students) s.sendBinaryLatest(data)
            return
          }

          let msg
          try {
            msg = JSON.parse(data)
          } catch (e) {
            return
          }

          // 在场通道：第一条必须是 auth
          if (conn.role === 'presence') {
            if (msg.t !== 'auth') return
            const rec = auth.verify(msg.token)
            if (!rec || rec.role !== 'student') {
              conn.sendJson({ t: 'auth-fail' })
              conn.close(1008)
              return
            }
            conn.presence = { classId: rec.classId, sid: rec.sid }
            presence.attach(rec.classId, rec.sid, rec.name)
            followers.add(conn)
            conn.sendJson({ t: 'auth-ok' })
            // 补发当前投屏状态：学生刚打开页面/刚重连时，也要能立刻知道老师是不是已经在投
            conn.sendJson({ t: 'cast', mode })
            return
          }

          if (msg.t === 'hello') {
            conn.cid = String(msg.cid || '')
            if (conn.role === 'ctl') {
              // 教师令牌：口令登录拿到的那个（见 lib/auth.js 的 issue(role:'teacher')）
              const rec = auth.verify(msg.token)
              if (!rec || rec.role !== 'teacher') {
                conn.sendJson({ t: 'error', message: '投屏需要教师登录：请先用教师口令登录，再点开始投屏' })
                conn.close(1008)
                return
              }
              conn.ctlOk = true
              ctls.add(conn)
              peersToCtl()
              return
            }
            // 学生观看页必须带学生令牌：这样教师端的「在看」才对应得到人
            const rec = auth.verify(msg.token)
            if (!rec || rec.role !== 'student') {
              conn.sendJson({ t: 'error', message: '观看投屏需要先用学号登录' })
              conn.close(1008)
              return
            }

            // 身份：正常学生端是本人；局域网代理会送来一份名单（for），
            // 表示「这条连接代表这么多人在看」—— 服务端照样能准确记账，
            // 而公网上行/下行都只走这一条。
            const list = []
            if (Array.isArray(msg.for)) {
              // 代理模式：名单就是全部。**空名单表示「现在没人看了」** ——
              // 不能回退成令牌本人，否则会留下一个「幽灵观众」。
              for (const it of msg.for) {
                if (it && it.sid) {
                  list.push({ classId: it.classId || rec.classId, sid: it.sid, name: it.name || '' })
                }
              }
            } else {
              // 普通学生端：本人
              list.push({ classId: rec.classId, sid: rec.sid, name: rec.name || '' })
            }

            // 名单变了（代理那边有人进/退出观看）→ 先把旧的摘掉再登记新的
            const changed =
              !conn.castWhos ||
              conn.castWhos.length !== list.length ||
              conn.castWhos.some((w, i) => w.sid !== list[i].sid || w.classId !== list[i].classId)
            if (changed) {
              markCast(conn, false)
              conn.castWhos = list
              conn.castWho = list[0] // 兼容旧字段
            }

            // 同一学生只保留一个窗口在看：新窗口接管，旧窗口主动退场。
            // 好处一：教师端「在看」不会因为多开标签页而翻倍；
            // 好处二：旧窗口立刻停止收帧，省服务器带宽（一帧几百 KB，学生机也会卡）。
            // 只对「代表一个人」的连接生效：代理那条代表很多人，
            // 它不能把真正在看的学生踢掉（那样全班都收不到画面）。
            if (conn.castWhos.length === 1) {
              for (const other of students) {
                if (other === conn || !other.castWho) continue
                if (other.castWho.classId !== conn.castWho.classId) continue
                if (other.castWho.sid !== conn.castWho.sid) continue
                other.sendJson({ t: 'taken-over' })
                markCast(other, false)
                other.close(1000)
              }
            }

            if (!conn.authed) {
              conn.authed = true
              students.add(conn)
              // 记住的 mode 补发一份：晚进教室的学生也能立刻知道现在是否在投屏
              conn.sendJson({ t: 'mode', mode })
              toCtls({ t: 'newstudent', cid: conn.cid || '' })
            } else {
              conn.sendJson({ t: 'mode', mode })
            }
            markCast(conn, mode === 'watch')
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
            // 已经有另一条连接在投屏：忽略这个 idle（它只是自己没开播而已）
            if (modeOwner && modeOwner !== conn && modeOwner.isOpen) return
            modeOwner = null
            setMode('idle', true)
            return
          }

          if (msg.t === 'ping') {
            conn.sendJson({ t: 'pong' })
            return
          }
          // pong / stat 之类：不回，保持安静
        },

        onClose(conn) {
          // 关页面 / 强杀浏览器 / 断网：TCP 一断，这里立刻把人摘掉
          if (conn.role === 'presence' && conn.presence) {
            presence.detach(conn.presence.classId, conn.presence.sid)
            followers.delete(conn)
          }
          if (conn.castWho || (conn.castWhos && conn.castWhos.length)) {
            markCast(conn, false)
            conn.castWho = null
            conn.castWhos = null
          }
          // 正在投屏的那条连接断了：必须归零，否则学生端对着最后一帧干等
          if (modeOwner === conn) {
            modeOwner = null
            setMode('idle', true)
          }
          if (conn.role === 'ctl') ctls.delete(conn)
          if (conn.role === 'student') {
            students.delete(conn)
            peersToCtl()
          }
        },
      })
    },

    state() {
      const now = Date.now()
      const dt = Math.max(0.5, (now - windowAt) / 1000)
      const mbps = (bytesWindow * 8) / dt / 1000000
      if (dt > 1.5) {
        bytesWindow = 0
        windowAt = now
      }
      return {
        students: uniqueWatchers(),
        controller: ctls.size > 0,
        mode,
        frames,
        mbps: Math.round(mbps * 100) / 100,
        lan,
      }
    },

    /**
     * 广播一条控制消息（讲义跟随用）。
     * 发给学生端 SPA 的在场通道 + 观看页；返回送达条数，方便教师端显示。
     */
    broadcast(msg) {
      let n = 0
      for (const c of followers) {
        if (c.isOpen) {
          c.sendJson(msg)
          n++
        }
      }
      for (const s of students) {
        if (s.isOpen) s.sendJson(msg)
      }
      return n
    },

    /** 教师端要显示「学生该打开哪个地址」，由 index.js 启动时把网卡地址塞进来 */
    setLan(list) {
      lan = Array.isArray(list) ? list : []
    },
  }

  return api
}

module.exports = { createCast }
