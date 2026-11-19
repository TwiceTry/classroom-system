/*
 * 模板：复制这个目录、改成你的平台名，然后填 verify()。
 *
 * 阅读顺序建议：
 *   1. 本文件（看清要写哪几块）
 *   2. ../local/index.js（最短的完整例子，没有网络请求）
 *   3. ../kg/index.js（带验证码两阶段的例子）
 *   4. ../README.md（规范全文、禁止事项、测试清单）
 *
 * 目录名以下划线开头会被加载器跳过 —— 所以这个模板不会真的生效。
 * 复制成别的名字（比如 my-school/）才开始加载。
 */
import { REASON, ok, fail } from '../types.js'

/** 契约版本，固定 1 */
export const apiVersion = 1

/** 唯一标识，会存进数据库。改成你的平台短名（小写、无空格） */
export const key = 'my-school'

/** 老师看到的名字 */
export const name = '某某平台'

/** 一句话说明，老师选方式时看这个 */
export const desc = '用某某平台的账号密码登录'

/** 要不要让系统记住密码（加密存储，老师能查看也能删） */
export const remember = true

/**
 * 登录表单要哪些字段。
 *
 * 学生端照这个**动态渲染**第二步，所以加一个新插件时登录页一行都不用改。
 * 没有字段（比如扫码）就写 []，前端会跳过输入直接提交。
 *
 * type: text | password | tel | code
 */
export const credentials = [
  {
    key: 'password',
    label: '密码',
    type: 'password',
    required: true,
    placeholder: '请输入密码',
    autocomplete: 'current-password',
    tip: '你的账号是「学号 + 密码」。',
    fallbackTip: '一直登不进去？跟老师说一声。',
  },
]

/**
 * 老师要配什么。设置页照这个渲染，插件不用写 Vue。
 *
 * type: text | password | url | url-list | bool | number | select
 */
export const settings = [
  {
    key: 'endpoint',
    label: '平台地址',
    type: 'url',
    placeholder: 'http://...',
    hint: '留空则视为未配置（登录会返回 CONFIG_ERROR）',
  },
]

/** 有图形验证码就声明；没有就删掉这三行 */
export const captcha = { kind: 'image', auto: true, maxAutoTries: 2 }

/**
 * 把平台的原始返回翻译成 Outcome。
 *
 * **单独抽成纯函数**：这样能不起服务、不打网络就写单测覆盖全部分支。
 * 分档判断尽量只写在这个函数里，verify 只负责「发请求、拿原始返回」。
 */
export function mapResult(raw) {
  // 下面这段是骨架，按你的平台改
  const status = String((raw && raw.status) || '')

  if (status === '200') return ok({})

  // 凭证错 —— 唯一会计入失败次数的一种
  if (status === '401') return fail(REASON.BAD_CREDENTIAL, '账号或密码不对')

  // 平台挂了 —— 千万别写成 BAD_CREDENTIAL，那会把人推向锁定
  if (status === '' || status === 'ERR') {
    return fail(REASON.SERVICE_DOWN, '登录服务暂时不可用，请稍后再试')
  }

  // 认不出来的一律当凭证错？不 —— 认不出来说明我们没搞懂对方，
  // 报 SERVICE_DOWN 更安全（不计失败），同时日志里能看到原始返回。
  return fail(REASON.SERVICE_DOWN, '登录服务返回了无法识别的内容，请联系老师')
}

/** 核心 */
export async function verify(ctx) {
  // ① 配置不全，先拦掉（不要发出注定失败的网络请求）
  const endpoint = String((ctx.settings && ctx.settings.endpoint) || '').trim()
  if (!endpoint) return fail(REASON.CONFIG_ERROR, '登录服务还没配好，请联系老师')

  // ② 学生已经填过验证码 → 用暂存的 session 直接提交
  if (ctx.captcha) {
    // const p = takePending(key, ctx.captcha.handle)
    // if (!p) return fail(REASON.NEED_CHALLENGE, '验证码已过期，请点「换一张」')
    // const raw = await submit(p.session, ctx.captcha.code)
    // return mapResult(raw)
  }

  // ③ 发请求。**必须透传 ctx.signal**，否则系统给的超时无效
  let raw
  try {
    const res = await fetch(endpoint + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: ctx.sid, password: ctx.credentials.password }),
      signal: ctx.signal,
    })
    raw = { status: String(res.status), body: await res.text() }
  } catch (e) {
    // 网络层异常：超时 / DNS / TLS / 连接拒绝 —— 都不是学生的错
    ctx.log({ msg: '请求失败', error: String((e && e.message) || e) })
    return fail(
      REASON.SERVICE_DOWN,
      e && e.name === 'AbortError' ? '登录服务连接超时，请稍后再试' : '登录服务暂时连不上，请稍后再试'
    )
  }

  return mapResult(raw)
}

/* ---------------- 可选钩子 ---------------- */

// 验证前：可以短路（比如维护窗口直接拒）
// export async function beforeVerify(ctx) { }

// 无论成败都调：记指标、清 session
// export async function afterVerify(result, ctx) { }

// 成功后：同步头像、拉班级
// export async function onSuccess(result, ctx) { }

// 失败后：额外上报
// export async function onFailure(result, ctx) { }
