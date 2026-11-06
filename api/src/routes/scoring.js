/*
 * routes/scoring.js —— 分数榜 / 互动视图
 *
 * 分数不是存出来的，是**算出来的**（方案 + 事件流 → 分数）。
 * 这样做的好处：改了方案的分值，历史分数立刻按新规则重算，不会出现
 * 「库里存着旧分、页面上新分」的两套账。
 */
import { requireAuth } from '../plugins/auth.js'
import { notFound } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import * as presence from '../lib/presence.js'
import * as scheme from '../lib/scheme.js'
import { scoring, withCourseScheme } from '../lib/scheme.js'
import * as schemeio from '../lib/schemeio.js'

/**
 * 当前方案的原文（编辑器要完整对象，不能是解析后的裁剪版）。
 * 注意 currentRaw() 返回的是 { id, version, raw } 包装，
 * 前端要的是**内层的方案对象**（raw.items / raw.totalFull）。
 */
function rawOfCurrent() {
  try {
    const w = schemeio.currentRaw()
    return (w && w.raw) || null
  } catch (e) {
    return null
  }
}

/** 判分规则清单（编辑器下拉用） */
const RULE_LIST = [
  { type: 'base', name: '基准扣分', hint: '全勤满分，缺勤/迟到按次数扣' },
  { type: 'acc', name: '累计加减', hint: '每次加减分累加，封顶满分' },
  { type: 'avg', name: '等级均分', hint: '判 A/B/C/X，按系数折算后取平均' },
  { type: 'last', name: '取最后一次', hint: '多次提交取最后一次' },
  { type: 'raw', name: '卷面折算', hint: '录卷面分，乘系数' },
  { type: 'rubric', name: '量规评分', hint: '按维度逐项打分求和' },
]

/** 采集形态清单 */
const FORM_LIST = [
  { form: 'attendance', name: '考勤', hint: '按日期+节次点名' },
  { form: 'manual', name: '课堂互动', hint: '点一下就加减分' },
  { form: 'graded', name: '作业', hint: '交上来再批阅' },
  { form: 'rubric', name: '大作业', hint: '按维度量规评分' },
  { form: 'paper', name: '机试', hint: '试卷/题库，自动判分' },
]

const view = (row) => ({
  sid: row.student.sid,
  name: row.student.name || '',
  total: row.total,
  base: row.base,
  extra: row.extra,
  capped: row.capped,
  items: row.rows.map((r) => ({ key: r.item.key, name: r.item.name, full: r.item.full, score: r.score })),
})

export default async function scoringRoutes(app) {
  /**
   * 当前方案 + 可用模块（前端导航、模块页、抽屉、「去模块评分」全读这一份）。
   *
   * 形状：`{ scheme:{...}, items:[...], modules:[...], hidden:[...] }`
   * —— **scheme 是嵌套的**，不是平铺；modules 决定「这个模块开没开、路由是什么」。
   * 少给一项，页面就会显示「这个模块没有启用」。
   */
  // 学生端也要读（侧栏菜单靠 modules 渲染），所以是「登录即可」而不是「仅教师」
  app.get('/api/scheme', { preHandler: requireAuth() }, async (req) => {
    const course = repo.getCourse(String(req.query.courseId || ''))
    const anyCourse = course || repo.listCourses().find((c) => !c.archived) || null

    // 「这节课开了哪些学生入口」：存隐藏列表
    const vis = anyCourse ? repo.getState('stuvis:' + anyCourse.id, null) : null
    const hidden = vis && Array.isArray(vis.hidden) ? vis.hidden.map(String) : []

    const submitOf = (i) => (i.module && i.module.submit) || 'code'
    const kindOfModule = (i) => {
      if (i.form === 'attendance') return 'attendance'
      if (i.form === 'manual') return 'manual'
      if (i.form === 'paper') return 'paper'
      if (submitOf(i) === 'files') return 'project'
      return 'work'
    }

    return withCourseScheme(anyCourse, () => {
      const s = scheme.current()
      const items = scheme.items()

      // 考勤只保留一个入口（一门课一个考勤页）
      let attendanceTaken = false
      const modules = items
        .filter((i) => i.module && i.module.enabled)
        .filter((i) => {
          if (i.form !== 'attendance') return true
          if (attendanceTaken) return false
          attendanceTaken = true
          return true
        })
        .map((i) => {
          const kind = kindOfModule(i)
          return {
            itemKey: i.key,
            title: (i.module && i.module.title) || i.name,
            form: i.form,
            submit: submitOf(i),
            kind,
            teacherRoute: '/teacher/modules/' + encodeURIComponent(i.key),
            // 考勤 / 课堂互动只有老师端
            studentRoute:
              kind === 'attendance' || kind === 'manual' ? '' : '/student/modules/' + encodeURIComponent(i.key),
            studentVisible: hidden.indexOf(i.key) < 0,
          }
        })

      return {
        scheme: { id: s.id, name: s.name, version: s.version, totalFull: s.totalFull, passLine: s.passLine, cap: s.cap },
        items: items.map((i) => {
          const p = (i.rule && i.rule.params) || {}
          return {
            key: i.key,
            name: i.name,
            short: i.short,
            full: i.full,
            extra: !!i.extra,
            form: i.form,
            module: !!i.module && !!i.module.enabled,
            // 保持对象形状（前端有地方读 item.rule.type）
            rule: i.rule || null,
            // 打分控件要用的：等级（avg）或量规维度（rubric）
            // 不摊平出来，GradeBox 就只渲染出一个空框，老师没法打分
            grades: Array.isArray(p.grades) ? p.grades : [],
            dims: Array.isArray(p.dims) ? p.dims : [],
            rawFull: p.rawFull === undefined ? null : Number(p.rawFull),
            hint: i.hint || '',
            reasonRequired: !!i.reasonRequired,
            reasonLabel: i.reasonLabel || '',
          }
        }),
        modules,
        hidden,
        // 方案编辑器要的是「原文 + 可选规则/形态清单」：
        // 少了 raw，编辑页会直接报「方案文件读不出来」
        raw: rawOfCurrent(),
        rules: RULE_LIST,
        forms: FORM_LIST,
        errors: [],
        warnings: [],
      }
    })
  })

  /**
   * 班级页的「一次拿全」：**班 + 名册 + 分数榜 + 记分流水**。
   *
   * 前端 `Classes.vue` 的结构是 `data.value = res`，然后用 `data.board.list` /
   * `data.students` / `data.events` —— 也就是说它期望这是**一个对象里带 board 字段**，
   * 不是扁平的列表。形状一变，整张表就会显示「还没有名单」。
   */
  app.get('/api/classes/:id/scores', { preHandler: requireAuth('teacher') }, async (req) => {
    const cls = repo.getClass(req.params.id)
    if (!cls) throw notFound('班级不存在')
    const course = cls.courseId ? repo.getCourse(cls.courseId) : null
    return withCourseScheme(course, () => {
      const roster = repo.rosterOf(cls.id)
      const events = repo.eventsOf(cls.id, { limit: 1000 }).items
      const board = scoring.computeClass(roster, events)
      const cur = scheme.current()
      return {
        class: { id: cls.id, name: cls.name, courseId: cls.courseId || '', createdAt: cls.createdAt || '' },
        students: roster,
        board,
        events,
        scheme: { id: cur.id, name: cur.name, version: cur.version, passLine: cur.passLine, totalFull: cur.totalFull, cap: cur.cap },
        items: scheme.items(),
      }
    })
  })

  /** 互动视图：学生名单 + 在线状态 + 互动项小计（课堂上「点谁加分」那个页面用） */
  app.get('/api/classes/:id/interact', { preHandler: requireAuth('teacher') }, async (req) => {
    const cls = repo.getClass(req.params.id)
    if (!cls) throw notFound('班级不存在')
    const course = cls.courseId ? repo.getCourse(cls.courseId) : null

    return withCourseScheme(course, () => {
      const roster = repo.rosterOf(cls.id)
      const events = repo.eventsOf(cls.id, { limit: 1000 }).items
      const board = scoring.computeClass(roster, events)
      const online = presence.onlineSet(cls.id)
      const items = scheme.items()

      return {
        classId: cls.id,
        className: cls.name,
        // 「互动」这类可以做加减分的项（form=manual / mode=acc|base 且不是考勤）
        items: items
          .filter((i) => i.form !== 'attendance')
          .map((i) => ({ key: i.key, name: i.name, short: i.short, full: i.full, extra: !!i.extra })),
        students: board.list.map((row) => ({
          sid: row.student.sid,
          name: row.student.name || '',
          online: online.has(row.student.sid),
          total: row.total,
          items: row.rows.map((r) => ({ key: r.item.key, score: r.score })),
        })),
      }
    })
  })

  /** 单个学生的明细（点名字看抽屉用） */
  app.get('/api/classes/:id/students/:sid/score', { preHandler: requireAuth('teacher') }, async (req) => {
    const cls = repo.getClass(req.params.id)
    if (!cls) throw notFound('班级不存在')
    const stu = repo.findStudent(cls.id, req.params.sid)
    if (!stu) throw notFound('这个学生不在班里')
    const course = cls.courseId ? repo.getCourse(cls.courseId) : null

    return withCourseScheme(course, () => {
      const events = repo
        .eventsOf(cls.id, { limit: 1000, sid: stu.sid })
        .items.filter((e) => !e.voided)
      const board = scoring.computeStudent(events, stu.sid)
      return {
        sid: stu.sid,
        name: stu.name,
        total: board.total,
        base: board.base,
        extra: board.extra,
        capped: board.capped,
        items: board.rows.map((r) => ({
          key: r.item.key,
          name: r.item.name,
          full: r.item.full,
          score: r.score,
          events: r.events.map((e) => ({
            id: e.id,
            kind: e.kind || '',
            delta: Number(e.delta || 0),
            reason: e.reason || '',
            operator: e.operator || '',
            createdAt: e.createdAt,
          })),
        })),
      }
    })
  })
}
