/*
 * routes/auth.js —— 登录 / 身份 / 退出
 *
 * 学生免密登录的前提是「学号 + 姓名」与名册对得上：
 * 令牌里锁死 classId / sid，之后所有学生接口只认令牌里的身份，
 * 不接受前端再传 sid（这样改 URL 也看不到别人的东西）。
 */
import { issue, revoke, checkPassword } from '../lib/auth.js'
import { config, setPassword, getStudentAuth, setStudentAuth } from '../config.js'
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

  /**
   * 学生登录。两种校验方式，由教师在「课程管理 → 学生登录方式」里切换：
   *
   *   local（默认）—— 学号 + 姓名，和名册比对；免密、离线、瞬时
   *   kg            —— 学号 + 青果密码，能登上青果就放行（见 lib/kg-auth.js）
   *
   * 不管哪种方式，最后都必须落到「名册里有这个学号」——
   * 否则没有班级归属，后面的作业、考勤、分数全都挂不上。
   */
  app.post('/api/auth/login/student', {
    schema: {
      body: {
        type: 'object',
        required: ['sid'],
        properties: {
          sid: { type: 'string', maxLength: 40 },
          name: { type: 'string', maxLength: 40 },
          password: { type: 'string', maxLength: 128 },
          /* 学生主动要求「用青果再验一次」（改过密码后本地哈希对不上时用） */
          verifyRemote: { type: 'boolean' },
        },
      },
    },
    handler: async (req) => {
      const sid = String(req.body.sid || '').trim()
      if (!sid) throw badRequest('请填写学号')

      const sa = getStudentAuth() // 读一次：mode 和青果入口来自同一份配置
      const mode = sa.mode

      if (mode === 'kg') {
        const password = String(req.body.password || '')
        if (!password) throw badRequest('请填写青果密码')

        /*
         * 第一步永远是**查名册**：不在本课程名单里的学号，一律不该去问青果。
         * 原来顺序反了（先验青果再查名册），学生密码输对了却不在名单，
         * 等于白消耗一次青果登录。
         */
        const clsK = repo.findClassBySid(sid)
        if (!clsK) throw unauthorized('这个学号不在本课程的名单里，找老师确认一下')
        const stuK = repo.findStudent(clsK.id, sid)
        if (!stuK) throw unauthorized('这个学号不在本课程的名单里，找老师确认一下')

        /*
         * 第二步：先看本地记没记住。
         *   记住且对得上 → 直接放行（不打青果：快，也不消耗它的失败次数）
         *   没记过       → 必须去问青果（第一次登录）
         *   对不上       → 默认拒绝；只有学生**主动点「用青果再验一次」**才走远端
         *
         * 为什么「对不上」不自动去问青果：青果满 5 次锁号，
         * 自动回落等于让学生手滑几下就把自己账号打锁。
         */
        const creds = await import('../lib/student-creds.js')
        const local = creds.verify(sid, password)
        const wantRemote = req.body.verifyRemote === true

        if (local === true) {
          /* 本地已验证，直接过 */
        } else if (local === null || wantRemote) {
          const { verifyStudent } = await import('../lib/kg-auth.js')
          const r = await verifyStudent(sid, password, { bases: sa.kgBases })
          if (!r.ok) throw unauthorized(r.message)
          // 青果认了 → 记下来，下次本地比对
          try {
            creds.remember(sid, password)
          } catch (e) {
            /* 记不住不影响这次登录 */
          }
        } else {
          throw unauthorized(
            '密码不对。如果最近在智慧校园改过密码，点「用青果再验一次」重新确认'
          )
        }
      } else {
        const name = String(req.body.name || '').trim()
        if (!name) throw badRequest('学号与姓名都要填')

        const cls0 = repo.findClassBySid(sid)
        if (!cls0) throw unauthorized('这个学号不在任何班级名册里，找老师确认一下')
        const stu0 = repo.findStudent(cls0.id, sid)
        if (!stu0 || String(stu0.name).trim() !== name) {
          throw unauthorized('学号与姓名对不上（注意姓名要和名册完全一致）')
        }
      }

      const cls = repo.findClassBySid(sid)
      if (!cls) throw unauthorized('这个学号不在任何班级名册里，找老师确认一下')
      const stu = repo.findStudent(cls.id, sid)
      if (!stu) throw unauthorized('这个学号不在班级名册里，找老师确认一下')

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
  /**
   * 学生登录页要知道该显示哪种表单（学号+姓名 / 学号+密码）。
   * 公开接口，**只回 mode** —— 不回青果地址，没必要让外面知道入口。
   */
  app.get('/api/auth/student-mode', async () => {
    return { mode: getStudentAuth().mode }
  })

  /** 教师看当前学生登录校验方式 */
  app.get('/api/settings/student-auth', { preHandler: requireAuth('teacher') }, async () => {
    const sa = getStudentAuth()
    let rememberedCount = 0
    try {
      const creds = await import('../lib/student-creds.js')
      rememberedCount = creds.countRemembered()
    } catch (e) {
      rememberedCount = 0
    }
    return Object.assign({}, sa, { rememberedCount })
  })

  /**
   * 教师清空「记住的密码」。
   *   DELETE /api/settings/student-auth/creds       清全部
   *   DELETE /api/settings/student-auth/creds/:sid  清一个
   * 换设备、怀疑泄露、或者有学生改过青果密码却怎么也登不进时用。
   */
  app.delete('/api/settings/student-auth/creds', { preHandler: requireAuth('teacher') }, async () => {
    const creds = await import('../lib/student-creds.js')
    return { removed: creds.forgetAll() }
  })

  app.delete(
    '/api/settings/student-auth/creds/:sid',
    { preHandler: requireAuth('teacher') },
    async (req) => {
      const creds = await import('../lib/student-creds.js')
      return { removed: creds.forget(req.params.sid) }
    }
  )

  /** 教师改：切换校验方式 / 改青果入口（改完立即生效，下次登录就用新的） */
  app.patch(
    '/api/settings/student-auth',
    {
      preHandler: requireAuth('teacher'),
      schema: {
        body: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['local', 'kg'] },
            kgBases: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 5 },
          },
        },
      },
    },
    async (req) => setStudentAuth(req.body || {})
  )

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
      /*
       * 这里不再拦「环境变量控制的口令」。
       * 规则是 config.json 为唯一真源：TS_PASSWORD 只在还没有配置时用一次，
       * 之后界面上改就是改配置本身，下次启动也从配置读 —— 不会被人挡住。
       */
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
