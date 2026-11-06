/*
 * lib/auth.js —— 令牌签发与校验（HMAC-SHA256，无状态）
 *
 * 与旧后端**格式完全一致**：base64url(载荷).HMAC
 * 所以升级时老师/学生手上的旧令牌照样能用，不用重登。
 *
 * 为什么不做成 JWT：少一个依赖，payload 只有 classId/sid/name/role/exp，
 * HMAC + exp 已经够用；JWT 的多出来的东西（alg 协商、jwk）反而是攻击面。
 */

import crypto from 'node:crypto'
import { config } from '../config.js'

const revoked = new Map() // 指纹 → 到期时间（只是加速失败，安全边界在签名本身）

const b64 = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const fromB64 = (s) => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64')
}

const sign = (payloadB64) => b64(crypto.createHmac('sha256', String(config.secret || '')).update(payloadB64).digest())

const fingerprint = (token) => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32)

/** 发一个令牌（载荷里带 exp） */
export function issue(payload) {
  const body = Object.assign({}, payload, { exp: Date.now() + config.tokenHours * 3600 * 1000 })
  const data = b64(JSON.stringify(body))
  return data + '.' + sign(data)
}

/** 验令牌：签名不对 / 过期 / 已撤销 → null */
export function verify(token) {
  const t = String(token || '')
  const dot = t.lastIndexOf('.')
  if (dot <= 0) return null
  const data = t.slice(0, dot)
  const mac = t.slice(dot + 1)
  const expect = sign(data)
  if (mac.length !== expect.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null
  let body
  try {
    body = JSON.parse(fromB64(data).toString('utf8'))
  } catch (e) {
    return null
  }
  if (!body || !body.exp || body.exp < Date.now()) return null
  if (revoked.has(fingerprint(t))) return null
  delete body.exp
  return body
}

/** 退出登录：把这个令牌拉黑（重启清空，但载荷里有 exp，最多活 tokenHours 小时） */
export function revoke(token) {
  const rec = verify(token)
  if (!rec) return
  revoked.set(fingerprint(token), Date.now() + config.tokenHours * 3600 * 1000)
}

/** 教师口令比对（定长比较，防时序侧信道） */
export function checkPassword(pwd) {
  const a = Buffer.from(String(pwd || ''))
  const b = Buffer.from(String(config.teacherPassword || ''))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** 从请求头取令牌记录（Bearer xxx） */
export function fromRequest(req) {
  const raw = String(req.headers.authorization || '')
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  if (!m) return null
  return verify(m[1].trim())
}

setInterval(() => {
  const now = Date.now()
  for (const [k, exp] of revoked) if (exp < now) revoked.delete(k)
}, 10 * 60 * 1000).unref()
