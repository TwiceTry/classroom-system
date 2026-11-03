'use strict'
/*
 * auth.js —— 令牌鉴权（HMAC 签名，零依赖）
 *
 * 为什么不用「内存表」了：现在服务部署在服务器上，升级/重启比在教师机上频繁得多，
 * 内存表一重启所有人被踢下线，课堂中途重启就得全场重登。
 * 改成签名令牌：令牌 = base64(载荷).HMAC(密钥)，服务端不存表也能验，重启后照样有效。
 *
 *   · 密钥：config.secret（TS_SECRET 环境变量 > data/config.json 的 secret > 首次启动生成并落盘）
 *   · 撤销：退出登录把令牌指纹记在内存黑名单里（重启清空，但载荷里有 exp，最多活 tokenHours 小时）
 *   · 教师口令仍在 data/config.json（TS_PASSWORD 可覆盖）
 *   · 学生免密：按「课程 + 学号 + 姓名」比对名单，令牌里锁死 sid / classId / courseId，
 *     服务端只认令牌里的身份，不接受前端传 sid。
 */
const crypto = require('crypto')
const config = require('../config')

const revoked = new Map() // 指纹 -> 到期时间（只是加速失败，不是安全边界）

const ttl = () => config.tokenHours * 3600 * 1000

function b64(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64')
}

function sign(payloadB64) {
  return b64(crypto.createHmac('sha256', String(config.secret || '')).update(payloadB64).digest())
}

function fingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32)
}

/** 发一个令牌：载荷里带 exp */
function issue(payload) {
  const body = Object.assign({}, payload, { exp: Date.now() + ttl() })
  const data = b64(JSON.stringify(body))
  return data + '.' + sign(data)
}

/** 验令牌：签名不对 / 过期 / 已撤销 → null */
function verify(token) {
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

function revoke(token) {
  const rec = verify(token)
  if (!rec) return
  const ttlLeft = Math.max(1000, config.tokenHours * 3600 * 1000)
  revoked.set(fingerprint(token), Date.now() + ttlLeft)
}

/** 定期清理黑名单 */
setInterval(() => {
  const now = Date.now()
  for (const [k, exp] of revoked) if (exp < now) revoked.delete(k)
}, 10 * 60 * 1000).unref()

function checkPassword(pwd) {
  const a = Buffer.from(String(pwd || ''))
  const b = Buffer.from(String(config.teacherPassword || ''))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** 从请求头取令牌记录 */
function fromRequest(req) {
  const h = req.headers['authorization'] || ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return verify(m ? m[1].trim() : '')
}

/** 退出登录：把当前令牌拉黑 */
function revokeFromRequest(req) {
  const h = req.headers['authorization'] || ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  if (m) revoke(m[1].trim())
}

module.exports = { issue, verify, revoke, revokeFromRequest, checkPassword, fromRequest }
