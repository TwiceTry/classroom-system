'use strict'
/*
 * index.js —— 课堂系统服务入口（零第三方依赖，基线 Node 13.6.0 / Win7 x64）
 *
 * 一个进程同时干四件事：
 *   1) 静态托管前端构建产物（web/dist）；
 *   2) 提供 /api/* 业务接口；
 *   3) 把「代码示例」按原样挂到 /examples（Playground 预览要用真实相对路径）；
 *   4) /ws 上跑投屏中继（教师 → 学生）。
 *
 * 启动：node server/index.js   或  双击 启动课堂系统.bat
 */
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const config = require('./config')
const scheme = require('./lib/scheme')
const { createDb } = require('./lib/db')
const { createCast } = require('./routes/cast')
const compat = require('./lib/compat')
const coursepack = require('./lib/coursepack')
const createApi = require('./routes/api')
const { json, fail, sendFile, isInside, HttpError } = require('./lib/http')

const db = createDb(config.dataDir)
// 每个学生一套专属目录（作业 / 大作业 / 机试 / 记分）：启动时把老数据缺的一次补齐
require('./lib/students').ensureAll(db.listClasses())
const cast = createCast()
const api = createApi(db, cast)

/* ---------------- 启动自检 ---------------- */

function checkDirs() {
  const problems = []
  // 新布局：课程内容跟着课程走（data/courses/<课程>/content/），由课程包或各 tab 的导入放进来。
  // 库里已经有课程，就说明内容不指望「系统旁边的 lecture/materials」，别报缺。
  let hasCourses = false
  try {
    hasCourses = fs.readdirSync(path.join(config.dataDir, 'courses')).length > 0
  } catch (e) {
    hasCourses = false
  }
  if (hasCourses) return problems

  for (const [label, dir] of [
    ['materials', config.materialsDir],
    ['lecture', config.lectureDir],
    ['代码示例', config.examplesDir],
  ]) {
    if (!fs.existsSync(dir)) {
      problems.push(
        '没找到内容目录 ' + label + '：' + dir +
          '（新课的内容在 data/courses/<课程>/content/ 里，用「课程包导入」或对应页签的「导入」放进去；老布局才需要 courseDir / TS_COURSE_DIR）'
      )
    }
  }
  return problems
}

/* ---------------- 静态资源 ---------------- */

function serveSpa(req, res) {
  const url = new URL(req.url, 'http://x')
  let pathname = decodeURIComponent(url.pathname)
  if (pathname.endsWith('/')) pathname += 'index.html'

  const indexHtml = path.join(config.webDist, 'index.html')
  if (!fs.existsSync(indexHtml)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>课堂系统未构建</title>' +
        '<body style="font:16px/1.8 system-ui;padding:40px;max-width:720px;margin:auto">' +
        '<h2>前端还没构建</h2>' +
        '<p>在 <code>web</code> 目录里执行一次：</p>' +
        '<pre style="background:#f4f5f7;padding:12px;border-radius:8px">npm install\nnpm run build</pre>' +
        '<p>然后重启本服务。接口本身已经可用：<a href="/api/bootstrap">/api/bootstrap</a></p>'
    )
    return
  }

  const file = path.join(config.webDist, pathname)
  // 前端产物文件名带内容哈希（index-xxxx.js）→ 内容变了就换名，可以长期缓存；
  // /vendor 里的第三方库很少变 → 缓存一天。
  const cacheOpt = /^\/assets\//.test(pathname)
    ? { cache: 'public, max-age=31536000, immutable' }
    : /^\/vendor\//.test(pathname)
      ? { cache: 'public, max-age=86400' }
      : {}
  if (isInside(config.webDist, file) && sendFile(res, file, cacheOpt)) return

  // SPA 回退：/teacher/xxx、/watch 之类的路由都交给 index.html
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
  fs.createReadStream(indexHtml).pipe(res)
}

/* ---------------- 请求分发 ---------------- */

const server = http.createServer(async (req, res) => {
  const started = Date.now()
  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch (e) {
    return fail(res, 400, 'Bad URL')
  }
  const pathname = decodeURIComponent(url.pathname)
  const method = req.method

  res.on('finish', () => {
    if (pathname.startsWith('/api/')) {
      const cost = Date.now() - started
      if (cost > 300) console.log('[slow] ' + method + ' ' + pathname + ' ' + cost + 'ms')
    }
  })

  try {
    // 1) 业务接口
    if (pathname.startsWith('/api/')) {
      const hit = api.router.match(method, pathname)
      if (!hit) return fail(res, 404, '接口不存在：' + method + ' ' + pathname)
      // 每个请求一个独立的「当前考核方案」上下文：
      // need() 在 handler 里设方案，之后所有 scoring / scheme 读取都只看到自己那份，
      // 并发请求之间不会互相把方案改掉（多课程并行时这是真 bug）。
      const out = await scheme.runInRequest(() => hit.handler(req, hit.params, res))
      if (out !== undefined && !res.writableEnded) json(res, 200, out)
      return
    }

    // 2) 证据文件
    if (pathname.startsWith('/uploads/')) {
      const name = pathname.slice('/uploads/'.length)
      const file = path.join(config.uploadDir, name)
      if (isInside(config.uploadDir, file) && sendFile(res, file, { cache: 'private, max-age=86400' })) return
      return fail(res, 404, '文件不存在')
    }

    // 3) 代码示例（Playground 要按真实相对路径加载 vue.global.js 等）
    if (pathname.startsWith('/examples/')) {
      const rel = pathname.slice('/examples/'.length)
      // 新布局：内容跟着课程走（data/courses/<课程>/content/代码示例/）——
      // 页面里的 <script src="../vue.global.js"> 要按真实相对路径拿到运行时库
      const roots = []
      try {
        for (const c of db.listCourses()) {
          if (c.archived) continue
          roots.push(path.join(coursepack.contentRootOf(c), '代码示例'))
        }
      } catch (e) {
        /* 没有课程就走老布局 */
      }
      if (config.examplesDir) roots.push(config.examplesDir) // 老布局兜底
      for (const root of roots) {
        if (!root) continue
        const file = path.join(root, rel)
        // 示例运行时库（vue.global.js 等）很少变 → 缓存一天
        if (isInside(root, file) && sendFile(res, file, { cache: 'public, max-age=86400' })) return
      }
      return fail(res, 404, '示例文件不存在')
    }

    // 3.5) 绿色版 Chrome 下载（兼容性兜底页上的按钮）
    if (pathname === '/download/chrome109') {
      const bundle = compat.findBundle()
      const cfg = compat.readCfg()
      if (!bundle) {
        const url = String(cfg.downloadUrl || '').trim()
        if (url) {
          res.writeHead(302, { Location: url })
          return res.end()
        }
        return fail(res, 404, '服务器上还没有放绿色版 Chrome（把 chrome109.zip 放进 downloads/ 就会自动提供下载）')
      }
      const name = path.basename(bundle)
      const type = /\.zip$/i.test(name)
        ? 'application/zip'
        : /\.exe$/i.test(name)
          ? 'application/vnd.microsoft.portable-executable'
          : /\.7z$/i.test(name)
            ? 'application/x-7z-compressed'
            : 'application/octet-stream'
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': fs.statSync(bundle).size,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
        'Cache-Control': 'no-store',
      })
      return fs.createReadStream(bundle).pipe(res)
    }

    // 4) 前端页面
    if (method === 'GET' || method === 'HEAD') return serveSpa(req, res)
    return fail(res, 405, '不支持的方法')
  } catch (e) {
    if (e instanceof HttpError) {
      // 校验类错误（课程包 / 名单）会带逐条明细，一起发给前端
      const body = { error: e.message }
      if (Array.isArray(e.errors) && e.errors.length) body.errors = e.errors
      if (Array.isArray(e.warnings) && e.warnings.length) body.warnings = e.warnings
      return json(res, e.status, body)
    }
    console.error('[500] ' + method + ' ' + pathname + '\n' + (e && e.stack))
    if (!res.headersSent) return fail(res, 500, (e && e.message) || '服务端异常')
    try {
      res.end()
    } catch (e2) {
      /* ignore */
    }
  }
})

/* ---------------- 投屏中继 ---------------- */

cast.attach(server)
cast.setLan(lanAddresses())

/* ---------------- 启动 ---------------- */

function lanAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  Object.keys(ifaces).forEach((name) => {
    for (const ni of ifaces[name] || []) {
      // 169.254.* 是网卡没拿到 DHCP 时的自分配地址，学生机连不上去，别印出来误导人
      if (ni.family === 'IPv4' && !ni.internal && !/^169\.254\./.test(ni.address)) out.push(ni.address)
    }
  })
  return out
}

const problems = checkDirs()

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n[启动失败] 端口 ' + config.port + ' 已被占用。')
    console.error('  可能是课堂系统已经开着一个窗口了（或者别的程序占了该端口）。')
    console.error('  换端口：set TS_PORT=18731 后再启动，或改 data/config.json 里的 port。\n')
  } else {
    console.error('\n[启动失败] ' + e.message + '\n')
  }
  process.exit(1)
})

server.listen(config.port, config.host, () => {
  const line = '='.repeat(64)
  console.log('\n' + line)
  console.log('  示例课程 · 课堂系统')
  console.log(line)
  console.log('  教师端          http://localhost:' + config.port + '/  （口令登录，不限定登录位置）')
  for (const ip of lanAddresses()) {
    console.log('  教师端 / 学生端 http://' + ip + ':' + config.port + '/')
  }
  console.log('  投屏观看页      http://<教师机IP>:' + config.port + '/watch')
  console.log('  数据目录        ' + config.dataDir + '（classes/students/events 等 CSV + students/<班级>/<学号>/ 下的作业正文与大作业、记分快照）')
  console.log('  课程内容目录    ' + config.courseDir + '（讲义 / 材料 / 代码示例；改 data/config.json 的 courseDir 可换）')
  console.log(line)

  if (config.passwordIsDefault) {
    console.log('  ! 教师口令仍是默认值 "' + config.teacherPassword + '"')
    console.log('    改法：编辑 ' + path.join(config.dataDir, 'config.json') + ' 里的 teacherPassword')
  }
  if (!fs.existsSync(path.join(config.webDist, 'index.html'))) {
    console.log('  ! 前端尚未构建（web/dist 不存在），接口可用但页面打不开')
    console.log('    在 web 里执行 npm install && npm run build')
  }
  for (const p of problems) console.log('  ! ' + p)
  console.log('')
})

function shutdown() {
  const changed = db.flush()
  console.log('\n已写入 CSV' + (changed ? '（' + changed + ' 个文件有改动）' : '（无改动）') + '，退出。')
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
