/*
 * lib/student-creds.js —— 记住学生的登录密码（存派生值，不存明文）
 *
 * 为什么要记：
 *   学生登录方式切成「青果账号密码」后，每次登录都去问青果的话，
 *   既慢（要过验证码识别，1~2 秒）又要消耗青果的失败次数。
 *   记住之后，第二次起本地比对，一样安全、快得多。
 *
 * 为什么存派生值而不是加密后还原：
 *   登录只需要「判断对不对」，不需要还原出密码。
 *   存 scrypt(password, 随机盐) 就够了 —— 库被看到也拿不到原文。
 *
 * 为什么本地不过时不能自动去问青果：
 *   青果按 24 小时计失败次数，满 5 次锁号。
 *   如果「本地不通过就自动打青果」，学生手滑连输 5 次就把自己账号打锁了。
 *   所以本地失败一律直接拒，只有学生**主动点「用青果再验一次」**才走远端。
 *
 * 学生改过青果密码怎么办：
 *   本地哈希对不上 → 拒绝 → 学生点「用青果再验一次」→ 青果通过 → 覆盖本地哈希。
 *   这样既不会误锁号，也不会把人永久卡在外面。
 */

import crypto from 'node:crypto'
import { db } from './repo.js'

const ALGO = 'scrypt'
const KEY_LEN = 64
const SALT_LEN = 16

/** scrypt 是故意慢的（防暴力猜），但别慢到卡住登录 —— N=2^14 约 50ms */
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function hashOf(password, salt) {
  return crypto.scryptSync(String(password), salt, KEY_LEN, SCRYPT_OPTS).toString('hex')
}

/** 记住一个学生的密码（覆盖式）。返回值仅用于测试/日志，不含任何凭据。 */
export function remember(sid, password) {
  const id = String(sid || '').trim()
  const pwd = String(password || '')
  if (!id || !pwd) return false
  const salt = crypto.randomBytes(SALT_LEN).toString('hex')
  const hash = hashOf(pwd, salt)
  db()
    .prepare(
      `INSERT INTO student_credentials (sid, algo, salt, hash, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET algo = excluded.algo, salt = excluded.salt,
                                      hash = excluded.hash, updated_at = excluded.updated_at`
    )
    .run(id, ALGO, salt, hash, new Date().toISOString())
  return true
}

/**
 * 本地比对。返回：
 *   true   密码对
 *   false  密码不对
 *   null   没记过（需要去问青果）
 */
export function verify(sid, password) {
  const id = String(sid || '').trim()
  if (!id) return null
  let row = null
  try {
    row = db().prepare('SELECT algo, salt, hash FROM student_credentials WHERE sid = ?').get(id)
  } catch (e) {
    return null
  }
  if (!row || !row.salt || !row.hash) return null
  try {
    const got = Buffer.from(hashOf(password, row.salt), 'hex')
    const want = Buffer.from(row.hash, 'hex')
    // 常数时间比较：别让「前几位对了」这种时间差泄露信息
    if (got.length !== want.length) return false
    return crypto.timingSafeEqual(got, want)
  } catch (e) {
    return null
  }
}

/** 忘掉一个学生（教师端清理用） */
export function forget(sid) {
  return db().prepare('DELETE FROM student_credentials WHERE sid = ?').run(String(sid || '').trim()).changes > 0
}

/** 忘掉全部 */
export function forgetAll() {
  return db().prepare('DELETE FROM student_credentials').run().changes
}

/** 记住的人有几个（只回数量，不回任何凭据） */
export function countRemembered() {
  try {
    return db().prepare('SELECT COUNT(1) AS n FROM student_credentials').get().n
  } catch (e) {
    return 0
  }
}
