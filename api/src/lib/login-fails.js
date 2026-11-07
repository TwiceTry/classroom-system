/*
 * lib/login-fails.js —— 登录失败的本地计数与熔断
 *
 * 背景：外部系统「24 小时内输错 5 次锁号」。
 * 等它数到 5，学生已经进不去了，而且我们完全被动。
 *
 * 所以在本系统里自己数：
 *   第 1 次错 → 正常提示
 *   第 2 次错 → 正常提示（顺带提醒还剩一次）
 *   第 3 次错 → **本地禁止登录**，之后再登录连外部请求都不发
 *
 * 这样最坏情况是「课堂系统登不进」，而不是「校园账号被锁」——
 * 前者找老师点一下就能解，后者要等 24 小时。
 *
 * 解除方式：
 *   · 老师手动解锁（教师端按钮）
 *   · 或者 24 小时后自动过期（和外部系统的滚动窗口对齐，让学生第二天能自己试）
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
    return db().prepare('SELECT account, fail_count, blocked, blocked_at, updated_at FROM student_login_fails WHERE account = ?').get(k)
  } catch (e) {
    return null
  }
}

/**
 * 查这个账号现在还能不能登录。
 * @returns {{blocked:boolean, count:number, remainMs:number, until:string}}
 */
export function check(account) {
  const r = row(account)
  if (!r) return { blocked: false, count: 0, remainMs: 0, until: '' }

  const count = Number(r.fail_count || 0)
  if (!r.blocked) return { blocked: false, count, remainMs: 0, until: '' }

  const at = Date.parse(r.blocked_at || '') || 0
  const left = at + BLOCK_TTL_MS - Date.now()
  if (left <= 0) {
    // 过期了：自动放行，并把计数清掉
    clear(account)
    return { blocked: false, count: 0, remainMs: 0, until: '' }
  }
  return {
    blocked: true,
    count,
    remainMs: left,
    until: new Date(at + BLOCK_TTL_MS).toISOString(),
  }
}

/**
 * 记一次失败。返回累计次数与「是否刚被熔断」。
 * @param {string} account
 * @param {number} [serverCount] 外部系统自报的累计次数（有就取较大值，两边对齐）
 */
export function bump(account, serverCount) {
  const k = key(account)
  if (!k) return { count: 0, blocked: false, justBlocked: false }

  const cur = row(account)
  const prevCount = cur ? Number(cur.fail_count || 0) : 0
  const prevBlocked = !!(cur && cur.blocked)

  const merged = Math.max(prevCount + 1, Number(serverCount) || 0)
  const blocked = prevBlocked || merged >= BLOCK_AFTER
  const now = new Date().toISOString()

  try {
    db()
      .prepare(
        `INSERT INTO student_login_fails (account, fail_count, blocked, blocked_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account) DO UPDATE SET fail_count = excluded.fail_count,
                                            blocked = excluded.blocked,
                                            blocked_at = excluded.blocked_at,
                                            updated_at = excluded.updated_at`
      )
      .run(k, merged, blocked ? 1 : 0, prevBlocked ? cur.blocked_at : blocked ? now : '', now)
  } catch (e) {
    /* 记不住也不该让登录流程崩掉 */
  }

  return { count: merged, blocked, justBlocked: blocked && !prevBlocked }
}

/** 登录成功：清掉这个账号的失败记录 */
export function clear(account) {
  const k = key(account)
  if (!k) return false
  try {
    return db().prepare('DELETE FROM student_login_fails WHERE account = ?').run(k).changes > 0
  } catch (e) {
    return false
  }
}

/** 老师解锁一个账号 */
export function unblock(account) {
  return clear(account)
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
    const rows = db().prepare('SELECT account, blocked, blocked_at FROM student_login_fails WHERE blocked = 1').all()
    // 顺手清掉已过期的，别让数字虚高
    let n = 0
    for (const r of rows) {
      const at = Date.parse(r.blocked_at || '') || 0
      if (at + BLOCK_TTL_MS > Date.now()) n++
      else clear(r.account)
    }
    return n
  } catch (e) {
    return 0
  }
}
