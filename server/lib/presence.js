'use strict'
const auth = require('./auth')
/*
 * presence.js —— 在场状态（学生是否登录着、页面是否还开着）
 *
 * 两条信号，任一成立就算「在场」：
 *   1) 在场通道（WebSocket）还连着 —— 主用。关页面、强杀浏览器、断电、拔网线，
 *      TCP 一断立刻知道，所以教师端几秒内就能看到人变灰；
 *   2) 最近 120 秒内来过心跳（HTTP） —— 兜底。代理挡掉 WS 时仍然能判在场。
 *
 * 关页面 / 退出登录会额外发一次「报离」，所以正常操作是立即下线。
 * WS 断开后留 GRACE（5 秒）缓冲，避免自动重连（2 秒一次）时闪一下。
 *
 * 为什么不存盘：这是「此刻谁在教室」的瞬时状态，服务重启就该清空；
 * 真正的考勤记录在 events 表里（教师按在场名单一键记，才落成记录）。
 *
 * TTL 取 120 秒而不是 30 秒：Chrome 对被遮挡的标签页会把定时器降到 1 次/分钟，
 * 学生把网页切到后台看别的东西时，30 秒的 TTL 会把他误判成离线。
 */
const TTL = 120 * 1000
// 在场通道断掉后留的缓冲：足够 WS 自动重连（2 秒一次）走完，又不会让人挂了还显示在线。
const GRACE = 5 * 1000

const seen = new Map() // key = classId + ':' + sid → 最后一次心跳
const conns = new Map() // key → 还活着的在场通道条数（同一学生开多个标签页会累加）
const castConns = new Map() // key → 正在看投屏的连接条数（/watch 带令牌连上来才算）
// 边缘端快照来源的「谁在看投屏」：覆盖式（每个 sid 一个标记）。
// 必须与上面的 WS 来源分开记 —— 同一个学生可能既开着直连的观看页、
// 又被边缘端快照报了一次；混在一个计数里会导致「退出了还剩 1」（幽灵观众）。
const castSnap = new Map()   // key → true
// 边缘端（局域网代理）上报的快照：source → { online:Set, casting:Set }
// 代理把本地 N 个学生的状态打包成一次请求发上来（省流的关键）；
// 身份一律以**令牌**为准（客户端只能报「我手上有这些令牌」，
// 冒名顶替不了 —— 令牌是服务端签发的）。
const snapshots = new Map() // source -> { online: Set(sid), casting: Set(sid) }

const keyOf = (classId, sid) => classId + ':' + sid

function touch(classId, sid, name) {
  const key = keyOf(classId, sid)
  const now = Date.now()
  const hit = seen.get(key)
  if (hit) {
    hit.lastSeen = now
    if (name) hit.name = name
  } else {
    seen.set(key, { classId, sid, name: name || '', firstSeen: now, lastSeen: now })
  }
}

function leave(classId, sid) {
  seen.delete(keyOf(classId, sid))
}

/**
 * WebSocket 在场通道建立。
 * 为什么还要这一条：浏览器被强杀 / 断电 / 拔网线时，pagehide 根本不触发，
 * 只靠 HTTP 心跳要等 TTL（2 分钟）才变灰。而进程一死，TCP 立刻断，
 * 服务端能秒级感知 —— 这是「关掉网页就知道他不在线」的可靠来源。
 */
function attach(classId, sid, name) {
  touch(classId, sid, name)
  const key = keyOf(classId, sid)
  conns.set(key, (conns.get(key) || 0) + 1)
}

function detach(classId, sid) {
  const key = keyOf(classId, sid)
  const n = (conns.get(key) || 0) - 1
  if (n > 0) {
    conns.set(key, n)
    return
  }
  conns.delete(key)
  // 把「最后一次心跳」往前拨，只留 GRACE 秒的缓冲：
  // 这样强杀浏览器 = 5 秒后变灰，而不是等满 TTL。断线重连（2 秒）不会闪。
  const hit = seen.get(key)
  if (hit) hit.lastSeen = Math.min(hit.lastSeen, Date.now() - TTL + GRACE)
}

function isOnline(classId, sid) {
  const key = keyOf(classId, sid)
  if ((conns.get(key) || 0) > 0) return true
  const hit = seen.get(key)
  return !!hit && Date.now() - hit.lastSeen < TTL
}

/**
 * 投屏观看状态：/watch 页面连上投屏通道、并且带着学生令牌，才算「这个人在看投屏」。
 * 和「登录在场」分开记 —— 学生可能开着学生端页面但没开观看页，也可能反过来。
 */
function attachCast(classId, sid) {
  const key = keyOf(classId, sid)
  castConns.set(key, (castConns.get(key) || 0) + 1)
}

function detachCast(classId, sid) {
  const key = keyOf(classId, sid)
  const n = (castConns.get(key) || 0) - 1
  if (n > 0) castConns.set(key, n)
  else castConns.delete(key)
}

/**
 * 边缘端快照：一次性把「谁在场、谁在看投屏」报上来。
 *
 * entries: [{ token, online, casting }] —— token 是**学生令牌**，
 *   身份（班级/学号/姓名）一律由服务端从令牌解出来，客户端说了不算。
 *
 * 与直连的区别：
 *   · 直连走 WebSocket 在场通道，服务端秒级感知；
 *   · 边缘端走这个快照（几秒一次）—— 离线的人立刻 leave()，
 *     不用等 TTL（120 秒）才变灰。
 */
function applySnapshot(source, entries) {
  const prev = snapshots.get(source) || { online: new Set(), casting: new Set() }
  const nextOnline = new Set()
  const nextCasting = new Set()
  const who = new Map() // sid -> { classId, name }

  for (const e of entries) {
    const rec = auth.verify(e.token)
    if (!rec || rec.role !== 'student') continue // 令牌不对 → 这条不算
    const sid = rec.sid
    if (!sid) continue
    who.set(sid, { classId: rec.classId, name: rec.name })
    if (e.online) nextOnline.add(sid)
    if (e.casting) nextCasting.add(sid)
  }

  // 上场：刷新心跳（在线判定靠它）
  for (const sid of nextOnline) {
    const w = who.get(sid)
    touch(w.classId, sid, w.name)
  }
  // 离场：上次在线、这次没了 → 立刻下线（不等 TTL）
  for (const sid of prev.online) {
    if (nextOnline.has(sid)) continue
    const w = who.get(sid)
    if (w) leave(w.classId, sid)
  }
  // 看投屏：快照来源单独记（覆盖式）——
  // 不能和 WS 连接的计数混在一起，否则同一个人减一次还剩一次（幽灵观众）。
  for (const sid of nextCasting) {
    const w = who.get(sid)
    if (w) castSnap.set(keyOf(w.classId, sid), true)
  }
  for (const sid of prev.casting) {
    if (nextCasting.has(sid)) continue
    const w = who.get(sid)
    if (w) castSnap.delete(keyOf(w.classId, sid))
  }

  snapshots.set(source, { online: nextOnline, casting: nextCasting })
  return { online: nextOnline.size, casting: nextCasting.size }
}

/** 某班此刻正在看投屏的学号集合 */
function castingSet(classId) {
  const set = new Set()
  for (const [key, n] of castConns) {
    if (n <= 0) continue
    const at = key.indexOf(':')
    if (key.slice(0, at) === classId) set.add(key.slice(at + 1))
  }
  // 边缘端快照报来的（覆盖式，与上面的 WS 来源互不影响）
  for (const [key, on] of castSnap) {
    if (!on) continue
    const at = key.indexOf(':')
    if (key.slice(0, at) === classId) set.add(key.slice(at + 1))
  }
  return set
}

/** 某班此刻在线的学号集合（WS 通路优先，HTTP 心跳兜底） */
function onlineSet(classId) {
  const set = new Set()
  const now = Date.now()
  for (const rec of seen.values()) {
    if (rec.classId !== classId) continue
    if ((conns.get(keyOf(classId, rec.sid)) || 0) > 0 || now - rec.lastSeen < TTL) set.add(rec.sid)
  }
  return set
}

/** 清理过期记录，别让内存里长草 */
function sweep() {
  const now = Date.now()
  for (const [key, rec] of seen) {
    if (now - rec.lastSeen >= TTL * 4) seen.delete(key)
  }
}

setInterval(sweep, 60 * 1000).unref()

module.exports = {
  applySnapshot,
  touch,
  leave,
  attach,
  detach,
  attachCast,
  detachCast,
  isOnline,
  onlineSet,
  castingSet,
  TTL,
  GRACE,
}
