/*
 * lib/login-fails.js —— 登录失败的本地计数、熔断与手动禁用
 *
 * 三层保护：
 *   1. 自动熔断 —— 本系统数到 3 次就停，之后连外部请求都不发。
 *      等外部系统数到 5 就已经晚了（它锁号，我们完全被动）。
 *   2. 手动禁用 —— 老师可以在「班级管理 → 登录管理」里单独关掉某个学生。
 *   3. 记录外部自报次数 —— 每次失败时把外部系统返回的「今天已错 N 次」存下来，
 *      老师能看到真实的累计（这个数字只有登录失败时才知道，查不到）。
 *
 * 解除：老师手动解除，或 24 小时后自动过期（与外部系统的滚动窗口对齐）。
 */

import { db } from './repo.js'

/** 本地熔断阈值：到这次就停，绝不陪着外部系统数到 5 */
export const BLOCK_AFTER = 3

/** 熔断多久自动解除（毫秒）—— 与外部系统的 24 小时窗口一致 */
const BLOCK_TTL_MS = 24 * 60 * 60 * 1000

const key = (account) => String(account || '').trim().slice(0, 64)

function row(account) {
  const k = key(account)
  if (!k) return null
  try {
    return db().prepare('SELECT * FROM student_login_fails WHERE account = ?').get(k)
  } catch (e) {
    return null
  }
}

/** 找出与某个学号对应的记录（先按 account=sid，再按 sid 列） */
function rowOfSid(sid) {
  const s = String(sid || '').trim()
  if (!s) return null
  try {
    return (
      db().prepare('SELECT * FROM student_login_fails WHERE account = ?').get(s) ||
      db().prepare('SELECT * FROM student_login_fails WHERE sid = ? ORDER BY updated_at DESC LIMIT 1').get(s) ||
      null
    )
  } catch (e) {
    return null
  }
}

/**
 * 这个账号现在还能不能登录。
 * @returns {{blocked:boolean, count:number, remainMs:number, until:string, why:'auto'|'manual'|''}}
 */
export function check(account) {
  const r = row(account)
  if (!r) return { blocked: false, count: 0, remainMs: 0, until: '', why: '' }

  const count = Number(r.fail_count || 0)

  // 手动禁用：不看时间，只能老师解
  if (Number(r.manual_blocked || 0) === 1) {
    return { blocked: true, count, remainMs: 0, until: '', why: 'manual' }
  }

  if (!r.blocked) return { blocked: false, count, remainMs: 0, until: '', why: '' }

  const at = Date.parse(r.blocked_at || '') || 0
  const left = at + BLOCK_TTL_MS - Date.now()
  if (left <= 0) {
    clear(account)
    return { blocked: false, count: 0, remainMs: 0, until: '', why: '' }
  }
  return {
    blocked: true,
    count,
    remainMs: left,
    until: new Date(at + BLOCK_TTL_MS).toISOString(),
    why: 'auto',
  }
}

/**
 * 记一次失败。
 * @param {string} account 学生输的账号
 * @param {number} [remoteCount] 外部系统自报的当日累计输错次数
 * @param {string} [sid] 能认出来的学号（认不出就不传）
 */
export function bump(account, remoteCount, sid) {
  const k = key(account)
  if (!k) return { count: 0, blocked: false, justBlocked: false }

  const cur = row(account)
  const prevCount = cur ? Number(cur.fail_count || 0) : 0
  const prevBlocked = !!(cur && cur.blocked)
  const prevRemote = cur ? Number(cur.remote_count || 0) : 0

  const merged = Math.max(prevCount + 1, Number(remoteCount) || 0)
  const remote = Math.max(prevRemote, Number(remoteCount) || 0)
  const blocked = prevBlocked || merged >= BLOCK_AFTER
  const now = new Date().toISOString()

  try {
    db()
      .prepare(
        `INSERT INTO student_login_fails
           (account, sid, fail_count, remote_count, remote_at, blocked, manual_blocked, blocked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(account) DO UPDATE SET
           sid = CASE WHEN excluded.sid <> '' THEN excluded.sid ELSE student_login_fails.sid END,
           fail_count = excluded.fail_count,
           remote_count = excluded.remote_count,
           remote_at = excluded.remote_at,
           blocked = excluded.blocked,
           blocked_at = excluded.blocked_at,
           updated_at = excluded.updated_at`
      )
      .run(
        k,
        String(sid || ''),
        merged,
        remote,
        remote ? now : cur ? cur.remote_at : '',
        blocked ? 1 : 0,
        prevBlocked ? cur.blocked_at : blocked ? now : '',
        now
      )
  } catch (e) {
    /* 记不住也不该让登录流程崩掉 */
  }

  return { count: merged, blocked, justBlocked: blocked && !prevBlocked }
}

/** 登录成功：清掉这个账号的失败记录（手动禁用不受影响） */
export function clear(account) {
  const k = key(account)
  if (!k) return false
  try {
    const r = row(account)
    // 老师手动禁用的，不能因为「密码碰巧对了」就自动放行
    if (r && Number(r.manual_blocked || 0) === 1) {
      db()
        .prepare('UPDATE student_login_fails SET fail_count = 0, blocked = 0, blocked_at = ? WHERE account = ?')
        .run('', k)
      return false
    }
    return db().prepare('DELETE FROM student_login_fails WHERE account = ?').run(k).changes > 0
  } catch (e) {
    return false
  }
}

/** 老师手动禁用 / 解除某个学生（按学号） */
export function setManual(sid, on) {
  const s = String(sid || '').trim()
  if (!s) return false
  const cur = rowOfSid(s)
  const account = cur ? cur.account : s // 没记录就以学号为准建一条
  const now = new Date().toISOString()
  try {
    if (!cur) {
      db()
        .prepare(
          `INSERT INTO student_login_fails (account, sid, fail_count, remote_count, remote_at, blocked, manual_blocked, blocked_at, updated_at)
           VALUES (?, ?, 0, 0, '', 0, ?, ?, ?)`
        )
        .run(account, s, on ? 1 : 0, on ? now : '', now)
      return true
    }
    db()
      .prepare(
        `UPDATE student_login_fails
            SET manual_blocked = ?, fail_count = ?, blocked = 0, blocked_at = ?, updated_at = ?
          WHERE account = ?`
      )
      .run(on ? 1 : 0, on ? cur.fail_count : 0, on ? now : '', now, account)
    return true
  } catch (e) {
    return false
  }
}

/** 老师解锁一个账号（等价于解除手动禁用 + 清计数） */
export function unblock(account) {
  const k = key(account)
  if (!k) return false
  try {
    return db().prepare('DELETE FROM student_login_fails WHERE account = ?').run(k).changes > 0
  } catch (e) {
    return false
  }
}

/** 老师一键全解 */
export function unblockAll() {
  try {
    return db().prepare('DELETE FROM student_login_fails').run().changes
  } catch (e) {
    return 0
  }
}

/** 现在被禁止的账号数（教师端显示用，只回数量） */
export function blockedCount() {
  try {
    const rows = db().prepare('SELECT * FROM student_login_fails').all()
    let n = 0
    for (const r of rows) {
      if (Number(r.manual_blocked || 0) === 1) {
        n++
        continue
      }
      if (!r.blocked) continue
      const at = Date.parse(r.blocked_at || '') || 0
      if (at + BLOCK_TTL_MS > Date.now()) n++
      else clear(r.account)
    }
    return n
  } catch (e) {
    return 0
  }
}

/**
 * 给一批学号查出登录状态（班级管理页用）。
 * @returns {Map<string, {account:string, failCount:number, remoteCount:number, remoteAt:string,
 *                       blocked:boolean, manual:boolean, auto:boolean, until:string}>}
 */
export function statusOfSids(sids) {
  const out = new Map()
  const list = Array.isArray(sids) ? sids.map(String) : []
  if (!list.length) return out

  let rows = []
  try {
    rows = db()
      .prepare(
        `SELECT * FROM student_login_fails
          WHERE sid IN (${list.map(() => '?').join(',')})
             OR account IN (${list.map(() => '?').join(',')})`
      )
      .all(...list, ...list)
  } catch (e) {
    return out
  }

  const bySid = new Map()
  for (const r of rows) {
    // 同一个学号可能有多条（不同账号），取最近更新的一条
    const s = String(r.sid || '') || String(r.account || '')
    const prev = bySid.get(s)
    if (!prev || String(r.updated_at) > String(prev.updated_at)) bySid.set(s, r)
  }

  for (const [s, r] of bySid) {
    const manual = Number(r.manual_blocked || 0) === 1
    const at = Date.parse(r.blocked_at || '') || 0
    const autoLeft = at + BLOCK_TTL_MS - Date.now()
    const auto = !manual && Number(r.blocked || 0) === 1 && autoLeft > 0
    out.set(s, {
      account: String(r.account || ''),
      failCount: Number(r.fail_count || 0),
      remoteCount: Number(r.remote_count || 0),
      remoteAt: String(r.remote_at || ''),
      manual,
      auto,
      blocked: manual || auto,
      until: auto ? new Date(at + BLOCK_TTL_MS).toISOString() : '',
    })
  }
  return out
}
