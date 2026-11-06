/*
 * routes/classroom.js —— 课堂现场那几件事：点名 / 聚焦 / 考勤会话 / 名册导入
 *
 * 这些接口的共同点：**都是「此刻」的状态 + 要立刻推给全班**，
 * 所以状态存在 state 表（小、可丢）或内存，动作通过投屏通道广播出去。
 */
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import { scoring, scheme, withCourseScheme } from '../lib/scheme.js'
import { sheet as sheetLib } from '../lib/legacy.js'
import { broadcast } from './cast.js'

/** 上传类接口的体积上限（与《课程包格式规范》§8 一致：整包 500MB） */
const BIG_BODY = 512 * 1024 * 1024

/** 考勤会话（当前在点哪个班的哪一节，抽过谁）—— 存 state 表 */
const ATT_KEY = (classId) => 'attend:' + classId
/** 当前聚焦（全班屏幕上显示谁）—— 存 state 表 */
const SPOT_KEY = (classId) => 'spot:' + classId

/** 把「聚焦某人」推给全班（学生端会全屏显示这个人的名字/看他的屏幕） */
function announceSpotlight(classId, payload) {
  const spot = Object.assign({ kind: 'interact', at: Date.now() }, payload)
  repo.setState(SPOT_KEY(classId), spot)
  const delivered = broadcast(Object.assign({ t: 'spotlight' }, spot))
  return delivered
}

/** 名册解析：支持 [{sid,name}] 或一段「学号,姓名」文本 */
function parseRoster(body) {
  const out = []
  if (Array.isArray(body.students)) {
    for (const s of body.students) {
      const sid = String((s && s.sid) || '').trim()
      if (sid) out.push({ sid, name: String((s && s.name) || '').trim() })
    }
    return out
  }
  const text = String(body.text || '')
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split(/[,\t;，、]/).map((x) => x.trim())
    if (parts.length === 1) out.push({ sid: parts[0], name: '' })
    else out.push({ sid: parts[0], name: parts.slice(1).join(' ') })
  }
  return out
}

/** 对比现有名册与要导入的名单，给出「会发生什么」 */
function rosterPlan(current, incoming, mode) {
  const cur = new Map(current.map((s) => [s.sid, s]))
  const inc = new Map(incoming.map((s) => [s.sid, s]))
  const added = [...inc.keys()].filter((sid) => !cur.has(sid))
  const updated = [...inc.keys()].filter((sid) => cur.has(sid) && (cur.get(sid).name || '') !== (inc.get(sid).name || ''))
  const removed = mode === 'replace' ? [...cur.keys()].filter((sid) => !inc.has(sid)) : []
  return {
    added,
    updated,
    removed,
    unchanged: inc.size - added.length - updated.length,
    plan: {
      total: inc.size,
      added: added.slice(0, 12).map((sid) => inc.get(sid)),
      updated: updated.slice(0, 12).map((sid) => inc.get(sid)),
      removed: removed.slice(0, 12).map((sid) => cur.get(sid)),
    },
  }
}

export default async function classroomRoutes(app) {
  /* ---------------- 边缘端密钥（代理配置要用） ---------------- */

  app.get('/api/teacher/edge-key', { preHandler: requireAuth('teacher') }, async () => {
    const { config } = await import('../config.js')
    return {
      key: config.edgeKey,
      endpoint: '/api/presence/snapshot',
      howto:
        '在教学机的 proxy.conf 里加一行 edge.key = ' +
        config.edgeKey +
        '（然后重启代理）。代理每次上报都会用它对请求签名。',
    }
  })

  /* ---------------- 点名 ---------------- */

  app.get('/api/classes/:id/rollcall', { preHandler: requireAuth('teacher') }, async (req) => {
    const cls = repo.getClass(req.params.id)
    if (!cls) throw notFound('班级不存在')
    const roster = repo.rosterOf(cls.id)
    const st = repo.rollState(cls.id)
    const picked = st.picked.map((sid) => roster.find((s) => s.sid === sid)).filter(Boolean).map((s) => ({ sid: s.sid, name: s.name }))
    return { roster, picked, remaining: roster.length - picked.length, round: st.round }
  })

  /** 抽人：count 个；exclude=true 时不重复抽已经抽过的 */
  app.post('/api/classes/:id/rollcall/draw', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          exclude: { type: 'boolean' },
          lock: { type: 'boolean' },
        },
      },
    },
    handler: async (req) => {
      const cls = repo.getClass(req.params.id)
      if (!cls) throw notFound('班级不存在')
      const roster = repo.rosterOf(cls.id)
      if (!roster.length) throw badRequest('这个班还没有名册')
      const st = repo.rollState(cls.id)
      const count = Math.max(1, Math.min(12, Number(req.body.count) || 1))
      const exclude = req.body.exclude !== false
      const pickedSet = new Set(st.picked)
      const pool = roster.filter((s) => (exclude ? !pickedSet.has(s.sid) : true))
      if (!pool.length) throw badRequest('所有人都抽过了，请先「重置抽取」')

      const n = Math.min(count, pool.length)
      const chosen = []
      for (let i = 0; i < n; i++) {
        const idx = Math.floor(Math.random() * pool.length)
        chosen.push(pool.splice(idx, 1)[0])
      }
      let state = repo.rollState(cls.id)
      for (const s of chosen) state = repo.pickRollcall(cls.id, s.sid)

      // 抽一个人时同步到学生端（多人批量抽不播，屏幕上也显示不过来）
      if (chosen.length === 1) {
        announceSpotlight(cls.id, {
          kind: 'interact',
          sid: chosen[0].sid,
          lock: req.body.lock !== false,
          label: '',
          seq: state.picked.length,
          total: roster.length,
        })
      }
      return {
        drawn: chosen.map((s) => ({ sid: s.sid, name: s.name })),
        picked: chosen.length === 1 ? state.picked : st.picked.concat(chosen.map((s) => s.sid)),
        remaining: roster.length - (chosen.length === 1 ? state.picked.length : st.picked.length + chosen.length),
        round: state.round,
      }
    },
  })

  /** 从「已抽过」里去掉某人（抽错了） */
  app.post('/api/classes/:id/rollcall/remove', {
    preHandler: requireAuth('teacher'),
    schema: { body: { type: 'object', required: ['sid'], properties: { sid: { type: 'string' } } } },
    handler: async (req) => {
      const cls = repo.getClass(req.params.id)
      if (!cls) throw notFound('班级不存在')
      repo.removeRollcall(cls.id, String(req.body.sid))
      const st = repo.rollState(cls.id)
      return { picked: st.picked, remaining: repo.rosterOf(cls.id).length - st.picked.length, round: st.round }
    },
  })

  /** 重置抽取（round +1，整轮重新开始） */
  app.post('/api/classes/:id/rollcall/reset', { preHandler: requireAuth('teacher') }, async (req) => {
    const cls = repo.getClass(req.params.id)
    if (!cls) throw notFound('班级不存在')
    const st = repo.resetRollcall(cls.id)
    return { picked: [], remaining: repo.rosterOf(cls.id).length, round: st.round }
  })

  /* ---------------- 聚焦（全班看某个人 / 某块屏幕） ---------------- */

  app.post('/api/classes/:id/spotlight', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          sid: { type: 'string' },
          lock: { type: 'boolean' },
          label: { type: 'string', maxLength: 40 },
          seq: { type: 'number' },
          total: { type: 'number' },
          clear: { type: 'boolean' },
        },
      },
    },
    handler: async (req) => {
      const cls = repo.getClass(req.params.id)
      if (!cls) throw notFound('班级不存在')
      if (req.body.clear) {
        repo.setState(SPOT_KEY(cls.id), null)
        broadcast({ t: 'spotlight', clear: true })
        return { ok: true, spotlight: null }
      }
      const delivered = announceSpotlight(cls.id, req.body)
      return { ok: true, delivered }
    },
  })

  app.get('/api/classes/:id/spotlight', { preHandler: requireAuth('teacher') }, async (req) => {
    const cls = repo.getClass(req.params.id)
    if (!cls) throw notFound('班级不存在')
    return { spotlight: repo.getState(SPOT_KEY(cls.id), null) }
  })

  /* ---------------- 考勤会话（当前在点哪天的哪一节） ---------------- */

  app.post('/api/classes/:id/attend-state', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: {
          clear: { type: 'boolean' },
          day: { type: 'string' },
          slot: { type: 'string' },
          drawn: { type: 'array', items: { type: 'string' } },
          order: { type: 'boolean' },
          scope: { type: 'string' },
        },
      },
    },
    handler: async (req) => {
      const cls = repo.getClass(req.params.id)
      if (!cls) throw notFound('班级不存在')
      if (req.body.clear) {
        repo.setState(ATT_KEY(cls.id), null)
        return { ok: true }
      }
      const state = {
        day: String(req.body.day || ''),
        slot: String(req.body.slot || ''),
        drawn: Array.isArray(req.body.drawn) ? req.body.drawn.map(String).slice(0, 500) : [],
        order: !!req.body.order,
        scope: String(req.body.scope || 'unmarked'),
        at: Date.now(),
      }
      repo.setState(ATT_KEY(cls.id), state)
      return { ok: true, attend: state }
    },
  })

  /* ---------------- 代码工作台同步（Playground） ---------------- */

  /**
   * 老师在「代码练习」页把一段代码推给全班，学生端工作台自动跟着切。
   * 只存一个「当前推的是哪段、谁推的」，存 state 表；广播让学生端立刻收到。
   */
  const PG_KEY = (cid) => 'pg:' + cid
  const livePg = (classId) => (classId ? repo.getState(PG_KEY(classId), null) : null)

  /**
   * 「老师把代码推给全班」的当前状态。
   *
   * 字段就是**推的那一刻屏幕上的样子**，不含任何前端状态：
   *   dir/file/page  老师在看哪一课、哪个文件、哪个预览页
   *   cursor         光标字符偏移（学生端跟着跳）
   *   content        当前文件全文
   *   seq            单调递增；学生端只接受比手上更大的（防网络乱序把旧代码盖回去）
   *   by/at          谁推的、什么时候
   *
   * 消息类型统一成 `pgsync`（以前广播的是 `pg`，前端根本不认，功能等于没接上）。
   */
  app.get('/api/pgsync', { preHandler: requireAuth() }, async (req) => {
    const t = req.user
    if (!t.classId) return { sync: null }
    return { sync: livePg(t.classId) }
  })

  app.get('/api/classes/:id/pg-sync', { preHandler: requireAuth('teacher') }, async (req) => {
    const cls = repo.getClass(req.params.id)
    if (!cls) throw notFound('班级不存在')
    return { sync: livePg(cls.id) }
  })

  /** 老师推：seq 由服务端分配（前端不用管） */
  app.post('/api/classes/:id/pg-sync', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: {
          dir: { type: 'string', maxLength: 300 },
          file: { type: 'string', maxLength: 300 },
          page: { type: 'string', maxLength: 300 },
          cursor: { type: 'number' },
          content: { type: 'string' },
        },
      },
    },
    handler: async (req) => {
      const cls = repo.getClass(req.params.id)
      if (!cls) throw notFound('班级不存在')
      const prev = livePg(cls.id)
      const sync = {
        seq: (prev && Number(prev.seq)) ? Number(prev.seq) + 1 : 1,
        dir: String(req.body.dir || ''),
        file: String(req.body.file || ''),
        page: String(req.body.page || ''),
        cursor: Number(req.body.cursor) || 0,
        content: String(req.body.content || ''),
        by: req.user.name || '教师',
        at: Date.now(),
      }
      repo.setState(PG_KEY(cls.id), sync)
      const delivered = broadcast({ t: 'pgsync', sync })
      return { sync, delivered }
    },
  })

  /** 老师停：学生端收到 sync:null 就把自己的代码还回去 */
  app.delete('/api/classes/:id/pg-sync', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const cls = repo.getClass(req.params.id)
    if (!cls) throw notFound('班级不存在')
    repo.setState(PG_KEY(cls.id), null)
    broadcast({ t: 'pgsync', sync: null })
    reply.status(204).send()
  })

  /* ---------------- 学生端菜单显示开关 ---------------- */

  /**
   * 存「隐藏了哪些模块」而不是「显示哪些」：
   * 这样方案里以后新加的模块默认就是显示的，不会出现「加了模块却没入口」。
   */
  const STUVIS_KEY = (cid) => 'stuvis:' + cid

  function stuVisOf(courseId) {
    const v = courseId ? repo.getState(STUVIS_KEY(courseId), null) : null
    const hidden = v && Array.isArray(v.hidden) ? v.hidden.map(String) : []
    return { hidden, at: Number((v && v.at) || 0) }
  }

  app.get('/api/courses/:id/stuvis', { preHandler: requireAuth('teacher') }, async (req) => {
    const course = repo.getCourse(req.params.id)
    if (!course) throw notFound('课程不存在')
    const modules = withCourseScheme(course, () => {
      return scheme
        .items()
        .filter((it) => it.module && it.module.enabled)
        // 考勤 / 互动只在教师端操作，不给学生入口
        .filter((it) => it.form !== 'attendance' && it.form !== 'manual')
        .map((it) => ({ itemKey: it.key, title: (it.module && it.module.title) || it.name, kind: it.form || 'graded' }))
    })
    return Object.assign({ courseId: course.id, modules }, stuVisOf(course.id))
  })

  app.post('/api/courses/:id/stuvis', {
    preHandler: requireAuth('teacher'),
    schema: { body: { type: 'object', properties: { hidden: { type: 'array', items: { type: 'string' } } } } },
    handler: async (req) => {
      const course = repo.getCourse(req.params.id)
      if (!course) throw notFound('课程不存在')
      const clean = [...new Set((Array.isArray(req.body.hidden) ? req.body.hidden : []).map((x) => String(x || '').trim()))].filter(
        Boolean
      )
      // 全可见 = 没有这条状态，别在 state 表里留空行
      repo.setState(STUVIS_KEY(course.id), clean.length ? { hidden: clean, at: Date.now() } : null)
      const delivered = broadcast({ t: 'stuvis', courseId: course.id, hidden: clean, at: Date.now() })
      return { ok: true, hidden: clean, delivered }
    },
  })

  /* ---------------- 导出成绩 / 记分 CSV ---------------- */

  app.get('/api/classes/:id/export', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const cls = repo.getClass(req.params.id)
    if (!cls) throw notFound('班级不存在')
    const course = cls.courseId ? repo.getCourse(cls.courseId) : null
    const kind = String(req.query.kind || 'totals') === 'events' ? 'events' : 'totals'
    const roster = repo.rosterOf(cls.id)
    const events = repo.eventsOf(cls.id, { limit: 1000 }).items

    const esc = (v) => {
      const s = String(v === undefined || v === null ? '' : v)
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const lines = []
    const stamp = new Date().toISOString().slice(0, 10)

    if (kind === 'events') {
      lines.push(['时间', '学号', '姓名', '项目', '摘要', '原因', '操作人', '状态'].map(esc).join(','))
      const nameOf = new Map(roster.map((s) => [s.sid, s.name]))
      for (const e of events.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
        lines.push(
          [
            e.createdAt,
            e.sid,
            nameOf.get(e.sid) || '',
            e.item,
            [e.kind, e.grade, e.delta, e.reason].filter(Boolean).join(' '),
            e.reason || '',
            e.operator || '',
            e.voided ? '已撤销' : '有效',
          ]
            .map(esc)
            .join(',')
        )
      }
    } else {
      const board = withCourseScheme(course, () => scoring.computeClass(roster, events))
      const items = withCourseScheme(course, () => scheme.items())
      lines.push(['学号', '姓名', ...items.map((i) => i.name), '总评'].map(esc).join(','))
      for (const row of board.list) {
        const cell = (k) => (row.rows.find((x) => x.item.key === k) || {}).score || 0
        lines.push([row.student.sid, row.student.name || '', ...items.map((i) => cell(i.key)), row.total].map(esc).join(','))
      }
    }

    const body = '\ufeff' + lines.join('\r\n') + '\r\n' // BOM：Excel 打开不乱码
    const name = (cls.name || 'class') + '-' + (kind === 'events' ? '记分记录' : '总评') + '-' + stamp + '.csv'
    return reply
      .status(200)
      .headers({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
      })
      .send(body)
  })

  /* ---------------- 名册导入 ---------------- */

  /** 预检：会发生什么（不写库） */
  app.post('/api/classes/:id/roster/inspect', {
    preHandler: requireAuth('teacher'),
    schema: { body: { type: 'object' } },
    handler: async (req) => {
      const cls = repo.getClass(req.params.id)
      if (!cls) throw notFound('班级不存在')
      const mode = String(req.body.mode || 'merge') === 'replace' ? 'replace' : 'merge'
      const incoming = parseRoster(req.body)
      if (!incoming.length) throw badRequest('没读到有效的学号')
      const current = repo.rosterOf(cls.id)
      const p = rosterPlan(current, incoming, mode)
      return {
        ok: true,
        classId: cls.id,
        className: cls.name,
        mode,
        preview: incoming.slice(0, 8),
        count: incoming.length,
        currentCount: current.length,
        ...p,
      }
    },
  })

  /** 应用：并入或替换 */
  app.post('/api/classes/:id/roster/apply', {
    preHandler: requireAuth('teacher'),
    schema: { body: { type: 'object' } },
    handler: async (req) => {
      const cls = repo.getClass(req.params.id)
      if (!cls) throw notFound('班级不存在')
      const mode = String(req.body.mode || 'merge') === 'replace' ? 'replace' : 'merge'
      const incoming = parseRoster(req.body)
      if (!incoming.length) throw badRequest('没读到有效的学号')

      if (mode === 'replace') {
        const keep = new Set(incoming.map((s) => s.sid))
        for (const s of repo.rosterOf(cls.id)) if (!keep.has(s.sid)) repo.removeStudent(cls.id, s.sid)
      }
      const items = repo.addStudents(cls.id, incoming)
      return { ok: true, mode, total: items.length, students: items }
    },
  })

  /**
   * 从 Excel / CSV 上传名单（.xlsx / .csv，body 是原始字节）。
   * 解析交给旧 lib/sheet.js（它认识「学号」「姓名」这类表头写法）。
   *   ?apply=1 才真写库，否则只返回解析结果（预检）
   */
  app.post('/api/classes/:id/roster/sheet', {
    bodyLimit: BIG_BODY,
    preHandler: requireAuth('teacher'),
    schema: { body: {} },
    handler: async (req, reply) => {
      const cls = repo.getClass(req.params.id)
      if (!cls) throw notFound('班级不存在')
      const doApply = String(req.query.apply || '') === '1'
      const mode = String(req.query.mode || 'merge') === 'replace' ? 'replace' : 'merge'
      const buf = req.rawBodyBuffer
      if (!buf || !buf.length) throw badRequest('没有收到表格文件')

      let parsed
      try {
        const read = await sheetLib.readUploaded(buf)
        parsed = sheetLib.rowsToRoster(read.rows)
      } catch (e) {
        throw badRequest('表格解析失败：' + e.message)
      }
      if (!parsed.students.length) {
        throw badRequest(
          parsed.issues && parsed.issues.length
            ? '表格里没有一行是完整的（学号 + 姓名）：' + parsed.issues.slice(0, 5).map((it) => '第 ' + it.line + ' 行 ' + it.msg).join('；')
            : '表格里没读到任何一行（检查是否选错工作表，或没有「学号」「姓名」两列）'
        )
      }

      if (!doApply) {
        const current = repo.rosterOf(cls.id)
        const plan = rosterPlan(current, parsed.students, mode)
        return { ok: true, mode, preview: parsed.students.slice(0, 8), count: parsed.students.length, currentCount: current.length, ...plan }
      }

      if (mode === 'replace') {
        const keep = new Set(parsed.students.map((s) => s.sid))
        for (const s of repo.rosterOf(cls.id)) if (!keep.has(s.sid)) repo.removeStudent(cls.id, s.sid)
      }
      const items = repo.addStudents(cls.id, parsed.students)
      reply.status(201)
      return { ok: true, mode, total: items.length, students: items }
    },
  })

  /** 直接设置名册（前端「保存名单」用） */
  app.post('/api/classes/:id/roster', {
    preHandler: requireAuth('teacher'),
    schema: { body: { type: 'object' } },
    handler: async (req) => {
      const cls = repo.getClass(req.params.id)
      if (!cls) throw notFound('班级不存在')
      const incoming = parseRoster(req.body)
      const keep = new Set(incoming.map((s) => s.sid))
      for (const s of repo.rosterOf(cls.id)) if (!keep.has(s.sid)) repo.removeStudent(cls.id, s.sid)
      const items = repo.addStudents(cls.id, incoming)
      return { ok: true, total: items.length, students: items }
    },
  })
}
