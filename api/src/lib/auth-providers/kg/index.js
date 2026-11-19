/*
 * kg 插件：青果平台（账号 + 密码 + 图形验证码）
 *
 * ── 平台的验证码机制（实测确认，不是猜的）──────────────────────
 *   · 首屏 yzmbt=0 时不用带码就能提交
 *   · 但应答 message 形如「…|N」（N=当日失败次数），N>=2 或 yzmbt=1 或上次报错后，
 *     浏览器就会显示验证码框，之后每次提交必须带 randnumber
 *   · 带了验证码就真校验：错了返回 401「验证码有误!」，且**不累计**密码失败次数
 *   · 密码错返回 402（带失败计数），累计 5 次锁号
 *
 * ── 本插件的验证码两阶段 ────────────────────────────────────────
 *   自动识别 × 2（一次请求内跑完，学生无感）
 *     第 1 次失败 → 若判定是「密码错」立刻停手（别折腾验证码）；否则计一次
 *     第 2 次失败 → 不管什么原因都停
 *   仍没过 → 抓一张新图交给学生自己填（challenge）
 *   学生手填错 1 次 → 终局，「找老师」（B 方案）
 */
import { REASON, ok, fail, challenge, putPending, takePending } from '../types.js'
import * as kg from '../../kglogin/kglogin.js'

export const apiVersion = 1
export const key = 'kg'
export const name = '青果平台'
export const desc = '用学校平台的账号密码登录'
export const remember = true

export const captcha = { kind: 'image', auto: true, maxAutoTries: 2 }

export const credentials = [
  {
    key: 'password',
    label: '密码',
    type: 'password',
    required: true,
    placeholder: '请输入密码',
    autocomplete: 'current-password',
    tip: '你的账号是「学号 + 密码」，密码和学校平台一致。',
    fallbackTip: '一直登不进去？可能是密码和学校平台对不上了。跟老师说一声，老师可以临时把你改成「学号 + 姓名」登录。',
  },
]

export const settings = [
  {
    key: 'bases',
    label: '平台入口',
    type: 'url-list',
    hint: '填一个或多个，多个会轮询分流。全空则登录返回「没配好」',
  },
  {
    key: 'verifyEachTime',
    label: '每次登录都向平台核验',
    type: 'bool',
    default: false,
    hint: '关闭（默认）：通过一次后记住密码，之后本地比对，省一次 1.3 秒的往返',
  },
]

/* ---------------- 原始返回 → Outcome ---------------- */

/**
 * 把青果的返回翻译成标准结果。
 *
 * **纯粹是为了能测**：不起服务、不打网络，直接喂 {status, message, counter} 就能
 * 覆盖全部分支。青果这套 status 语义（402 分档、505、401、ERR）值得单独钉死。
 */
export function mapResult(raw) {
  const r = raw || {}
  const status = String(r.status || '')
  const message = String(r.message || '')
  const counter = Number(r.counter || 0)

  /* 青果登录成功只给 result 串，不给姓名 —— 身份以本系统名册为准，这里 identity 留空 */
  if (status === '200') return ok()

  /* 402：密码错。counter 是对方自报的「今天已错几次」 */
  if (status === '402') {
    if (counter >= 5) {
      return fail(REASON.ACCOUNT_LOCKED, '今天输错次数已满，账号被锁定了，明天再试或找老师', { counter })
    }
    return fail(
      REASON.BAD_CREDENTIAL,
      counter ? `账号或密码不对（今天已错 ${counter} 次，满 5 次会锁定）` : '账号或密码不对',
      { counter }
    )
  }

  /* 505：要短信验证。一期不做回填，让学生找老师 */
  if (status === '505') {
    return fail(REASON.NEED_CHALLENGE, '这个账号需要短信验证，请先完成验证后再登录', {
      challenge: { type: 'sms' },
    })
  }

  /* 401 / 文案里带「验证码」：图形码这次没过 */
  if (status === '401' || /验证码/.test(message)) {
    return fail(REASON.NEED_CHALLENGE, '验证码没验过', { challenge: { type: 'captcha' } })
  }

  /* ERR 是插件内部给的（网络层/解析失败），见下面 verify 里的 catch */
  if (status === 'ERR') {
    return fail(REASON.SERVICE_DOWN, '登录服务暂时不可用，请稍后再试')
  }

  /* 文案明确提到密码/账号 → 按凭证错处理 */
  if (/密码|账号/.test(message)) {
    return fail(REASON.BAD_CREDENTIAL, '账号或密码不对', { counter })
  }

  /*
   * 认不出来的，按「服务不可用」处理 —— **不要默认当凭证错**。
   * 当凭证错会记一次失败，而这类情况往往是平台改版、返回了没见过的结构，
   * 把学生推向锁定纯属误伤。SERVICE_DOWN 不计失败，日志里也能看到原始 message。
   */
  return fail(REASON.SERVICE_DOWN, '登录服务返回了无法识别的内容，请联系老师')
}

/* ---------------- 工具 ---------------- */

/** 从 settings.bases 里挑一个（轮询分流） */
let rr = 0
function pickBase(bases) {
  const list = (Array.isArray(bases) ? bases : [])
    .map((b) => String(b || '').trim().replace(/\/+$/, ''))
    .filter((b) => /^https?:\/\//i.test(b))
  if (!list.length) return ''
  const b = list[rr % list.length]
  rr = (rr + 1) % 1e9
  return b
}

/** 这个结果是不是「验证码没过」（继续下一步有意义） */
function isCaptchaIssue(r) {
  return r && r.outcome === 'fail' && r.reason === REASON.NEED_CHALLENGE && r.challenge && r.challenge.type === 'captcha'
}

/**
 * 在给定 session 上提交一次（带码或不带码）。
 * 学生填完验证码之后也走这里 —— 保证两条路径的请求构造完全一致。
 */
async function submitOnce(ses, base, info, sid, password, code) {
  const cr = kg.createCrypto()
  const built = await kg.buildLoginBody(ses, base, cr, {
    username: sid,
    password,
    captcha: code || '',
    sessionid: info.sessionid,
    ssessionid: info.ssessionid,
  })
  const res = await ses.postForm(`${base}/cas/logon.action`, built.body)
  let data
  try {
    data = JSON.parse(res.text)
  } catch (e) {
    /* 返回的不是 JSON：多半是被网关/防火墙挡了，原样带回去给日志看 */
    return { status: 'ERR', message: String(res.text || '').slice(0, 200), counter: 0 }
  }
  const raw = {
    status: String(data.status),
    message: String(data.message ?? '').split('|')[0],
    counter: 0,
  }
  const cnt = String(data.message ?? '').split('|')[1]
  if (cnt && /^\d+$/.test(cnt)) raw.counter = Number(cnt)
  return raw
}

/* ---------------- 核心 ---------------- */

export async function verify(ctx) {
  const bases = (ctx.settings && ctx.settings.bases) || []
  const base = pickBase(bases)
  if (!base) return fail(REASON.CONFIG_ERROR, '登录服务还没配好，请联系老师')

  const password = String((ctx.credentials && ctx.credentials.password) || '')
  if (!password) return fail(REASON.BAD_CREDENTIAL, '请输入密码')

  const sid = ctx.sid

  /* ===== 分支 A：学生已经填过图形码 → 用暂存的 session 提交一次 ===== */
  if (ctx.captcha && ctx.captcha.handle) {
    const p = takePending(key, ctx.captcha.handle)
    if (!p) {
      return fail(REASON.NEED_CHALLENGE, '验证码已过期，请点「换一张」重新获取')
    }
    let raw
    try {
      raw = await submitOnce(p.session, p.base, p.info, sid, password, ctx.captcha.code)
    } catch (e) {
      ctx.log({ msg: '提交验证码时出错', error: String((e && e.message) || e) })
      return fail(REASON.SERVICE_DOWN, '登录服务暂时连不上，请稍后再试')
    }
    const r = mapResult(raw)
    ctx.log({ msg: '人工验证码提交', status: raw.status, counter: raw.counter, reason: r.reason || 'ok' })

    /*
     * B 方案：学生手填错**一次**就终局。
     * 不再给他第二次 —— 连续错下去只会把平台账号推向锁定，
     * 而且这时候问题多半不在他（平台改版 / 识别一直不过 / 会话已经乱了）。
     */
    if (isCaptchaIssue(r)) {
      return fail(REASON.NEED_CHALLENGE, '验证码没填对，请找老师帮你处理', { challenge: { type: 'captcha' } })
    }
    return r
  }

  /* ===== 分支 B：首次提交，自动识别最多两次 ===== */
  let lastSes = null
  let lastInfo = null
  let lastRaw = null
  let lastReason = ''

  for (let i = 0; i < 2; i++) {
    const ses = new kg.Session()
    let page, info
    try {
      ;({ page, info } = await kg.openLoginPage(ses, base))
    } catch (e) {
      ctx.log({ msg: '打开登录页失败（第 ' + (i + 1) + ' 次）', error: String((e && e.message) || e) })
      return fail(REASON.SERVICE_DOWN, '登录服务暂时连不上，请稍后再试')
    }

    /*
     * 要不要带验证码：
     *   首屏 yzmbt=1 → 必须带
     *   第 2 次（上次已经失败过）→ 带
     *   counter >= 2（对方已经数到 2 次）→ 带
     */
    const needCap = info.yzmbt === '1' || i > 0 || Number(info.counter || 0) >= 2
    let code = ''
    if (needCap) {
      try {
        const s = await kg.solveCaptcha(ses, base)
        code = s.code
        ctx.log({ msg: '自动识别验证码', code: s.code, prob: Number(s.prob || 0).toFixed(2) })
      } catch (e) {
        /* 识别本身失败（OCR 库报错 / 图取不到）—— 当作这一轮没带码，继续提交 */
        ctx.log({ msg: '自动识别失败', error: String((e && e.message) || e) })
      }
    }

    let raw
    try {
      raw = await submitOnce(ses, base, info, sid, password, code)
    } catch (e) {
      ctx.log({ msg: '提交失败（第 ' + (i + 1) + ' 次）', error: String((e && e.message) || e) })
      return fail(REASON.SERVICE_DOWN, '登录服务暂时连不上，请稍后再试')
    }

    const r = mapResult(raw)
    ctx.log({
      msg: '自动提交 ' + (i + 1) + '/2',
      status: raw.status,
      counter: raw.counter,
      withCaptcha: !!code,
      reason: r.reason || 'ok',
    })

    if (r.outcome === 'ok') return r

    /*
     * 第 1 次就明确是「密码错」→ 立刻停手。
     * 继续自动识别验证码没有意义：密码是错的，填对验证码也登不进去，
     * 只会多打两次平台、多消耗对方的失败计数。
     */
    if (r.reason === REASON.BAD_CREDENTIAL || r.reason === REASON.ACCOUNT_LOCKED) return r
    /* 平台不可用 / 配置错：也不是验证码的锅 */
    if (r.reason === REASON.SERVICE_DOWN || r.reason === REASON.CONFIG_ERROR) return r

    lastSes = ses
    lastInfo = info
    lastRaw = raw
    lastReason = r.reason
  }

  /* ===== 两次自动都没过 → 抓一张新图交给学生 ===== */
  try {
    const fresh = lastSes || new kg.Session()
    const freshInfo = lastInfo || (await kg.openLoginPage(fresh, base)).info
    const s = await kg.solveCaptcha(fresh, base)
    const handle = putPending(key, { session: fresh, base, info: freshInfo })
    ctx.log({ msg: '自动两次未过，转人工验证码', lastStatus: lastRaw && lastRaw.status })
    return challenge(
      {
        type: 'captcha',
        image: 'data:image/jpeg;base64,' + Buffer.from(s.bytes || []).toString('base64'),
        handle,
      },
      lastReason === REASON.NEED_CHALLENGE
        ? '自动识别没能通过，请自己输入图中的字符'
        : '请再输入一次图中的字符'
    )
  } catch (e) {
    ctx.log({ msg: '取验证码图片失败', error: String((e && e.message) || e) })
    return fail(REASON.SERVICE_DOWN, '登录服务暂时连不上，请稍后再试')
  }
}

/* ---------------- 换一张验证码 ---------------- */

/**
 * 学生点了「换一张」。
 *
 * 用**同一个 session** 重新取图：平台那边一个会话只认最后一张，
 * 换会话反而会把之前那张作废得更彻底（而且有的平台换会话要重新走一遍登录页，慢）。
 *
 * @returns {object|null} 新的 challenge；handle 失效时返回 null（前端提示重新提交）
 */
export async function refresh({ handle }) {
  const p = takePending(key, handle)
  if (!p) return null
  const s = await kg.solveCaptcha(p.session, p.base)
  /* session 不变、只换图，所以可以沿用同一份暂存 —— 但换个新 handle 更安全
     （老的还在 TTL 里，防止两张图串用） */
  const nh = putPending(key, p)
  return {
    type: 'captcha',
    image: 'data:image/jpeg;base64,' + Buffer.from(s.bytes || []).toString('base64'),
    handle: nh,
  }
}

/* ---------------- 钩子 ---------------- */

/**
 * 成功后记一条（失败那边已经在 verify 里通过 ctx.log 记过了）。
 *
 * 这里刻意不做「记住密码」—— 那是系统层的事（加密、脱敏、可查看、可删都在那边），
 * 插件只声明 remember: true，剩下的系统来。
 */
export async function onSuccess(result, ctx) {
  ctx.log({ msg: '登录成功' })
}
