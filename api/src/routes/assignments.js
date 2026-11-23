/*
 * routes/assignments.js —— 作业 / 大作业（教师发布批阅 + 学生提交）
 *
 * 一条核心规则：**批阅即记分**。
 * 这类考核项在「记分管理」里没有手工入口，分数只能从批阅进来：
 *   rule=avg    → 判等级 A/B/C/X（可勾迟交）→ 折算
 *   rule=rubric → 按维度逐项打分 → 求和
 *   rule=raw    → 录卷面分 → ×系数（机试 / 笔试）
 * 改分/清分时**先撤上一条账**（eventId 记在提交上），再记新的 ——
 * 计分表始终「只追加 + 撤销」，不会两条同时生效。
 */
import fs from 'node:fs'
import path from 'node:path'
import { requireAuth } from '../plugins/auth.js'
import { ApiError, badRequest, notFound, conflict, forbidden } from '../lib/errors.js'
import { UPLOAD_DIR, config } from '../config.js'
import * as repo from '../lib/repo.js'
import * as store from '../lib/submitstore.js'
import * as starter from '../lib/starter.js'
import * as assignlib from '../lib/assignlib.js'
import * as scheme from '../lib/scheme.js'
import { withCourseScheme } from '../lib/scheme.js'
/*
 * 机试的「交没交卷」存在 state 文件里（submissions 表没这列），
 * 学生列表要显示「已交卷」就得读它。纯库，不会和 routes 形成循环依赖。
 */
import * as examLib from '../lib/exam.js'
/*
 * 状态判定只有一份，在 lib/phase.js —— 别在这个文件里再写一遍。
 * 学生视角（phaseOf）和教师视角（teacherPhaseOf）是两件事，详见那个文件的开头。
 */
import { gateOf, phaseMessage, teacherPhaseOf } from '../lib/phase.js'
import { broadcast } from './cast.js'
import {
  submissionView,
  gradeSubmission,
  kindOfItem,
  courseOfClass,
  courseOfAssignment,
} from '../lib/grading.js'
import * as content from '../lib/content.js'
import { contentRootOf } from './courses.js'

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
const MAX_TEXT_FILES = 40

/**
 * 取一份提交：路径里的 `:sid` 前端传的是**提交 id**（submissions[i].id），
 * 不是学号。这里两种都认（按 id 优先），避免前端换个参数就没法用。
 */
function findSubOf(a, key) {
  const row = repo.db().prepare(`SELECT * FROM submissions WHERE id = ?`).get(String(key))
  if (row && row.assignment_id === a.id) return repo.hydrate(row)
  return repo.findSubmission(a.id, key)
}

/**
 * 作业挂着的那一课示例的标题（老师端显示「对应示例：第 3 课 · …」）。
 * 挂不上（空白设计稿）就返回空串，前端会显示「作业自带代码」。
 */
function dirTitleOf(a) {
  if (!a.dir) return ''
  try {
    const course = a.courseId ? repo.getCourse(a.courseId) : repo.listCourses().find((c) => !c.archived)
    if (!course) return ''
    const hit = content.listExamples(contentRootOf(course)).find((x) => x.dir === a.dir)
    return hit ? hit.title || hit.dir : a.dir
  } catch (e) {
    return a.dir
  }
}

const view = (a) => ({
  id: a.id,
  /*
   * 这次作业的代码从哪来（工作台据此决定去哪读）：
   *   'example' —— 绑定了课程内容里的示例目录（dir 有值）
   *   'starter' —— 老师给的起手代码，全班共用 data/assignments/<作业id>/code/
   *
   * hasStarter 是**真去磁盘看的**。原来的 selfCode = !a.dir 只是推断：
   * 直接新建作业时磁盘上根本没有起手代码，却报「有」，
   * 前端于是既不去读它、也没法判断该显示什么。
   */
  codeSource: a.dir ? 'example' : 'starter',
  hasStarter: a.dir ? false : starter.hasStarter(a.id),
  dirTitle: dirTitleOf(a),
  kind: a.kind || 'work',
  itemKey: a.itemKey || '',
  courseId: a.courseId || '',
  title: a.title || '',
  dir: a.dir || '',
  note: a.note || '',
  status: a.status || 'closed',
  /*
   * started = 「老师点过开始」。
   *
   * 必须给：状态只有 open / closed 两个值，而 closed 同时表示两种完全不同的处境 ——
   *   没开始过（openedAt 空）  学生该看到「老师还没开始」
   *   已经结束（openedAt 有值） 学生该看到「已结束，只能看不能交」
   * 前端两个页面（AssignmentWork 的锁定态、列表的 tagOf）都靠它区分，
   * 但后端从来没给过 —— 于是 a.started 永远是 undefined，
   * 已结束的作业在学生那里一律显示成「未开始」。
   */
  /*
   * 教师视角的阶段（整场）。
   * 学生视角的 phase 在 student 接口里覆盖 —— 两份不是一回事：
   * 老师问「这场什么阶段」，学生问「我能不能进」。
   */
  phase: teacherPhaseOf(a),
  started: !!a.openedAt,
  createdAt: a.createdAt || '',
  openedAt: a.openedAt || '',
  closedAt: a.closedAt || '',
  weight: a.weight === undefined || a.weight === null ? 1 : Number(a.weight),
  designId: a.designId || '',
  dueAt: a.dueAt || '',
  allowLate: !!a.allowLate,
  /*
   * 过没过截止时间 —— 和 status 是两件事。
   *
   * status 是「老师有没有点停止」，dueAt 是「时间到没到」。
   * 老师忘了点停止时 status 一直是 open，但时间早过了；
   * 前端两处都要靠这个字段（横幅那句「已截止」、提交按钮要不要禁用），
   * 但后端从来没给过 —— 于是 x.overDue 永远是 undefined。
   */
  overDue: !!(a.dueAt && Date.parse(a.dueAt) && Date.now() > Date.parse(a.dueAt)),

  /*
   * 实际还在收吗 —— **推导出来**，不是数据库里那个 status。
   *
   * status 只记「老师点过开始 / 停止」，它不会因为时间流逝自己变。
   * 于是作业到期之后：学生那边已经交不上了（提交接口在拦），
   * 但教师端三处标签还写着「进行中」、按钮还是「停止收作业」——
   * 界面上等于要求老师手动点一下，系统才承认这次作业结束了。
   *
   * 这里不搞定时任务改 status：那样要维护一个扫描进程，
   * 停机期间的到期不会触发，而且「老师手动停」和「时间到」会被写成一回事，
   * 事后分不清是谁结束了它。让 status 只保留老师的手动意图，
   * 实际状态每次读的时候现算 —— 和 started 是同一个思路。
   */
  collecting: !!(
    a.status === 'open' &&
    !(a.dueAt && Date.parse(a.dueAt) && Date.now() > Date.parse(a.dueAt) && !a.allowLate)
  ),
  /*
   * 大作业：要不要交附件、收哪些扩展名。
   * 前端 ProjectDetail 一直在读这两个字段（`a.requireFile === false ? '可选' : '必须交一个'`
   * 以及「收 .zip .pdf …」的提示），但后端从来没给过 —— 于是它永远走硬编码兜底，
   * 服务端也无从校验（交 .exe 也收）。
   */
  requireFile: a.requireFile !== false,
  attachments: Array.isArray(a.attachments) ? a.attachments : [],
})

/**
 * 这是不是一场机试。
 *
 * 别写成 `a.kind === 'exam'` —— 机试的 kind 是 **'paper'**
 * （见 submitstore 的 DIR_OF_KIND：work→作业、project→大作业、paper→机试）。
 * 写错的那一版永远返回 false，结果有两处静默失效：
 *   · subForStudent 不给机试补 startedAt / submittedAt →
 *     前端分不出「开考了没交」和「已交卷」
 *   · 单人放行不生效 → 整场结束后谁都进不来
 * 所以这里三个都认，将来改口径也不会再漏。
 */
function isExamAssignment(a) {
  return a.kind === 'paper' || a.kind === 'exam' || String(a.itemKey || '') === 'exam'
}

/**
 * 机试卡片上的「考试信息」：限时 / 满分 / 题量 / 是不是题库随机卷。
 *
 * 学生决定点不点「开考」之前，真正想知道的是这几件事。原来列表一个都不给，
 * 卡片上只能写一句死板的「还没开考」—— 那句话既不是状态，也算不上信息，
 * 而且老师没开、已结束、没交卷三种情况显示得一模一样。
 *
 * 读的是老师上传的试卷源文件（data/exams/<作业id>.json）。
 * 没装卷子 / 读坏了 → 返回 null，前端就不显示这一行，
 * 而不是显示「满分 0 分 · 0 题」。
 */
function paperInfoOf(a) {
  if (!isExamAssignment(a)) return null
  try {
    const raw = examLib.readJson(examLib.sourceFile(a.id), null)
    if (!raw) return null
    const exam = examLib.normalize(raw)
    let questions = 0
    for (const s of exam.sections) {
      const n = exam.kind === 'bank' || s.pick > 0
        ? Math.min(s.pick || s.questions.length, s.questions.length)
        : s.questions.length
      questions += n
    }
    return { kind: exam.kind, duration: exam.duration, fullScore: exam.fullScore, questions }
  } catch (e) {
    /* 卷子是老师手改的 JSON，读坏了不该让整个列表 500 */
    return null
  }
}

/**
 * 学生端看到的「我在哪一批」。
 *
 * 只给序号、开始时间和这一批自己的截止时刻 —— **不给 sids**：
 * 那是这一批的完整名单，学生没必要看到同批还有谁。
 */
function batchBrief(b) {
  const closed = b.status !== 'open'
  /*
   * 已经关掉的批次不算「时间到」——
   * 两句话对学生是不同的意思：「时间到了，你没能交」和「老师把这一批收了」。
   * 前者可能还想找老师补，后者已经过去了。
   */
  const over = !closed && repo.batchOverdue(b)
  const leftMs = b.dueAt ? Date.parse(b.dueAt) - Date.now() : 0
  return {
    id: b.id,
    seq: b.seq,
    openedAt: b.openedAt,
    dueAt: b.dueAt,
    overDue: over,
    closed,
    leftMin: b.dueAt && !over && !closed ? Math.max(1, Math.ceil(leftMs / 60000)) : 0,
  }
}

/**
 * 学生端看到的「我的提交」。
 *
 * 机试要多补两个字段：startedAt / submittedAt。
 *
 * 它们存在答卷 state 文件里，submissions 表没有这两列，而前端**必须**靠 submittedAt
 * 区分「开考了、还没交」和「已经交卷」—— 学生一开考就会建一条 submission，
 * 只看 submission 存不存在的话，开考那一刻列表上就显示成「已交卷」了
 * （考试中刷新一下列表，会看到自己"已交卷"，实际还在答）。
 *
 * 只对机试读文件：作业没有这个概念，不该陪着多开一次 IO。
 */
function subForStudent(a, mine) {
  const out = {
    id: mine.id,
    createdAt: mine.createdAt,
    files: mine.files || [],
    score: mine.score === null || mine.score === undefined ? undefined : Number(mine.score),
    grade: mine.grade || '',
    comment: mine.comment || '',
    gradedAt: mine.gradedAt || '',
    late: !!mine.late,
  }
  if (isExamAssignment(a)) {
    try {
      const st = examLib.readJson(
        path.join(examLib.examDir(mine.classId, mine.sid, a.id, mine.id), 'exam.json'),
        null
      )
      if (st) {
        out.startedAt = st.startedAt || ''
        out.submittedAt = st.submittedAt || ''
      }
    } catch (e) {
      /* 读不到就当没开考，不影响列表 */
    }
  }
  return out
}

/**
 * 提交记录的对外形状：统一用 lib/grading.js 里那一份（别在这里再写一个）。
 *
 * 但**证据**得在这里补：它存在计分 event 上（`events.evidence`），
 * submission 行本身只有一个 eventId。
 * 原先直接把 submissionView 当 subView 用，于是接口从来不带 evidence，
 * 前端 `viewing.evidence` 永远是 undefined —— 老师传完证据看不到、也删不掉。
 */
const subView = (s, className) => {
  const v = submissionView(s, className)
  if (!v) return v
  if (v.eventId && s.classId) {
    const ev = repo.findEvent(s.classId, v.eventId)
    v.evidence = (ev && ev.evidence) || []
  }
  return v
}

export default async function assignmentRoutes(app) {
  /* ============================ 教师侧 ============================ */

  /** 作业列表（可按课程/考核项过滤，带提交统计） */
  app.get('/api/assignments', { preHandler: requireAuth('teacher') }, async (req) => {
    const courseId = String(req.query.courseId || '')
    const itemKey = String(req.query.itemKey || '')
    const items = repo
      .listAssignments(courseId || undefined)
      .filter((a) => !courseId || a.courseId === courseId || !a.courseId)
      .filter((a) => !itemKey || a.itemKey === itemKey)
      .map((a) => {
        const subs = repo.submissionsOf(a.id)
        const sids = new Set(subs.map((s) => s.sid))
        return Object.assign(view(a), {
          submissionCount: subs.length,
          studentCount: sids.size,
          gradedCount: subs.filter((s) => typeof s.score === 'number').length,
          latestAt: subs.length ? subs[subs.length - 1].createdAt : '',
          /*
           * 有几批正在放人。整场 status 是 closed、却有批在跑时，
           * 教师端要显示「分批进行中」——否则老师刚点「开始这一批」，
           * 上面的标签还写着「未开始」，和下面批次列表里的「进行中」打脸。
           */
          openBatches: repo.batchesOf(a.id).filter((b) => b.status === 'open').length,
        })
      })
    // 前端列表页还要这两块：可选的示例目录、以及「按班筛选」用的班级清单
    const course = courseId ? repo.getCourse(courseId) : repo.listCourses().find((c) => !c.archived) || null
    const dirs = course && fs.existsSync(contentRootOf(course))
      ? content.listExamples(contentRootOf(course)).map((x) => ({
          dir: x.dir,
          title: x.title,
          no: x.no,
          fileCount: x.fileCount,
        }))
      : []

    const allClasses = repo.listClasses(course ? course.id : undefined).map((c) => ({
      id: c.id,
      courseId: c.courseId || '',
      name: c.name,
      count: repo.rosterOf(c.id).length,
      createdAt: c.createdAt || '',
    }))

    return { items, total: items.length, dirs, allClasses }
  })

  /** 建作业 */
  app.post('/api/assignments', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 60 },
          itemKey: { type: 'string' },
          dir: { type: 'string' },
          note: { type: 'string', maxLength: 500 },
          weight: { type: 'number' },
          designId: { type: 'string' },
          dueAt: { type: 'string' },
          allowLate: { type: 'boolean' },
      requireFile: { type: 'boolean' },
      attachments: { type: 'array', items: { type: 'string', maxLength: 16 }, maxItems: 30 },
          courseId: { type: 'string' },
        },
      },
    },
    handler: async (req, reply) => {
      const b = req.body
      const courseId = String(b.courseId || req.query.courseId || '')
      const course = courseId ? repo.getCourse(courseId) : repo.listCourses().find((c) => !c.archived) || null
      if (courseId && !course) throw notFound('课程不存在：' + courseId)

      return withCourseScheme(course, () => {
        const itemKey = String(b.itemKey || 'homework')
        const item = scheme.itemByKey(itemKey) || null
        if (!item) throw badRequest('考核方案里没有这一项：' + itemKey + '（先去方案里启用对应模块）')
        const kind = kindOfItem(item)
        const a = repo.insertAssignment({
          id: uid('a'),
          kind,
          itemKey: item.key,
          courseId: course ? course.id : '',
          title: String(b.title).trim(),
          dir: String(b.dir || ''),
          note: String(b.note || ''),
          status: 'closed',
          createdAt: new Date().toISOString(),
          weight: b.weight,
          designId: b.designId || '',
          dueAt: b.dueAt || '',
          allowLate: !!b.allowLate,
        requireFile: b.requireFile === false ? false : true,
        attachments: Array.isArray(b.attachments)
          ? b.attachments.map(String).slice(0, 30)
          : [],
        })
        /*
         * 课堂作业要有「起手代码」—— 全班共用的那份题目初始状态。
         *   从作业库建（designId）→ 用设计包里带的 code/
         *   直接新建              → 落一个空白 index.html 兜底
         * 以前这条路一行都没有，于是学生打开作业只能看到课程示例。
         */
        if (starter.hasStarterKind(kind)) {
          let files = null
          if (b.designId && course) {
            try {
              files = assignlib.designCode(course.id, String(b.designId))
            } catch (e) {
              files = null
            }
          }
          starter.ensureStarter(a.id, files)
        }

        reply.status(201)
        return { assignment: view(a) }
      })
    },
  })

  /** 改作业（标题/备注/权重/截止/迟交） */
  app.patch('/api/assignments/:id', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 60 },
          note: { type: 'string', maxLength: 500 },
          weight: { type: 'number' },
          dueAt: { type: 'string' },
          allowLate: { type: 'boolean' },
      requireFile: { type: 'boolean' },
      attachments: { type: 'array', items: { type: 'string', maxLength: 16 }, maxItems: 30 },
          dir: { type: 'string' },
        },
      },
    },
    handler: async (req) => {
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      const next = Object.assign({}, a)
      for (const k of ['title', 'note', 'weight', 'dueAt', 'allowLate', 'dir', 'requireFile', 'attachments']) {
        if (req.body[k] !== undefined) next[k] = req.body[k]
      }
      return { assignment: view(repo.updateAssignment(a.id, next)) }
    },
  })

  /** 开 / 关（关掉之后学生不能提交） */
  /** 开始收作业：开放 + 通知全班（学生端立刻能进来；delivered 是送达人数） */
  app.post('/api/assignments/:id/start', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    /*
     * 带 sids = 只开这一批；不带 = 老行为，整场开放给全班。
     *
     * 两种模式并存是有意的：
     *   · 随堂作业，全班一起做  → 不选人，直接开始（和以前一样）
     *   · 机器不够 / 要盯纪律   → 分成几批，一批十几个人进来，
     *     做完一批再放下一批，直到所有人都做完
     *
     * 判定顺序（学生能不能交）：
     *   整场 status === 'open' → 全班都能交
     *   否则找「包含我、open、没过期」的那一批
     * 所以分批的时候整场保持 closed，只有批次在放人。
     */
    const sids = Array.isArray(req.body && req.body.sids)
      ? req.body.sids.map((x) => String(x || '').trim()).filter(Boolean)
      : []

    if (sids.length) {
      const seq = repo.nextBatchSeq(a.id)
      /*
       * 这一批自己的时限。
       *
       * minutes > 0  → 从现在起算，算成绝对的 dueAt 存下来
       * 不传 / 0     → 不限时（看整场的 dueAt）
       *
       * 为什么参数是分钟、存的是绝对时间：
       *   老师想的是「这批给 20 分钟」（他不知道确切几点收），
       *   而存储要的是「到哪个时刻为止」—— 后者不会因为机器时间漂移而改变口径。
       */
      const minutes = Math.max(0, Math.floor(Number((req.body && req.body.minutes) || 0)))
      const batch = repo.insertBatch({
        id: uid('bt'),
        assignmentId: a.id,
        seq,
        sids,
        status: 'open',
        openedAt: new Date().toISOString(),
        dueAt: minutes > 0 ? new Date(Date.now() + minutes * 60000).toISOString() : '',
        note: String((req.body && req.body.note) || '').slice(0, 100),
      })
      /* 名单只发给被点到的那些人 —— 轮不到的学生不该收到「开始了」的提示 */
      const delivered = broadcast({
        t: 'assignment',
        action: 'open',
        id: a.id,
        title: a.title,
        itemKey: a.itemKey,
        batchId: batch.id,
        sids,
      })
      return {
        batch,
        delivered,
        assignment: view(a),
        message: '第 ' + seq + ' 批已开始（' + sids.length + ' 人）',
      }
    }

    const next = repo.updateAssignment(a.id, { status: 'open', openedAt: new Date().toISOString() })
    const delivered = broadcast({ t: 'assignment', action: 'open', id: a.id, title: a.title, itemKey: a.itemKey })
    return { assignment: view(next), delivered }
  })

  /** 结束：关闭 + 通知全班 */
  app.post('/api/assignments/:id/stop', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const next = repo.updateAssignment(a.id, { status: 'closed', closedAt: new Date().toISOString() })
    const delivered = broadcast({ t: 'assignment', action: 'close', id: a.id, title: a.title, itemKey: a.itemKey })
    return { assignment: view(next), delivered }
  })

  /**
   * 结束某一批（整场不动）。
   *
   * 老师收完第 1 批再放第 2 批，靠的就是这个 ——
   * 如果结束批次时顺手把整场也关了，第 2 批就开不出来。
   */
  app.post('/api/assignments/:id/batches/:batchId/stop', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const b = repo.findBatch(req.params.batchId)
    if (!b || b.assignmentId !== a.id) throw notFound('这一批不存在')
    if (b.status !== 'open') return { batch: b, delivered: 0, message: '这一批已经结束了' }

    const next = repo.updateBatch(b.id, { status: 'closed', closedAt: new Date().toISOString() })
    /* 只通知这一批的人：别人的页面不该因为「第 1 批收了」跳提示 */
    const delivered = broadcast({
      t: 'assignment',
      action: 'batch-close',
      id: a.id,
      title: a.title,
      itemKey: a.itemKey,
      batchId: b.id,
      sids: b.sids,
    })
    return { batch: next, delivered, message: '第 ' + b.seq + ' 批已结束' }
  })

  /**
   * 结束**所有**还没结束的批次。
   *
   * 这是原来「■ 结束作业」的替代：既然入口只剩批次，
   * 「整场收工」就该是「把所有批次一起关掉」，而不是另设一个整场开关。
   * 分批放人的时候用不上它；一节临下课、或者发现有人还在拖，一按全收。
   */
  app.post('/api/assignments/:id/batches/stop-all', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const open = repo.batchesOf(a.id).filter((b) => b.status === 'open')
    if (!open.length) return { stopped: 0, message: '没有正在进行的批次' }

    const now = new Date().toISOString()
    for (const b of open) repo.updateBatch(b.id, { status: 'closed', closedAt: now })
    const delivered = broadcast({ t: 'assignment', action: 'close', id: a.id, title: a.title, itemKey: a.itemKey })
    return {
      stopped: open.length,
      delivered,
      message: '已结束 ' + open.length + ' 个批次',
    }
  })

  /** 删作业：连提交记录 + 磁盘文件 + 已记的分一起清 */
  app.delete('/api/assignments/:id', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')

    // 撤销由批阅记下的分（否则分数会悬空）
    const subs = repo.submissionsOf(a.id)
    for (const s of subs) {
      if (!s.eventId) continue
      const ev = repo.findEvent(s.classId, s.eventId)
      if (ev && !ev.voided) repo.voidEvent(s.classId, s.eventId, '删除作业')
    }

    const classes = repo.listClasses().map((c) => ({ id: c.id, students: repo.rosterOf(c.id) }))
    const folders = store.removeAssignmentEverywhere(a.kind, a.id, classes)

    // 起手代码（data/assignments/<作业id>/code/）也要清，否则会攒一堆没人认领的目录
    starter.removeStarter(a.id)

    // 机试还要清试卷源文件 + 纸质卷目录（不然 data/exams 里会一直堆）
    if (a.kind === 'paper') {
      try {
        const examLib = await import('../lib/exam.js')
        const src = examLib.sourceFile(a.id)
        if (src && fs.existsSync(src)) fs.unlinkSync(src)
        const dir = path.join(config.dataDir, 'exams', String(a.id).replace(/[^A-Za-z0-9_.-]/g, '_'))
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
      } catch (e) {
        /* 清不掉也不该让删除失败 */
      }
    }

    repo.deleteSubmissionsOf(a.id)
    /* 机试的补考放行记录也要清，否则留着指向一个不存在的作业 */
    repo.deletePassesOf(a.id)
    repo.deleteAssignment(a.id)
    reply.status(204).send()
    void folders
  })

  /** 某次作业：提交清单 + 未交名单（可按班过滤） */
  app.get('/api/assignments/:id', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const classId = String(req.query.classId || '')
    const all = repo.submissionsOf(a.id)
    const nameOfClass = new Map(repo.listClasses().map((c) => [c.id, c.name]))
    const scope = classId ? all.filter((s) => s.classId === classId) : all

    const classes = classId ? repo.listClasses().filter((c) => c.id === classId) : repo.listClasses()
    const submitted = new Set(scope.map((s) => s.sid))
    const missing = []
    let total = 0
    for (const c of classes) {
      for (const s of repo.rosterOf(c.id)) {
        total++
        if (!submitted.has(s.sid)) missing.push({ sid: s.sid, name: s.name, classId: c.id, className: c.name })
      }
    }

    /* 已交的人的 sid，用于给每一批算「这批交了几个」 */
    const submittedSids = new Set(scope.map((s) => s.sid))

    const batchesNow = repo.batchesOf(a.id)
    return {
      assignment: Object.assign(view(a), {
        /* 有批在放人时，整场虽然是 closed，教师端要显示「分批进行中」 */
        openBatches: batchesNow.filter((b) => b.status === 'open').length,
      }),
      /*
       * 分批列表。每批带上「这批有多少人、交了几个」——
       * 老师要判断的是「第 2 批能不能收了」，而不是去看名单。
       */
      batches: batchesNow.map((b) => {
        const over = repo.batchOverdue(b)
        const leftMs = b.dueAt ? Date.parse(b.dueAt) - Date.now() : 0
        return {
          id: b.id,
          seq: b.seq,
          status: b.status,
          openedAt: b.openedAt,
          closedAt: b.closedAt,
          dueAt: b.dueAt,
          note: b.note,
          count: b.sids.length,
          submitted: b.sids.filter((sid) => submittedSids.has(sid)).length,
          /* 这一批自己的计时：还剩多少 / 到没到 */
          overDue: over,
          leftMin: b.dueAt && !over ? Math.max(1, Math.ceil(leftMs / 60000)) : 0,
        }
      }),
      /*
       * 全班名单（带「交没交」）。分批放人要勾人，得先有名单 ——
       * 原来这页只有 missing（未交的），勾不出「已经交了的人」。
       * 用 roster 而不是让学生端接口去拼，是因为老师要按班看、要看到还没交的人。
       */
      roster: classes.flatMap((cl) =>
        repo.rosterOf(cl.id).map((s) => {
          /*
           * 他在第几批（没进过任何批 = 0）。
           *
           * 「每一批从上批剩下的人开始」靠这个字段：
           * 开完一批之后，老师下一个动作几乎总是「把还没排过的人放进来」，
           * 让他每次重新从 117 个名字里挑，等于白做。
           */
          const inB = batchesNow.filter((b) => b.sids.includes(String(s.sid)))
          const lastB = inB.length ? inB[inB.length - 1] : null
          return {
            sid: s.sid,
            name: s.name,
            classId: cl.id,
            className: cl.name,
            submitted: submittedSids.has(s.sid),
            batchSeq: lastB ? lastB.seq : 0,
            batched: !!lastB,
          }
        })
      ),
      submissions: scope.map((s) => subView(s, nameOfClass.get(s.classId))),
      stats: {
        classId,
        rosterCount: total,
        submittedStudents: submitted.size,
        submissionCount: scope.length,
        gradedCount: scope.filter((s) => typeof s.score === 'number').length,
        missing,
      },
    }
  })

  /**
   * 学生打开作业时，工作台要加载的代码（三层状态的唯一入口）
   *
   *   有「我的提交」 → 给提交（继续改交上去的那份）
   *   没有           → 给起手代码（第一次做作业）
   *   都没有         → 空，前端提示「老师没给起手代码」
   *
   * ?from=starter 强制取起手代码 —— 「恢复最初状态」用它。
   * 注意它**不会删提交**：分数和计分记录都挂在提交上，删了等于把分撤掉。
   */
  app.get('/api/assignments/:id/code', { preHandler: requireAuth() }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const t = req.user || {}
    const isStudent = t.role === 'student'

    if (isStudent) {
      const cls = repo.getClass(t.classId)
      if (!cls) throw notFound('班级不存在')
      if (cls.courseId && a.courseId && cls.courseId !== a.courseId) {
        throw forbidden('这次作业不属于你的课程')
      }
    }

    const sid = isStudent ? t.sid : String(req.query.sid || '')
    const from = String(req.query.from || '')

    if (from !== 'starter' && sid) {
      const mine = repo.findSubmission(a.id, sid)
      const files = mine ? store.readTextFiles(a.kind, mine.classId, mine.sid, a.id, mine.files || []) : []
      if (files && files.length) {
        return {
          dir: '@s:' + mine.id,
          source: 'submission',
          files,
          submittedAt: mine.createdAt || '',
          hasStarter: starter.hasStarter(a.id),
        }
      }
    }

    const st = starter.readStarter(a.id)
    return {
      dir: starter.dirToken(a.id),
      source: st ? 'starter' : 'empty',
      files: st ? st.files : [],
      submittedAt: '',
      hasStarter: !!st,
    }
  })

  /** 看某份提交的文件正文（课堂作业） */
  app.get('/api/assignments/:id/submissions/:sid', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const sub = findSubOf(a, req.params.sid)
    if (!sub) throw notFound('提交记录不存在')
    const files = a.kind === 'project' ? [] : store.readTextFiles(a.kind, sub.classId, sub.sid, a.id, sub.files)
    return { submission: subView(sub), files }
  })

  /** 批阅 */
  app.post('/api/assignments/:id/submissions/:sid/grade', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: {
          grade: { type: 'string', maxLength: 8 },
          late: { type: 'boolean' },
          // 前端「卷面分」输入框空着时会发 ''，只认 number 就会 400（rubric/等级作业根本不填这个）
          raw: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          dims: { anyOf: [{ type: 'object' }, { type: 'string' }] },
          comment: { type: 'string', maxLength: 1000 },
          weight: { type: 'number' },
        },
      },
    },
    handler: async (req) => {
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      const sub = findSubOf(a, req.params.sid)
      if (!sub) throw notFound('提交记录不存在')
      return { submission: gradeSubmission(a, sub, req.user.name || '教师', req.body) }
    },
  })

  /** 打回重做：分数与评语清空、计分作废，学生可以再交 */
  app.post('/api/assignments/:id/submissions/:sid/redo', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const sub = findSubOf(a, req.params.sid)
    if (!sub) throw notFound('提交记录不存在')
    const course = courseOfClass(sub.classId) || courseOfAssignment(a)
    const item = withCourseScheme(course, () => scheme.itemByKey(a.itemKey) || {})
    const mode = item && item.rule ? item.rule.type : 'avg'
    const clear = { comment: '（打回重做）' }
    if (mode === 'rubric') clear.dims = ''
    else if (mode === 'raw') clear.raw = ''
    else clear.grade = ''
    return { submission: gradeSubmission(a, sub, req.user.name || '教师', clear), message: '已打回：分数与评语清空，学生可以重新提交' }
  })

  /** 作业进度（教师端看「多少人交了/批了/没交」的细表） */
  app.get('/api/assignments/:id/progress', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const classId = String(req.query.classId || '')
    const subs = repo.submissionsOf(a.id)
    const bySid = new Map(subs.map((s) => [s.sid, s]))
    const classes = classId ? repo.listClasses().filter((c) => c.id === classId) : repo.listClasses()

    const rows = []
    for (const c of classes) {
      for (const s of repo.rosterOf(c.id)) {
        const sub = bySid.get(s.sid)
        rows.push({
          classId: c.id,
          className: c.name,
          sid: s.sid,
          name: s.name,
          submitted: !!sub,
          submittedAt: sub ? sub.createdAt : '',
          graded: !!(sub && typeof sub.score === 'number'),
          score: sub && typeof sub.score === 'number' ? sub.score : null,
          grade: (sub && sub.grade) || '',
          late: !!(sub && sub.late),
        })
      }
    }
    return {
      assignment: view(a),
      total: rows.length,
      submitted: rows.filter((r) => r.submitted).length,
      graded: rows.filter((r) => r.graded).length,
      rows,
    }
  })

  /** 删掉某份提交（老师清理误交） */
  app.delete('/api/assignments/:id/submissions/:sid', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const sub = findSubOf(a, req.params.sid)
    if (!sub) throw notFound('提交记录不存在')
    if (sub.eventId) {
      const ev = repo.findEvent(sub.classId, sub.eventId)
      if (ev && !ev.voided) repo.voidEvent(sub.classId, sub.eventId, '删除提交')
    }
    const dir = store.dirOf(a.kind, sub.classId, sub.sid, a.id)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      /* 忽略 */
    }
    repo.db().prepare(`DELETE FROM submissions WHERE id = ?`).run(sub.id)
    reply.status(204).send()
  })

  /**
   * 评分证据（老师侧的佐证材料）：挂在「这次评分对应的计分记录」上。
   * 所以必须先给分 —— 证据要跟着一条分走，否则无从追溯。
   */
  app.post('/api/assignments/:id/submissions/:sid/evidence', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['dataUrl'],
        properties: { dataUrl: { type: 'string' }, name: { type: 'string', maxLength: 100 } },
      },
    },
    handler: async (req) => {
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      const sub = findSubOf(a, req.params.sid)
      if (!sub) throw notFound('提交记录不存在')
      if (!sub.eventId) throw badRequest('先给分，再传证据（证据要挂在这次评分上）')
      const ev = repo.findEvent(sub.classId, sub.eventId)
      if (!ev) throw notFound('计分记录不存在（可能已被撤销，重新给一次分）')

      const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(String(req.body.dataUrl))
      if (!m) throw badRequest('文件格式不正确')
      const buf = Buffer.from(m[2], 'base64')
      if (buf.length > 6 * 1024 * 1024) throw new ApiError(413, 'too_large', '单个证据文件不能超过 6MB')

      const safe = String(req.body.name || 'evidence').replace(/[\\/:*?"<>|]/g, '_').slice(-80)
      const stored = Date.now().toString(36) + '-' + safe
      fs.mkdirSync(UPLOAD_DIR, { recursive: true })
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf)

      const list = (ev.evidence || []).concat([
        { name: safe, stored, size: buf.length, by: req.user.name || '教师', at: new Date().toISOString() },
      ])
      repo.db().prepare(`UPDATE events SET evidence = ? WHERE class_id = ? AND id = ?`).run(JSON.stringify(list), ev.classId, ev.id)
      return { submission: subView(repo.findSubmission(a.id, sub.sid)) }
    },
  })

  /** 删一条证据 */
  app.delete('/api/assignments/:id/submissions/:sid/evidence', {
    preHandler: requireAuth('teacher'),
    schema: { body: { type: 'object', properties: { stored: { type: 'string' } } } },
    handler: async (req) => {
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      const sub = findSubOf(a, req.params.sid)
      if (!sub || !sub.eventId) throw notFound('没有可删的证据')
      const ev = repo.findEvent(sub.classId, sub.eventId)
      if (!ev) throw notFound('计分记录不存在')
      const stored = String(req.body.stored || '')
      const list = (ev.evidence || []).filter((x) => x.stored !== stored)
      repo.db().prepare(`UPDATE events SET evidence = ? WHERE class_id = ? AND id = ?`).run(JSON.stringify(list), ev.classId, ev.id)
      try {
        if (stored) fs.unlinkSync(path.join(UPLOAD_DIR, stored))
      } catch (e) {
        /* 文件可能已被清理 */
      }
      return { submission: subView(repo.findSubmission(a.id, sub.sid)) }
    },
  })

  /* ============================ 学生侧 ============================ */

  /** 我能看到的作业（只列本班 + 已开放/我交过的） */
  app.get('/api/student/assignments', { preHandler: requireAuth('student') }, async (req) => {
    const t = req.user
    const cls = repo.getClass(t.classId)
    if (!cls) throw notFound('班级不存在')
    const course = cls.courseId ? repo.getCourse(cls.courseId) : null

    /*
     * 按考核项过滤。
     *
     * 学生端的「课堂作业 / 大作业 / 机试」是三个独立页面，各自请求
     * `?itemKey=homework|project|exam`，但这里原先**根本没读这个参数** ——
     * 于是三个页面拿到的都是同一份「本课程全部作业」，
     * 学生点「课堂作业」会看到大作业和机试混在一起。
     *
     * 不传 itemKey 时返回全部（保留原来的用法，命令行/调试仍可用）；
     * 传了就按考核项精确过滤。将来加新的考核项时，前端只要传自己的 itemKey，
     * 这里不用改。
     */
    const wantItem = String(req.query.itemKey || '').trim()

    const items = repo
      .listAssignments(course ? course.id : undefined)
      .filter((a) => !a.courseId || a.courseId === (course ? course.id : ''))
      .filter((a) => !wantItem || String(a.itemKey || '') === wantItem)
      .map((a) => {
        const mine = repo.findSubmission(a.id, t.sid)
        /*
         * 三态全部可见（原来只有 status==='open' 或自己交过才给）：
         *
         *   老师刚建好、还没点开始   → 学生完全看不到，课上宣布了也找不到入口
         *   老师停止后、没交过的人   → 作业从列表里消失，像被删了
         *
         * 「能不能交」由 status 决定（提交接口那条校验），不该拿它当可见性开关。
         * 学生需要看到的是「有这么一次作业、现在处在哪一步」。
         */
        const gate = gateOf(a, t.sid)
        const me = Object.assign(view(a), {
          mySubmission: mine ? subForStudent(a, mine) : null,
          /*
           * 我在哪一批。只给序号和状态，**不给 sids** ——
           * 那是这一批的完整名单，学生没必要看到同批还有谁。
           */
          myBatch: gate.batch ? batchBrief(gate.batch) : null,
        })
        /* 状态只有一个来源：phaseOf 算出的 phase，前端只做翻译 */
        me.phase = gate.via
        if (gate.ok) me.collecting = true
        /*
         * 有多少批正在放人。
         * 整场 status 是 closed、却有批在跑 —— 界面该显示「分批进行中」，
         * 否则老师点了「开始这一批」，标签还写着「未开始」，自相矛盾。
         */
        me.openBatches = repo.batchesOf(a.id).filter((b) => b.status === 'open').length
        /* 机试卡片上的考试信息（限时 / 满分 / 题量）；非机试为 null */
        me.paperInfo = paperInfoOf(a)
        /*
         * 机试「单人放行」：整场已经结束，但老师让这个人补考。
         *
         * 对他而言这场就是「还能开考」—— collecting 是给人看的状态，
         * 应该按「这个人能不能进」算，而不是按「全班还收不收」算。
         * 已经交过卷的不算（他补考完了，卡片该回到「已交卷」）。
         */
        if (isExamAssignment(a) && !(me.mySubmission && me.mySubmission.submittedAt)) {
          if (repo.findPass(a.id, t.classId, t.sid)) {
            me.collecting = true
            /* 放行也是「对这个人而言已开放」，phase 要跟着改，否则标签还说已结束 */
            me.phase = 'open'
          }
        }
        return me
      })
      .filter(Boolean)
    return { items, total: items.length, className: cls.name }
  })

  /** 学生看某次作业详情（题目说明 + 我的提交） */
  app.get('/api/student/assignments/:id', { preHandler: requireAuth('student') }, async (req) => {
    const t = req.user
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const cls = repo.getClass(t.classId)
    if (cls && a.courseId && cls.courseId && a.courseId !== cls.courseId) throw forbidden('这次作业不属于你的课程')
    const mine = repo.findSubmission(a.id, t.sid)
    /*
     * 不在这里拦「还没开放」—— 列表已经能看到了，点进来却被 403，
     * 学生只会以为是坏了。未开始 / 已结束该由页面用 started + status 说明清楚，
     * 而「不能交」由提交接口那条校验兜（那里才是真正要拦的地方）。
     */
    const gate = gateOf(a, t.sid)
    return {
      assignment: Object.assign(view(a), {
        /* 状态只有一个来源：phaseOf 算出的 phase，前端只做翻译 */
        collecting: gate.ok,
        phase: gate.via,
        myBatch: gate.batch ? batchBrief(gate.batch) : null,
        /*
         * 有几批在放人（且没过时间）。
         * 学生端靠它区分「老师还没开始」和「开始了但还没轮到我」——
         * 后者不该让他一直等，也不该让他以为老师忘了。
         */
        openBatches: repo.batchesOf(a.id).filter((b) => b.status === 'open' && !repo.batchOverdue(b)).length,
      }),
      mySubmission: mine ? subView(mine) : null,
      /*
       * 同时给一个数组形态。
       *
       * 学生端两个详情页（课堂作业、大作业）都是按「列表」写的：
       *   mine.length 显示「已交 N 次」、v-for 渲染每一条、mine[mine.length-1] 取最近一次。
       * 但接口只有 mySubmission（单个对象），于是 `res.mine || []` 永远是空数组 ——
       * 学生交完作业，页面上「我的提交」整块不显示，附件也下载不回来。
       *
       * 现在一次提交是覆盖（同一 assignment+sid 只有一行），所以数组最多一条；
       * 将来若改成保留历史，这个字段天然还是对的，前端不用动。
       */
      mine: mine ? [subView(mine)] : [],
      files: mine && a.kind !== 'project' ? store.readTextFiles(a.kind, mine.classId, mine.sid, a.id, mine.files) : [],
    }
  })

  /**
   * 学生提交。
   *   files: [{ path, text }]        课堂作业（交代码/文本，path 是工作台里的相对路径）
   *   files: [{ name, dataUrl }]     大作业（交附件）
   * changed: ['index.html', …]      这次改了哪几个（老师一眼看出改了什么）
   * 重复提交 = 覆盖（旧文件先清掉，免得多交的文件永远留着）
   */
  app.post('/api/student/assignments/:id/submit', {
    preHandler: requireAuth('student'),
    schema: {
      body: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            maxItems: MAX_TEXT_FILES,
            items: {
              type: 'object',
              // 代码工作台传的是 path，附件传的是 name —— 两个都认
              anyOf: [{ required: ['path'] }, { required: ['name'] }],
              properties: {
                path: { type: 'string' },
                name: { type: 'string' },
                text: { type: 'string' },
                dataUrl: { type: 'string' },
              },
            },
          },
          changed: { type: 'array', items: { type: 'string' } },
          note: { type: 'string', maxLength: 1000 },
          url: { type: 'string', maxLength: 300 },
        },
      },
    },
    handler: async (req, reply) => {
      const t = req.user
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      /* 整场开着，或者他被放进了某一批 —— 两者都不成立就是「还没轮到你」 */
      const gate = gateOf(a, t.sid)
      /* 文案由 phaseMessage 统一给 —— 别在这里再拼一遍 */
      if (!gate.ok) throw conflict(phaseMessage(gate.via, a))

      /*
       * 过了截止时间、并且不允许迟交 → 不再收。
       *
       * 只判 status 是不够的：**老师可能忘了点「停止」**，status 一直是 open，
       * 于是 allowLate = false 形同虚设 —— 过了截止时间学生照样能交，
       * 而且前端还看不出已经截止（后端连 overDue 都没给）。
       *
       * 这条必须放在接口层：界面上的按钮禁用只是提示，
       * 学生刷新页面、或者直接调接口都能绕过去。
       */
      const overdueAt = a.dueAt && Date.parse(a.dueAt) ? Date.parse(a.dueAt) : 0
      const isLate = !!overdueAt && Date.now() > overdueAt
      if (isLate && !a.allowLate) {
        const d = new Date(overdueAt)
        const p = (n) => String(n).padStart(2, '0')
        throw conflict(
          '这次作业 ' +
            d.getFullYear() +
            '-' +
            p(d.getMonth() + 1) +
            '-' +
            p(d.getDate()) +
            ' ' +
            p(d.getHours()) +
            ':' +
            p(d.getMinutes()) +
            ' 就截止了，不再接收。有特殊情况请找老师'
        )
      }

      const cls = repo.getClass(t.classId)
      if (!cls) throw notFound('班级不存在')
      if (a.courseId && cls.courseId && a.courseId !== cls.courseId) throw forbidden('这次作业不属于你的课程')
      if (!repo.findStudent(cls.id, t.sid)) throw forbidden('你不在这个班的名册里')

      const entries = Array.isArray(req.body.files) ? req.body.files : []
      const existing = repo.findSubmission(a.id, t.sid)

      /*
       * 校验必须放在**删旧文件之前**。
       *
       * 原来的顺序是：rmSync 清掉上次的目录 → writeFiles → 最后才判「没有要提交的文件」。
       * 于是学生提交一张空表（或前端漏传 files）时，上一次的提交已经被删干净了，
       * 然后收到 400「没有要提交的文件」—— 作业就这么丢了，找不回来。
       * 先把不该发生的情况挡掉，再动磁盘。
       */
      /*
       * 「至少要有点东西」：课堂作业/机试必须有文件；
       * 大作业可以是 附件 / 说明 / 链接 三选一，但**不能全空**。
       * 前端本来就有这句提示（ProjectDetail：「说明、链接、附件至少要有一项」），
       * 但只在浏览器里拦，绕过前端直接调接口就能把提交清成空。
       */
      if (a.kind === 'project') {
        const note = String(req.body.note || '').trim()
        const url = String(req.body.url || '').trim()
        if (!entries.length && !note && !url) {
          throw badRequest('这次大作业至少要交一项：附件、说明或链接')
        }
        // 作业规则要求「必须交附件」时，光有说明/链接不算
        if (!entries.length && a.requireFile !== false) {
          throw badRequest('这次大作业必须交附件（说明和链接不能代替）')
        }
        // 附件类型白名单（建单时从设计包继承）；没配就不限
        const allow = Array.isArray(a.attachments)
          ? a.attachments.map((x) => String(x).toLowerCase().replace(/^\./, ''))
          : []
        if (allow.length && entries.length) {
          for (const f of entries) {
            const nm = String(f.name || f.path || '')
            const ext = nm.indexOf('.') >= 0 ? nm.split('.').pop().toLowerCase() : ''
            if (!ext || !allow.includes(ext)) {
              throw badRequest('不收「' + nm + '」这类文件，可交：' + allow.map((x) => '.' + x).join(' '))
            }
          }
        }
      } else if (!entries.length) {
        throw badRequest('没有要提交的文件')
      }

      // 覆盖式：先清掉上次的目录
      if (existing) {
        const dir = store.dirOf(a.kind, cls.id, t.sid, a.id)
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch (e) {
          /* 忽略 */
        }
      }
      const written = entries.length ? store.writeFiles(a.kind, cls.id, t.sid, a.id, entries) : []

      /*
       * 这里原来还有一条「过了截止不收迟交」的判断 —— 已挪到函数开头（见 isLate）。
       *
       * 挪的原因是它站错了位置：**它在 writeFiles 之后**。
       * 而 writeFiles 会先清掉这个学生上一次的目录再写新的。
       * 于是学生迟交一次：上一次的提交被删了，然后收到「不收迟交」——
       * 作业没了，还以为是系统坏了。
       *
       * 现在 isLate 在最前面判，磁盘一个字节都不会动。
       */

      const payload = {
        classId: cls.id,
        sid: t.sid,
        name: t.name || '',
        dir: a.dir || '',
        files: written.map((w) => w.name),
        changed: Array.isArray(req.body.changed) ? req.body.changed.map(String).slice(0, MAX_TEXT_FILES) : [],
        note: String(req.body.note || '').slice(0, 1000),
        url: String(req.body.url || '').slice(0, 300),
        /* 用开头算好的那个（同一份判断，别在两处各算一次） */
        late: isLate,
      }

      let sub
      if (existing) {
        sub = repo.updateSubmission(existing.id, Object.assign({}, payload, { createdAt: new Date().toISOString() }))
        // 重新提交要清掉上一次的批阅（否则分数还在但内容换了）
        if (existing.eventId) {
          const ev = repo.findEvent(cls.id, existing.eventId)
          if (ev && !ev.voided) repo.voidEvent(cls.id, existing.eventId, '学生重新提交')
        }
        sub = repo.updateSubmission(sub.id, { score: null, grade: '', comment: '', eventId: '', gradedAt: '', gradedBy: '' })
      } else {
        sub = repo.insertSubmission(Object.assign({ id: uid('s'), assignmentId: a.id, createdAt: new Date().toISOString() }, payload))
      }
      reply.status(201)
      return { submission: subView(sub), files: written }
    },
  })

  /** 学生看自己那份提交的详情（含文件正文） */
  app.get('/api/student/assignments/:id/submissions/:sid', { preHandler: requireAuth('student') }, async (req) => {
    const t = req.user
    if (String(req.params.sid) !== t.sid) throw forbidden('只能看自己的')
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const mine = repo.findSubmission(a.id, t.sid)
    if (!mine) throw notFound('你还没有提交')
    return {
      submission: subView(mine),
      files: a.kind === 'project' ? [] : store.readTextFiles(a.kind, mine.classId, mine.sid, a.id, mine.files),
    }
  })

  /** 学生下载自己交的附件（大作业） */
  app.get('/api/student/assignments/:id/files/:name', { preHandler: requireAuth('student') }, async (req, reply) => {
    const t = req.user
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const full = store.filePathOf(a.kind, t.classId, t.sid, a.id, req.params.name)
    if (!full) throw notFound('文件不存在')
    const st = fs.statSync(full)
    return reply
      .status(200)
      .headers({
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(full)),
      })
      .send(fs.createReadStream(full))
  })
}
