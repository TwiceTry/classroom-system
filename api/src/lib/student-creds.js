/*
 * lib/student-creds.js —— 记住学生的登录密码
 *
 * 为什么要记：
 *   学生登录方式切成「青果账号密码」后，每次登录都去问青果的话，
 *   既慢（要过验证码识别，1~2 秒）又要消耗青果的失败次数。
 *   记住之后，第二次起本地比对，一样安全、快得多。
 *
 * 为什么是**可逆加密**而不是哈希：
 *   老师需要能在「登录管理」里看到记住的密码（学生忘了自己当初填了什么、
 *   或者要核对是不是跟青果一致）。哈希做不到这件事，所以改成 AES-256-GCM。
 *
 *   这是个明确的取舍，写在这里免得以后有人以为是疏忽：
 *     存哈希 → 库泄露也拿不到原文，但老师永远看不到；
 *     存密文 → 老师能在界面上看，代价是**密钥（data/config.json 的 secret）
 *              必须和数据库分开保管**。两样一起被拿走，等于明文。
 *   密钥不直接复用 secret，而是经 HKDF 派生一把专用的（标签不同 → 换不出别的用途）。
 *
 * 为什么本地不过时不能自动去问青果：
 *   青果按 24 小时计失败次数，满 5 次锁号。
 *   如果「本地不通过就自动打青果」，学生手滑连输 5 次就把自己账号打锁了。
 *   所以本地失败一律直接拒，只有学生**主动点「用青果再验一次」**才走远端。
 *
 * 学生改过青果密码怎么办：
 *   本地对不上 → 拒绝 → 学生点「用青果再验一次」→ 青果通过 → 覆盖本地记录。
 *   这样既不会误锁号，也不会把人永久卡在外面。
 *
 * 老数据（scrypt 派生值）：
 *   上一版存的是 scrypt 哈希，**还原不出来**。那些记录照样能用来本地比对，
 *   但 reveal() 对它们返回 null，界面显示「旧记录（不可查看）」。
 *   学生下次用青果验一次，就会自动升级成加密记录。
 */

import crypto from 'node:crypto'
import { config } from '../config.js'
import { db } from './repo.js'

/** 当前用的算法 */
const ALGO = 'aes-256-gcm'
/** 上一版：scrypt 派生值，只能比对、不能还原 */
const ALGO_LEGACY = 'scrypt'

const IV_LEN = 12 // GCM 推荐 96 位
const SALT_LEN = 16
const KEY_LEN = 64
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/**
 * 加密密钥：由 config.secret 经 HKDF 派生。
 *
 * 不用 secret 本身 —— 那个还兼着签 token，用途混在一起，
 * 一旦哪天要换签名方案就会把所有存着的密码一起弄废。
 * HKDF 的 info 里写清用途，等于给这把钥匙贴了标签。
 */
function encKey() {
  const base = String(config.secret || '')
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(base, 'utf8'), Buffer.from('teach-system/student-creds', 'utf8'), Buffer.from(ALGO, 'utf8'), 32)
  )
}

/** 旧的派生值（只在读老记录时用） */
function hashOf(password, salt) {
  return crypto.scryptSync(String(password), salt, KEY_LEN, SCRYPT_OPTS).toString('hex')
}

/**
 * 记住一个学生的密码（覆盖式）。返回值仅用于测试/日志，不含任何凭据。
 *
 * 存法：salt 字段放 IV，hash 字段放「密文:认证标签」（都是 hex）。
 * 复用这两个列而不是加新列 —— 表结构一变就要写迁移，
 * 而这两个字段本来就只是"两个字符串"，语义由 algo 决定。
 */
export function remember(sid, password) {
  const id = String(sid || '').trim()
  const pwd = String(password || '')
  if (!id || !pwd) return false
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, encKey(), iv)
  const body = Buffer.concat([cipher.update(pwd, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  db()
    .prepare(
      `INSERT INTO student_credentials (sid, algo, salt, hash, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET algo = excluded.algo, salt = excluded.salt,
                                      hash = excluded.hash, updated_at = excluded.updated_at`
    )
    .run(id, ALGO, iv.toString('hex'), body.toString('hex') + ':' + tag.toString('hex'), new Date().toISOString())
  return true
}

/**
 * 本地比对。返回：
 *   true   密码对
 *   false  密码不对
 *   null   没记过（需要去问青果）
 *
 * 新旧两种记录都认。
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
    if (row.algo === ALGO) {
      const plain = decryptRow(row)
      if (plain === null) return false
      const a = Buffer.from(plain, 'utf8')
      const b = Buffer.from(String(password || ''), 'utf8')
      if (a.length !== b.length) return false
      return crypto.timingSafeEqual(a, b)
    }
    /* 老记录：scrypt 派生值 */
    const got = Buffer.from(hashOf(password, row.salt), 'hex')
    const want = Buffer.from(row.hash, 'hex')
    if (got.length !== want.length) return false
    return crypto.timingSafeEqual(got, want)
  } catch (e) {
    return null
  }
}

/** 解一行记录；失败返回 null（密钥换了、数据被改过、或者老格式） */
function decryptRow(row) {
  if (row.algo !== ALGO) return null
  try {
    const [bodyHex, tagHex] = String(row.hash).split(':')
    if (!bodyHex || !tagHex) return null
    const decipher = crypto.createDecipheriv(ALGO, encKey(), Buffer.from(row.salt, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(bodyHex, 'hex')), decipher.final()]).toString('utf8')
  } catch (e) {
    /* GCM 认证失败：密钥不对或密文被篡改 —— 当作"还原不了"，不要抛出 */
    return null
  }
}

/**
 * 还原出明文密码，给「登录管理」页展示用。
 *
 * 返回 { password, legacy }：
 *   password  明文；老记录或失败时为 ''
 *   legacy    true 表示这是上一版的 scrypt 记录，只能比对不能看
 * 调用方按 legacy 显示「旧记录（不可查看）」，不要显示成空密码。
 */
export function reveal(sid) {
  const id = String(sid || '').trim()
  if (!id) return { password: '', legacy: false }
  let row = null
  try {
    row = db().prepare('SELECT algo, salt, hash FROM student_credentials WHERE sid = ?').get(id)
  } catch (e) {
    return { password: '', legacy: false }
  }
  if (!row) return { password: '', legacy: false }
  if (row.algo !== ALGO) return { password: '', legacy: true }
  const pwd = decryptRow(row)
  return { password: pwd === null ? '' : pwd, legacy: pwd === null }
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

/**
 * 列出被记住的凭据（含明文），只给教师用。
 *
 * sids 为空 = 全部。传一批 sid 就只回这些人的（界面按班过滤时用）。
 */
export function listRemembered(sids) {
  let rows = []
  try {
    rows = db().prepare('SELECT sid, algo, updated_at FROM student_credentials ORDER BY updated_at DESC').all()
  } catch (e) {
    return []
  }
  const allow = Array.isArray(sids) && sids.length ? new Set(sids.map(String)) : null
  const out = []
  for (const r of rows) {
    if (allow && !allow.has(r.sid)) continue
    const { password, legacy } = reveal(r.sid)
    out.push({ sid: r.sid, password, legacy, updatedAt: r.updated_at || '' })
  }
  return out
}
