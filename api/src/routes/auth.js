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

/**
 * 从青果账号里认出学号。
 *
 * 学校的青果账号不一定正好等于学号：可能带工号风格的前缀（WP…）、
 * 也可能带后缀（邮箱、@域）。所以匹配规则是：
 *
 *   1. 完全相等 → 就是它
 *   2. 否则找「账号里包含」的学号，多个命中取**最长**的
 *      （短学号容易误配，要求至少 6 位）
 *   3. 都没有 → 返回空，调用方据此提示「没加入班级」
 *
 * 注意匹配失败和密码错误必须分开报：
 * 前者是「找老师加名单」，后者是「密码打错了」。
 * 混在一起说，学生会一直重试密码，把账号试到锁定。
 */
function matchSid(account, sids) {
  const a = String(account || '').trim()
  if (!a) return ''
  const list = Array.isArray(sids) ? sids : []
  if (list.includes(a)) return a
  let hit = ''
  for (const raw of list) {
    const s = String(raw || '')
    if (s.length < 6) continue
    if (a.indexOf(s) >= 0 && s.length > hit.length) hit = s
  }
  return hit
}

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
        },
      },
    },
    handler: async (req) => {
      /*
       * kg 模式下这个字段装的是「青果账号」——它可能等于学号，也可能带前缀/后缀，
       * 所以先当账号用，验过之后再换成本系统认得的学生学号（见下面的 matchSid）。
       */
      let sid = String(req.body.sid || '').trim()
      if (!sid) throw badRequest('请填写学号')

      /*
       * 老师手动禁用的，**两种登录方式都要拦住**。
       *
       * 这一步必须在 mode 分支之前：老师禁的是「这个人」，不是「这种登录方式」。
       * 否则切回「学号+姓名」他就又进来了 —— 那这个禁用形同虚设。
       */
      let manualBlocked = false
      try {
        const lf = await import('../lib/login-fails.js')
        const mb = lf.check(sid)
        manualBlocked = !!(mb.blocked && mb.why === 'manual')
      } catch (e) {
        /* 查不到记录就当没禁用 */
      }
      if (manualBlocked) throw unauthorized('这个账号已被老师禁止登录，请联系老师')

      const sa = getStudentAuth() // 读一次：mode 和青果入口来自同一份配置
      const mode = sa.mode

      if (mode === 'kg') {
        const account = sid // 青果账号，可能不等于学号
        const password = String(req.body.password || '')

        /*
         * 第 0 步：本地熔断检查。
         *
         * 外部系统是「24 小时错 5 次锁号」，等它数到 5 就已经晚了。
         * 所以在本地数到 3 次就自己停 —— 被熔断之后**连请求都不发**，
         * 学生最坏只是进不来课堂系统（老师点一下能解），账号本身不会被锁。
         */
        const fails = await import('../lib/login-fails.js')
        const blocked = fails.check(account)
        if (blocked.blocked) {
          // 老师手动禁用的，没有「自动恢复」这回事，只能找老师
          if (blocked.why === 'manual') {
            throw unauthorized('这个账号已被老师禁止登录，请联系老师')
          }
          const hours = Math.max(1, Math.round(blocked.remainMs / 3600000))
          throw unauthorized(
            '这个账号今天输错次数过多，已暂时禁止登录。约 ' +
              hours +
              ' 小时后自动恢复，也可以联系老师立即解锁'
          )
        }

        if (!password) throw badRequest('请填写密码')

        /*
         * 第一步：先验证「这个账号能不能登上青果」。
         *
         * 注意这里**不能**先查名册 —— 因为账号可能带前缀（如 WP2515230114），
         * 精确查名册必然查不到，但人是真的、也确实该让他进。
         * 所以顺序是「先证明他是谁（登录成功），再认他是哪个学生（匹配学号）」。
         *
         * 缓存策略：
         *   老师开了「每次登录都核验」→ 每次都问青果
         *   否则（默认）           → 记住过且对得上就直接放行，省一次远端往返
         */
        const creds = await import('../lib/student-creds.js')
        const local = sa.verifyEachTime ? null : creds.verify(account, password)

        if (local !== true) {
          const { verifyStudent } = await import('../lib/kg-auth.js')
          const r = await verifyStudent(account, password, { bases: sa.kgBases })
          if (!r.ok) {
            const m = String(r.message || '')

            /*
             * 凭据错 → 本地记一次。网络类问题（超时/连不上/服务不可用）不记：
             * 那是我们的问题，不该算到学生头上。
             */
            if (!/超时|连不上|不可用/.test(m)) {
              // 顺手认一下学号（认不出就算了），这样班级管理页能按学号显示这条失败记录
              const guess = matchSid(account, repo.listAllSids())
              const st = fails.bump(account, r.counter, guess)
              if (st.justBlocked) {
                throw unauthorized(
                  '这个账号已连续输错 ' +
                    fails.BLOCK_AFTER +
                    ' 次。为保证账号安全，本系统暂时禁止登录，明天会自动恢复，也可以联系老师解锁'
                )
              }
            }

            /*
             * 只说该说的：锁定 / 短信验证 / 输错次数 —— 这些是学生必须知道的后果。
             * 其余（验证没通过、服务异常…）一律收敛成「账号或密码不对」。
             */
            throw unauthorized(/锁定|短信|次数|超时|连不上/.test(m) ? m : '账号或密码不对')
          }
          // 青果认了 → 记下来，下次本地比对
          try {
            creds.remember(account, password)
          } catch (e) {
            /* 记不住不影响这次登录 */
          }
        }

        // 登录成功 → 清掉失败记录（下次从 0 开始数）
        fails.clear(account)

        /*
         * 第二步：能登录上了，再认身份。
         * 账号等于某个学号，或者**账号里包含**某个学号（取最长的那个，避免短号误配），
         * 就按那个学号的身份走。
         *
         * 都对不上 → 不是密码问题，是没入班：这种情况必须和「密码错」分开说，
         * 否则学生会一直以为密码打错了，反复重试（还会把账号打锁）。
         */
        sid = matchSid(account, repo.listAllSids())
        if (!sid) {
          // 只说「没入班」，不提是哪个系统验证过的 —— 学生不需要知道这层
          throw unauthorized('这个账号还没有加入本课程班级，请联系老师')
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
  app.get('/api/auth/student-mode', async (req, reply) => {
    // 老师随时可能切模式，这个响应不能被任何一层缓存住
    reply.header('Cache-Control', 'no-store, must-revalidate')
    return { mode: getStudentAuth().mode }
  })

  /** 教师看当前学生登录校验方式 */
  app.get('/api/settings/student-auth', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    // 老师刚改完就刷新，必须看到新值 —— 不允许缓存
    reply.header('Cache-Control', 'no-store, must-revalidate')
    const sa = getStudentAuth()
    let rememberedCount = 0
    try {
      const creds = await import('../lib/student-creds.js')
      rememberedCount = creds.countRemembered()
    } catch (e) {
      rememberedCount = 0
    }
    let blockedCount = 0
    try {
      const fails = await import('../lib/login-fails.js')
      blockedCount = fails.blockedCount()
    } catch (e) {
      blockedCount = 0
    }
    return Object.assign({}, sa, { rememberedCount, blockedCount })
  })

  /**
   * 教师解锁「输错太多次被本地禁止」的账号。
   *   DELETE /api/settings/student-auth/blocks        全解
   *   DELETE /api/settings/student-auth/blocks/:account  解一个
   * 学生第二天本来也会自动恢复，但课上等不起 —— 老师点一下立刻能进。
   */
  app.delete('/api/settings/student-auth/blocks', { preHandler: requireAuth('teacher') }, async () => {
    const fails = await import('../lib/login-fails.js')
    return { removed: fails.unblockAll() }
  })

  app.delete(
    '/api/settings/student-auth/blocks/:account',
    { preHandler: requireAuth('teacher') },
    async (req) => {
      const fails = await import('../lib/login-fails.js')
      return { removed: fails.unblock(req.params.account) }
    }
  )

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
            /* 每次登录都向青果核验（不沿用本地记住的密码） */
            verifyEachTime: { type: 'boolean' },
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
