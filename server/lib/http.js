'use strict'
/*
 * http.js —— 极简 HTTP 工具（零依赖）
 *
 * 只做四件事：路由匹配、读 JSON 请求体、返回 JSON、发静态文件。
 * 不引入 Express：教师机是 Win7 / 无外网，能少一个 node_modules 就少一个坑。
 */
const fs = require('fs')
const path = require('path')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.vue': 'text/plain; charset=utf-8',
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function json(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(
    status,
    Object.assign(
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      },
      extraHeaders || {}
    )
  )
  res.end(body)
}

function ok(res, obj) {
  json(res, 200, obj)
}

function fail(res, status, message) {
  json(res, status, { error: message })
}

/** 读请求体（JSON / 文本），带大小上限 */
function readBody(req, limit) {
  const max = limit || 2 * 1024 * 1024
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > max) {
        reject(new HttpError(413, '请求体过大（上限 ' + Math.round(max / 1024 / 1024) + 'MB）'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 把请求体流式写到磁盘（上传大文件用），带大小上限。
 * resolve 时文件已完整落盘；超限/出错会删掉半截文件并 reject。
 */
function readToFile(req, filePath, limit) {
  const max = limit || 2 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath)
    let size = 0
    let settled = false

    const done = (err) => {
      if (settled) return
      settled = true
      if (err) {
        ws.destroy()
        try {
          fs.unlinkSync(filePath)
        } catch (e) {
          /* 没有就算了 */
        }
        reject(err)
      } else {
        resolve({ size })
      }
    }

    req.on('data', (c) => {
      size += c.length
      if (size > max) {
        req.destroy()
        done(new HttpError(413, '文件太大（上限 ' + Math.round(max / 1024 / 1024) + 'MB）'))
      }
    })
    req.on('error', (e) => done(e))
    ws.on('error', (e) => done(e))
    ws.on('finish', () => done(null))
    req.pipe(ws)
  })
}

/** 读二进制请求体（上传 zip 用），返回 Buffer */
function readBuffer(req, limit) {
  const max = limit || 2 * 1024 * 1024
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > max) {
        reject(new HttpError(413, '文件太大（上限 ' + Math.round(max / 1024 / 1024) + 'MB）'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req, limit) {
  const text = await readBody(req, limit)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

/** 路由表：支持 /a/:id/b 形式的占位段 */
class Router {
  constructor() {
    this.routes = []
  }

  add(method, pattern, handler) {
    const keys = []
    const re = new RegExp(
      '^' +
        pattern
          .split('/')
          .map((seg) => {
            if (seg.startsWith(':')) {
              keys.push(seg.slice(1))
              return '([^/]+)'
            }
            return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          })
          .join('/') +
        '/?$'
    )
    this.routes.push({ method: method.toUpperCase(), re, keys, handler })
  }

  get(p, h) {
    this.add('GET', p, h)
  }
  post(p, h) {
    this.add('POST', p, h)
  }
  patch(p, h) {
    this.add('PATCH', p, h)
  }
  del(p, h) {
    this.add('DELETE', p, h)
  }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method.toUpperCase()) continue
      const m = r.re.exec(pathname)
      if (!m) continue
      const params = {}
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])))
      return { handler: r.handler, params }
    }
    return null
  }
}

/** 发静态文件；返回 false 表示不存在 */
function sendFile(res, filePath, opts) {
  const o = opts || {}
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch (e) {
    return false
  }
  if (!stat.isFile()) return false
  const ext = path.extname(filePath).toLowerCase()
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': o.cache || 'no-cache',
    'Last-Modified': stat.mtime.toUTCString(),
  }
  // opts.download = 想让浏览器存下来时的文件名（证据 / 附件这类点一下就下的）
  if (o.download) headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(String(o.download))
  res.writeHead(200, headers)
  fs.createReadStream(filePath).pipe(res)
  return true
}

/** 防目录穿越：resolved 必须落在 base 之内 */
function isInside(base, target) {
  const b = path.resolve(base)
  const t = path.resolve(target)
  return t === b || t.startsWith(b + path.sep)
}

module.exports = { Router, json, ok, fail, readBody, readBuffer, readToFile, readJson, sendFile, isInside, HttpError, MIME }
