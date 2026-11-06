/*
 * routes/auth.js —— 登录 / 身份 / 退出
 *
 * 学生免密登录的前提是「学号 + 姓名」与名册对得上：
 * 令牌里锁死 classId / sid，之后所有学生接口只认令牌里的身份，
 * 不接受前端再传 sid（这样改 URL 也看不到别人的东西）。
 */
import { issue, revoke, checkPassword } from '../lib/auth.js'
import { config } from '../config.js'
import { requireAuth } from '../plugins/auth.js'
import { badRequest, unauthorized, forbidden } from '../lib/errors.js'
import * as repo from '../lib/repo.js'

export default async function authRoutes(app) {
  /** 教师登录 */
  app.post('/api/auth/login/teacher', {
    schema: {
      body: { type: 'object', required: ['password'], properties: { password: { type: 'string' } } },
    },
    handler: async (req) => {
      if (!checkPassword(req.body.password)) throw unauthorized('口令不正确')
      const token = issue({ role: 'teacher', name: '教师' })
      return { token, role: 'teacher', name: '教师', expiresInHours: config.tokenHours }
    },
  })

  /** 学生登录（学号 + 姓名，对应名册；免密） */
  app.post('/api/auth/login/student', {
    schema: {
      body: {
        type: 'object',
        required: ['sid', 'name'],
        properties: { sid: { type: 'string' }, name: { type: 'string' } },
      },
    },
    handler: async (req) => {
      const sid = String(req.body.sid || '').trim()
      const name = String(req.body.name || '').trim()
      if (!sid || !name) throw badRequest('学号与姓名都要填')

      const cls = repo.findClassBySid(sid)
      if (!cls) throw unauthorized('这个学号不在任何班级名册里，找老师确认一下')
      const stu = repo.findStudent(cls.id, sid)
      if (!stu || String(stu.name).trim() !== name) {
        throw unauthorized('学号与姓名对不上（注意姓名要和名册完全一致）')
      }

      const token = issue({ role: 'student', classId: cls.id, sid, name: stu.name })
      const course = cls.courseId ? repo.getCourse(cls.courseId) : null
      // 与 /api/auth/me 同一形状：身份挂在 student 下（前端 applyLogin 按这个取）
      return {
        token,
        role: 'student',
        student: {
          sid,
          name: stu.name,
          classId: cls.id,
          className: cls.name,
          courseId: course ? course.id : cls.courseId || '',
          courseName: course ? course.name : '',
        },
        expiresInHours: config.tokenHours,
      }
    },
  })

  /**
   * 我是谁（前端刷新后用它恢复身份；令牌过期 401）。
   *
   * **形状是前端既有契约**：学生端从 `me.student.name` / `me.student.courseName`
   * 取侧栏头部与课程名，所以身份必须挂在 `student` 下面，
   * 而不是平铺在顶层（平铺会让侧栏显示 "undefined undefined"）。
   */
  app.get('/api/auth/me', { preHandler: requireAuth() }, async (req) => {
    const u = req.user
    if (u.role === 'student') {
      const cls = u.classId ? repo.getClass(u.classId) : null
      const course = cls && cls.courseId ? repo.getCourse(cls.courseId) : null
      return {
        role: 'student',
        student: {
          sid: u.sid,
          name: u.name || '',
          classId: u.classId || '',
          className: cls ? cls.name : '',
          courseId: course ? course.id : '',
          courseName: course ? course.name : '',
        },
      }
    }
    return { role: 'teacher', name: u.name || '' }
  })

  /** 退出登录（把当前令牌拉黑） */
  app.post('/api/auth/logout', { preHandler: requireAuth() }, async (req, reply) => {
    const raw = String(req.headers.authorization || '')
    const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
    if (m) revoke(m[1].trim())
    reply.status(204).send()
  })
}
