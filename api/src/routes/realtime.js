/*
 * routes/realtime.js —— 在场状态 / 边缘端上报 / 投屏状态
 *
 * 这一组接口是「此刻怎么样」，不进 SQLite。
 * 边缘端上报（/api/presence/snapshot）要签名 —— 它代表的是**一群人**的状态，
 * 不能谁都能报（否则一个空名单就能把全班踢下线）。
 */
import crypto from 'node:crypto'
import { config } from '../config.js'
import { requireAuth, requireAnyUser } from '../plugins/auth.js'
import { unauthorized, forbidden, badRequest, notFound } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import * as presence from '../lib/presence.js'
import { verify } from '../lib/auth.js'

/** 投屏状态由 routes/cast.js 维护（mode / 在看人数 / 帧数 / 上行带宽） */
import { castState } from './cast.js'

export default async function realtimeRoutes(app) {
  /** 心跳：学生端每 10 秒来一次（WS 被掐掉时靠它兜底） */
  app.post('/api/presence/ping', { preHandler: requireAuth('student') }, async (req) => {
    const t = req.user
    presence.touch(t.classId, t.sid, t.name)
    return { ok: true, online: presence.onlineSet(t.classId).size, cast: castState().mode }
  })

  /** 关页面 / 退出登录（前端用 keepalive 发，保证卸载后也能送到） */
  app.post('/api/presence/leave', { preHandler: requireAuth('student') }, async (req) => {
    const t = req.user
    presence.leave(t.classId, t.sid)
    return { ok: true }
  })

  /** 某班此刻的在场/在看名单 */
  app.get('/api/classes/:id/presence', { preHandler: requireAuth('teacher') }, async (req) => {
    const cls = repo.getClass(req.params.id)
    if (!cls) throw notFound('班级不存在')
    const roster = repo.rosterOf(cls.id)
    const online = presence.onlineSet(cls.id)
    const casting = presence.castingSet(cls.id)
    return {
      onlineCount: online.size,
      castingCount: casting.size,
      total: roster.length,
      online: roster.filter((s) => online.has(s.sid)),
      offline: roster.filter((s) => !online.has(s.sid)),
      casting: roster.filter((s) => casting.has(s.sid)),
      ttlSeconds: Math.round(presence.TTL / 1000),
    }
  })

  /**
   * 边缘端上报（教学机代理）。签名三件套：
   *   X-Edge-Source / X-Edge-Ts / X-Edge-Sign = HMAC(edgeKey, source + ts + body)
   */
  app.post('/api/presence/snapshot', async (req) => {
    const source = String(req.headers['x-edge-source'] || '').slice(0, 40)
    const tsText = String(req.headers['x-edge-ts'] || '')
    const sign = String(req.headers['x-edge-sign'] || '')
    // 验签必须用**原始字节**（解析后的对象再序列化会变），
    // 所以 app.js 里给 JSON 加了一个 parser，把原始 Buffer 挂在 req.rawBodyBuffer
    const rawBody = req.rawBodyBuffer || Buffer.from(JSON.stringify(req.body || {}), 'utf8')

    if (!source) throw unauthorized('缺少 X-Edge-Source')
    const ts = Number(tsText)
    if (!isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
      throw unauthorized('X-Edge-Ts 不对：教学机与服务器时间差超过 5 分钟，或请求已过期')
    }
    const mac = crypto.createHmac('sha256', config.edgeKey)
    mac.update(source + '\n' + tsText + '\n')
    mac.update(rawBody)
    const expect = Buffer.from(mac.digest('hex'), 'utf8')
    const got = Buffer.from(sign, 'utf8')
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) {
      throw unauthorized('边缘端签名不对：教学机 proxy.conf 里的 edge.key 要和服务端一致')
    }
    if (!presence.markNonce(source, ts)) throw unauthorized('这个上报已经用过了（防重放）')

    let body = {}
    try {
      body = JSON.parse(rawBody.toString('utf8') || '{}')
    } catch (e) {
      throw badRequest('body 不是合法 JSON')
    }
    const list = Array.isArray(body.students) ? body.students.slice(0, 500) : []
    const r = presence.applySnapshot(source, list, verify)
    return { ok: true, online: r.online, casting: r.casting }
  })

  /** 投屏状态（学生端靠它决定要不要弹「开始投屏」横幅）—— 登录即可看 */
  app.get('/api/cast/status', { preHandler: requireAnyUser() }, async () => castState())
}
