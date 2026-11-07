/*
 * lib/kg-auth.js —— 用「青果智慧校园平台」校验学生身份
 *
 * 场景：教师端可以把学生登录方式切成两种
 *   ① local（默认）—— 学号 + 姓名，和课程系统名单比对（不联网）
 *   ② kg          —— 学生输学号 + 青果密码，能登上青果就放行
 * 这里只负责 ② 的那一次校验，账号即学号（老师确认过，不做映射表）。
 *
 * 三条硬约束（都关乎学生账号安全）：
 *   1. **绝不自动重试**。青果按天记失败次数，满 5 次锁号；
 *      自动换验证码重试等于拿学生的账号去赌识别率。一次不过就返回。
 *   2. **密码不落盘、不进日志**。只在这一层的内存里待一瞬间。
 *   3. **超时兜底**。青果是外网服务，卡住不能把课程系统的登录接口一起拖死。
 *
 * 两个入口（8888 / 9999）内容一样，按请求轮询分流；
 * 失败不换另一个再试 —— 换了也只是再消耗一次失败机会。
 */

import * as kg from './kglogin/kglogin.js'
import { DEFAULT_KG_BASES } from '../config.js'

/** 默认入口只在 config.js 定义一份，这里复用，免得两处对不上 */
export const DEFAULT_BASES = DEFAULT_KG_BASES

/** 轮询指针：两个入口交替用，避免总打同一个 */
let rr = 0

/** 把 promise 套一层超时（青果挂掉时不能拖住登录接口） */
function withTimeout(promise, ms) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** 从 bases 里挑一个（轮询）；非法 URL 直接跳过 */
function pickBase(bases) {
  const list = (Array.isArray(bases) ? bases : DEFAULT_BASES)
    .map((b) => String(b || '').trim().replace(/\/+$/, ''))
    .filter((b) => /^https?:\/\//i.test(b))
  if (!list.length) return ''
  const b = list[rr % list.length]
  rr = (rr + 1) % 1e9
  return b
}

/**
 * 校验一个学生的青果账号。
 *
 * @param {string} sid      学号（也是青果账号）
 * @param {string} password 青果密码（明文，只在内存里过一遍）
 * @param {object} opts     { bases, timeoutMs }
 * @returns {{ok:boolean, message:string, base?:string}}
 *          ok=false 时 message 是可以直接显示给学生的中文说明
 */
export async function verifyStudent(sid, password, opts = {}) {
  const base = pickBase(opts.bases)
  if (!base) return { ok: false, message: '学校没配置青果登录地址，请联系老师' }

  const timeoutMs = Number(opts.timeoutMs || 20000)

  let r
  try {
    r = await withTimeout(
      kg.login({
        base,
        username: String(sid || '').trim(),
        password: String(password || ''),
        captcha: '',
        maxTries: 1, // 关键：一次不过就停，绝不拿学生账号赌验证码识别
        forceCaptcha: false,
        log: () => {}, // 不回显任何与凭据有关的过程信息
      }),
      timeoutMs
    )
  } catch (e) {
    const isTimeout = e && e.message === 'timeout'
    return {
      ok: false,
      message: isTimeout
        ? '连接青果超时（' + base + '），请稍后再试'
        : '连不上青果（' + base + '）：' + String((e && e.message) || e).slice(0, 60),
    }
  }

  const status = String((r && r.status) || '')
  const msg = String((r && r.message) || '')
  const counter = Number((r && r.counter) || 0)

  if (status === '200') return { ok: true, message: '', base }

  /*
   * 402 的原文是「您24小时内已输错 N 次密码，若超过5次，您的账号将被锁定！」
   * —— 它说的是**已经错了几次**，不是已经锁了。
   * 用 /锁定/ 去匹配会把这句话误判成「账号已锁定」，对学生是误导
   * （明明只是密码打错，却告诉他号废了）。按 counter 分档才准。
   */
  if (status === '402') {
    if (counter >= 5) {
      return { ok: false, message: '青果提示：今天输错次数已满，账号被锁定了，明天再试或找老师' }
    }
    return {
      ok: false,
      message: counter
        ? '学号或密码不对（今天已错 ' + counter + ' 次，满 5 次会锁号）'
        : '学号或密码不对',
    }
  }
  if (status === '505') {
    return { ok: false, message: '这个账号需要短信二次验证，请先在青果网页上登录一次' }
  }
  if (status === '401' || /验证码/.test(msg)) {
    return { ok: false, message: '青果的验证码没认对，请再点一次登录' }
  }
  if (/密码|账号/.test(msg)) {
    return { ok: false, message: '学号或密码不对' }
  }
  if (status === 'ERR') {
    return { ok: false, message: '青果返回了看不懂的内容，请稍后再试' }
  }
  return { ok: false, message: '青果拒绝登录：' + (msg || '未知原因').slice(0, 60) }
}
