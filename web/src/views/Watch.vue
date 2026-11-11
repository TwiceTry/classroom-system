<template>
  <div class="watch">
    <!-- 画面不跟窗口缩放：默认按教师机原始像素 1:1 显示，窗口装不下就出滚动条，学生自己滚 / 缩放 -->
    <div ref="scroller" class="scroller" @wheel="onWheel" @dblclick="toggleQuickZoom">
      <div class="stage">
        <canvas ref="canvas"></canvas>
      </div>
    </div>

    <div v-show="overlayShown" class="overlay" :class="{ clickable: handedOver }" @click="handedOver && resumeHere()">
      <div class="big">{{ overlayTitle }}</div>
      <div class="sub">{{ overlaySub }}</div>
    </div>

    <div v-if="debug" class="dbg">{{ debugText }}</div>
    <div v-show="toast" class="toast-bar">{{ toast }}</div>

    <div class="hud">
      <button title="缩小（键盘 -）" @click="zoomStep(-1)">－</button>
      <button class="pct" title="点击回到 100%（键盘 1）" @click="setZoom(1)">{{ pctText }}</button>
      <button title="放大（键盘 +）" @click="zoomStep(1)">＋</button>
      <i class="sep"></i>
      <button class="wide" :class="{ on: fitMode }" title="让整幅画面落进窗口（键盘 0）" @click="fitWindow()">适应窗口</button>
      <button class="wide" :class="{ on: fullscreen }" title="全屏（键盘 F）" @click="toggleFull">{{ fullscreen ? '退出全屏' : '全屏' }}</button>
    </div>
  </div>
</template>

<script setup>
/*
 * /watch —— 学生投屏观看页（从 机房投屏/student-viewer.html 搬过来）
 *
 * 这一页不套布局（但必须带学生令牌：否则「谁在看」对应不到人，服务端也会把连接关掉）。
 * 三条沿用下来的现场经验：
 *   1) 收到第一帧就显示画面，不要用可能丢失的 mode 消息去否决已经到手的帧；
 *   2) 整屏帧解码完再一次性画，别先清屏（否则每帧闪黑）；
 *   3) 已经看到过画面时断线只留底部提示，别用占位页把最后一帧盖住。
 *
 * 缩放与滚动（为什么不「等比塞满窗口」）：
 *   教师机多是 1920×1080，学生机常见 1366×768。等比塞满等于把字压到七成，后排看不清。
 *   所以默认 1:1 原始像素显示，窗口装不下就出滚动条让学生自己滚；
 *   再给 －/＋、适应窗口、全屏三个按钮兜住「要看全貌」的需求。比例记在本机。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getToken } from '../api'

const canvas = ref(null)
const scroller = ref(null)
const overlayShown = ref(true)
const overlayTitle = ref('正在连接教师机…')
const overlaySub = ref('请稍候')
const toast = ref('')
const debug = ref(false)
const debugText = ref('')
// 被另一个窗口接管（同一学生只留一个在看）：不再自动重连，等学生自己点
let handedOver = false

const zoom = ref(1) // 1 = 100%，即教师机原始像素
const fitMode = ref(false) // 处在「适应窗口」：窗口大小变了跟着重算
const fullscreen = ref(false)
const pctText = computed(() => Math.round(zoom.value * 100) + '%')

const ZOOM_MIN = 0.2
const ZOOM_MAX = 4
const ZOOM_STEPS = [0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]
const ZOOM_KEY = 'cast-zoom'

const qs = location.search.replace(/^\?/, '')
function param(name, def) {
  const m = new RegExp('(^|&)' + name + '=([^&]*)').exec(qs)
  return m ? decodeURIComponent(m[2]) : def
}

debug.value = param('debug', '0') === '1'
const HOST = param('host', location.host || '')

let ws = null
let ctx = null
let mode = 'idle'
let dw = 1024
let dh = 768
let hasFrame = false
let lastFrameIndex = -1
let wholeSeq = 0
let wholeDrawn = 0
let retry = 1000
let connectedOnce = false
let failAt = 0
let retryTimer = null
let statTimer = null
let statAt = Date.now()
const stat = { frames: 0, bytes: 0, fps: 0, kbps: 0, tiles: 0, drops: 0, keys: 0, bad: 0 }

const cid = (() => {
  try {
    let v = localStorage.getItem('cast-cid')
    if (!v) {
      v = 'c' + Math.random().toString(36).slice(2, 10)
      localStorage.setItem('cast-cid', v)
    }
    return v
  } catch (e) {
    return 'c' + Math.random().toString(36).slice(2, 10)
  }
})()

function showOverlay(title, sub) {
  overlayTitle.value = title
  overlaySub.value = sub || ''
  overlayShown.value = true
}

function hideOverlay() {
  overlayShown.value = false
}

function showToast(text) {
  toast.value = text
}

function hideToast() {
  toast.value = ''
}

function applyMode(m) {
  mode = m
  if (m === 'idle') {
    /*
     * 老师开播时如果是「自动把学生送到这一页」的（castWatch 记了来源），
     * 停播就把他送回去 —— 否则学生停在一块黑底提示上，还得自己找路回课件，
     * 而老师可能已经切去讲课了。
     *
     * 只对自动跳来的生效：学生自己点「课堂投屏」进来的没有 cast-from，就留在这页。
     */
    let back = ''
    try {
      back = sessionStorage.getItem('cast-from') || ''
      sessionStorage.removeItem('cast-from')
    } catch (e) {
      /* 隐私模式读不到就留在本页 */
    }
    if (back && back !== location.pathname + location.search) {
      location.replace(back)
      return
    }
    showOverlay('本节课未投屏', '请等待教师开始广播')
  } else if (hasFrame) hideOverlay()
  else showOverlay('正在接收画面…')
}

function decode(blob, fn) {
  if (window.createImageBitmap) {
    createImageBitmap(blob).then(
      (bmp) => {
        try {
          fn(bmp)
        } finally {
          if (bmp.close) bmp.close()
        }
      },
      () => {
        /* 解码失败不致命：等下一帧，或等教师端的整屏校准 */
      }
    )
  } else {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      fn(img)
      URL.revokeObjectURL(url)
    }
    img.onerror = () => URL.revokeObjectURL(url)
    img.src = url
  }
}

function drawWhole(bytes, mime) {
  const seq = ++wholeSeq
  decode(new Blob([bytes], { type: mime }), (src) => {
    if (seq < wholeDrawn) return // 迟到的旧帧不许覆盖新帧
    wholeDrawn = seq
    if (src.width < dw || src.height < dh) ctx.clearRect(0, 0, dw, dh)
    ctx.drawImage(src, 0, 0)
  })
}

function renderFrame(buffer) {
  const dv = new DataView(buffer)
  if (dv.getUint8(0) !== 1) return
  const flags = dv.getUint8(1)
  const frameIndex = dv.getUint16(2, true)
  const nw = dv.getUint16(4, true)
  const nh = dv.getUint16(6, true)
  const tileSize = dv.getUint16(8, true)
  const tileCount = dv.getUint16(10, true)
  const mime = flags & 2 ? 'image/webp' : 'image/jpeg'

  const cv = canvas.value
  if (cv.width !== nw || cv.height !== nh) {
    dw = nw
    dh = nh
    cv.width = dw
    cv.height = dh
    // 教师机分辨率变了：在「适应窗口」里就重算，否则守住学生自己选的比例
    if (fitMode.value) fitWindow(false)
    else applyZoom()
  }

  if (lastFrameIndex >= 0 && frameIndex > lastFrameIndex + 1) stat.drops += frameIndex - lastFrameIndex - 1
  lastFrameIndex = frameIndex

  const cols = Math.ceil(dw / tileSize)
  let off = 16

  if (flags & 1) {
    const wholeLen = dv.getUint32(off, true)
    off += 4
    if (off + wholeLen <= buffer.byteLength) {
      drawWhole(new Uint8Array(buffer, off, wholeLen), mime)
      stat.keys++
    } else {
      stat.bad++
    }
  } else {
    for (let i = 0; i < tileCount; i++) {
      if (off + 8 > buffer.byteLength) break
      const idx = dv.getUint16(off, true)
      off += 2
      let tw = dv.getUint8(off)
      off += 1
      let th = dv.getUint8(off)
      off += 1
      const len = dv.getUint32(off, true)
      off += 4
      if (off + len > buffer.byteLength) break
      const bytes = new Uint8Array(buffer, off, len)
      off += len
      const tx = (idx % cols) * tileSize
      const ty = Math.floor(idx / cols) * tileSize
      if (tw <= 0) tw = tileSize
      if (th <= 0) th = tileSize
      drawTile(bytes, tx, ty, mime)
      stat.tiles++
    }
  }

  stat.frames++
  stat.bytes += buffer.byteLength
  if (!hasFrame) {
    hasFrame = true
    hideOverlay()
  }
}

function drawTile(bytes, x, y, mime) {
  decode(new Blob([bytes], { type: mime }), (src) => ctx.drawImage(src, x, y))
}

function send(obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj))
    } catch (e) {
      /* ignore */
    }
  }
}

function onControl(msg) {
  if (msg.t === 'ping') return send({ t: 'pong' })
  if (msg.t === 'mode') return applyMode(msg.mode)
  if (msg.t === 'taken-over') {
    // 另一个窗口（应用内页面/新标签页）接管了投屏：这个窗口停止接收，省带宽
    handedOver = true
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    try {
      ws && ws.close()
    } catch (e) {
      /* 已经断了 */
    }
    ws = null
    showOverlay('已在另一个窗口观看投屏', '这个窗口已经停止接收画面（省带宽）· 点这里换回本窗口')
    return
  }
  if (msg.t === 'error') {
    // 比如令牌失效被服务端拒绝：别再无限重连了，直接说清楚
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    showOverlay('需要登录才能观看投屏', msg.message || '请先在学生端用学号登录，再打开本页')
  }
}

/* ---------------- 缩放 / 滚动 ---------------- */

function clampZ(z) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
}

function applyZoom() {
  const cv = canvas.value
  if (!cv) return
  cv.style.width = Math.max(1, Math.round(dw * zoom.value)) + 'px'
  cv.style.height = Math.max(1, Math.round(dh * zoom.value)) + 'px'
}

function saveZoom() {
  try {
    localStorage.setItem(ZOOM_KEY, String(Math.round(zoom.value * 1000) / 1000))
    localStorage.setItem(ZOOM_KEY + '-fit', fitMode.value ? '1' : '0')
  } catch (e) {
    /* 存不下就算了，不影响看 */
  }
}

/** 整幅画面落进窗口（工具栏按钮 / 键盘 0 / 双击的一半） */
function fitWindow(save) {
  const sc = scroller.value
  if (!sc) return
  const pad = 16
  const w = Math.max(80, sc.clientWidth - pad)
  const h = Math.max(80, sc.clientHeight - pad)
  fitMode.value = true
  zoom.value = clampZ(Math.min(w / dw, h / dh))
  applyZoom()
  if (save !== false) saveZoom()
}

/**
 * 以 (cx,cy) 为锚点缩放：鼠标指着哪儿，缩放后那儿还留在原地。
 * 不传坐标就按窗口中心；滚动位置一起补偿，免得「放大一下就跳走」。
 */
function setZoom(z, cx, cy) {
  const cv = canvas.value
  const sc = scroller.value
  if (!cv || !sc) return
  const target = clampZ(z)
  const before = cv.getBoundingClientRect()
  const srect = sc.getBoundingClientRect()
  const anchorX = cx == null ? srect.left + srect.width / 2 : cx
  const anchorY = cy == null ? srect.top + srect.height / 2 : cy
  const ax = anchorX - before.left
  const ay = anchorY - before.top
  const k = target / (zoom.value || 1)
  fitMode.value = false
  zoom.value = target
  applyZoom()
  const after = cv.getBoundingClientRect()
  sc.scrollLeft += after.left + ax * k - anchorX
  sc.scrollTop += after.top + ay * k - anchorY
  saveZoom()
}

function zoomStep(dir) {
  const z = zoom.value
  const list = dir > 0 ? ZOOM_STEPS : ZOOM_STEPS.slice().reverse()
  const next = dir > 0 ? list.find((s) => s > z + 0.001) || ZOOM_MAX : list.find((s) => s < z - 0.001) || ZOOM_MIN
  setZoom(next)
}

/** 双击画面：适应窗口 ⇄ 100% 来回切，比去点按钮快 */
function toggleQuickZoom() {
  if (fitMode.value) setZoom(1)
  else fitWindow()
}

function onWheel(e) {
  // 普通滚轮留给浏览器滚动（这正是学生要的）；Ctrl/⌘ + 滚轮才缩放
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  setZoom(zoom.value * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY)
}

function toggleFull() {
  if (!document.fullscreenElement) {
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {})
  } else if (document.exitFullscreen) {
    document.exitFullscreen().catch(() => {})
  }
}

function onFsChange() {
  fullscreen.value = !!document.fullscreenElement
}

function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const k = e.key
  if (k === '+' || k === '=') {
    zoomStep(1)
    e.preventDefault()
  } else if (k === '-' || k === '_') {
    zoomStep(-1)
    e.preventDefault()
  } else if (k === '0') {
    fitWindow()
    e.preventDefault()
  } else if (k === '1') {
    setZoom(1)
    e.preventDefault()
  } else if (k === 'f' || k === 'F') {
    toggleFull()
    e.preventDefault()
  }
}

function onResize() {
  if (fitMode.value) fitWindow(false)
}

function connect() {
  if (!HOST) {
    showOverlay('这一页不能直接打开', '请从课堂系统里点「课堂投屏」进来，不要把这个文件存到本机双击')
    return
  }
  // 观看投屏要身份：没有令牌就别连，免得服务端一直拒
  if (!getToken()) {
    showOverlay('请先用学号登录', '观看投屏需要学生身份，登录后会自动回到本页')
    return
  }
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
  try {
    ws = new WebSocket(proto + HOST + '/ws?role=student')
  } catch (e) {
    scheduleRetry()
    return
  }
  ws.binaryType = 'arraybuffer'

  ws.onopen = () => {
    retry = 1000
    connectedOnce = true
    failAt = 0
    hideToast()
    if (hasFrame) hideOverlay()
    // 带上学生令牌（若这台机器登录过学生端）：教师端就能看到「谁正在看投屏」
    send({
      t: 'hello',
      cid,
      w: window.innerWidth,
      h: window.innerHeight,
      ua: navigator.userAgent,
      token: getToken() || '',
    })
    if (!hasFrame) showOverlay('已连接，等待画面…')
  }

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        onControl(JSON.parse(ev.data))
      } catch (e) {
        /* 坏消息忽略 */
      }
      return
    }
    renderFrame(ev.data)
  }

  ws.onclose = () => {
    if (!handedOver) onDown()
  }
  ws.onerror = () => {
    /* onclose 接手 */
  }
}

/** 被接管后想换回本窗口：点一下重新连（同时会把另一个窗口踢下线） */
function resumeHere() {
  handedOver = false
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  hasFrame = false
  showOverlay('正在接管投屏…', '稍等')
  connect()
}

function onDown() {
  if (!failAt) failAt = Date.now()
  if (hasFrame) showToast('与教师机的连接中断，正在重连…')
  else showOverlay(connectedOnce ? '与教师机的连接已断开' : '正在连接教师机…', '正在自动重连…')
  scheduleRetry()
}

function scheduleRetry() {
  const wait = retry
  retry = Math.min(retry * 2, 5000)
  if (failAt) {
    const sec = Math.floor((Date.now() - failAt) / 1000)
    if (sec >= 15) {
      if (hasFrame) showToast('已断开 ' + sec + ' 秒 · 请告诉老师检查教师机')
      else showOverlay('还没连上教师机', '已等待 ' + sec + ' 秒。请举手告诉老师。')
    }
  }
  retryTimer = setTimeout(connect, wait)
}

function startDebug() {
  if (!debug.value) return
  statTimer = setInterval(() => {
    const now = Date.now()
    const dt = (now - statAt) / 1000
    stat.fps = Math.round(stat.frames / dt)
    stat.kbps = Math.round((stat.bytes * 8) / dt / 1000)
    statAt = now
    stat.frames = 0
    stat.bytes = 0
    debugText.value =
      'mode  ' + mode + '\nframe ' + lastFrameIndex + '\nfps   ' + stat.fps + '\nkbps  ' + stat.kbps +
      '\ntiles ' + stat.tiles + '\nkey   ' + stat.keys + '\nbad   ' + stat.bad + '\ndrop  ' + stat.drops + '\n' + HOST
    stat.tiles = 0
  }, 1000)
  setInterval(() => send({ t: 'stat', fps: stat.fps, kbps: stat.kbps }), 5000)
}

onMounted(() => {
  ctx = canvas.value.getContext('2d')
  // 记住上次的比例：「适应窗口」还是固定百分比，各人各机各不相同
  try {
    const z = parseFloat(localStorage.getItem(ZOOM_KEY))
    if (z > 0) zoom.value = clampZ(z)
    fitMode.value = localStorage.getItem(ZOOM_KEY + '-fit') === '1'
  } catch (e) {
    /* 读不到就用默认 100% */
  }
  if (fitMode.value) fitWindow(false)
  else applyZoom()
  applyMode('idle')
  connect()
  startDebug()
  window.addEventListener('resize', onResize)
  window.addEventListener('keydown', onKey)
  document.addEventListener('fullscreenchange', onFsChange)
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('fullscreenchange', onFsChange)
  if (retryTimer) clearTimeout(retryTimer)
  if (statTimer) clearInterval(statTimer)
  if (ws) ws.close()
})
</script>

<style scoped>
/* 被接管时的提示可以点一下换回来 */
.overlay.clickable {
  cursor: pointer;
}

.watch {
  position: fixed;
  inset: 0;
  background: #111;
  overflow: hidden;
}

/* 滚动容器：窗口装不下画面时出滚动条，学生自己滚 */
.scroller {
  position: absolute;
  inset: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.scroller::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}

.scroller::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.22);
  border: 3px solid #111;
  border-radius: 4px;
}

.scroller::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.36);
}

.scroller::-webkit-scrollbar-track {
  background: transparent;
}

/* 画面比窗口小的时候居中；比窗口大时靠 margin:auto 归零贴左上，不被裁掉一截 */
.stage {
  display: flex;
  min-width: 100%;
  min-height: 100%;
  padding: 8px;
  box-sizing: border-box;
}

canvas {
  display: block;
  margin: auto;
  background: #000;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06);
}

/* 缩放控件：固定尺寸，不随窗口走，也不跟着画面滚 */
.hud {
  position: fixed;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.62);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  opacity: 0.55;
  transition: opacity 0.16s;
}

.hud:hover {
  opacity: 1;
}

.hud button {
  border: 0;
  padding: 7px 9px;
  border-radius: 4px;
  background: transparent;
  color: #e5e7eb;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.hud button:hover {
  background: rgba(255, 255, 255, 0.14);
}

.hud .pct {
  min-width: 56px;
  color: #fbbf24;
  font-variant-numeric: tabular-nums;
}

.hud .wide {
  font-size: 12.5px;
}

.hud .wide.on {
  background: rgba(251, 191, 36, 0.18);
  color: #fbbf24;
}

.hud .sep {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: rgba(255, 255, 255, 0.18);
}

.overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: #111;
  color: #d8d8d8;
  text-align: center;
  font-family: 'Microsoft YaHei', 'SimHei', sans-serif;
}

.overlay .big {
  font-size: 26px;
  color: #f0f0f0;
}

.overlay .sub {
  font-size: 14px;
  color: #8a8a8a;
  max-width: 76vw;
  line-height: 1.7;
}

.dbg {
  position: fixed;
  z-index: 30;
  right: 10px;
  top: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  color: #9fe1cb;
  font: 12px/1.5 Consolas, monospace;
  white-space: pre;
}

.toast-bar {
  position: fixed;
  z-index: 25;
  left: 50%;
  bottom: 62px;
  transform: translateX(-50%);
  padding: 8px 16px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.66);
  color: #ffd9a0;
  font-size: 14px;
  white-space: nowrap;
}
</style>
