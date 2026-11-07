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
  createdAt: a.createdAt || '',
  openedAt: a.openedAt || '',
  closedAt: a.closedAt || '',
  weight: a.weight === undefined || a.weight === null ? 1 : Number(a.weight),
  designId: a.designId || '',
  dueAt: a.dueAt || '',
  allowLate: !!a.allowLate,
})

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
          dir: { type: 'string' },
        },
      },
    },
    handler: async (req) => {
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      const next = Object.assign({}, a)
      for (const k of ['title', 'note', 'weight', 'dueAt', 'allowLate', 'dir']) {
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

    return {
      assignment: view(a),
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
        const visible = a.status === 'open' || !!mine
        if (!visible) return null
        return Object.assign(view(a), {
          mySubmission: mine
            ? {
                id: mine.id,
                createdAt: mine.createdAt,
                files: mine.files || [],
                score: mine.score === null || mine.score === undefined ? undefined : Number(mine.score),
                grade: mine.grade || '',
                comment: mine.comment || '',
                gradedAt: mine.gradedAt || '',
                late: !!mine.late,
              }
            : null,
        })
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
    if (a.status !== 'open' && !mine) throw forbidden('这次作业还没开放')
    return {
      assignment: view(a),
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
      if (a.status !== 'open') throw conflict('这次作业还没开放（或已经截止）')

      const cls = repo.getClass(t.classId)
      if (!cls) throw notFound('班级不存在')
      if (a.courseId && cls.courseId && a.courseId !== cls.courseId) throw forbidden('这次作业不属于你的课程')
      if (!repo.findStudent(cls.id, t.sid)) throw forbidden('你不在这个班的名册里')

      const entries = Array.isArray(req.body.files) ? req.body.files : []
      const existing = repo.findSubmission(a.id, t.sid)

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
      if (a.kind !== 'project' && !written.length) throw badRequest('没有要提交的文件')

      const late = !!(a.dueAt && Date.parse(a.dueAt) && Date.now() > Date.parse(a.dueAt))
      if (late && !a.allowLate) throw conflict('已经过了截止时间（' + a.dueAt + '），这次不收迟交')

      const payload = {
        classId: cls.id,
        sid: t.sid,
        name: t.name || '',
        dir: a.dir || '',
        files: written.map((w) => w.name),
        changed: Array.isArray(req.body.changed) ? req.body.changed.map(String).slice(0, MAX_TEXT_FILES) : [],
        note: String(req.body.note || '').slice(0, 1000),
        url: String(req.body.url || '').slice(0, 300),
        late,
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
