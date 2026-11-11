/*
 * routes/classroom.js —— 课堂现场那几件事：点名 / 聚焦 / 考勤会话 / 名册导入
 *
 * 这些接口的共同点：**都是「此刻」的状态 + 要立刻推给全班**，
 * 所以状态存在 state 表（小、可丢）或内存，动作通过投屏通道广播出去。
 */
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import * as scheme from '../lib/scheme.js'
import { scoring, withCourseScheme } from '../lib/scheme.js'
import * as sheetLib from '../lib/sheet.js'
import { rowsToXlsx, stampedName } from '../lib/xlsx.js'
import { broadcast } from './cast.js'
import { standDown } from '../lib/focus.js'

/** standDown 的依赖（参数传，避免 focus.js 反向 import 成环） */
const FOCUS_DEPS = { repo, broadcast }

/** 上传类接口的体积上限（与《课程包格式规范》§8 一致：整包 500MB） */
const BIG_BODY = 512 * 1024 * 1024

/** 考勤会话（当前在点哪个班的哪一节，抽过谁）—— 存 state 表 */
const ATT_KEY = (classId) => 'attend:' + classId
/** 当前聚焦（全班屏幕上显示谁）—— 存 state 表 */
const SPOT_KEY = (classId) => 'spot:' + classId

/** 把「聚焦某人」推给全班（学生端会全屏显示这个人的名字/看他的屏幕） */
function announceSpotlight(classId, payload) {
  const spot = Object.assign({ kind: 'interact', at: Date.now() }, payload)
  /*
   * name 兜底：这一层是点名学生端弹窗的**唯一出口**，
   * 而学生端 Spotlight.vue 读的是 `msg.name || ''` —— 没这个字段，
   * 弹窗照样出现（高度也在），就是上面一片空白，看起来像坏了。
   *
   * 调用方（课堂互动抽人 / 考勤点名）以前都没传 name，
   * 与其每处都记得传，不如在这里按 sid 从名单补一次：
   * 名单本来就在内存里，一次 find 而已。以后加新调用也不会漏。
   */
  if (spot.sid && !spot.name) {
    try {
      const stu = repo.rosterOf(classId).find((s) => s.sid === spot.sid)
      if (stu && stu.name) spot.name = stu.name
    } catch (e) {
      /* 补不上就算了，别因为显示名字把点名流程搞挂 */
    }
  }
  /*
   * 立起点名之前，先把这个班的讲义跟随 / 代码同步停掉。
   * 学生端同一时刻只该看一块东西 —— 否则「跟着讲义」的提示条和点名大字会叠在一起，
   * 学生既不知道看哪儿，老师也以为点名把学生拽过来了、其实没有。
   */
  standDown(classId, 'spotlight', FOCUS_DEPS)
  repo.setState(SPOT_KEY(classId), spot)
  const delivered = broadcast(Object.assign({ t: 'spotlight' }, spot))
  return delivered
}

/** 名册解析：支持 [{sid,name}] 或一段「学号,姓名」文本 */
/**
 * 表头里的常见词。老师的表格第一行往往是「学号,姓名,备注」，
 * 直接当数据会把「学号」当成一个学生导进去 —— 名单里凭空多一个人。
 */
const HEADER_WORDS = new Set(['学号', '姓名', '备注', '序号', '名字', 'sid', 'name', 'no', 'id', '备注说明'])

/** 去掉 BOM 与零宽字符：本系统导出的 CSV 带 UTF-8 BOM（Excel 打开才不乱码） */
function cleanCell(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D]/g, '')
    .trim()
}

function looksLikeHeader(sid, name) {
  const a = cleanCell(sid).toLowerCase()
  return HEADER_WORDS.has(a)
}

function parseRoster(body) {
  const out = []
  if (Array.isArray(body.students)) {
    for (const s of body.students) {
      const sid = cleanCell(s && s.sid)
      const name = cleanCell(s && s.name)
      if (sid && !looksLikeHeader(sid, name)) out.push({ sid, name })
    }
    return out
  }
  const text = String(body.text || '')
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split(/[,\t;，、]/).map(cleanCell)
    const sid = parts[0]
    // 第二列之后可能有「备注」等空列，join 完要在末尾再 trim 一次
    const name = parts.length === 1 ? '' : parts.slice(1).join(' ').trim()
    if (looksLikeHeader(sid, name)) continue
    out.push({ sid, name })
  }
  return out
}

/**
 * 对比现有名册与要导入的名单，给出「会发生什么」
 *
 * 返回三组字段，**类型分开、各司其职**：
 *   counts  —— 数字。文案里的「新增 3 人」只能从这里取。
 *   details —— 对象数组（最多 12 条，带姓名）。展开「看是哪几个人」用这个。
 *   added / updated / removed —— 完整的 sid 数组，给需要精确比对的地方用。
 *
 * 原来只有 added / updated / removed 三个数组，而前端文案写成
 * `'新增 ' + r.added + ' 人'` —— 数组拼字符串会渲染成「新增 9000001,9000002 人」；
 * 又因为明细被 slice(0,12)，replace 模式下老师看到「移出 12 人」，
 * 而实际要删的可能是 61 个 —— 破坏性操作被严重低估。
 * 计数和明细混在一个字段里迟早出事，所以这里一次分开。
 */
function rosterPlan(current, incoming, mode) {
  const cur = new Map(current.map((s) => [s.sid, s]))
  const inc = new Map(incoming.map((s) => [s.sid, s]))
  const added = [...inc.keys()].filter((sid) => !cur.has(sid))
  const updated = [...inc.keys()].filter((sid) => cur.has(sid) && (cur.get(sid).name || '') !== (inc.get(sid).name || ''))
  const removed = mode === 'replace' ? [...cur.keys()].filter((sid) => !inc.has(sid)) : []
  const unchanged = inc.size - added.length - updated.length

  return {
    counts: {
      parsed: inc.size,
      added: added.length,
      updated: updated.length,
      removed: removed.length,
      unchanged,
    },
    details: {
      added: added.slice(0, 12).map((sid) => inc.get(sid)),
      // 改名要给「原名 → 新名」，只有新名字的话老师没法确认改对了没有
      updated: updated.slice(0, 12).map((sid) => ({
        sid,
        name: inc.get(sid).name || '',
        from: cur.get(sid).name || '',
        to: inc.get(sid).name || '',
      })),
      removed: removed.slice(0, 12).map((sid) => cur.get(sid)),
      /** 明细是否被截断（前端据此显示「等 N 人」） */
      truncated: added.length > 12 || updated.length > 12 || removed.length > 12,
    },
    added,
    updated,
    removed,
    unchanged,
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
      const pickedNow = chosen.length === 1 ? state.picked.length : st.picked.length + chosen.length
      return {
        drawn: chosen.map((s) => ({ sid: s.sid, name: s.name })),
        // 前端「本轮已抽 {pickedCount} 人」直接读这个字段；以前只给了 picked 数组，
        // 于是随机点名之后那一栏就变成空的（数字没了）。
        pickedCount: pickedNow,
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
      /* 推代码之前，先把这个班的点名 / 讲义跟随停掉：学生端只该跟着一块走 */
      standDown(cls.id, 'pgsync', FOCUS_DEPS)
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

  /* ---------------- 导出成绩 / 记分（xlsx） ----------------
   * 统一成 xlsx 而不是 CSV：
   *   · 学号是长数字，CSV 被 Excel 转成科学计数法；姓名里的中文还可能乱码
   *   · 老师拿到表多半要排序/求和/加列，xlsx 才顺手
   * 包格式里的 *.roster.csv 不受影响（那是课程包的一部分，改了旧包打不开）。
   */

  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

  app.get('/api/classes/:id/export', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const cls = repo.getClass(req.params.id)
    if (!cls) throw notFound('班级不存在')
    const course = cls.courseId ? repo.getCourse(cls.courseId) : null
    const kind = String(req.query.kind || 'totals') === 'events' ? 'events' : 'totals'
    const roster = repo.rosterOf(cls.id)
    const events = repo.eventsOf(cls.id, { limit: 1000 }).items

    let rows = []
    let name = ''

    if (kind === 'events') {
      rows.push(['时间', '学号', '姓名', '项目', '摘要', '原因', '操作人', '状态'])
      const nameOf = new Map(roster.map((s) => [s.sid, s.name]))
      for (const e of events.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
        rows.push([
          e.createdAt,
          e.sid,
          nameOf.get(e.sid) || '',
          e.item,
          [e.kind, e.grade, e.delta, e.reason].filter(Boolean).join(' '),
          e.reason || '',
          e.operator || '',
          e.voided ? '已撤销' : '有效',
        ])
      }
      name = stampedName((cls.name || '班级') + '-记分记录', 'xlsx')
    } else {
      const board = withCourseScheme(course, () => scoring.computeClass(roster, events))
      const items = withCourseScheme(course, () => scheme.items())
      rows.push(['学号', '姓名', ...items.map((i) => i.name), '总评'])
      for (const row of board.list) {
        const cellScore = (k) => (row.rows.find((x) => x.item.key === k) || {}).score || 0
        rows.push([row.student.sid, row.student.name || '', ...items.map((i) => cellScore(i.key)), row.total])
      }
      name = stampedName((cls.name || '班级') + '-总评', 'xlsx')
    }

    // 第 0 列（学号）按文本写；流水的时间列也按文本，别让 Excel 改格式
    const buf = await rowsToXlsx(rows, { sheetName: kind === 'events' ? '记分记录' : '总评', textCols: [0] })
    return reply
      .status(200)
      .headers({
        'Content-Type': XLSX_TYPE,
        'Content-Length': buf.length,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
      })
      .send(buf)
  })

  /** 当前名单导出（xlsx）：老师拿到就能改几个人再导回来 */
  app.get('/api/classes/:id/roster.xlsx', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const cls = repo.getClass(req.params.id)
    if (!cls) throw notFound('班级不存在')
    const roster = repo.rosterOf(cls.id)
    const rows = [['学号', '姓名', '备注']]
    for (const s of roster) rows.push([s.sid, s.name || '', ''])
    const buf = await rowsToXlsx(rows, { sheetName: '名单', textCols: [0] })
    const name = stampedName((cls.name || '班级') + '-名单', 'xlsx')
    return reply
      .status(200)
      .headers({
        'Content-Type': XLSX_TYPE,
        'Content-Length': buf.length,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
      })
      .send(buf)
  })

  /** 名单空模板（xlsx）：三列表头 + 两行示例，填完直接上传 */
  app.get('/api/classes/:id/roster/template.xlsx', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const rows = [
      ['学号', '姓名', '备注'],
      ['2025000001', '张三', '班长'],
      ['2025000002', '李四', ''],
    ]
    const buf = await rowsToXlsx(rows, { sheetName: '名单', textCols: [0] })
    const name = '名单模板.xlsx'
    return reply
      .status(200)
      .headers({
        'Content-Type': XLSX_TYPE,
        'Content-Length': buf.length,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
      })
      .send(buf)
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

      // 改动之前算账，返回给前端用来提示「新增 / 改名 / 移出 各几人」
      const plan = rosterPlan(repo.rosterOf(cls.id), incoming, mode)

      if (mode === 'replace') {
        const keep = new Set(incoming.map((s) => s.sid))
        for (const s of repo.rosterOf(cls.id)) if (!keep.has(s.sid)) repo.removeStudent(cls.id, s.sid)
      }
      const items = repo.addStudents(cls.id, incoming)
      return { ok: true, mode, total: items.length, students: items, ...plan }
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

      /*
       * plan 要在**改动之前**算，才能说清「这一下会新增几个 / 移出几个」。
       * 干跑和真导入都要，所以提前算一次。
       */
      const current = repo.rosterOf(cls.id)
      const plan = rosterPlan(current, parsed.students, mode)

      /*
       * 被跳过的行必须一起返回。
       * rowsToRoster 会把「学号与第 N 行重复」「姓名不像人名」记进 issues，
       * 但原先只有「一行都没成功」时才拿它拼错误信息；部分成功时直接丢掉 ——
       * 老师导入完发现少了一个人，完全不知道是被哪天跳过的。
       */
      const issues = parsed.issues || []

      if (!doApply) {
        return {
          ok: true,
          mode,
          preview: parsed.students.slice(0, 8),
          count: parsed.students.length,
          currentCount: current.length,
          issues,
          ...plan,
        }
      }

      if (mode === 'replace') {
        const keep = new Set(parsed.students.map((s) => s.sid))
        for (const s of current) if (!keep.has(s.sid)) repo.removeStudent(cls.id, s.sid)
      }
      const items = repo.addStudents(cls.id, parsed.students)
      reply.status(201)
      return { ok: true, mode, total: items.length, students: items, issues, ...plan }
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
