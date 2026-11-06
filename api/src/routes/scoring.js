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
import { RULES } from '../lib/rules.js'

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

/**
 * 判分规则清单（方案编辑器用）。
 *
 * 前端是这样用它：
 *   规则下拉        ← rules[].type / rules[].name
 *   规则说明        ← rules[].desc
 *   **参数输入框**  ← 遍历 rules[].schema 渲染（起始分 / 缺勤扣分 / 单次上限 / 等级表 …）
 *
 * 这里原来只给了 { type, name, hint }，`schema` 是 undefined，
 * 于是编辑器「计分规则」下面**一个参数框都不渲染**：
 * 起始分、缺勤一次扣几分、单次上限、等级表、量规维度，老师全都改不了，
 * 只能看到下拉框和一条空说明。表现就是「基准扣分没有起始分设置项」。
 *
 * 真正的定义在 lib/rules.js 的 RULES 里（schema 是纯数据，可以安全序列化），
 * 这里把它合并进来，避免两处各写一份、又对不上。
 */
const RULE_LIST = [
  { type: 'base', name: '基准扣分', hint: '全勤满分，缺勤/迟到按次数扣' },
  { type: 'acc', name: '累计加减', hint: '每次加减分累加，封顶满分' },
  { type: 'avg', name: '等级均分', hint: '判 A/B/C/X，按系数折算后取平均' },
  { type: 'last', name: '取最后一次', hint: '多次提交取最后一次' },
  { type: 'raw', name: '卷面折算', hint: '录卷面分，乘系数' },
  { type: 'rubric', name: '量规评分', hint: '按维度逐项打分求和' },
].map((r) => {
  const def = RULES[r.type]
  return Object.assign({}, r, {
    desc: (def && def.desc) || r.hint,
    schema: (def && def.schema) || [],
  })
})

/** 采集形态清单 */
/**
 * 采集形态清单（考核项在哪儿录分）。
 *
 * 两个字段名都要给：
 *   · `form` — 语义名，方案文件里的字段就叫这个
 *   · `key`  — 前端下拉用的 v-model 值（历史上一直读 key）
 * 早先这里只有 `form`，前端 `:value="f.key"` 拿到的是 undefined ——
 * 下拉框里每个选项都没有值，选了等于没选，页面上就表现为「采集方式是空的、
 * 选了也留不住、还回不到未设置」。
 */
const FORM_LIST = [
  { form: 'attendance', name: '考勤', hint: '按日期+节次点名' },
  { form: 'manual', name: '课堂互动', hint: '点一下就加减分' },
  { form: 'graded', name: '作业', hint: '交上来再批阅' },
  { form: 'rubric', name: '大作业', hint: '按维度量规评分' },
  { form: 'paper', name: '机试', hint: '试卷/题库，自动判分' },
].map((f) => Object.assign({}, f, { key: f.form }))

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
    /** 只要导航用的那点东西（学生端每页首屏都会拉） */
    const brief = String(req.query.brief || '') === '1'

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

      /*
       * `?brief=1`：学生端／只需要导航的页面用。
       *
       * 完整版 8.3KB，其中 raw(3.4KB) + rules + forms + grades/dims/hint 全是
       * 「方案编辑器」和「打分控件」用的；学生端只拿 modules 渲染侧栏，
       * 却每页首屏都背上这 5KB 用不到的东西。brief 版只留导航需要的。
       */
      if (brief) {
        return {
          scheme: { id: s.id, name: s.name, version: s.version, totalFull: s.totalFull, passLine: s.passLine, cap: s.cap },
          // 前端有 `scheme.items.find(x => x.key === …)` 用来取模块标题，键不能少
          items: items.map((i) => ({
            key: i.key,
            name: i.name,
            short: i.short,
            full: i.full,
            extra: !!i.extra,
            form: i.form,
            module: !!i.module && !!i.module.enabled,
          })),
          modules,
          hidden,
        }
      }

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

      /*
       * rows[].item 原本是**完整的考核项**（含 rule.params / hint / presets / hintTemplate），
       * 每个学生都带一份 → 60 人 × 5 项 = 306KB，而整个响应才 323KB。
       * 而前端班表格只用 `x.item.key` 和 `x.score`（表头来自顶层 items）。
       * 这里按「表格需要的字段」瘦身，不动 computeClass 本身（分数榜、抽屉、导出还要完整对象）。
       */
      const slimItem = (i) => ({ key: i.key, name: i.name, short: i.short, full: i.full, extra: !!i.extra })
      const slimBoard = Object.assign({}, board, {
        list: (board.list || []).map((r) =>
          Object.assign({}, r, { rows: (r.rows || []).map((x) => ({ item: slimItem(x.item), score: x.score })) })
        ),
        itemAvg: (board.itemAvg || []).map((x) => ({ item: slimItem(x.item), avg: x.avg })),
      })

      return {
        class: { id: cls.id, name: cls.name, courseId: cls.courseId || '', createdAt: cls.createdAt || '' },
        students: roster,
        board: slimBoard,
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

      /*
       * 当前在记哪一项。
       *
       * 前端一直在传 ?itemKey=xxx，但这里原先没读 —— 页面上的「互动分 / 次数」
       * 两列于是永远指向写死的那个语义（甚至干脆没值）。
       * 现在按 itemKey 取，缺省仍是 interact。
       */
      const itemKey = String(req.query.itemKey || 'interact')
      const item = items.find((i) => i.key === itemKey) || items.find((i) => i.key === 'interact') || null

      // 每人在这一项上的「次数」：未撤销的记分条数（加分、扣分都算一次）
      const countMap = new Map()
      for (const e of events) {
        if (e.voided) continue
        if (String(e.item) !== itemKey) continue
        countMap.set(e.sid, (countMap.get(e.sid) || 0) + 1)
      }

      // 最近几条操作（页面上「刚给谁加了分」用）
      const recent = events
        .filter((e) => !e.voided)
        .slice(-50)
        .reverse()
        .map((e) => ({
          id: e.id,
          sid: e.sid,
          name: (roster.find((s) => s.sid === e.sid) || {}).name || '',
          item: e.item,
          delta: e.delta,
          at: e.at,
        }))

      // 点名抽取进度：前端「本轮已抽 N 人 · 还剩 M 人」从这里来。
      // 以前没有这个字段，页面一进来就显示 0，刷新后也恢复不了已抽数量。
      const rollSt = repo.rollState(cls.id)

      return {
        classId: cls.id,
        className: cls.name,
        roll: {
          pickedCount: (rollSt.picked || []).length,
          remaining: Math.max(0, roster.length - (rollSt.picked || []).length),
          round: rollSt.round,
        },
        itemKey: item ? item.key : itemKey,
        itemName: item ? item.name : '课堂互动',
        full: item ? item.full : 10,
        // 方案里可以自定义「加减分按钮」（发言 +1 / 上台 +2 …）。
        // 前端读 res.presets，这里以前没给 → 永远退回代码里写死的 FALLBACK_PRESETS，
        // 老师在方案里配的预设根本不生效。
        presets: Array.isArray(scheme.current().presets) ? scheme.current().presets : [],
        // 「互动」这类可以做加减分的项（form=manual / mode=acc|base 且不是考勤）
        items: items
          .filter((i) => i.form !== 'attendance')
          .map((i) => ({ key: i.key, name: i.name, short: i.short, full: i.full, extra: !!i.extra })),
        students: board.list.map((row) => {
          const rowOf = (row.rows || []).find((r) => r.item && r.item.key === itemKey)
          return {
            sid: row.student.sid,
            name: row.student.name || '',
            online: online.has(row.student.sid),
            total: row.total,
            // 这两列前端一直在渲染（{{ row.score }} / {{ row.count }}），这里以前没给
            score: rowOf ? rowOf.score : 0,
            count: countMap.get(row.student.sid) || 0,
            items: (row.rows || []).map((r) => ({ key: r.item.key, score: r.score })),
          }
        }),
        recent,
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
