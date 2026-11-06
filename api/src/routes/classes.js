/*
 * routes/classes.js —— 班级与名册
 *
 * 班级挂在课程下面；名册是 (classId, sid) 复合主键 ——
 * 同一个学号可以同时出现在不同学期的班里，互不干扰。
 */
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound, conflict } from '../lib/errors.js'
import * as repo from '../lib/repo.js'

const view = (c) => {
  const roster = repo.rosterOf(c.id)
  return {
    id: c.id,
    courseId: c.courseId || '',
    name: c.name,
    createdAt: c.createdAt || '',
    rollcallRound: c.rollcallRound || 1,
    studentCount: roster.length,
    students: roster,
  }
}

export default async function classRoutes(app) {
  /** 班级列表（可按课程过滤） */
  app.get('/api/classes', { preHandler: requireAuth('teacher') }, async (req) => {
    const courseId = String(req.query.courseId || '')
    const items = repo.listClasses(courseId || undefined).map((c) => {
      const roster = repo.rosterOf(c.id)
      return {
        id: c.id,
        courseId: c.courseId || '',
        name: c.name,
        createdAt: c.createdAt || '',
        studentCount: roster.length,
      }
    })
    return { items, total: items.length }
  })

  app.get('/api/classes/:id', { preHandler: requireAuth('teacher') }, async (req) => {
    const c = repo.getClass(req.params.id)
    if (!c) throw notFound('班级不存在')
    return view(c)
  })

  app.post('/api/classes', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 },
          courseId: { type: 'string' },
        },
      },
    },
    handler: async (req, reply) => {
      const name = req.body.name.trim()
      if (!name) throw badRequest('班级名不能为空')
      const courseId = String(req.body.courseId || '')
      if (courseId && !repo.getCourse(courseId)) throw notFound('课程不存在：' + courseId)
      const c = repo.insertClass({
        id: 'cl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name,
        courseId,
        createdAt: new Date().toISOString(),
        rollcallRound: 1,
      })
      reply.status(201)
      return view(c)
    },
  })

  app.patch('/api/classes/:id', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 60 }, courseId: { type: 'string' } },
      },
    },
    handler: async (req) => {
      const c = repo.getClass(req.params.id)
      if (!c) throw notFound('班级不存在')
      if (req.body.courseId !== undefined && req.body.courseId && !repo.getCourse(req.body.courseId)) {
        throw notFound('课程不存在：' + req.body.courseId)
      }
      const next = repo.updateClass(c.id, {
        name: req.body.name !== undefined ? String(req.body.name).trim() : c.name,
        courseId: req.body.courseId !== undefined ? req.body.courseId : c.courseId,
      })
      return view(next)
    },
  })

  app.delete('/api/classes/:id', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const c = repo.getClass(req.params.id)
    if (!c) throw notFound('班级不存在')
    const n = repo.rosterOf(c.id).length
    if (n > 0) {
      // 有学生就要求确认，别一键删掉一学期的记分
      if (String(req.query.force || '') !== '1') {
        throw conflict('这个班还有 ' + n + ' 名学生（记分会一起删）。确认要删就加 ?force=1', { studentCount: n })
      }
    }
    repo.deleteClass(c.id)
    reply.status(204).send()
  })

  /* ------------------------------ 名册 ------------------------------ */

  app.get('/api/classes/:id/students', { preHandler: requireAuth('teacher') }, async (req) => {
    const c = repo.getClass(req.params.id)
    if (!c) throw notFound('班级不存在')
    const items = repo.rosterOf(c.id)
    return { items, total: items.length }
  })

  /** 批量加人（导入名单）：同 sid 覆盖姓名，返回最新名册 */
  app.post('/api/classes/:id/students', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['students'],
        properties: {
          students: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            items: {
              type: 'object',
              required: ['sid'],
              properties: { sid: { type: 'string' }, name: { type: 'string' } },
            },
          },
        },
      },
    },
    handler: async (req, reply) => {
      const c = repo.getClass(req.params.id)
      if (!c) throw notFound('班级不存在')
      const list = req.body.students
        .map((s) => ({ sid: String(s.sid || '').trim(), name: String(s.name || '').trim() }))
        .filter((s) => s.sid)
      if (!list.length) throw badRequest('没有有效的学号')
      const items = repo.addStudents(c.id, list)
      reply.status(201)
      return { items, total: items.length }
    },
  })

  app.patch('/api/classes/:id/students/:sid', {
    preHandler: requireAuth('teacher'),
    schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 40 } } } },
    handler: async (req) => {
      const ok = repo.renameStudent(req.params.id, req.params.sid, req.body.name)
      if (!ok) throw notFound('这个学生不在班里')
      return { ok: true, students: repo.rosterOf(req.params.id) }
    },
  })

  app.delete('/api/classes/:id/students/:sid', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const ok = repo.removeStudent(req.params.id, req.params.sid)
    if (!ok) throw notFound('这个学生不在班里')
    reply.status(204).send()
  })
}
