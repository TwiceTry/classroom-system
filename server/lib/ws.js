'use strict'
/*
 * ws.js —— 自己实现的 WebSocket 服务端（RFC 6455 子集，零依赖）
 *
 * 为什么要自己写：教师机无外网、不方便装 ws 包；而这个协议真正需要实现的
 * 只有「握手 + 帧解析 + 帧编码」，一百多行足够。但下面几条**必须**做对，
 * 都是老方案在真机上踩过的坑：
 *
 *   1) 一条消息可能由多个帧组成（FIN=0 + opcode=0 续帧）。浏览器发大消息时
 *      真的会拆（实测 125KB 拆成 94KB + 31KB）。只读第一帧就会把「半张画面」
 *      当完整消息转发，学生端长度校验不过 → 整帧丢弃 → 全黑、只有鼠标处有图。
 *   2) 客户端发来的帧必须解掩码；大块用一次异或，别逐字节。
 *   3) 单条消息要有上限（16MB），防止坏客户端把内存吃光。
 *   4) 服务端发的帧不加掩码。
 *   5) 二进制大帧要有「只保留最新一帧」的背压，个别学生卡住不能拖垮全班。
 */
const crypto = require('crypto')

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_MESSAGE = 16 * 1024 * 1024

const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_BIN = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64')
}

function encodeFrame(opcode, payload) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(len, 6)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

class Conn {
  constructor(socket, req, onMessage, onClose) {
    this.socket = socket
    this.req = req
    this.onMessage = onMessage
    this.onClose = onClose
    this.alive = true
    this.closed = false
    this.role = ''
    this.cid = ''
    this.buf = Buffer.alloc(0)

    // 分片重组
    this.fragOpcode = 0
    this.fragChunks = []
    this.fragLen = 0

    // 二进制背压：只保留最新一帧（差量帧）；整屏关键帧另排队，不会被顶掉
    this._latest = null
    this._keyQueue = []
    this._flushing = false

    this.remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')

    socket.setNoDelay(true)
    socket.on('data', (chunk) => this._onData(chunk))
    socket.on('error', () => this.close())
    // http.Server 建出来的 socket 是 allowHalfOpen=true（为了 keep-alive），
    // 所以对端 FIN 过来只会触发 'end'，不会自动 'close'。这里必须自己收尾，
    // 否则学生关掉页面后「在线人数」会永远挂在那里，教师端以为还有人。
    socket.on('end', () => this.close())
    socket.on('close', () => this._fireClose())
    if (process.env.TS_WS_DEBUG) {
      socket.on('end', () => console.error('[ws] end role=' + this.role))
      socket.on('close', () => console.error('[ws] close role=' + this.role))
      socket.on('error', (e) => console.error('[ws] error role=' + this.role + ' ' + e.message))
    }
  }

  get isOpen() {
    return !this.closed && this.socket.writable
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    try {
      this._parse()
    } catch (e) {
      this.close(1002)
    }
  }

  _parse() {
    for (;;) {
      if (this.buf.length < 2) return
      const b0 = this.buf[0]
      const b1 = this.buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let off = 2

      if (len === 126) {
        if (this.buf.length < 4) return
        len = this.buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (this.buf.length < 10) return
        const hi = this.buf.readUInt32BE(2)
        if (hi > 0) return this.close(1009)
        len = this.buf.readUInt32BE(6)
        off = 10
      }

      if (len > MAX_MESSAGE) return this.close(1009)

      let mask = null
      if (masked) {
        if (this.buf.length < off + 4) return
        mask = this.buf.slice(off, off + 4)
        off += 4
      }
      if (this.buf.length < off + len) return

      const payload = Buffer.from(this.buf.slice(off, off + len))
      this.buf = this.buf.slice(off + len)
      if (mask) unmask(payload, mask)
      this._frame(fin, opcode, payload)
    }
  }

  _frame(fin, opcode, payload) {
    if (opcode === OP_CLOSE) return this.close(1000)
    if (opcode === OP_PING) return this._send(OP_PONG, payload)
    if (opcode === OP_PONG) {
      this.alive = true
      return
    }

    if (opcode === OP_TEXT || opcode === OP_BIN) {
      this.fragOpcode = opcode
      this.fragChunks = [payload]
      this.fragLen = payload.length
    } else if (opcode === OP_CONT) {
      if (!this.fragOpcode) return
      this.fragChunks.push(payload)
      this.fragLen += payload.length
      if (this.fragLen > MAX_MESSAGE) return this.close(1009)
    } else {
      return
    }

    if (!fin) return

    const whole = this.fragChunks.length === 1 ? this.fragChunks[0] : Buffer.concat(this.fragChunks, this.fragLen)
    const op = this.fragOpcode
    this.fragOpcode = 0
    this.fragChunks = []
    this.fragLen = 0

    if (!this.onMessage) return
    try {
      if (op === OP_TEXT) this.onMessage(this, whole.toString('utf8'), false)
      else this.onMessage(this, whole, true)
    } catch (e) {
      console.error('[ws] 消息处理异常：' + e.message)
    }
  }

  _send(opcode, payload) {
    if (!this.isOpen) return false
    try {
      return this.socket.write(encodeFrame(opcode, payload))
    } catch (e) {
      this.close()
      return false
    }
  }

  sendText(text) {
    return this._send(OP_TEXT, Buffer.from(String(text), 'utf8'))
  }

  sendJson(obj) {
    return this.sendText(JSON.stringify(obj))
  }

  /**
   * 发二进制帧，带「只保留最新一帧」的背压：
   * 上一帧还没写完（socket 缓冲未排空）时，新帧直接覆盖待发的那一帧，
   * 绝不排队堆积 —— 个别学生机卡住不能拖垮整间教室。
   *
   * 但「整屏关键帧」必须保住（帧头 flags & 1）：
   *   差量模式下，一帧整屏就是学生的**基准画面**（差量块要画在它上面）。
   *   慢链路（公网隧道）上整屏帧大、差量帧小 —— 如果一视同仁地覆盖，
   *   整屏帧会被后来的差量帧顶掉、永远发不出去 → 学生端黑屏，
   *   只有鼠标动到的地方才显示（差量块更新了那块）。
   *   所以：整屏帧排队（最多留 3 张防堆积），排队期间差量帧直接丢。
   */
  sendBinaryLatest(buf) {
    if (!this.isOpen) return false
    const isKey = !!(buf && buf.length > 1 && (buf[1] & 1))
    if (isKey) {
      // 整屏关键帧：排队（最多 3 张防堆积），差量帧顶不掉它
      if (!this._keyQueue) this._keyQueue = []
      if (this._keyQueue.length < 3) this._keyQueue.push(buf)
    } else {
      // 有整屏帧在排队 → 丢掉这个差量帧（保住基准画面）
      if (this._keyQueue && this._keyQueue.length) return true
      this._latest = buf
    }
    if (!this._flushing) this._flushLatest()
    return true
  }

  _flushLatest() {
    if (!this.isOpen) {
      this._latest = null
      this._flushing = false
      return
    }
    // 整屏关键帧优先发；没有排队帧才发差量帧
    let buf = null
    if (this._keyQueue && this._keyQueue.length) buf = this._keyQueue.shift()
    else {
      buf = this._latest
      this._latest = null
    }
    if (!buf) {
      this._flushing = false
      return
    }
    this._flushing = true
    const frame = encodeFrame(OP_BIN, buf)
    try {
      this.socket.write(frame, () => {
        this._flushing = false
        if (this._latest || (this._keyQueue && this._keyQueue.length)) this._flushLatest()
      })
    } catch (e) {
      this._flushing = false
      this.close()
    }
  }

  close(code) {
    if (this.closed) return
    this.closed = true
    try {
      if (this.socket.writable) {
        const p = Buffer.alloc(2)
        p.writeUInt16BE(code || 1000, 0)
        this.socket.write(encodeFrame(OP_CLOSE, p))
      }
    } catch (e) {
      /* ignore */
    }
    try {
      this.socket.end()
    } catch (e) {
      /* ignore */
    }
    this._fireClose()
  }

  _fireClose() {
    if (this._fired) return
    this._fired = true
    this.closed = true
    if (this.onClose) {
      try {
        this.onClose(this)
      } catch (e) {
        /* ignore */
      }
    }
  }
}

function unmask(buf, mask) {
  const len = buf.length
  if (len >= 512) {
    // 大块整体异或：200KB 逐字节约 12ms，整体异或约 0.7ms
    const m32 = mask.readUInt32BE(0)
    const end = len - (len % 4)
    for (let i = 0; i < end; i += 4) buf.writeUInt32BE((buf.readUInt32BE(i) ^ m32) >>> 0, i)
    for (let i = end; i < len; i++) buf[i] ^= mask[i & 3]
    return buf
  }
  for (let i = 0; i < len; i++) buf[i] ^= mask[i & 3]
  return buf
}

/**
 * 挂到 http.Server 上。
 * onMessage(conn, data, isBinary) —— data 为 string（文本）或 Buffer（二进制）
 */
function attach(server, handlers) {
  const conns = new Set()

  server.on('upgrade', (req, socket) => {
    const u = new URL(req.url, 'http://localhost')
    if (u.pathname !== '/ws') {
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (!key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
    )

    const conn = new Conn(
      socket,
      req,
      (c, data, isBinary) => {
        if (handlers.onMessage) handlers.onMessage(c, data, isBinary, u)
      },
      (c) => {
        conns.delete(c)
        if (handlers.onClose) handlers.onClose(c)
      }
    )
    conn.query = u.searchParams
    conns.add(conn)
    if (handlers.onOpen) handlers.onOpen(conn, u)
  })

  // 心跳：25s 一次 ping，两次没有 pong 就断开，避免「僵尸学生」把在线人数撑高
  const timer = setInterval(() => {
    for (const c of conns) {
      if (!c.isOpen) continue
      if (!c.alive) {
        c.close(1001)
        continue
      }
      c.alive = false
      c._send(OP_PING, Buffer.alloc(0))
    }
  }, 25000)
  timer.unref()

  return { conns }
}

module.exports = { attach, Conn }
