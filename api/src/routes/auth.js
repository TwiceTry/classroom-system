/*
 * routes/auth.js —— 登录 / 身份 / 退出
 *
 * 学生免密登录的前提是「学号 + 姓名」与名册对得上：
 * 令牌里锁死 classId / sid，之后所有学生接口只认令牌里的身份，
 * 不接受前端再传 sid（这样改 URL 也看不到别人的东西）。
 */
import { issue, revoke, checkPassword } from '../lib/auth.js'
import * as overrides from '../lib/auth-overrides.js'
import { providerFor, buildContext, runVerify, listProviders, getProvider } from '../lib/auth-providers/index.js'
import { countsAsFailure, peekPending } from '../lib/auth-providers/types.js'
import * as errlog from '../lib/errlog.js'
import { config, setPassword, getStudentAuth, setStudentAuth, providerSettings } from '../config.js'
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

/**
 * 按插件声明的 credentials 从请求体里收集凭证。
 *
 * 为什么不直接传 req.body：插件只该拿到它自己声明过的字段。
 * 把整个 body 递过去，等于让它有机会摸到别人的字段（比如 sid、captcha），
 * 而"这个插件需要什么"应该是**它自己声明、系统照着给**。
 *
 * 缺的字段给空串而不是 undefined —— 插件里写 `ctx.credentials.password` 时，
 * 空串能被 `if (!password)` 拦住，undefined 更容易在拼接时变成字符串 "undefined"。
 */
function collectCreds(plugin, body) {
  const out = {}
  for (const f of (plugin && plugin.credentials) || []) {
    if (!f || !f.key) continue
    out[f.key] = String((body && body[f.key]) ?? '')
  }
  return out
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
          /*
           * 学生自己填的图形验证码（上一轮登录接口返回 needCaptcha 时才会有）。
           * handle 是服务端给的不透明串，用来找回当时那一份平台会话。
           */
          captcha: {
            type: 'object',
            properties: {
              code: { type: 'string', maxLength: 12 },
              handle: { type: 'string', maxLength: 64 },
            },
          },
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
      /*
       * 这个学生实际用哪种方式：先看他有没有单独设置，没有才回落到全局。
       *
       * 为什么需要按人覆盖：一节课上两种方式并存是常态 ——
       * 大部分学生走青果账号密码，个别学生青果密码老对不上（或者账号被锁），
       * 老师想让他先用「学号 + 姓名」进来上课。
       * 反过来也有：默认学号+姓名，但个别要交作业的要求必须走青果。
       */
      const mode = overrides.modeFor(sid, sa.mode)

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
          /*
           * 走 kg 插件。
           *
           * 原来这里是 `verifyStudent()` + 一串中文正则去猜「算不算凭证错」。
           * 插件化之后不用猜了：插件给 reason，`countsAsFailure()` 说该不该记。
           * 这比正则可靠 —— 平台改一次文案，正则就悄悄失效，而 code 不会。
           */
          const p = providerFor('kg', sa.mode === 'kg' ? 'kg' : '')
          if (!p) throw unauthorized('登录服务还没配好，请联系老师')

          const logFn = (o) =>
            errlog.write(Object.assign({ kind: 'kg-login', sid: account, target: (sa.kgBases || [])[0] || '' }, o || {}))

          const out = await runVerify(
            p,
            buildContext({
              /* 这里传 account（可能带 WP 前缀），不是匹配出来的 sid —— 平台认的是账号 */
              sid: account,
              credentials: collectCreds(p, req.body),
              /* 学生上一轮填的图形码（首次提交时为 null） */
              captcha: req.body.captcha && req.body.captcha.code ? req.body.captcha : null,
              /* 插件自己的配置（bases / verifyEachTime），不再由系统层拼 */
              settings: providerSettings(p.key),
              repo,
              request: { ip: req.ip, ua: req.headers['user-agent'] || '' },
              log: logFn,
            }),
            logFn
          )

          /*
           * 要图形验证码 —— 这**不是失败**，是还差一步。
           * 以 200 返回，前端据此显示图片 + 输入框；
           * 用 401 会走统一的错误处理，把学生踢回第一步。
           */
          if (out.outcome === 'challenge') {
            return {
              needCaptcha: true,
              challenge: out.challenge || null,
              message: out.message || '请输入图中的字符',
            }
          }

          if (out.outcome !== 'ok') {
            /* 只有「凭证错」才记失败。平台挂了 / 要短信验证 / 配置错，都不算学生的错 */
            if (countsAsFailure(out.reason)) {
              const guess = matchSid(account, repo.listAllSids())
              const st = fails.bump(account, out.counter, guess)
              if (st.justBlocked) {
                throw unauthorized(
                  '这个账号已连续输错 ' +
                    fails.BLOCK_AFTER +
                    ' 次。为保证账号安全，本系统暂时禁止登录，明天会自动恢复，也可以联系老师解锁'
                )
              }
            }
            throw unauthorized(out.message || '账号或密码不对')
          }

          // 平台认了 → 记下来，下次本地比对（省一次 1.3 秒的往返）
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
        /*
         * 走插件。
         *
         * 原来这里是一段写死的「查名册比对姓名」。
         * 换成插件之后，这段逻辑搬进了 auth-providers/local/index.js ——
         * 系统层不再知道「学号+姓名」这件事是怎么实现的，只认插件返回的 Outcome。
         *
         * 注意 kg 分支暂时还留着原样：它的插件（含验证码两阶段）还没搬完，
         * 半吊子接进来比不接更危险。等 kg 插件就绪、回归测试过了再切。
         */
        /*
         * 用**这个学生实际该用的插件**，而不是写死 'local'。
         *
         * 原来这里传 'local' 是因为 else 分支本身就代表「学号+姓名」。
         * 但插件化之后，"不是 kg" 不等于 "就是 local" —— 可能还有第三个、第四个插件。
         * 这一个参数决定了新插件能不能跑起来。
         */
        const p = providerFor(mode, getStudentAuth().provider || 'local')
        if (!p) throw unauthorized('登录服务还没配好，请联系老师')

        const r = await runVerify(
          p,
          buildContext({
            sid,
            credentials: collectCreds(p, req.body),
            settings: {},
            repo,
            request: { ip: req.ip, ua: req.headers['user-agent'] || '' },
            log: (o) => errlog.write(Object.assign({ kind: 'auth-plugin', plugin: p.key, sid }, o || {})),
          }),
          (o) => errlog.write(Object.assign({ kind: 'auth-plugin', plugin: p.key, sid }, o || {}))
        )

        if (r.outcome !== 'ok') throw unauthorized(r.message || '登录失败，请重试')
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
  /*
   * 原来这里有个 GET /api/auth/student-mode（只回全局 mode），**已删除**。
   *
   * 删它是因为它现在会说错话：登录方式可以按人设置了，
   * 全局值只代表"默认"，不代表某个具体学生。谁再拿它去画登录表单，
   * 就会在"个人覆盖"的班上画出错误的输入框（只给姓名框、其实要密码）。
   * 正确的入口是下面的 student-probe —— 先给学号，再问方式。
   */

  /**
   * 学生登录第一步：这个学号该用哪种方式登。
   *
   *   POST /api/auth/student-probe  { sid }
   *   → { mode: 'local' | 'kg', needPassword: boolean }
   *
   * 为什么需要这一步：登录方式可以**按人设置**了（auth_overrides），
   * 全局值不再代表「这个学生」。原来登录页一进来就问全局 mode，
   * 于是「全局学号+姓名、但这个人被设成账号密码」时，页面只显示姓名框 ——
   * 学生输完姓名点登录，才被告知要密码，而他根本没看到密码框。
   *
   * 所以顺序反过来：先拿到学号 → 问服务端 → 再决定画什么表单。
   *
   * 三条约束：
   *   · 不缓存（老师刚改完就生效）
   *   · 学号不存在时也回全局 mode —— 否则这个接口变成「学号是否存在」的探针
   *   · 不回姓名/班级等信息，只回"要不要密码"
   */
  app.post(
    '/api/auth/student-probe',
    {
      schema: {
        body: {
          type: 'object',
          required: ['sid'],
          properties: { sid: { type: 'string', maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store, must-revalidate')
      const sid = String(req.body.sid || '').trim()
      const sa = getStudentAuth()
      /* 空学号直接按全局回，别让前端卡在这一步 */
      const key = sid ? overrides.modeFor(sid, sa.provider) : sa.provider
      const p = providerFor(key, sa.provider)
      if (!p) return { mode: 'local', provider: 'local', needPassword: false, credentials: [], name: '' }

      /*
       * 把插件声明的**表单字段**一并回给前端 —— 前端照着 credentials 渲染第二步，
       * 不再写「kg 就显示密码框」那种 if。
       * 加一个新插件（比如要工号 + 短信码、或者扫码那种 credentials: []）时，
       * 登录页一行都不用改。
       */
      return {
        /* mode 是旧字段（前端还在读），provider 是新的 */
        mode: p.key,
        provider: p.key,
        name: p.name,
        desc: p.desc || '',
        credentials: p.credentials || [],
        captcha: p.captcha || { kind: 'none' },
        needPassword: (p.credentials || []).some((f) => f.type === 'password'),
      }
    }
  )

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
    return Object.assign({}, sa, { rememberedCount, blockedCount, overrideCount: overrides.count() })
  })

  /**
   * 换一张图形验证码。
   *
   *   POST /api/auth/captcha/refresh  { handle }
   *   → { ok: true, challenge: { image, handle } } | { ok: false, reason: 'expired' }
   *
   * 前端只传 handle，**不传"当前是哪个登录方式"** ——
   * 用 peekPending 从暂存里反查插件，避免让客户端决定用哪个插件跑。
   *
   * 换不出来（handle 过期 / 插件不支持）时前端应该提示「重新获取」，
   * 而不是给一个空白框 —— 那比不显示还糟。
   */
  app.post(
    '/api/auth/captcha/refresh',
    {
      schema: { body: { type: 'object', required: ['handle'], properties: { handle: { type: 'string', maxLength: 64 } } } },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store, must-revalidate')
      const handle = String(req.body.handle || '')
      const pk = peekPending(handle)
      if (!pk) return { ok: false, reason: 'expired' }
      const p = providerFor(pk.key, pk.key)
      if (!p || typeof p.refresh !== 'function') return { ok: false, reason: 'unsupported' }
      try {
        const ch = await p.refresh({ handle })
        return ch ? { ok: true, challenge: ch } : { ok: false, reason: 'expired' }
      } catch (e) {
        errlog.write({ kind: 'auth-plugin', plugin: pk.key, msg: '刷新验证码失败：' + e.message })
        return { ok: false, reason: 'error' }
      }
    }
  )

  /**
   * 有哪些登录方式可选、各自要配什么。
   *
   *   GET /api/settings/student-auth/providers
   *   → { current: 'kg', providers: [ { key, name, desc, settings, values, ... } ] }
   *
   * 设置页照 settings 渲染配置表单 —— 加新插件时前端一行不用改。
   * values 是每个插件**当前存着的配置**，直接回填到表单里。
   */
  app.get('/api/settings/student-auth/providers', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store, must-revalidate')
    const sa = getStudentAuth()
    const providers = listProviders().map((p) =>
      Object.assign({}, p, { values: (sa.providers && sa.providers[p.key]) || {} })
    )
    return { current: sa.provider, providers }
  })

  /* ---------------- 学生登录方式：按人单独设置 ---------------- */

  /**
   * 看这个班有哪些学生单独设过。
   *
   *   GET /api/settings/student-auth/overrides?classId=xxx
   *   → { items: [{ sid, mode }], globalMode, total }
   *
   * 只回**有覆盖**的那些（大多数学生跟随全局，没必要逐行传）。
   * globalMode 一并给出，前端可以在下拉里显示「跟随全局 · 账号+密码」。
   */
  app.get('/api/settings/student-auth/overrides', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store, must-revalidate')
    const classId = String(req.query.classId || '')
    let sids = null
    if (classId) {
      const repo = await import('../lib/repo.js')
      sids = (repo.rosterOf(classId) || []).map((s) => s.sid)
    }
    const map = overrides.listOf(sids)
    const items = [...map.entries()].map(([sid, mode]) => ({ sid, mode }))
    return { items, total: items.length, globalMode: getStudentAuth().mode }
  })

  /**
   * 批量设置（单个也是传一个元素的数组，后端只有一条路径）。
   *
   *   PUT /api/settings/student-auth/overrides
   *   body: { sids: ["2515270201", ...], mode: "local" | "kg" | "" }
   *
   * mode 传空串 = **清除覆盖**，回到跟随全局。
   * 上限 500 个一次：全选一整个年级也就这个量级，再多就该分班点了。
   */
  app.put(
    '/api/settings/student-auth/overrides',
    {
      preHandler: requireAuth('teacher'),
      schema: {
        body: {
          type: 'object',
          required: ['sids'],
          properties: {
            sids: { type: 'array', items: { type: 'string' }, maxItems: 500 },
            mode: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const mode = String(req.body.mode || '').trim()
      /*
       * 合法性交给加载器判断，这里不再写死 local / kg。
       * 写死的话，新插件的 key 会被这里挡掉 —— 而且报错信息还会骗人
       * （"只能是 local / kg"，可明明界面上列出来第三种了）。
       */
      if (mode && !getProvider(mode)) throw badRequest('没有这个登录方式：' + mode + '（留空表示跟随全局）')
      const r = overrides.setMany(req.body.sids || [], mode)
      return Object.assign({ ok: true, mode }, r)
    }
  )

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
   * 教师看「已记住的密码」（明文）。
   *
   *   GET /api/settings/student-auth/creds?classId=xxx
   *
   * 只在「登录管理」面板里用 —— 学生忘了自己当初填的什么、或者要核对
   * 是不是和青果一致时，老师能直接看到。前端默认打码，点小眼睛才显示。
   *
   * 三条约束，别放松：
   *   · 必须教师身份（requireAuth('teacher')）
   *   · 不许任何一层缓存（no-store）—— 这是明文，不能留在代理 / 浏览器里
   *   · 按班过滤：只回这个班的学生，别把全校的凭据一次性倒出来
   *
   * 上一版存的是 scrypt 哈希（还原不出来），那些记录 password 为空、legacy=true，
   * 界面显示「旧记录（不可查看）」。学生用青果再验一次就会升级成可查看的加密记录。
   */
  app.get('/api/settings/student-auth/creds', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store, must-revalidate')
    const classId = String(req.query.classId || '')
    let sids = null
    if (classId) {
      const repo = await import('../lib/repo.js')
      sids = (repo.rosterOf(classId) || []).map((s) => s.sid)
    }
    const creds = await import('../lib/student-creds.js')
    const items = creds.listRemembered(sids)
    return { items, total: items.length }
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
