/*
 * routes/attendance.js —— 考勤（按「日期 + 节次」记账）
 *
 * 数据形态：考勤就是一条普通记分事件（item = 方案里 form=attendance 的项，
 * kind = 出勤/迟到/缺勤/请假/早退，slot = 1-2节…，delta = 该扣的分）。
 * 好处：和计分完全同一条链路，撤销/恢复、溯源、分表全都复用。
 *
 * 两条业务约定（沿用旧实现，别改）：
 *   · **出勤不记账**：出勤扣 0 分，写一行只是噪音 → 除非显式 includePresent
 *   · **重记覆盖**：同一天同一节次重记时，先把旧的撤掉（打 voided），不叠加
 */
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import {
  scoring,
  withCourseScheme,
  attendanceItem,
  attendanceDelta,
  attendanceKinds,
  SLOTS,
  slotOf,
  dayOf,
} from '../lib/scheme.js'

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

/** 班级 + 它所属的课程（方案挂在课程上） */
function classAndCourse(classId) {
  const cls = repo.getClass(classId)
  if (!cls) throw notFound('班级不存在')
  const course = cls.courseId ? repo.getCourse(cls.courseId) : null
  return { cls, course }
}

/** 这个班按天分组的考勤记录 */
function attendanceDays(classId, itemKey) {
  const evs = repo.eventsOf(classId, { limit: 1000 }).items.filter((e) => e.item === itemKey && !e.voided)
  const map = new Map()
  for (const e of evs) {
    const d = dayOf(e.createdAt)
    if (!map.has(d)) map.set(d, [])
    map.get(d).push(e)
  }
  return { days: Array.from(map.keys()).sort().reverse(), map }
}

/** 撤掉某个学生（或整班）在同一天同一节次的旧账 */
function voidSlot({ classId, itemKey, day, slot, sid, by }) {
  const list = repo.eventsOf(classId, { limit: 1000 }).items.filter((e) => {
    if (e.item !== itemKey || e.voided) return false
    if (dayOf(e.createdAt) !== day) return false
    if (sid && e.sid !== sid) return false
    if (slot && slotOf(e) !== slot) return false
    return true
  })
  for (const e of list) repo.voidEvent(classId, e.id, by)
  return list.length
}

export default async function attendanceRoutes(app) {
  /** 考勤视图：某天的名单 + 已标记 + 各节次统计 */
  app.get('/api/classes/:id/attendance', { preHandler: requireAuth('teacher') }, async (req) => {
    const { cls, course } = classAndCourse(req.params.id)
    return withCourseScheme(course, () => {
      const item = attendanceItem(req.query.itemKey)
      if (!item) throw badRequest('考核方案里没有考勤项（form = attendance）')

      const { days, map } = attendanceDays(cls.id, item.key)
      const day = String(req.query.date || '') || days[0] || ''
      const dayEvents = map.get(day) || []
      const slot = String(req.query.slot || '')
      const picked = slot ? dayEvents.filter((e) => slotOf(e) === slot) : dayEvents

      const roster = repo.rosterOf(cls.id)
      const board = scoring.computeClass(roster, repo.eventsOf(cls.id, { limit: 1000 }).items)

      return {
        itemKey: item.key,
        itemName: item.name,
        full: item.full,
        kinds: attendanceKinds(item),
        day,
        slot,
        slots: SLOTS,
        slotStats: SLOTS.map((s) => ({ slot: s, count: dayEvents.filter((e) => slotOf(e) === s).length })).filter(
          (x) => x.count > 0
        ),
        days: days.slice(0, 30),
        marks: picked.map((e) => ({ sid: e.sid, kind: e.kind, delta: e.delta, slot: slotOf(e), eventId: e.id })),
        students: roster,
        scores: board.list.map((r) => ({
          sid: r.student.sid,
          score: (r.rows.find((x) => x.item.key === item.key) || {}).score || 0,
          total: r.total,
        })),
      }
    })
  })

  /** 提交一屏考勤：{ date, slot, entries: [{sid, kind, note?}], replaceDay?, includePresent? } */
  app.post('/api/classes/:id/attendance', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['entries'],
        properties: {
          date: { type: 'string' },
          slot: { type: 'string', maxLength: 20 },
          replaceDay: { type: 'boolean' },
          includePresent: { type: 'boolean' },
          entries: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            items: {
              type: 'object',
              required: ['sid'],
              properties: { sid: { type: 'string' }, kind: { type: 'string' }, note: { type: 'string' } },
            },
          },
        },
      },
    },
    handler: async (req) => {
      const { cls, course } = classAndCourse(req.params.id)
      const who = req.user.name || '教师'
      return withCourseScheme(course, () => {
        const item = attendanceItem(req.query.itemKey)
        if (!item) throw badRequest('考核方案里没有考勤项（form = attendance）')

        const b = req.body
        const day = String(b.date || '').slice(0, 10) || dayOf(new Date().toISOString())
        const slot = String(b.slot || '').slice(0, 20)
        const roster = new Map(repo.rosterOf(cls.id).map((s) => [s.sid, s]))

        let voided = 0
        if (b.replaceDay) voided = voidSlot({ classId: cls.id, itemKey: item.key, day, slot, by: who })

        const nowIso = new Date().toISOString()
        let created = 0
        let present = 0
        let skipped = 0
        for (const raw of b.entries) {
          const sid = String(raw.sid || '').trim()
          const kind = String(raw.kind || '出勤').trim() || '出勤'
          if (!roster.has(sid)) {
            skipped++
            continue
          }
          if (kind === '出勤' && !b.includePresent) {
            present++ // 出勤不记账（扣 0 分，写了只是噪音）
            continue
          }
          repo.insertEvent({
            id: uid('e'),
            classId: cls.id,
            sid,
            item: item.key,
            kind,
            slot,
            delta: attendanceDelta(item, kind),
            reason: String(raw.note || '').slice(0, 200) || (slot ? day + ' ' + slot : day) + ' 考勤',
            operator: who,
            createdAt: day + nowIso.slice(10), // 用选的日期 + 当前时刻
            voided: false,
            evidence: [],
            schemeVersion: String(scoring.scheme.version()),
          })
          created++
        }
        return { ok: true, created, present, skipped, voided, day, slot }
      })
    },
  })

  /** 单条即时点：同一人同一天同一节次覆盖（点回「出勤」= 撤销） */
  app.post('/api/classes/:id/attendance/mark', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['sid'],
        properties: {
          sid: { type: 'string' },
          kind: { type: 'string' },
          date: { type: 'string' },
          slot: { type: 'string', maxLength: 20 },
        },
      },
    },
    handler: async (req) => {
      const { cls, course } = classAndCourse(req.params.id)
      const who = req.user.name || '教师'
      const b = req.body
      const sid = String(b.sid || '').trim()
      if (!repo.findStudent(cls.id, sid)) throw notFound('该学生不在本班名单里')

      return withCourseScheme(course, () => {
        const item = attendanceItem(req.query.itemKey)
        if (!item) throw badRequest('考核方案里没有考勤项（form = attendance）')

        const kind = String(b.kind || '出勤').trim() || '出勤'
        const day = String(b.date || '').slice(0, 10) || dayOf(new Date().toISOString())
        const slot = String(b.slot || '').slice(0, 20)
        const voided = voidSlot({ classId: cls.id, itemKey: item.key, day, slot, sid, by: who })

        let eventId = ''
        const dv = attendanceDelta(item, kind)
        if (kind !== '出勤') {
          const ev = repo.insertEvent({
            id: uid('e'),
            classId: cls.id,
            sid,
            item: item.key,
            kind,
            slot,
            delta: dv,
            reason: (slot ? day + ' ' + slot : day) + ' 考勤',
            operator: who,
            createdAt: day + new Date().toISOString().slice(10),
            voided: false,
            evidence: [],
            schemeVersion: String(scoring.scheme.version()),
          })
          eventId = ev.id
        }
        /*
         * 回一个这台学生**记完之后**的考勤分。
         *
         * 前端点一下格子就把这个值写进 scoreMap 就地刷新（`scoreMap[sid] = res.score`）。
         * 原来这里不返回 score，前端拿到 undefined → scoreOf() 兜底成 0，
         * 于是「点一下迟到」分数立刻从 5 变 0（其实应该还是 5，perLate=0 不扣分），
         * 非要刷新页面才恢复。老师会以为这一下把学生的考勤分扣光了。
         */
        const roster = repo.rosterOf(cls.id)
        const events = repo.eventsOf(cls.id, { limit: 1000 }).items
        const board = scoring.computeClass(roster, events)
        const row = board.list.find((r) => r.student.sid === sid)
        const rowOf = row && (row.rows || []).find((r) => r.item && r.item.key === item.key)

        return {
          ok: true,
          sid,
          kind,
          day,
          slot,
          voided,
          eventId,
          // 前端把 delta 写进本地 marks 清单（顶部「1-2节 · n」旁边的小字）
          delta: dv,
          score: rowOf ? rowOf.score : 0,
        }
      })
    },
  })
}
