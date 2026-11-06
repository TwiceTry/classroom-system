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
import { UPLOAD_DIR } from '../config.js'
import * as repo from '../lib/repo.js'
import * as store from '../lib/submitstore.js'
import { scheme, withCourseScheme } from '../lib/scheme.js'
import { gradeSubmission, kindOfItem, courseOfClass, courseOfAssignment } from '../lib/grading.js'
import { content } from '../lib/legacy.js'
import { contentRootOf } from './courses.js'

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
const MAX_TEXT_FILES = 40

const view = (a) => ({
  id: a.id,
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

const subView = (s, className) => ({
  id: s.id,
  assignmentId: s.assignmentId,
  classId: s.classId,
  className: className || '',
  sid: s.sid,
  name: s.name || '',
  dir: s.dir || '',
  createdAt: s.createdAt || '',
  files: s.files || [],
  changed: s.changed || [],
  note: s.note || '',
  url: s.url || '',
  eventId: s.eventId || '',
  grade: s.grade || '',
  late: !!s.late,
  raw: s.raw === null || s.raw === undefined ? undefined : Number(s.raw),
  dims: s.dims || undefined,
  score: s.score === null || s.score === undefined ? undefined : Number(s.score),
  comment: s.comment || '',
  gradedAt: s.gradedAt || '',
  gradedBy: s.gradedBy || '',
})

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
        reply.status(201)
        return view(a)
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
      return view(repo.updateAssignment(a.id, next))
    },
  })

  /** 开 / 关（关掉之后学生不能提交） */
  app.post('/api/assignments/:id/open', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    return view(repo.updateAssignment(a.id, { status: 'open', openedAt: new Date().toISOString() }))
  })

  app.post('/api/assignments/:id/close', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    return view(repo.updateAssignment(a.id, { status: 'closed', closedAt: new Date().toISOString() }))
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

  /** 看某份提交的文件正文（课堂作业） */
  app.get('/api/assignments/:id/submissions/:sid', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const sub = repo.findSubmission(a.id, req.params.sid)
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
          raw: { type: 'number' },
          dims: { anyOf: [{ type: 'object' }, { type: 'string' }] },
          comment: { type: 'string', maxLength: 1000 },
          weight: { type: 'number' },
        },
      },
    },
    handler: async (req) => {
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      const sub = repo.findSubmission(a.id, req.params.sid)
      if (!sub) throw notFound('提交记录不存在')
      return { submission: gradeSubmission(a, sub, req.user.name || '教师', req.body) }
    },
  })

  /** 打回重做：分数与评语清空、计分作废，学生可以再交 */
  app.post('/api/assignments/:id/submissions/:sid/redo', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const sub = repo.findSubmission(a.id, req.params.sid)
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
    const sub = repo.findSubmission(a.id, req.params.sid)
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
      const sub = repo.findSubmission(a.id, req.params.sid)
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
      const sub = repo.findSubmission(a.id, req.params.sid)
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

    const items = repo
      .listAssignments(course ? course.id : undefined)
      .filter((a) => !a.courseId || a.courseId === (course ? course.id : ''))
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
      files: mine && a.kind !== 'project' ? store.readTextFiles(a.kind, mine.classId, mine.sid, a.id, mine.files) : [],
    }
  })

  /**
   * 学生提交。
   *   files: [{ name, text }]        课堂作业（交代码/文本）
   *   files: [{ name, dataUrl }]     大作业（交附件）
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
              required: ['name'],
              properties: { name: { type: 'string' }, text: { type: 'string' }, dataUrl: { type: 'string' } },
            },
          },
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
        changed: [],
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
