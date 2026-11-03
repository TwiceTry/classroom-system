'use strict'
/*
 * zipfile.js —— 从磁盘上的 zip 里流式读取（导入课程包用）
 *
 * 为什么不用原来的 readZip(buf)：那个要求整个 zip 先读进内存。
 * 课程包上限 500MB，全内存等于「上传一个包，服务器吃掉一个包」——
 * 两个人同时导就可能把服务器拖死。这里改成：
 *
 *   scan(path)      逐条流过，只算 sha256 与大小；小文件（部件 json、名单 csv）才留在内存
 *   extractTo(...)  需要落盘时再流一次，边解边写，任何时刻内存里只有一条目的缓冲
 *
 * 依赖 yauzl（后端允许第三方依赖了）；它按 zip 的通用标志位 bit 11 正确解码 UTF-8 文件名，
 * 中文目录（代码示例/第01课）不会乱码。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const yauzl = require('yauzl')

const DEFAULT_LIMITS = {
  entries: 20000, // 条目数上限
  maxBytes: 0, // 解压后总字节上限（0 = 不限；课程包会传 3× 单包上限进来）
  inline: 4 * 1024 * 1024, // 单个「部件」文件留在内存里的上限（course.json / scheme.json / 名单）
}

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zf) => {
      if (err) return reject(err)
      resolve(zf)
    })
  })
}

/** 判断哪些条目需要「留内容在内存」（部件 + 名单），其余只记 sha256 */
function isPartFile(name) {
  return (
    /(^|\/)pack\.json$/.test(name) ||
    /(^|\/)course\.json$/.test(name) ||
    /(^|\/)scheme\.json$/.test(name) ||
    /(^|\/)classes\/index\.json$/.test(name) ||
    /\.roster\.csv$/i.test(name) // 名单：示例1班.roster.csv
  )
}

/**
 * 扫描一个 zip：返回 { entries: Map(文件名 → {name,size,sha256,data|null}), count, bytes }
 * 目录条目会被跳过；data 只对部件/名单这类小文件保留（超出 inline 上限则丢内容并标记 tooBig）。
 */
async function scan(filePath, opts) {
  const lim = Object.assign({}, DEFAULT_LIMITS, opts || {})
  const zf = await openZip(filePath)

  return new Promise((resolve, reject) => {
    const entries = new Map()
    let count = 0
    let bytes = 0

    const fail = (e) => {
      try {
        zf.close()
      } catch (err) {}
      reject(e)
    }

    zf.on('entry', (entry) => {
      const name = String(entry.fileName || '')
      if (/\/$/.test(name)) return zf.readEntry() // 目录项
      if (++count > lim.entries) return fail(new Error('包里的文件数超过上限 ' + lim.entries))

      zf.openReadStream(entry, (err, rs) => {
        if (err) return fail(err)
        const h = crypto.createHash('sha256')
        const keep = isPartFile(name) && entry.uncompressedSize <= lim.inline
        const chunks = keep ? [] : null
        let size = 0

        rs.on('data', (c) => {
          size += c.length
          bytes += c.length
          if (lim.maxBytes && bytes > lim.maxBytes) {
            rs.destroy()
            return fail(new Error('包解压后超过 ' + Math.round(lim.maxBytes / 1024 / 1024) + 'MB 上限，已中止（可能是异常包）'))
          }
          h.update(c)
          if (chunks) chunks.push(c)
        })
        rs.on('error', fail)
        rs.on('end', () => {
          entries.set(name, {
            name,
            size,
            sha256: h.digest('hex'),
            data: chunks ? Buffer.concat(chunks) : null,
          })
          zf.readEntry()
        })
      })
    })

    zf.on('end', () => resolve({ entries, count, bytes }))
    zf.on('error', fail)
    zf.readEntry()
  })
}

/**
 * 把指定条目流式解到磁盘。
 * @param {string} filePath zip 路径
 * @param {function(string): string} destOf  zip 内名 → 目标绝对路径（返回 '' 表示跳过）
 * @returns {Promise<{written:number, bytes:number}>}
 */
async function extractTo(filePath, destOf) {
  const zf = await openZip(filePath)
  return new Promise((resolve, reject) => {
    let written = 0
    let bytes = 0

    const fail = (e) => {
      try {
        zf.close()
      } catch (err) {}
      reject(e)
    }

    zf.on('entry', (entry) => {
      const name = String(entry.fileName || '')
      if (/\/$/.test(name)) return zf.readEntry()
      const dest = destOf(name)
      if (!dest) return zf.readEntry()

      zf.openReadStream(entry, (err, rs) => {
        if (err) return fail(err)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        const ws = fs.createWriteStream(dest)
        rs.on('data', (c) => (bytes += c.length))
        rs.on('error', fail)
        ws.on('error', fail)
        ws.on('finish', () => {
          written++
          zf.readEntry()
        })
        rs.pipe(ws)
      })
    })

    zf.on('end', () => resolve({ written, bytes }))
    zf.on('error', fail)
    zf.readEntry()
  })
}

module.exports = { scan, extractTo, isPartFile, DEFAULT_LIMITS }
