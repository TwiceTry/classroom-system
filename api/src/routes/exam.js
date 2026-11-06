/*
 * routes/exam.js —— 机试（出卷 / 开考 / 答题 / 交卷 / 判卷）
 *
 * 数据模型：机试就是「kind=paper 的作业」+ 提交记录 + 每个学生一份答卷状态文件。
 *   · 试卷源：  data/exams/<作业id>/source.json      （导入的题库/试卷）
 *   · 纸质卷：  data/exams/<作业id>/试卷.md · 答案卷.md（老师打印）
 *   · 答卷：    data/students/<班>/<学号>/机试/<作业id>/<提交id>/exam.json
 *
 * 抽题用**种子**（作业id + 学号）：同一个学生每次进来拿到的都是同一份卷，
 * 刷新/换设备不会换题；不同学生抽到的题不同。
 */
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound, forbidden, conflict } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import { gradeSubmission, submissionView, courseOfAssignment } from '../lib/grading.js'
import { withCourseScheme, scheme } from '../lib/scheme.js'
import { examLib } from '../lib/legacy.js'

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

/** 试卷目录 */
function paperDirOf(assignmentId) {
  return path.join(config.dataDir, 'exams', String(assignmentId).replace(/[^A-Za-z0-9_.-]/g, '_'))
}

/** 这次作业必须是「试卷」形态的考核项 */
function examItemOf(a) {
  const item = withCourseScheme(courseOfAssignment(a), () => scheme.itemByKey(a.itemKey))
  if (!item || item.form !== 'paper') throw badRequest('这次作业的考核项不是「试卷」形态（方案里 form 要设成 paper）')
  return item
}

function loadExam(a) {
  const raw = examLib.readJson(examLib.sourceFile(a.id), null)
  if (!raw) throw notFound('还没有导入试卷 / 题库')
  return examLib.normalize(raw)
}

/** 学生答卷状态（存文件，不进 SQLite：题目结构大且只在机试期间用） */
function readState(a, sub) {
  const file = path.join(examLib.examDir(sub.classId, sub.sid, a.id, sub.id), 'exam.json')
  return examLib.readJson(file, null)
}

function writeState(a, sub, state) {
  const dir = examLib.examDir(sub.classId, sub.sid, a.id, sub.id)
  fs.mkdirSync(dir, { recursive: true })
  examLib.writeJson(path.join(dir, 'exam.json'), state)
  if (state.graded) {
    // 交卷/判卷后留一份人看得懂的答卷（md），老师可以直接看
    try {
      const cls = repo.getClass(sub.classId)
      const ctx = {
        course: (repo.getCourse(a.courseId) || {}).name || '',
        assignment: a,
        paper: state.paper,
        student: { sid: sub.sid, name: sub.name, className: cls ? cls.name : '' },
        state,
        graded: state.graded,
      }
      fs.writeFileSync(path.join(dir, '答卷.md'), examLib.renderReport(ctx), 'utf8')
    } catch (e) {
      /* 渲染失败不影响交卷 */
    }
  }
}

function remainingOf(state) {
  if (!state.paper || !state.paper.duration) return null
  const end = new Date(state.startedAt).getTime() + state.paper.duration * 60000
  return Math.max(0, Math.round((end - Date.now()) / 1000))
}

/** 幂等开考：已有答卷就返回它，没有才抽题新建 */
function ensureSubmission(a, t) {
  const mine = repo.submissionsOf(a.id).filter((s) => s.sid === t.sid && s.classId === t.classId)
  const last = mine[mine.length - 1]
  if (last) {
    const st = readState(a, last)
    if (st) return { sub: last, state: st }
  }
  const exam = loadExam(a)
  const { paper } = examLib.paperFor(exam, a.id + ':' + t.sid)
  const sub = repo.insertSubmission({
    id: uid('sb'),
    assignmentId: a.id,
    classId: t.classId,
    sid: t.sid,
    name: t.name,
    createdAt: new Date().toISOString(),
  })
  const state = { paper, answers: {}, startedAt: new Date().toISOString(), submittedAt: '', graded: null }
  writeState(a, sub, state)
  return { sub, state }
}

export default async function examRoutes(app) {
  /* ============================ 教师侧 ============================ */

  /** 导入试卷 / 题库（老师把 JSON 贴进来），顺带出「试卷 / 答案卷」各一份 */
  app.post('/api/exams/:id/paper', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: { source: { type: 'object' } },
        additionalProperties: true,
      },
    },
    handler: async (req) => {
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      examItemOf(a)
      const src = req.body.source || req.body
      const norm = examLib.normalize(src)
      const check = examLib.validate(norm)
      if (check.errors.length) throw badRequest(check.errors.join('；'))

      const dir = paperDirOf(a.id)
      fs.mkdirSync(dir, { recursive: true })
      examLib.writeJson(examLib.sourceFile(a.id), src)

      // 空白卷 + 答案卷（md / html 各一份，老师直接打印）
      const paper = examLib.printPaper(norm, a.id)
      const base = {
        course: (repo.getCourse(a.courseId) || {}).name || '',
        assignment: a,
        paper,
        student: null,
      }
      try {
        fs.writeFileSync(path.join(dir, '试卷.md'), examLib.renderPaperMd(Object.assign({}, base, { withAnswer: false })), 'utf8')
        fs.writeFileSync(path.join(dir, '答案卷.md'), examLib.renderPaperMd(Object.assign({}, base, { withAnswer: true })), 'utf8')
        fs.writeFileSync(path.join(dir, '试卷.html'), examLib.renderHtml(Object.assign({}, base, { withAnswer: false })), 'utf8')
        fs.writeFileSync(path.join(dir, '答案卷.html'), examLib.renderHtml(Object.assign({}, base, { withAnswer: true })), 'utf8')
      } catch (e) {
        /* 渲染失败不影响导入 */
      }

      return {
        ok: true,
        paperDir: dir,
        warnings: check.warnings,
        summary: {
          kind: norm.kind,
          title: norm.title,
          duration: norm.duration,
          fullScore: norm.fullScore,
          sections: norm.sections.map((s) => ({
            id: s.id,
            title: s.title,
            type: s.type,
            typeName: examLib.TYPE_NAME[s.type],
            score: s.score,
            pick: s.pick,
            count: s.questions.length,
          })),
        },
      }
    },
  })

  /** 这场机试的概况 + 每个学生的进度与得分 */
  app.get('/api/exams/:id', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    examItemOf(a)
    const raw = examLib.readJson(examLib.sourceFile(a.id), null)
    const subs = repo.submissionsOf(a.id)
    const names = new Map(repo.listClasses().map((c) => [c.id, c.name]))
    return {
      assignment: { id: a.id, title: a.title, status: a.status, itemKey: a.itemKey },
      imported: !!raw,
      paper: raw ? { title: (raw.title || ''), fullScore: raw.fullScore, duration: raw.duration } : null,
      rows: subs.map((s) => {
        const st = readState(a, s)
        return Object.assign(submissionView(s, names.get(s.classId)), {
          startedAt: st ? st.startedAt : '',
          submittedAt: st ? st.submittedAt || '' : '',
          answered: st && st.answers ? Object.keys(st.answers).length : 0,
          autoScore: st && st.graded ? st.graded.autoScore : null,
        })
      }),
    }
  })

  /** 下载纸质卷（?answer=1 取答案卷；fmt=md|html） */
  app.get('/api/exams/:id/paper-file', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const answer = String(req.query.answer || '') === '1'
    const fmt = String(req.query.fmt || 'md').toLowerCase() === 'html' ? 'html' : 'md'
    const file = path.join(paperDirOf(a.id), (answer ? '答案卷.' : '试卷.') + fmt)
    if (!fs.existsSync(file)) throw notFound('还没导入试卷')
    const st = fs.statSync(file)
    return reply
      .status(200)
      .headers({
        'Content-Type': fmt === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Content-Length': st.size,
        'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(path.basename(file)),
      })
      .send(fs.createReadStream(file))
  })

  /** 判卷（老师改机试分：录卷面分 → 按方案折算并记账） */
  app.post('/api/exams/:id/submissions/:subId/grade', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: {
          raw: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          comment: { type: 'string', maxLength: 1000 },
        },
      },
    },
    handler: async (req) => {
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      const sub = repo.findSubmission(a.id, req.params.subId) || hydrateById(req.params.subId)
      if (!sub) throw notFound('答卷不存在')
      const patch = { comment: req.body.comment || '' }
      if (req.body.raw !== undefined && req.body.raw !== null && String(req.body.raw) !== '') patch.raw = Number(req.body.raw)
      return { submission: submissionView(gradeSubmission(a, sub, req.user.name || '教师', patch)) }
    },
  })

  /** 教师看某一份答卷（答案 + 得分） */
  app.get('/api/exams/:id/submissions/:subId', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const sub = repo.findSubmission(a.id, req.params.subId) || hydrateById(req.params.subId)
    if (!sub) throw notFound('答卷不存在')
    const st = readState(a, sub)
    return {
      submission: submissionView(sub),
      state: st ? { answers: st.answers, startedAt: st.startedAt, submittedAt: st.submittedAt, graded: st.graded } : null,
      paper: st ? examLib.publicPaper(st.paper) : null,
    }
  })

  /** 教师下载某份答卷（渲染成 md/html） */
  app.get('/api/exams/:id/submissions/:subId/paper-file', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const sub = repo.findSubmission(a.id, req.params.subId) || hydrateById(req.params.subId)
    if (!sub) throw notFound('答卷不存在')
    const st = readState(a, sub)
    if (!st || !st.graded) throw notFound('这份答卷还没交卷')
    const cls = repo.getClass(sub.classId)
    const ctx = {
      course: (repo.getCourse(a.courseId) || {}).name || '',
      assignment: a,
      paper: st.paper,
      student: { sid: sub.sid, name: sub.name, className: cls ? cls.name : '' },
      state: st,
      graded: st.graded,
    }
    const fmt = String(req.query.fmt || 'md').toLowerCase() === 'html' ? 'html' : 'md'
    const body = fmt === 'html' ? examLib.renderHtml(ctx) : examLib.renderReport(ctx)
    return reply
      .status(200)
      .headers({
        'Content-Type': fmt === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Content-Disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent(sub.sid + '-答卷.' + fmt),
      })
      .send(body)
  })

  /* ============================ 学生侧 ============================ */

  /** 学生下载自己的答卷 */
  app.get('/api/student/exams/:id/paper-file', { preHandler: requireAuth('student') }, async (req, reply) => {
    const t = req.user
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const mine = repo.submissionsOf(a.id).filter((s) => s.sid === t.sid && s.classId === t.classId)
    const sub = mine[mine.length - 1]
    if (!sub) throw notFound('你还没开卷')
    const st = readState(a, sub)
    if (!st || !st.graded) throw notFound('还没交卷')
    const cls = repo.getClass(sub.classId)
    const ctx = {
      course: (repo.getCourse(a.courseId) || {}).name || '',
      assignment: a,
      paper: st.paper,
      student: { sid: sub.sid, name: sub.name, className: cls ? cls.name : '' },
      state: st,
      graded: st.graded,
    }
    const fmt = String(req.query.fmt || 'md').toLowerCase() === 'html' ? 'html' : 'md'
    return reply
      .status(200)
      .headers({
        'Content-Type': fmt === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Content-Disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent('我的答卷.' + fmt),
      })
      .send(fmt === 'html' ? examLib.renderHtml(ctx) : examLib.renderReport(ctx))
  })

  /** 开考（幂等：刷新/换设备还是同一份卷） */
  app.post('/api/student/exams/:id/start', { preHandler: requireAuth('student') }, async (req) => {
    const t = req.user
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    examItemOf(a)
    if (a.status !== 'open') throw forbidden(a.openedAt ? '这场机试已经结束了' : '老师还没开始这场机试')
    const { sub, state } = ensureSubmission(a, t)
    return {
      submissionId: sub.id,
      paper: examLib.publicPaper(state.paper),
      answers: state.answers || {},
      startedAt: state.startedAt,
      submittedAt: state.submittedAt || '',
      remaining: remainingOf(state),
    }
  })

  /** 当前状态（不抽题，只读） */
  app.get('/api/student/exams/:id/current', { preHandler: requireAuth('student') }, async (req) => {
    const t = req.user
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const mine = repo.submissionsOf(a.id).filter((s) => s.sid === t.sid && s.classId === t.classId)
    const sub = mine[mine.length - 1]
    if (!sub) return { started: false }
    const st = readState(a, sub)
    if (!st) return { started: false }
    return {
      started: true,
      submissionId: sub.id,
      paper: examLib.publicPaper(st.paper),
      answers: st.answers || {},
      startedAt: st.startedAt,
      submittedAt: st.submittedAt || '',
      remaining: remainingOf(st),
      score: typeof sub.score === 'number' ? sub.score : null,
      comment: sub.comment || '',
    }
  })

  /** 保存答案（交卷后不可改；超时不可改） */
  app.post('/api/student/exams/:id/answers', {
    preHandler: requireAuth('student'),
    schema: {
      body: {
        type: 'object',
        properties: { answers: { type: 'object' } },
      },
    },
    handler: async (req) => {
      const t = req.user
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      examItemOf(a)
      const { sub, state } = ensureSubmission(a, t)
      if (state.submittedAt) throw conflict('已经交卷了，不能再改')
      const left = remainingOf(state)
      if (left !== null && left <= 0) throw forbidden('考试时间到了，不能再作答')
      state.answers = Object.assign({}, state.answers, req.body.answers || {})
      writeState(a, sub, state)
      return { ok: true, remaining: left, answered: Object.keys(state.answers).length }
    },
  })

  /** 交卷：自动判分 + 立刻记账（老师之后还能改分） */
  app.post('/api/student/exams/:id/submit', { preHandler: requireAuth('student') }, async (req) => {
    const t = req.user
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    examItemOf(a)
    const { sub, state } = ensureSubmission(a, t)
    if (state.submittedAt) return { ok: true, already: true, submissionId: sub.id }

    state.submittedAt = new Date().toISOString()
    state.graded = examLib.autoGrade(state.paper, state.answers || {}, {})
    state.graded.at = state.submittedAt
    writeState(a, sub, state)

    // 自动判分立刻进计分表：学生交完就能看到分，老师再改也是「撤旧记新」
    const graded = gradeSubmission(a, sub, '机试自动判分', { raw: state.graded.autoScore, comment: '' })
    return { ok: true, submissionId: sub.id, autoScore: state.graded.autoScore, total: state.graded.total, score: graded.score }
  })
}

/** 兜底：直接按提交 id 查（机试路由允许用 subId） */
function hydrateById(id) {
  const row = repo.db().prepare(`SELECT * FROM submissions WHERE id = ?`).get(String(id))
  return row ? repo.hydrate(row) : null
}
