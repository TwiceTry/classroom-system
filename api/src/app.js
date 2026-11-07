/*
 * app.js —— Fastify 装配
 *
 * 组装顺序：错误处理 → body parser（保留原始字节）→ 路由 → 静态资源 → SPA 回退。
 * 把这个函数单独拿出来，是为了自检能 `buildApp()` 起一个进程内实例，
 * 不用真的占端口。
 */
import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import { config } from './config.js'
import { ApiError } from './lib/errors.js'

import authRoutes from './routes/auth.js'
import courseRoutes from './routes/courses.js'
import classRoutes from './routes/classes.js'
import eventRoutes from './routes/events.js'
import realtimeRoutes from './routes/realtime.js'
import miscRoutes from './routes/misc.js'
import castRoutes from './routes/cast.js'
import contentRoutes from './routes/content.js'
import attendanceRoutes from './routes/attendance.js'
import scoringRoutes from './routes/scoring.js'
import assignmentRoutes from './routes/assignments.js'
import examRoutes from './routes/exam.js'
import compatRoutes from './routes/compat.js'
import classroomRoutes from './routes/classroom.js'
import contentEditRoutes from './routes/content-edit.js'
import schemeEditRoutes from './routes/scheme-edit.js'
import libraryRoutes from './routes/library.js'
import coursepackRoutes from './routes/coursepack.js'

export async function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger === undefined ? { level: process.env.TS_LOG_LEVEL || 'warn' } : opts.logger,
    bodyLimit: 2 * 1024 * 1024, // 2MB：普通 JSON 接口够用；大文件走流式上传接口
  })

  /**
   * JSON body：解析的同时把**原始字节**留下来。
   * 边缘端上报要验 HMAC —— 签名是对原始字节算的，用重新序列化的对象验会永远对不上。
   */
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBodyBuffer = body
    if (!body || !body.length) return done(null, {})
    try {
      done(null, JSON.parse(body.toString('utf8')))
    } catch (e) {
      done(new ApiError(400, 'bad_json', 'body 不是合法 JSON'))
    }
  })

  /**
   * 二进制 body（zip 包、Excel 名单、图片上传）：原样收进 Buffer。
   * 课程包导入、内容上传、名单表格都走这条 —— 不能让 Fastify 当成 JSON 去解析。
   *
   * 除了 zip，还要收表格的 MIME：老师从系统里下载 .xlsx 再传回来时，
   * 浏览器/客户端会带 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`，
   * 不在这个列表里就是 415 Unsupported Media Type —— 看着像"功能坏了"，其实是没接住 body。
   * （前端自己上传时用的是 octet-stream，所以只测前端发现不了这个问题。）
   */
  app.addContentTypeParser(
    [
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream',
      // Excel / CSV 名单
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/vnd.ms-excel.sheet.macroenabled.12',
      'text/csv',
      'text/plain',
    ],
    { parseAs: 'buffer' },
    (req, body, done) => {
      req.rawBodyBuffer = body
      done(null, body)
    }
  )

  /** 统一错误体：{ error: { code, message, details } } */
  /**
   * 状态码 → 稳定的错误码。
   * 复用旧模块（coursepack-import / classio / schemeio …）时，它们抛的是
   * `{ status, message }`，没有 code —— 这里补一个，前端就不用按中文匹配。
   */
  const CODE_BY_STATUS = {
    400: 'bad_request',
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    413: 'too_large',
    415: 'unsupported_media_type',
    422: 'unprocessable',
  }

  app.setErrorHandler((err, req, reply) => {
    /*
     * 两种错误形状都要认：
     *   · 新代码：ApiError（statusCode + code）
     *   · 旧模块：HttpError（只有 status）
     * 只认 statusCode 的话，旧模块抛的「不是 zip」「sha256 不符」
     * 「学号跨班重复」全会被吞成 500「服务器内部错误」——
     * 老师根本看不出该改哪儿，而这恰恰是规范 §7 最强调的地方。
     */
    const legacyStatus = typeof err.status === 'number' && err.status >= 400 ? err.status : 0
    const rawStatus = Number(err.statusCode || legacyStatus) || 0
    const status = rawStatus >= 400 ? rawStatus : 500
    const isKnown = err instanceof ApiError || (rawStatus >= 400 && rawStatus < 500)

    if (!isKnown) req.log.error({ err }, '未捕获异常')
    if (reply.sent) return

    /*
     * 旧模块把「哪几条不对」挂在 err.errors 上（比如课程包：
     * 「course.id 不合法」「第 3 个文件的 sha256 不符」）。
     * 只回一句「有 N 个问题」老师没法改，所以把第一条塞进 message、全部放进 details。
     */
    const list = Array.isArray(err.errors) ? err.errors : null
    let message = isKnown ? err.message : '服务器内部错误'
    if (list && list.length) message += '：' + list[0] + (list.length > 1 ? ' 等 ' + list.length + ' 条' : '')

    const details = err.details !== undefined ? err.details : list ? { errors: list, warnings: err.warnings || [] } : undefined

    reply.status(status).send({
      error: {
        code: err.code || (status === 500 ? 'internal' : CODE_BY_STATUS[status] || 'error'),
        message,
        ...(details !== undefined ? { details } : {}),
      },
    })
  })

  /* ---------------- 业务路由 ---------------- */
  await app.register(fastifyWebsocket) // 投屏中继 /ws 要先于 cast 路由注册
  await app.register(miscRoutes)
  await app.register(authRoutes)
  await app.register(courseRoutes)
  await app.register(classRoutes)
  await app.register(eventRoutes)
  await app.register(realtimeRoutes)
  await app.register(castRoutes)
  await app.register(contentRoutes)
  await app.register(attendanceRoutes)
  await app.register(scoringRoutes)
  await app.register(assignmentRoutes)
  await app.register(examRoutes)
  await app.register(compatRoutes)
  await app.register(classroomRoutes)
  await app.register(contentEditRoutes)
  await app.register(schemeEditRoutes)
  await app.register(libraryRoutes)
  await app.register(coursepackRoutes)

  /* ---------------- 前端静态资源 + SPA 回退 ---------------- */
  const hasWeb = fs.existsSync(path.join(config.webDist, 'index.html'))
  const indexHtml = path.join(config.webDist, 'index.html')

  /**
   * 入口页：自己发，不走 static。
   * 原因：`@fastify/static` 在 `index: false` 时对目录根 `/` 直接回 403
   * （它认为「你在访问一个没有索引页的目录」），而且它是 `/*` 通配，
   * 在 onRequest 里改 url 也拦不住（Fastify 5 的 req.url 还是只读的）。
   * 静态路由 `/` 的优先级高于通配 `/*`，所以显式注册最稳。
   *
   * 顺带把 no-cache + ETag/304 一起给了：
   * 重新构建后如果学生拿旧 HTML，会引用已删除的 hash 资源 → 白屏。
   */
  const serveIndex = (req, reply) => {
    const st = fs.statSync(indexHtml)
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"'
    const base = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Last-Modified': st.mtime.toUTCString(),
      ETag: etag,
    }
    const inm = String(req.headers['if-none-match'] || '').trim()
    const ims = String(req.headers['if-modified-since'] || '').trim()
    if (
      (inm && inm.split(',').map((x) => x.trim()).indexOf(etag) >= 0) ||
      (ims && ims === st.mtime.toUTCString())
    ) {
      return reply.status(304).headers(base).send()
    }
    return reply.status(200).headers(base).send(fs.createReadStream(indexHtml))
  }

  /*
   * 公共运行时：/lib/*
   *
   * 「代码示例」里的页面要加载 Vue、SFC 加载器、启动器，这三样是**第三方库**，
   * 不是老师的课程内容。原来它们躺在 content/代码示例/ 里，页面用 ../vue.global.js 相对引用 ——
   * 于是服务端必须靠一份「文件名白名单」把它们挑出来放行（浏览器原生 <script> 带不上令牌）。
   *
   * 现在统一放到 /lib/ 前缀下，语义清了：
   *   /lib/*   公开的运行时库（第三方，谁都能下）
   *   /api/*   业务接口（要登录）
   *
   * 好处：
   *   · 白名单没了，加库不用改代码
   *   · 带长缓存（这些文件基本不变，1.8MB 的 sfc-loader 不该每 5 分钟重下）
   *   · 页面写绝对路径 /lib/...，不受 <base> 影响，预览更稳
   *   · 课程包里不再重复携带 2.4MB 的库
   */
  await app.register(fastifyStatic, {
    root: path.join(import.meta.dirname, 'lib', 'runtime'),
    prefix: '/lib/',
    decorateReply: false, // 第二个 static 实例，避免重复装饰 reply
    /*
     * 长缓存：这些库只有升级版本才变，1.8MB 的 sfc-loader 不该每次开课重下。
     * 用 maxAge + immutable（@fastify/static 自己会拼 Cache-Control），
     * 别在 setHeaders 里手写 —— 那样会被它自己的默认值 max-age=0 覆盖。
     */
    maxAge: '365d',
    immutable: true,
    setHeaders(res) {
      res.setHeader('Access-Control-Allow-Origin', '*')
    },
  })

  if (hasWeb) {
    app.get('/', serveIndex)
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      index: false, // 入口页由上面的显式路由处理
      setHeaders(res, filePath) {
        // 带 hash 的产物可以长期缓存
        if (filePath.includes(path.sep + 'assets' + path.sep)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          return
        }
        // 入口页必须 no-cache（上面那条路由已经处理，这里是直连 /index.html 的情况）
        if (path.basename(filePath) === 'index.html') {
          res.setHeader('Cache-Control', 'no-cache')
        }
      },
    })
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply
        .status(404)
        .send({ error: { code: 'not_found', message: '接口不存在：' + req.method + ' ' + req.url } })
    }
    if (!hasWeb) {
      return reply
        .status(200)
        .type('text/html; charset=utf-8')
        .send(
          '<!doctype html><meta charset="utf-8"><title>前端还没构建</title>' +
            '<body style="font:16px/1.8 system-ui;padding:40px">' +
            '<h2>前端还没构建</h2><p>在 <code>web</code> 目录执行：</p>' +
            '<pre style="background:#f4f5f7;padding:12px;border-radius:8px">npm install\nnpm run build</pre></body>'
        )
    }
    // SPA 路由（/teacher/classes 之类）：一律回入口页，交给前端路由
    return serveIndex(req, reply)
  })

  return app
}
