/*
 * zip.js —— 极简 ZIP 打包 / 解包（deflate 压缩，零第三方依赖）
 *
 * 课程包里主要是文本（讲义 md、示例源码），deflate 一把就能小 3–4 倍；
 * Node 自带 zlib.deflateRawSync/inflateRawSync，不用引 archiver 之类的库。
 *
 * 支持：
 *   · 压缩方式 0（存储）与 8（deflate）：文本压缩、已压缩的媒体（png/jpg/zip/mp4）仍按存储放
 *   · 文件名 UTF-8（通用标志位 bit 11，Windows 资源管理器 / macOS 都能正确显示中文）
 *   · 目录层级（靠文件名里的 / 表达，不单独写目录项）
 * 不支持：加密、ZIP64（单包 4GB 以上）。课程包上限 500MB，够用。
 */

import zlib from 'zlib'

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

/** JS Date → DOS 时间/日期（ZIP 头里用的老格式） */
function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear())
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f)
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/**
 * 打一个 zip。
 * @param {Array<{path: string, data: Buffer|string}>} entries  path 用 / 分隔，相对包根
 * @param {Date} [when] 时间戳（默认当前时间；测试里可以固定）
 * @returns {Buffer}
 */
/** 这些类型本身已经是压缩过的，再 deflate 基本没收益，直接存（省 CPU） */
const STORE_EXT = /\.(png|jpe?g|gif|webp|avif|ico|mp4|mp3|m4a|ogg|webm|zip|gz|7z|rar|pdf|docx|xlsx|pptx|woff2?)$/i

function makeZip(entries, when) {
  const stamp = dosDateTime(when || new Date())
  const locals = []
  const centrals = []
  let offset = 0

  for (const e of entries) {
    const name = String(e.path).replace(/\\/g, '/').replace(/^\/+/, '')
    if (!name) continue
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data == null ? '' : e.data), 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)

    // 文本用 deflate；压不小就退回存储（小文件/已压缩格式常有这种）
    let method = 0
    let payload = data
    if (!STORE_EXT.test(name) && data.length > 64) {
      const packed = zlib.deflateRawSync(data, { level: 9 })
      if (packed.length < data.length) {
        method = 8
        payload = packed
      }
    }

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    local.writeUInt16LE(20, 4) // 需要版本 2.0
    local.writeUInt16LE(0x0800, 6) // 通用标志：文件名 UTF-8
    local.writeUInt16LE(method, 8) // 0 = 存储，8 = deflate
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18) // 压缩后大小
    local.writeUInt32LE(data.length, 22) // 原始大小
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra 长度

    locals.push(local, nameBuf, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // 中央目录项签名
    central.writeUInt16LE(20, 4) // 创建版本
    central.writeUInt16LE(20, 6) // 需要版本
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // 磁盘号
    central.writeUInt16LE(0, 36) // 内部属性
    central.writeUInt32LE(0, 38) // 外部属性
    central.writeUInt32LE(offset, 42) // 本地头偏移

    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(centrals.length / 2, 8) // 条目数
  eocd.writeUInt16LE(centrals.length / 2, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuf, eocd])
}

/* ---------------- 读 zip（导入课程包用） ---------------- */

/**
 * 解析一个 zip（只读内存，不落盘）。
 * 支持：存储（0）、deflate（8）；不支持加密 / ZIP64。
 * @param {Buffer} buf
 * @returns {Array<{name: string, data: Buffer, size: number, dir: boolean}>}
 */
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是 zip 文件（太短）')

  // EOCD 在结尾，注释最长 65535 字节，所以从尾部往前找
  let eocd = -1
  const from = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是 zip 文件（找不到目录结尾）')

  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const files = []

  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error('zip 目录结构损坏（第 ' + (i + 1) + ' 项）')
    }
    const flags = buf.readUInt16LE(off + 8)
    const method = buf.readUInt16LE(off + 10)
    const crc = buf.readUInt32LE(off + 16)
    const csize = buf.readUInt32LE(off + 20)
    const usize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const cmtLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const nameBuf = buf.slice(off + 46, off + 46 + nameLen)
    // bit 11 = 文件名是 UTF-8；不是的话按 latin1 兜底（中文名会乱，但不至于崩）
    const name = flags & 0x0800 ? nameBuf.toString('utf8') : nameBuf.toString('latin1')

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error('zip 本地头损坏：' + name)
    }
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataAt = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.slice(dataAt, dataAt + csize)

    let data
    if (method === 0) data = raw
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else throw new Error('不支持的压缩方式（' + method + '）：' + name)

    if (crc32(data) !== crc) throw new Error('文件校验失败（CRC 不符）：' + name)

    files.push({ name, data, size: usize || data.length, method, dir: name.endsWith('/') })
    off += 46 + nameLen + extraLen + cmtLen
  }

  return files
}

export { makeZip, readZip, crc32 }