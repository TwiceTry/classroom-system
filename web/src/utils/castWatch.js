/*
 * castWatch.js —— 学生端「老师一开播，自动把投屏页打开」
 *
 * 浏览器有一条硬规矩：**没有用户点击，脚本不许开新标签页**（Chrome/Safari 一律拦，
 * 返回 null）。所以这里分三层尽力，不假装能做到更多：
 *
 *   1) 已经有窗口引用（本会话里点过侧栏「课堂投屏」，或上一次开播自动开过）→
 *      直接把那个标签页导航到 /watch 并拉到前台，**不需要再点**；
 *   2) 没引用 → 先试一次 window.open（学生刚点过页面时，浏览器会放行）；
 *   3) 被拦 → 在学生端顶部挂一条横幅「老师开始投屏了」，点一下即开。
 *      这一次点击之后就有了引用，**这节课后面再开播都能走第 1 层**。
 *
 * 状态从两条路来：在场通道的 WS 推送（秒级），加上心跳回包里的 cast 字段（兜底）。
 */
import { reactive } from 'vue'
import { getToken } from '../api'
import { onPresenceMessage } from './presence'

const WATCH_PATH = '/watch'
const WIN_NAME = 'pg-cast' // 用固定名字：重复 open 只会复用同一个标签页
const POLL_MS = 20000

export const castWatch = reactive({
  casting: false, // 老师正在投屏
  banner: false, // 需要学生点一下才能开
  hint: '',
  muted: false, // 学生点了「先不看」，本次开播不再打扰
})

let win = null // 投屏页窗口引用（拿到它就不用再点了）
let unsub = null
let pollTimer = null
let started = false

function alive() {
  try {
    return !!win && !win.closed
  } catch (e) {
    return false
  }
}

function reuse() {
  if (!alive()) return false
  try {
    if (win.location.pathname !== WATCH_PATH) win.location.replace(WATCH_PATH)
    win.focus()
    return true
  } catch (e) {
    // 引用失效或跨域：当没有
    win = null
    return false
  }
}

/** 打开（或复用）投屏页；返回 true 表示屏幕上已有这个窗口 */
export function openWatch() {
  if (reuse()) {
    castWatch.banner = false
    return true
  }
  let w = null
  try {
    w = window.open(WATCH_PATH, WIN_NAME)
  } catch (e) {
    w = null
  }
  if (w && !w.closed) {
    win = w
    castWatch.banner = false
    return true
  }
  return false
}

/** 横幅上的「先不看」：这次不打扰，老师下次开播再问 */
export function dismissCastWatch() {
  castWatch.muted = true
  castWatch.banner = false
}

function apply(mode) {
  const casting = mode === 'watch'
  const was = castWatch.casting
  castWatch.casting = casting

  if (!casting) {
    castWatch.banner = false
    castWatch.muted = false // 停播了，下一轮重新提醒
    return
  }
  if (was) return // 本来就在投，别反复提醒
  if (castWatch.muted) return
  // 不再自动弹新窗口（学生可能正看到一半）：只挂一条横幅，点一下在应用内打开
  castWatch.banner = true
  castWatch.hint = '点一下在这里打开，也可以自己去「课堂投屏」'
}

async function poll() {
  try {
    // 这个接口要登录（不登录的话课堂状态就成公开信息了）
    const token = getToken()
    if (!token) return
    const r = await fetch('/api/cast/status', { headers: { Authorization: 'Bearer ' + token } })
    if (!r.ok) return
    const j = await r.json()
    if (j && j.mode) apply(j.mode)
  } catch (e) {
    /* 网络抖动忽略，WS 与下一次轮询会补 */
  }
}

function onVisible() {
  if (!document.hidden) poll()
}

export function startCastWatch() {
  if (started) return
  started = true
  unsub = onPresenceMessage((m) => {
    if (m && m.t === 'cast') apply(m.mode)
  })
  poll()
  pollTimer = setInterval(() => {
    if (!document.hidden) poll()
  }, POLL_MS)
  document.addEventListener('visibilitychange', onVisible)
}

export function stopCastWatch() {
  if (!started) return
  started = false
  if (unsub) unsub()
  unsub = null
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  document.removeEventListener('visibilitychange', onVisible)
  castWatch.casting = false
  castWatch.banner = false
}
