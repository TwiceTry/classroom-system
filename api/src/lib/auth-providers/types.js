/*
 * auth-providers/types.js —— 登录插件的公共契约
 *
 * 插件只能 import 这个文件，不许碰 repo / db / config。
 * 这样插件的全部本事就限于「把某一家的登录过程跑通，并翻译成下面这几种结果」。
 *
 * ── 为什么要这么设计 ─────────────────────────────────────────────
 * 不同平台的差异有三层：
 *   ① 传输层   HTTP POST / 页面解析 / OAuth 跳转 / 扫码轮询
 *   ② 协议层   字段名（username vs account）、加解密、验证码
 *   ③ 语义层   `status:402「您已输错1次」` / `code:1「密码错误」` / `invalid_grant`
 *
 * 插件吃掉三层，只回一个 Outcome。系统只认 Outcome ——
 * 它不需要（也不该）知道「青果 402」和「正方 code:1」其实是同一件事。
 *
 * ── 最关键的一条 ────────────────────────────────────────────────
 * 「凭证错」和「平台挂了」必须分清：
 *   前者计失败、累计触发锁定；后者**绝不能计失败** ——
 *   平台挂的时候把人推向 5 次锁定，等于把学校账号一起搭进去。
 * 现在这段判断散在 auth.js 里靠中文正则猜，插件化之后由插件明确声明。
 */

/** 失败原因。系统按它决定要不要计失败、要不要熔断 */
export const REASON = {
  /** 学生输错了（密码不对）。**唯一会计入失败次数的一种** */
  BAD_CREDENTIAL: 'bad-credential',
  /** 账号被对方锁了（今天错太多次 / 管理员封禁）。不计失败，计了也没用 */
  ACCOUNT_LOCKED: 'account-locked',
  /** 需要第二因素：图形码 / 短信 / 扫码。一期只做图形码 */
  NEED_CHALLENGE: 'need-challenge',
  /** 这个人不在对方系统里（学号对不上） */
  NOT_ENROLLED: 'not-enrolled',
  /** 对方不可用：超时 / 5xx / DNS / TLS。**不计失败** */
  SERVICE_DOWN: 'service-down',
  /** 我方配置有问题（没填入口、key 过期） */
  CONFIG_ERROR: 'config-error',
  /** 当前环境跑不了这套流程（比如必须校园内网） */
  UNSUPPORTED: 'unsupported',
}

/** 这个 reason 该不该计入「密码失败」—— 只有一种 */
export function countsAsFailure(reason) {
  return reason === REASON.BAD_CREDENTIAL
}

/* ---------------- 结果构造器 ---------------- */

/**
 * 成功。
 * @param {object} [identity] { sid, name } —— 对方系统能给出姓名时带上，
 *                            没有就留空（系统以自己名册为准）
 */
export function ok(identity) {
  return { outcome: 'ok', identity: identity || null }
}

/**
 * 失败（终局）。
 *
 * @param {string} reason   REASON 里的值
 * @param {string} message  给学生看的中文，别出现 ERR_402 这种
 * @param {object} [extra]  { counter, challenge, detail }
 */
export function fail(reason, message, extra) {
  return Object.assign({ outcome: 'fail', reason, message: String(message || '') }, extra || {})
}

/**
 * 还差一步：把图形验证码交给学生自己填。
 *
 * 注意它**不是失败** —— 系统会以 200 返回，前端据此显示输入框，
 * 而不是把学生踢回第一步。用 401 会走统一的错误处理，体验全错。
 *
 * @param {object} challenge { type:'captcha', image:'data:image/png;base64,...', handle:'h_xxx' }
 * @param {string} [message]
 */
export function challenge(challenge, message) {
  return {
    outcome: 'challenge',
    challenge: challenge || null,
    message: String(message || '请输入图中的字符'),
  }
}

/* ---------------- 验证码暂存 ---------------- */

/**
 * 验证码会话暂存（插件内部用）。
 *
 * 为什么必须有它：验证码和平台 session 是绑死的 ——
 * 抓图用的是这个会话，提交也必须用同一个，否则永远是「验证码错误」。
 * 所以插件抓完图得把 { session, image } 存起来，等学生填完再取回。
 *
 * 为什么放内存不落库：验证码本来就短命（通常 2 分钟就过期），
 * 服务重启丢了让学生重来一次即可，不值得为它建表。
 *
 * handle 是不透明字符串，系统层原样透传给前端、再带回来，不解析。
 */
const PENDING_TTL_MS = 5 * 60 * 1000
const pending = new Map()

export function putPending(pluginKey, data) {
  const handle = 'h_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  pending.set(handle, { key: pluginKey, data, at: Date.now() })
  sweep()
  return handle
}

export function takePending(pluginKey, handle) {
  const v = pending.get(String(handle || ''))
  if (!v) return null
  /* 不删：学生可能手滑点两次提交，删了第二次就变成「已过期」，很困惑。
     交给 TTL 清理。 */
  if (v.key !== pluginKey) return null
  if (Date.now() - v.at > PENDING_TTL_MS) {
    pending.delete(handle)
    return null
  }
  return v.data
}

/**
 * 只看不取：这个 handle 属于哪个插件。
 *
 * 「换一张验证码」时系统只知道 handle、不知道是哪个插件 ——
 * 用它反查，避免让前端传「当前是哪个登录方式」（那会变成客户端说了算）。
 */
export function peekPending(handle) {
  const v = pending.get(String(handle || ''))
  if (!v) return null
  if (Date.now() - v.at > PENDING_TTL_MS) {
    pending.delete(handle)
    return null
  }
  return { key: v.key, data: v.data }
}

/** 顺手清一批过期的。putPending 一次扫一遍，量小无所谓 */
function sweep() {
  const now = Date.now()
  for (const [k, v] of pending) {
    if (now - v.at > PENDING_TTL_MS) pending.delete(k)
  }
}

/* ---------------- 系统侧的加载器工具 ---------------- */

/**
 * 契约版本。
 * 改了 Outcome 的形状 / 钩子的签名就要 +1 —— 加载器会拒绝版本不符的插件，
 * 好过让老插件在新系统上静默跑错。
 */
export const API_VERSION = 1

/** 校验一个插件模块是不是合法的。返回问题列表，空数组 = 通过 */
export function validatePlugin(mod, dirName) {
  const errs = []
  if (!mod) return [dirName + '：没有默认导出']
  if (mod.apiVersion !== API_VERSION) errs.push(dirName + '：apiVersion 应为 ' + API_VERSION + '，实际 ' + mod.apiVersion)
  if (!mod.key || typeof mod.key !== 'string') errs.push(dirName + '：缺 key')
  if (!mod.name || typeof mod.name !== 'string') errs.push(dirName + '：缺 name')
  if (typeof mod.verify !== 'function') errs.push(dirName + '：缺 verify()')
  if (!Array.isArray(mod.credentials)) errs.push(dirName + '：credentials 必须是数组（没有字段就写 []）')
  if (mod.settings !== undefined && !Array.isArray(mod.settings)) errs.push(dirName + '：settings 必须是数组')
  return errs
}
