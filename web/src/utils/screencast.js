/*
 * screencast.js —— 教师端抓屏推流（从 课堂工具/机房投屏/teacher-console.html 搬过来）
 *
 * 协议一个字节都没改，所以老方案的实测结论继续有效：
 *   - 采集先降到 ≤1280×720 / ≤15fps，否则 getImageData 与 JPEG 编码撑不住；
 *   - 64×64 图块逐像素差量（容差 7），只发变化块；
 *   - 推送节奏放 Worker 定时器，避免教师全屏放 PPT 时被浏览器降频到 1 次/秒；
 *   - 一次活动停下来之后补推整屏校准帧，把丢帧残留的坏块刷回去；
 *   - 连上中继立刻发 hello，否则「学生先上线、控制台后开」时 peers=0，一帧都不推。
 */
import { reactive } from 'vue'
import { getToken } from '../api'

const TILE = 64
const MASK32 = 0xf8f8f8f8

function createScreenCast() {
  const s = reactive({
    connected: false,
    running: false,
    peers: 0,
    capW: 0,
    capH: 0,
    fps: 0,
    cost: 0,
    perMbps: 0,
    allMbps: 0,
    drops: 0,
    blocks: 0,
    frames: 0,
    msg: '',
    msgType: '',
    hidden: false,
    lastStudentAt: '',
  })

  // 默认全部最高档：跟随设备屏幕 + 15fps + q85。
  // 「模式」不默认整屏 —— 那是按台数换来的策略档，不是清晰度档，
  // 整屏模式单台 3–10 Mbps，一个班 40 台会把交换机打死。
  const cfg = reactive({
    resMode: 'screen', // 'screen' 跟随设备屏幕 | 'viewport' 跟随当前窗口 | 'manual' 固定档
    maxW: 1280, // manual 时才用
    maxH: 720,
    fps: 15,
    quality: 0.85,
    mode: 'diff', // diff | full
    settleMs: 2000,
    keyMaxMs: 60000,
  })

  /** 按当前档位算出「目标采集尺寸」 */
  function targetSize() {
    if (cfg.resMode === 'screen') {
      return {
        w: Math.max(320, Math.round(window.screen.width || window.innerWidth)),
        h: Math.max(240, Math.round(window.screen.height || window.innerHeight)),
      }
    }
    if (cfg.resMode === 'viewport') {
      return {
        w: Math.max(320, Math.round(window.innerWidth)),
        h: Math.max(240, Math.round(window.innerHeight)),
      }
    }
    return { w: cfg.maxW, h: cfg.maxH }
  }

  let ws = null
  let video = null
  let stream = null
  let cap = null
  let mctx = null
  let pool = []
  let running = false
  let busy = false
  let force = false
  let capW = 1280
  let capH = 720
  let cols = 0
  let rows = 0
  let prev32 = null
  let frameIndex = 0
  let lastKeyAt = 0
  let changedAt = 0
  let busyAt = 0
  let ticker = null
  let retryTimer = null
  let stat = { frames: 0, bytes: 0, drops: 0, cost: 0, blocks: 0 }
  let statAt = Date.now()
  let statTimer = null
  let destroyed = false

  function setMsg(text, type) {
    s.msg = text || ''
    s.msgType = type || ''
  }

  /* ---------------- 采集元素 ---------------- */

  function ensureDom() {
    if (video) return
    video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    // 抓屏源元素脱离文档时，个别 Chrome 版本会少给帧；挂一个几乎看不见的 2×2 在角落
    video.style.cssText =
      'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;'
    document.body.appendChild(video)

    cap = document.createElement('canvas')
    mctx = cap.getContext('2d', { willReadFrequently: true })
  }

  /* ---------------- 编码与发送 ---------------- */

  function acquire(w, h) {
    for (const o of pool) {
      if (!o.busy) {
        o.busy = true
        o.cv.width = w
        o.cv.height = h
        return o
      }
    }
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const item = { cv, ctx: cv.getContext('2d'), busy: true }
    pool.push(item)
    return item
  }

  function toArrayBuffer(blob) {
    return new Promise((resolve) => {
      if (!blob) return resolve(null)
      if (blob.arrayBuffer) blob.arrayBuffer().then(resolve, () => resolve(null))
      else {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.onerror = () => resolve(null)
        fr.readAsArrayBuffer(blob)
      }
    })
  }

  function buildFrame(flags, whole, tiles) {
    let size = 16
    if (whole) size += 4 + whole.byteLength
    else for (const t of tiles) size += 8 + t.bytes.byteLength

    const buf = new ArrayBuffer(size)
    const dv = new DataView(buf)
    let off = 16
    dv.setUint8(0, 1)
    dv.setUint8(1, flags)
    dv.setUint16(2, frameIndex, true)
    frameIndex = (frameIndex + 1) & 0xffff
    dv.setUint16(4, capW, true)
    dv.setUint16(6, capH, true)
    dv.setUint16(8, TILE, true)
    dv.setUint16(10, whole ? 0 : tiles.length, true)
    dv.setUint32(12, 0, true)

    if (whole) {
      dv.setUint32(16, whole.byteLength, true)
      off = 20
      new Uint8Array(buf, off).set(new Uint8Array(whole))
    } else {
      for (const t of tiles) {
        dv.setUint16(off, t.idx, true)
        off += 2
        dv.setUint8(off, t.w)
        off += 1
        dv.setUint8(off, t.h)
        off += 1
        dv.setUint32(off, t.bytes.byteLength, true)
        off += 4
        new Uint8Array(buf, off).set(new Uint8Array(t.bytes))
        off += t.bytes.byteLength
      }
    }
    return buf
  }

  function send(buf) {
    if (!ws || ws.readyState !== 1) return false
    try {
      ws.send(buf)
      stat.frames++
      stat.bytes += buf.byteLength
      s.frames++
      return true
    } catch (e) {
      return false
    }
  }

  function encodeTile(t) {
    return new Promise((resolve) => {
      const o = acquire(t.tw, t.th)
      o.ctx.drawImage(cap, t.x0, t.y0, t.tw, t.th, 0, 0, t.tw, t.th)
      o.cv.toBlob(
        async (blob) => {
          o.busy = false
          const ab = await toArrayBuffer(blob)
          resolve(ab ? { idx: t.idx, w: t.tw, h: t.th, bytes: ab } : null)
        },
        'image/jpeg',
        cfg.quality
      )
    })
  }

  function finish(t0, blocks) {
    stat.cost = Math.round(performance.now() - t0)
    stat.blocks = blocks
    busy = false
    schedule()
  }

  function sendKey(t0) {
    lastKeyAt = t0
    cap.toBlob(
      async (blob) => {
        const ab = await toArrayBuffer(blob)
        if (ab) send(buildFrame(1, ab, null))
        finish(t0, 0)
      },
      'image/jpeg',
      cfg.quality
    )
  }

  async function sendTiles(changed, t0) {
    const list = await Promise.all(changed.map(encodeTile))
    const tiles = list.filter(Boolean)
    if (tiles.length) send(buildFrame(0, null, tiles))
    finish(t0, tiles.length)
  }

  /** 全像素差量：块内一发现差异立刻早退 */
  function detect(cur32) {
    const changed = []
    for (let ty = 0; ty < rows; ty++) {
      const y0 = ty * TILE
      const th = Math.min(TILE, capH - y0)
      for (let tx = 0; tx < cols; tx++) {
        const x0 = tx * TILE
        const tw = Math.min(TILE, capW - x0)
        let hit = false
        for (let y = y0; y < y0 + th && !hit; y++) {
          let i = y * capW + x0
          const end = i + tw
          for (; i < end; i++) {
            if ((cur32[i] & MASK32) !== (prev32[i] & MASK32)) {
              hit = true
              break
            }
          }
        }
        if (hit) changed.push({ x0, y0, tw, th, idx: ty * cols + tx })
      }
    }
    prev32.set(cur32)
    return changed
  }

  function loop() {
    if (!running) return
    if (busy) {
      if (performance.now() - busyAt > 3000) {
        busy = false
        setMsg('上一次编码卡住超过 3 秒，已自动恢复。', 'err')
      } else {
        stat.drops++
        s.drops = stat.drops
        schedule()
        return
      }
    }
    if (!ws || ws.readyState !== 1) return schedule()
    if (s.peers <= 0) return schedule()

    busy = true
    busyAt = performance.now()
    const t0 = performance.now()

    mctx.drawImage(video, 0, 0, capW, capH)
    const img = mctx.getImageData(0, 0, capW, capH)
    const cur32 = new Uint32Array(img.data.buffer, img.data.byteOffset, img.data.length >> 2)

    const changed = detect(cur32)
    if (changed.length) changedAt = t0

    const key = force
    force = false
    const ratio = cols && rows ? changed.length / (cols * rows) : 0
    const settle = changed.length === 0 && changedAt > lastKeyAt && t0 - changedAt > cfg.settleMs
    const overdue = changed.length > 0 && t0 - lastKeyAt > cfg.keyMaxMs
    const whole = key || ratio > 0.5 || settle || overdue || (cfg.mode === 'full' && changed.length > 0)

    if (whole) sendKey(t0)
    else if (changed.length) sendTiles(changed, t0)
    else finish(t0, 0)
  }

  /* ---------------- 定时器（Worker 里跑，抗后台降频） ---------------- */

  function startTicker() {
    const ms = Math.max(1, Math.round(1000 / cfg.fps))
    if (!ticker && window.Worker && window.Blob && window.URL && URL.createObjectURL) {
      try {
        const src =
          "var t=null;onmessage=function(e){var d=e.data||{};" +
          "if(d.cmd==='start'){if(t){clearInterval(t);}t=setInterval(function(){postMessage(1);},d.ms);}" +
          "else if(d.cmd==='stop'){if(t){clearInterval(t);t=null;}}};"
        const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))
        ticker = new Worker(url)
        ticker.onmessage = () => {
          if (running) loop()
        }
      } catch (e) {
        ticker = null
      }
    }
    if (ticker) ticker.postMessage({ cmd: 'start', ms })
  }

  function stopTicker() {
    if (ticker) ticker.postMessage({ cmd: 'stop' })
  }

  function schedule() {
    if (!running) return
    if (!ticker) setTimeout(loop, Math.max(1, Math.round(1000 / cfg.fps)))
  }

  /* ---------------- 连接中继 ---------------- */

  function connect() {
    if (destroyed) return
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
    try {
      ws = new WebSocket(proto + location.host + '/ws?role=ctl')
    } catch (e) {
      setMsg('无法建立投屏通道：' + e.message, 'err')
      return
    }
    ws.onopen = () => {
      s.connected = true
      setMsg('投屏通道已连接，可以开始投屏。', 'ok')
      // 必须发：否则「学生先上线、控制台后开」时拿不到 peers，一帧都不推。
      // 同时带上教师令牌：控制台不再靠「来自本机」认人，改成认登录身份，
      // 这样从局域网 IP / 另一台机器打开教师端也能投屏。
      ws.send(JSON.stringify({ t: 'hello', token: getToken() }))
      ws.send(JSON.stringify({ t: 'mode', mode: running ? 'watch' : 'idle' }))
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch (e) {
        return
      }
      if (msg.t === 'peers') s.peers = msg.students | 0
      if (msg.t === 'newstudent') {
        force = true
        s.lastStudentAt = new Date().toLocaleTimeString()
      }
      if (msg.t === 'error') setMsg(msg.message, 'err')
    }
    ws.onclose = () => {
      s.connected = false
      s.peers = 0
      if (destroyed) return
      setMsg('与投屏通道断开，正在重连…（请确认课堂系统服务还在运行）', 'err')
      retryTimer = setTimeout(connect, 2000)
    }
  }

  /* ---------------- 对外动作 ---------------- */

  function calcCapture() {
    const t = targetSize()
    const sw = video.videoWidth || t.w
    const sh = video.videoHeight || t.h
    const k = Math.min(1, t.w / sw, t.h / sh)
    capW = Math.max(128, Math.round((sw * k) / 2) * 2)
    capH = Math.max(128, Math.round((sh * k) / 2) * 2)
    cap.width = capW
    cap.height = capH
    cols = Math.ceil(capW / TILE)
    rows = Math.ceil(capH / TILE)
    prev32 = new Uint32Array(capW * capH)
    s.capW = capW
    s.capH = capH
  }

  async function start() {
    if (running) return
    ensureDom()
    // 投屏是教师的权限，这里不按地址设卡：能不能抓屏交给浏览器裁决，抓不了就把原因说成人话。
    // 唯一会「抓不了」的情形是 http + 非 localhost 的源（浏览器收走 getDisplayMedia），
    // 用「打开教师端.bat」把该地址加过白名单后照样能投 —— 不是权限被我们拦掉。
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setMsg(
        '浏览器没有给这个地址屏幕接口（http 下只有 localhost 算安全上下文）。两条路都对：' +
          '① 用 http://localhost:' + (location.port || '80') + ' 打开教师端；' +
          '② 用「打开教师端.bat」启动，它会先把这个地址加进 Chrome 白名单。' +
          '当前地址 ' + location.host + ' 的讲义 / 计分 / 点名不受影响。',
        'err'
      )
      return
    }
    try {
      const t = targetSize()
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { max: cfg.fps }, width: { max: t.w }, height: { max: t.h } },
        audio: false,
      })
      video.srcObject = stream
      await video.play()
      const track = stream.getVideoTracks()[0]
      if (track) track.onended = () => stop('教师端停止了共享')

      calcCapture()
      running = true
      force = true
      changedAt = 0
      lastKeyAt = performance.now()
      frameIndex = 0
      s.running = true
      s.drops = 0
      s.frames = 0
      setMsg('投屏中 · ' + capW + '×' + capH + '，学生端应已开始接收画面。', 'ok')
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'mode', mode: 'watch' }))
      startTicker()
      schedule()
    } catch (e) {
      setMsg('抓屏未开始：' + ((e && e.message) || e), 'err')
    }
  }

  function stop(reason) {
    running = false
    busy = false
    s.running = false
    stopTicker()
    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
      stream = null
    }
    if (video) video.srcObject = null
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'mode', mode: 'idle' }))
    if (reason) setMsg(reason, '')
  }

  function requestKey() {
    force = true
    setMsg('已请求重推整屏。', 'ok')
  }

  /** 固定档位（手动选 1600×900 之类） */
  function applyResolution(w, h) {
    cfg.resMode = 'manual'
    cfg.maxW = w
    cfg.maxH = h
    if (running) {
      calcCapture()
      force = true
    }
  }

  /** 跟随设备屏幕 / 跟随当前窗口 */
  function applyResMode(mode) {
    cfg.resMode = mode
    if (running) {
      calcCapture()
      force = true
    }
  }

  function applyFps(v) {
    cfg.fps = v
    if (running) startTicker()
  }

  function startStats() {
    statTimer = setInterval(() => {
      const now = Date.now()
      const dt = Math.max(0.001, (now - statAt) / 1000)
      s.fps = Math.round(stat.frames / dt)
      s.allMbps = (stat.bytes * 8) / dt / 1000000
      s.perMbps = s.peers ? s.allMbps / s.peers : 0
      s.cost = stat.cost
      s.blocks = stat.blocks
      statAt = now
      stat.frames = 0
      stat.bytes = 0
    }, 1000)
  }

  let mounted = false
  let resizeTimer = null

  // 「跟随当前窗口」时，老师拖窗口大小要跟着变 —— 否则学生端会留一圈黑边
  function onResize() {
    if (!running || cfg.resMode !== 'viewport') return
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      resizeTimer = null
      calcCapture()
      force = true
    }, 300)
  }

  function mount() {
    if (mounted) return
    mounted = true
    destroyed = false
    ensureDom()
    connect()
    startStats()
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
  }

  function onVisibility() {
    s.hidden = document.hidden
  }

  function unmount() {
    if (!mounted) return
    mounted = false
    destroyed = true
    stop('')
    if (retryTimer) clearTimeout(retryTimer)
    if (statTimer) clearInterval(statTimer)
    if (ticker) {
      ticker.terminate()
      ticker = null
    }
    if (ws) {
      try {
        ws.close()
      } catch (e) {
        /* ignore */
      }
      ws = null
    }
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('resize', onResize)
    if (resizeTimer) clearTimeout(resizeTimer)
    if (video && video.parentNode) video.parentNode.removeChild(video)
    video = null
    cap = null
    mctx = null
    pool = []
  }

  return { s, cfg, mount, unmount, start, stop, requestKey, applyResolution, applyResMode, applyFps, targetSize }
}

/*
 * 全系统只有这一份实例。
 * 原因：投屏必须跨路由活着 —— 老师开播后去讲义页翻页、去点名页抽人，
 * 推流都不能断。所以由教师端布局（TeacherLayout）负责 mount/unmount，
 * 投屏页只读状态、调档位。
 */
export const cast = createScreenCast()
