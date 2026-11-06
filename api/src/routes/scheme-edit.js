/*
 * routes/scheme-edit.js —— 考核方案的编辑与导入导出
 *
 * 复用的旧逻辑（读/写/校验/试算全在 lib/schemeio.js 与 lib/scheme.js）：
 *   · inspect  = 预检（会不会有冲突、能不能用）
 *   · preview  = 试算（改前/改后的分数对比，不落盘）
 *   · apply    = 真正保存（版本 +1、写变更日志）
 *
 * 一条规矩：**方案是「算分规则」的唯一来源**。这里的写操作都会让
 * 历史分数按新规则重算（不是存分），所以「改方案」必须能试算、能回滚版本。
 */
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import * as scheme from '../lib/scheme.js'
import { scoring, withCourseScheme } from '../lib/scheme.js'
import * as schemeio from '../lib/schemeio.js'

/** 当前课程（?courseId= 或第一门未归档的课） */
function courseOf(req) {
  const id = String(req.query.courseId || '')
  if (id) return repo.getCourse(id)
  return repo.listCourses().find((c) => !c.archived) || null
}

export default async function schemeEditRoutes(app) {
  /** 当前方案的原文（编辑器载入用） */
  app.get('/api/scheme/raw', { preHandler: requireAuth('teacher') }, async (req) => {
    const course = courseOf(req)
    return withCourseScheme(course, () => {
      const _w = schemeio.currentRaw(); const raw = _w && _w.raw
      const cur = scheme.current()
      return { courseId: course ? course.id : '', schemeId: cur.id, version: cur.version, raw }
    })
  })

  /** 保存方案（PATCH = 改当前方案） */
  app.patch('/api/scheme', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: {
          scheme: { type: 'object' },
          note: { type: 'string', maxLength: 200 },
        },
        additionalProperties: true,
      },
    },
    handler: async (req) => {
      const course = courseOf(req)
      /*
       * 用 schemeFromBody 而不是 `req.body.scheme || req.body`。
       *
       * 前端保存时提交的是 `{ raw: {...} }`（raw 是编辑器里方案原文的叫法），
       * 而这里原来只认 `scheme` 或裸对象 → 拿到的是外层壳 `{ raw }`，
       * 它既没有 id 也没有 items，于是保存必定失败：
       *   「缺少 id；items 不能为空」
       * 下面那个 schemeFromBody 早就把三种形状都处理了（scheme / raw / 裸对象），
       * 只是这个接口忘了用它 —— 导入、预检都正常，唯独「保存方案」永远失败。
       */
      const incoming = schemeFromBody(req.body)
      if (!incoming || typeof incoming !== 'object') throw badRequest('body 里没有方案对象')
      return withCourseScheme(course, () => {
        const out = scheme.save(incoming, req.user.name || '教师', String(req.body.note || ''))
        const changes = out.raw.changes || []
        return {
          ok: true,
          // 顶层带上版本号与这次的变更记录：前端保存后要就地更新页头的 v 号和变更日志。
          // 原先只放在 scheme 里，前端读 res.version / res.change 拿到 undefined，
          // 提示就变成「已保存 · vundefined」。
          version: out.raw.version,
          change: changes.length ? changes[changes.length - 1] : null,
          warnings: out.warnings || [],
          scheme: {
            id: out.raw.id,
            name: out.raw.name,
            version: out.raw.version,
            items: (out.raw.items || []).map((i) => ({ key: i.key, name: i.name, full: i.full })),
          },
        }
      })
    },
  })

  /**
   * 从请求体里取出「方案对象」。
   *
   * 三种形状都要认（都真实出现过）：
   *   · `{ scheme: {...} }`  —— 早期约定
   *   · `{ raw: {...} }`     —— 前端「导入方案」上传文件后包的一层（raw 是编辑器里方案原文的叫法）
   *   · 直接就是方案对象     —— 导出的 scheme.json 原样 POST
   *
   * 只认前两种之外的一种时，第三种会被当成「一个没有 items 的对象」→
   * 预检报告成「文件: (未命名) · 0 项，所有考核项都被删了」，老师一点确认方案就空了。
   */
  function schemeFromBody(body) {
    const b = body || {}
    if (b.scheme && typeof b.scheme === 'object') return b.scheme
    if (b.raw && typeof b.raw === 'object') return b.raw
    return b
  }

  /** 预检：这份方案能不能用（不改任何东西） */
  app.post('/api/scheme/inspect', {
    preHandler: requireAuth('teacher'),
    schema: { body: { type: 'object', properties: { scheme: { type: 'object' } }, additionalProperties: true } },
    handler: async (req) => {
      const course = courseOf(req)
      const incoming = schemeFromBody(req.body)
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw badRequest('body 里没有方案对象')
      return withCourseScheme(course, () => schemeio.inspect(incoming))
    },
  })

  /** 试算：把这份方案套到某个班，看分数会怎么变（不落盘） */
  app.post('/api/scheme/preview', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: { scheme: { type: 'object' }, classId: { type: 'string' } },
        additionalProperties: true,
      },
    },
    handler: async (req) => {
      const cls = req.body.classId ? repo.getClass(String(req.body.classId)) : repo.listClasses()[0]
      if (!cls) throw notFound('班级不存在')
      const course = cls.courseId ? repo.getCourse(cls.courseId) : null
      const incoming = req.body.scheme || req.body
      const roster = repo.rosterOf(cls.id)
      const events = repo.eventsOf(cls.id, { limit: 1000 }).items

      return withCourseScheme(course, () => {
        const check = incoming && typeof incoming === 'object' ? schemeio.inspect(incoming) : null
        const before = scoring.computeClass(roster, events)
        // 用一个独立的方案对象试算（不切换全局方案）
        let after = null
        if (check && check.normalized) {
          const n = check.normalized
          const rows = roster.map((s) => {
            const mine = events.filter((e) => e.sid === s.sid)
            const r = scoring.computeStudentWith(n.items || [], n.cap || 100, mine, s.sid)
            return { sid: s.sid, name: s.name, total: r.total }
          })
          const avg = rows.length ? Math.round((rows.reduce((a, b) => a + b.total, 0) / rows.length) * 10) / 10 : 0
          after = { totalAvg: avg, students: rows }
        }
        return {
          classId: cls.id,
          className: cls.name,
          before: {
            totalAvg: before.totalAvg,
            passRate: before.passRate,
            students: before.list.map((r) => ({ sid: r.student.sid, name: r.student.name, total: r.total })),
          },
          after,
          diff: check && check.diff ? check.diff : null,
          warnings: (check && check.warnings) || [],
        }
      })
    },
  })

  /** 应用方案（导入一份别处带来的方案） */
  app.post('/api/scheme/apply', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: { scheme: { type: 'object' }, force: { type: 'boolean' }, note: { type: 'string' } },
        additionalProperties: true,
      },
    },
    handler: async (req) => {
      const course = courseOf(req)
      const incoming = schemeFromBody(req.body)
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw badRequest('body 里没有方案对象')
      return withCourseScheme(course, () =>
        schemeio.apply(incoming, { force: !!req.body.force, by: req.user.name || '教师', note: req.body.note || '' })
      )
    },
  })

  /** 导出一份方案 JSON（老师之间传方案） */
  app.get('/api/scheme/export.json', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const course = courseOf(req)
    const out = withCourseScheme(course, () => { const w = schemeio.currentRaw(); return { raw: w && w.raw, cur: scheme.current() } })
    if (!out.raw) throw notFound('当前没有方案文件')
    const name = 'scheme-' + (out.cur.id || 'default') + '-v' + (out.cur.version || 1) + '.json'
    return reply
      .status(200)
      .headers({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
      })
      .send(JSON.stringify(out.raw, null, 2))
  })

  /** 归档：把当前方案另存一份，再基于它继续改（留一个可回滚的点） */
  app.post('/api/scheme/archive', { preHandler: requireAuth('teacher') }, async (req) => {
    const course = courseOf(req)
    return withCourseScheme(course, () => {
      const _w = schemeio.currentRaw(); const raw = _w && _w.raw
      if (!raw) throw notFound('当前没有方案文件')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const archivedId = (raw.id || 'default') + '-archived-' + stamp
      const copy = Object.assign({}, raw, { id: archivedId, name: (raw.name || '方案') + '（归档 ' + stamp + '）' })
      scheme.saveAs(copy, archivedId, req.user.name || '教师', '归档当前版本')
      return { ok: true, archivedId, current: raw.id }
    })
  })
}
