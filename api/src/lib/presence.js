/*
 * lib/presence.js —— 谁在场 / 谁在看投屏（内存态，不落库）
 *
 * 为什么不进 SQLite：这是「此刻」的状态，秒级变化，写库只会把 WAL 写爆；
 * 进程重启后所有人本来就要重连，内存态正好。
 *
 * 两条判定信号（与旧实现一致，别乱改）：
 *   1) 在场通道（WebSocket）连着 —— 主用。关页面/拔网线，TCP 一断立刻知道
 *   2) 最近 TTL 内来过心跳（HTTP）—— 兜底。WS 被中间设备掐掉时仍能判在场
 *
 * TTL 取 120 秒而不是 30 秒：Chrome 会把后台标签页的定时器降到 1 次/分钟，
 * 30 秒会把「切出去看别的」的学生误判成离线。
 */
const TTL = 120 * 1000
const GRACE = 5 * 1000

const seen = new Map() // key → { classId, sid, name, firstSeen, lastSeen }
const conns = new Map() // key → 在场通道条数
const castConns = new Map() // key → 直连观看投屏的条数
const castSnap = new Map() // key → true（边缘端上报的，覆盖式，与上面分开记）

/** 边缘端快照：source → { online:Set, casting:Set, lastAt } */
const snapshots = new Map()
const MAX_SOURCES = 20
const SNAPSHOT_TTL = 10 * 60 * 1000
/** 防重放：source + ts 只收一次 */
const nonces = new Map()
const MAX_NONCES = 2000

const keyOf = (classId, sid) => String(classId) + ':' + String(sid)

export function touch(classId, sid, name) {
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

export function leave(classId, sid) {
  seen.delete(keyOf(classId, sid))
}

export function attach(classId, sid, name) {
  touch(classId, sid, name)
  const key = keyOf(classId, sid)
  conns.set(key, (conns.get(key) || 0) + 1)
}

export function detach(classId, sid) {
  const key = keyOf(classId, sid)
  const n = (conns.get(key) || 0) - 1
  if (n > 0) {
    conns.set(key, n)
    return
  }
  conns.delete(key)
  // 把最后一次心跳往前拨，只留 GRACE 秒：强杀浏览器 → 5 秒变灰，而不是等满 TTL
  const hit = seen.get(key)
  if (hit) hit.lastSeen = Math.min(hit.lastSeen, Date.now() - TTL + GRACE)
}

export function attachCast(classId, sid) {
  const key = keyOf(classId, sid)
  castConns.set(key, (castConns.get(key) || 0) + 1)
}

export function detachCast(classId, sid) {
  const key = keyOf(classId, sid)
  const n = (castConns.get(key) || 0) - 1
  if (n > 0) castConns.set(key, n)
  else castConns.delete(key)
}

export function onlineSet(classId) {
  const out = new Set()
  const now = Date.now()
  for (const rec of seen.values()) {
    if (rec.classId !== classId) continue
    if ((conns.get(keyOf(classId, rec.sid)) || 0) > 0 || now - rec.lastSeen < TTL) out.add(rec.sid)
  }
  return out
}

export function castingSet(classId) {
  const out = new Set()
  for (const [key, n] of castConns) {
    if (n <= 0) continue
    const at = key.indexOf(':')
    if (key.slice(0, at) === String(classId)) out.add(key.slice(at + 1))
  }
  for (const [key, on] of castSnap) {
    if (!on) continue
    const at = key.indexOf(':')
    if (key.slice(0, at) === String(classId)) out.add(key.slice(at + 1))
  }
  return out
}

export function isOnline(classId, sid) {
  const key = keyOf(classId, sid)
  return (conns.get(key) || 0) > 0 || Date.now() - ((seen.get(key) || {}).lastSeen || 0) < TTL
}

/** 防重放：同一 source + 时间戳只收一次 */
export function markNonce(source, ts) {
  const key = source + ':' + ts
  const now = Date.now()
  if (nonces.has(key)) return false
  nonces.set(key, now + 300 * 1000)
  if (nonces.size > MAX_NONCES) {
    for (const [k, exp] of nonces) if (exp < now) nonces.delete(k)
    if (nonces.size > MAX_NONCES) {
      let extra = nonces.size - MAX_NONCES
      for (const k of nonces.keys()) {
        nonces.delete(k)
        if (--extra <= 0) break
      }
    }
  }
  return true
}

/**
 * 边缘端（局域网代理）上报：一次性把「谁在场、谁在看投屏」报上来。
 * entries: [{ token, online, casting }] —— 身份由 verify(token) 解出来，客户端说了不算。
 */
export function applySnapshot(source, entries, verifyToken) {
  const prev = snapshots.get(source) || { online: new Set(), casting: new Set() }
  const nextOnline = new Set()
  const nextCasting = new Set()
  const who = new Map()

  for (const e of entries) {
    const rec = verifyToken(e.token)
    if (!rec || rec.role !== 'student' || !rec.sid) continue
    who.set(rec.sid, { classId: rec.classId, name: rec.name })
    if (e.online) nextOnline.add(rec.sid)
    if (e.casting) nextCasting.add(rec.sid)
  }

  for (const sid of nextOnline) {
    const w = who.get(sid)
    touch(w.classId, sid, w.name)
  }
  for (const sid of prev.online) {
    if (nextOnline.has(sid)) continue
    const w = who.get(sid)
    if (w) leave(w.classId, sid)
  }
  for (const sid of nextCasting) {
    const w = who.get(sid)
    if (w) castSnap.set(keyOf(w.classId, sid), true)
  }
  for (const sid of prev.casting) {
    if (nextCasting.has(sid)) continue
    const w = who.get(sid)
    if (w) castSnap.delete(keyOf(w.classId, sid))
  }

  if (!snapshots.has(source) && snapshots.size >= MAX_SOURCES) {
    let oldest = null
    let oldestAt = Infinity
    for (const [k, v] of snapshots) {
      if ((v.lastAt || 0) < oldestAt) {
        oldestAt = v.lastAt || 0
        oldest = k
      }
    }
    if (oldest !== null) snapshots.delete(oldest)
  }
  snapshots.set(source, { online: nextOnline, casting: nextCasting, lastAt: Date.now() })
  return { online: nextOnline.size, casting: nextCasting.size }
}

export function sweep() {
  const now = Date.now()
  for (const [key, rec] of seen) if (now - rec.lastSeen >= TTL * 4) seen.delete(key)
  for (const [src, v] of snapshots) if (now - (v.lastAt || 0) > SNAPSHOT_TTL) snapshots.delete(src)
  for (const [k, exp] of nonces) if (exp < now) nonces.delete(k)
}

export const stats = () => ({
  watching: seen.size,
  conns: [...conns.values()].reduce((a, b) => a + b, 0),
  casting: [...castConns.values()].reduce((a, b) => a + b, 0),
  snapshotSources: snapshots.size,
})

export { TTL, GRACE }

setInterval(sweep, 60 * 1000).unref()
