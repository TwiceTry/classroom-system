/*
 * routes/events.js —— 记分事件（append-only）
 *
 * 设计上只做三件事：追加、撤销（打标记）、恢复。
 * **不提供「改一条记录」的接口** —— 改分就是「撤销旧的 + 记一条新的」，
 * 这样任何一次分数变化都能追到人和时间，也不会出现「谁把分改了」的悬案。
 */
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import * as repo from '../lib/repo.js'

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

const view = (e) => ({
  id: e.id,
  classId: e.classId,
  sid: e.sid,
  item: e.item,
  delta: Number(e.delta || 0),
  kind: e.kind || '',
  grade: e.grade || '',
  late: !!e.late,
  raw: e.raw === null || e.raw === undefined ? undefined : Number(e.raw),
  dims: e.dims || undefined,
  weight: e.weight === null || e.weight === undefined ? 1 : Number(e.weight),
  slot: e.slot || '',
  reason: e.reason || '',
  operator: e.operator || '',
  createdAt: e.createdAt || '',
  voided: !!e.voided,
  voidedAt: e.voidedAt || '',
  voidedBy: e.voidedBy || '',
  evidence: e.evidence || undefined,
  schemeVersion: e.schemeVersion || '',
})

export default async function eventRoutes(app) {
  /** 记分记录（分页；可按学生/考核项/时间段过滤） */
  app.get('/api/classes/:id/events', { preHandler: requireAuth('teacher') }, async (req) => {
    const cls = repo.getClass(req.params.id)
    if (!cls) throw notFound('班级不存在')
    const { items, nextCursor } = repo.eventsOf(cls.id, {
      limit: req.query.limit,
      cursor: req.query.cursor,
      sid: req.query.sid,
      item: req.query.item,
      from: req.query.from,
      to: req.query.to,
    })
    return { items: items.map(view), nextCursor, limit: Number(req.query.limit) || 200 }
  })

  /**
   * 记一笔分。
   *
   * 三种形态（对应方案里的不同考核项）：
   *   · 加减分：delta（+2 / -1）
   *   · 等级制：grade（A/B/C…，分值由方案折算）
   *   · 卷面分：raw（机试/笔试原始分）
   *   · 量规：dims（{ code: 9, ui: 6, ... }）
   */
  app.post('/api/classes/:id/events', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['sid', 'item'],
        properties: {
          sid: { type: 'string', minLength: 1 },
          item: { type: 'string', minLength: 1 },
          delta: { type: 'number' },
          kind: { type: 'string', maxLength: 20 },
          grade: { type: 'string', maxLength: 8 },
          late: { type: 'boolean' },
          raw: { type: 'number' },
          dims: { type: 'object' },
          weight: { type: 'number' },
          slot: { type: 'string', maxLength: 20 },
          reason: { type: 'string', maxLength: 500 },
          operator: { type: 'string', maxLength: 40 },
          evidence: { type: 'array', maxItems: 6, items: { type: 'object' } },
          schemeVersion: { type: 'string' },
        },
      },
    },
    handler: async (req, reply) => {
      const cls = repo.getClass(req.params.id)
      if (!cls) throw notFound('班级不存在')
      const b = req.body
      const sid = String(b.sid)
      if (!repo.findStudent(cls.id, sid)) throw notFound('这个学生不在本班名册里')

      const hasValue =
        b.delta !== undefined ||
        b.grade !== undefined ||
        b.raw !== undefined ||
        (b.dims && Object.keys(b.dims).length > 0) ||
        String(b.kind || '').trim() !== ''
      if (!hasValue) throw badRequest('这次记分没有任何分值/等级/卷面分——如果只是出勤留痕，请带上 kind')

      const ev = repo.insertEvent({
        id: uid('e'),
        classId: cls.id,
        sid,
        item: String(b.item),
        delta: Number(b.delta || 0),
        kind: b.kind || '',
        grade: b.grade || '',
        late: !!b.late,
        raw: b.raw,
        dims: b.dims,
        weight: b.weight,
        slot: b.slot || '',
        reason: b.reason || '',
        operator: b.operator || req.user.name || '教师',
        createdAt: new Date().toISOString(),
        voided: false,
        evidence: b.evidence,
        schemeVersion: b.schemeVersion || '',
      })
      reply.status(201)
      return view(ev)
    },
  })

  /** 撤销（不删记录，只打标记） */
  app.post('/api/classes/:id/events/:eid/void', {
    preHandler: requireAuth('teacher'),
    schema: { body: { type: 'object', properties: { reason: { type: 'string', maxLength: 200 } } } },
    handler: async (req) => {
      const ev = repo.voidEvent(req.params.id, req.params.eid, req.user.name || '教师')
      if (!ev) throw notFound('这条记分不存在')
      return view(ev)
    },
  })

  /** 恢复（撤销错了再撤销回来） */
  app.post('/api/classes/:id/events/:eid/restore', { preHandler: requireAuth('teacher') }, async (req) => {
    const ev = repo.restoreEvent(req.params.id, req.params.eid)
    if (!ev) throw notFound('这条记分不存在')
    return view(ev)
  })
}
