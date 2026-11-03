/*
 * presence.js —— 学生端「在场」心跳（双通道）
 *
 * 规则：人在页面里 = 在场；关页面 / 退出登录 = 立刻报离。
 *
 * 为什么要两条通道：
 *   1) WebSocket 在场通道 —— 主用。浏览器被强杀、断电、拔网线时 pagehide 不触发，
 *      但 TCP 一断服务端立刻知道，教师端点名页几秒内就变灰。
 *   2) HTTP 心跳 —— 兜底。代理挡掉 WS、或 WS 正在重连时，25 秒一次的心跳让
 *      老师仍然看得到人；服务端 TTL 120 秒（后台标签页会被降频到 1 次/分钟，
 *      TTL 太短会把「切窗口看别的」误判成离线）。
 *
 * 令牌不进 URL：WS 连上后第一条消息再发 auth，免得被代理/日志记下来。
 */
import { getToken } from '../api'

const PING_MS = 10000
const RECONNECT_MS = 2000

let timer = null
let ws = null
let wsTimer = null
let running = false

// 除心跳外，这条通道还负责收教师端的「跟随讲义」推送
const handlers = new Set()

/** 订阅服务端推来的控制消息；返回取消订阅函数 */
export function onPresenceMessage(fn) {
  handlers.add(fn)
  return () => handlers.delete(fn)
}

function dispatch(msg) {
  for (const fn of handlers) {
    try {
      fn(msg)
    } catch (e) {
      /* 单个订阅者出错不影响其他 */
    }
  }
}

function ping() {
  if (!getToken()) return
  fetch('/api/presence/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
    body: '{}',
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      // 心跳顺带回一个投屏状态：WS 被挡掉时，靠它把「老师开播了」送进来
      if (data && data.cast) dispatch({ t: 'cast', mode: data.cast })
    })
    .catch(() => {
      /* 网络抖动不打扰学生，下一次心跳会补上 */
    })
}

function leave() {
  const token = getToken()
  if (!token) return
  try {
    fetch('/api/presence/leave', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: '{}',
    }).catch(() => {})
  } catch (e) {
    /* ignore */
  }
}

function openWs() {
  if (!running || !getToken()) return
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
  try {
    ws = new WebSocket(proto + location.host + '/ws?role=presence')
  } catch (e) {
    ws = null
    scheduleWs()
    return
  }
  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({ t: 'auth', token: getToken() }))
    } catch (e) {
      /* ignore */
    }
  }
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch (e) {
      return
    }
    if (msg.t === 'auth-fail') {
      stopPresence()
      return
    }
    dispatch(msg)
  }
  ws.onclose = () => {
    ws = null
    scheduleWs()
  }
  ws.onerror = () => {
    /* onclose 接手 */
  }
}

function scheduleWs() {
  if (!running || wsTimer) return
  wsTimer = setTimeout(() => {
    wsTimer = null
    openWs()
  }, RECONNECT_MS)
}

function onVisible() {
  if (running && !document.hidden) ping()
}

export function startPresence() {
  if (running) return
  running = true
  ping()
  openWs()
  timer = setInterval(ping, PING_MS)
  window.addEventListener('pagehide', leave)
  window.addEventListener('beforeunload', leave)
  document.addEventListener('visibilitychange', onVisible)
}

export function stopPresence() {
  if (!running) return
  running = false
  if (timer) clearInterval(timer)
  timer = null
  if (wsTimer) clearTimeout(wsTimer)
  wsTimer = null
  if (ws) {
    try {
      ws.close()
    } catch (e) {
      /* ignore */
    }
    ws = null
  }
  window.removeEventListener('pagehide', leave)
  window.removeEventListener('beforeunload', leave)
  document.removeEventListener('visibilitychange', onVisible)
  leave()
}
