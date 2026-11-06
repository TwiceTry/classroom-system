/*
 * routes/auth.js —— 登录 / 身份 / 退出
 *
 * 学生免密登录的前提是「学号 + 姓名」与名册对得上：
 * 令牌里锁死 classId / sid，之后所有学生接口只认令牌里的身份，
 * 不接受前端再传 sid（这样改 URL 也看不到别人的东西）。
 */
import { issue, revoke, checkPassword } from '../lib/auth.js'
import { config, setPassword, getPasswordSource } from '../config.js'
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

  /**
   * 改教师口令 —— 老师自己在界面上改，不用去动 data/config.json。
   *
   * 写进 config.json 后**立即生效**（config 里是 getter，不用重启进程），
   * 下次启动也是从文件读。
   *
   * 注意：已经登录的设备（包括当前这个）**不会掉线** —— 令牌是 JWT，
   * 签名用的是 secret，跟口令无关。所以换口令 ≠ 踢掉别人，
   * 想让旧令牌立刻作废，得换 config.json 的 secret（那会让所有人重登）。
   */
  app.post('/api/auth/password', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['oldPassword', 'newPassword'],
        properties: {
          oldPassword: { type: 'string' },
          newPassword: { type: 'string' },
        },
      },
    },
    handler: async (req) => {
      const oldPwd = String(req.body.oldPassword || '')
      const newPwd = String(req.body.newPassword || '')

    if (!checkPassword(oldPwd)) throw unauthorized('当前口令不正确')

    const err = checkNewPassword(newPwd)
    if (err) throw badRequest(err)
    if (newPwd === oldPwd) throw badRequest('新口令和当前口令一样，没有变化')

    let written = false
    try {
      setPassword(newPwd)
      written = true
    } catch (e) {
      // 只读介质（U 盘 / 容器只读层）：不能假装成功，否则重启后悄悄变回去
      throw badRequest('写不进 data/config.json：' + e.message)
    }

    const notes = []
    if (newPwd === 'teacher') {
      // 不硬拦（有人忘了口令、想先改回默认再处理），但要说清楚风险
      notes.push('你正在把口令改回默认值 teacher —— 任何知道这个系统的人都能进教师端，建议尽快换一个。')
    }
    if (getPasswordSource() === 'env-migrated') {
      notes.push('口令已写入 data/config.json。环境变量 TS_PASSWORD 只在首次启动时生效，以后以文件为准。')
    }
    notes.push('已登录的设备不会立即掉线，最多再保持 ' + config.tokenHours + ' 小时；要立刻全部踢掉，需更换 config.json 里的 secret。')

      return { ok: written, tokenHours: config.tokenHours, notes }
    },
  })
}

/**
 * 新口令的基本要求。
 * 返回 '' 表示通过，否则返回给老师看的原因。
 */
function checkNewPassword(pwd) {
  const s = String(pwd || '')
  if (!s.trim()) return '新口令不能为空'
  if (s.length < 6) return '口令太短，至少 6 位'
  if (s.length > 64) return '口令太长（最多 64 位）'
  if (/^\s+$/.test(s)) return '口令不能只有空格'
  return ''
}
