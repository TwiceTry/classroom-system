#!/usr/bin/env node
/*
 * lan-proxy.js —— 教学机上的「局域网 → 公网」正向代理（反向代理）
 *
 * 场景：教学机有两块网卡 —— 一块连学生机的局域网，一块通公网。
 *       项目部署在公网的地址（例如 https://your-public-host:45600）
 *       学生机在局域网里直接访问不稳 / 不通 / 想走教学机中转，
 *       就在教学机上跑这个脚本：监听一个本地端口，把请求原样转给公网地址。
 *
 *   学生机  ──(局域网)──▶  教学机 :18799  ──(公网)──▶  https://your-public-host:45600
 *
 * ★ 实时流量走本地（新增）
 *   投屏、点名心跳、在线状态这些是「实时流量」，走公网绕一圈又慢又占带宽
 *   （投屏的画面帧尤其致命）。所以按路径分流：
 *
 *     /ws、/api/cast/*、/api/presence/*、/api/clock/*   →  本机课堂系统（127.0.0.1:18730）
 *     其它（页面、静态资源、作业、名单、接口…）          →  公网地址
 *
 *   分流清单用 --local-paths 改；不想分流就加 --no-local。
 *
 * 特点：
 *   · 零依赖，只用 Node 内置模块（http/https/net/tls/url/os）——Win7 上不用装任何东西
 *   · 兼容 Node 6 ~ 12（Win7 能装的最后一个大版本是 Node 12.22 LTS）
 *   · 透传 WebSocket（课堂系统的投屏 / 同步走 /ws，必须能代理）
 *   · 透传流式响应、压缩、分块；上游的 Location 会改写成本地地址，避免跳到公网去
 *   · 上游证书自签时可加 --insecure 跳过校验
 *
 * 用法：
 *   node lan-proxy.js --port 18799 --target https://your-public-host:45600
 *   node lan-proxy.js --port 18799 --target https://… --local-target http://127.0.0.1:18730
 *   node lan-proxy.js --port 18799 --target https://… --host 192.0.2.21 --verbose
 */

'use strict'

var http = require('http')
var https = require('https')
var net = require('net')
var tls = require('tls')
var url = require('url')
var os = require('os')

/* ---------------- 参数 ---------------- */
function arg(name, def) {
  var i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
function has(name) {
  return process.argv.indexOf('--' + name) >= 0
}

var LISTEN_PORT = parseInt(arg('port', '18799'), 10)
var LISTEN_HOST = arg('host', '0.0.0.0')
var TARGET = arg('target', 'http://127.0.0.1:18730') // 默认转本机的课堂系统；要转发到公网就在命令行里传 --target
var TIMEOUT = parseInt(arg('timeout', '120000'), 10)
var INSECURE = has('insecure')
var VERBOSE = has('verbose')
var REWRITE = !has('no-redirect-rewrite')
var QUIET = has('quiet')

/* 实时流量分流：走本机课堂系统，不出公网 */
var USE_LOCAL = !has('no-local')
var LOCAL_TARGET = arg('local-target', 'http://127.0.0.1:18730')
var LOCAL_PATHS = arg('local-paths', '/ws,/api/cast,/api/presence,/api/clock')
  .split(',')
  .map(function (x) {
    return x.trim()
  })
  .filter(Boolean)

if (!LISTEN_PORT) {
  console.error('端口不对：--port 要一个数字')
  process.exit(1)
}

function parseTarget(raw) {
  var u = url.parse(raw)
  if (!u.protocol || !u.hostname) return null
  return {
    raw: raw,
    protocol: u.protocol,
    host: u.hostname,
    port: parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80),
    basePath: u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : '',
    hostHeader: u.host,
    agent: null,
  }
}

var UP = parseTarget(TARGET)
if (!UP) {
  console.error('目标地址不对：--target 要写成 http://主机:端口 或 https://主机:端口')
  process.exit(1)
}
var LOCAL = USE_LOCAL ? parseTarget(LOCAL_TARGET) : null
if (USE_LOCAL && !LOCAL) {
  console.error('本地目标地址不对：--local-target 要写成 http://127.0.0.1:18730 这样的样子')
  process.exit(1)
}

/* 每个目标一个连接池 */
function makeAgent(t) {
  if (t.protocol === 'https:') {
    t.agent = new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: !INSECURE })
  } else {
    t.agent = new http.Agent({ keepAlive: true, maxSockets: 64 })
  }
  return t.agent
}
makeAgent(UP)
if (LOCAL) makeAgent(LOCAL)

/* 逐跳头 */
var HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']

function copyHeaders(src) {
  var out = {}
  for (var k in src) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue
    var v = src[k]
    out[k] = Array.isArray(v) ? v.slice() : v
  }
  return out
}

function stripHop(headers) {
  var out = {}
  for (var k in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, k)) continue
    if (HOP.indexOf(k.toLowerCase()) >= 0) continue
    out[k] = headers[k]
  }
  return out
}

function now() {
  var d = new Date()
  function p(n) {
    return (n < 10 ? '0' : '') + n
  }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

function log() {
  if (QUIET) return
  var a = Array.prototype.slice.call(arguments)
  a[0] = '[' + now() + '] ' + a[0]
  console.log.apply(console, a)
}

function verbose() {
  if (VERBOSE) log.apply(null, arguments)
}

/* 请求该走哪一边：实时流量走本地，别的走公网 */
function pickTarget(reqPath) {
  if (!LOCAL) return { t: UP, tag: '公网' }
  var p = String(reqPath || '').split('?')[0]
  for (var i = 0; i < LOCAL_PATHS.length; i++) {
    var pre = LOCAL_PATHS[i]
    if (p === pre || p.indexOf(pre + '/') === 0 || (pre.charAt(pre.length - 1) === '/' && p.indexOf(pre) === 0)) {
      return { t: LOCAL, tag: '本地' }
    }
  }
  return { t: UP, tag: '公网' }
}

/* 上游的绝对地址 → 本地地址（重定向别把人甩到公网去） */
function localOrigin(req) {
  var host = req.headers['x-forwarded-host'] || req.headers.host || LISTEN_HOST + ':' + LISTEN_PORT
  return 'http://' + host
}

function rewriteLocation(loc, req, t) {
  if (!loc) return loc
  var origin = t.protocol + '//' + t.hostHeader
  if (loc.indexOf(origin) === 0) return localOrigin(req) + loc.slice(origin.length)
  if (loc.indexOf('//' + t.hostHeader) === 0) return localOrigin(req) + loc.slice(('//' + t.hostHeader).length)
  return loc
}

function rewriteCookie(cookies) {
  if (!cookies) return cookies
  var list = Array.isArray(cookies) ? cookies : [cookies]
  var out = list.map(function (c) {
    return String(c).replace(/;\s*domain=[^;]*/gi, '')
  })
  return Array.isArray(cookies) ? out : out[0]
}

/* ---------------- HTTP 转发 ---------------- */
function upstreamRequest(req, res, target, tag) {
  var headers = stripHop(copyHeaders(req.headers))
  headers.host = target.hostHeader
  headers['accept-encoding'] = req.headers['accept-encoding'] || 'identity'

  var opts = {
    protocol: target.protocol,
    host: target.host,
    port: target.port,
    method: req.method,
    path: target.basePath + req.url,
    headers: headers,
    agent: target.agent,
  }
  if (target.protocol === 'https:') opts.rejectUnauthorized = !INSECURE

  var client = target.protocol === 'https:' ? https : http
  var started = Date.now()
  var proxyReq = client.request(opts, function (proxyRes) {
    try {
      var out = stripHop(copyHeaders(proxyRes.headers))
      // 不能给不存在的头赋 undefined（Node 会当非法头值抛错，整个代理就崩了）
      if (REWRITE && out.location) out.location = rewriteLocation(out.location, req, target)
      if (proxyRes.headers['set-cookie']) out['set-cookie'] = rewriteCookie(proxyRes.headers['set-cookie'])
      res.writeHead(proxyRes.statusCode, out)
      proxyRes.pipe(res)
      verbose(
        tag + ' ' + req.method + ' ' + req.url + ' → ' + proxyRes.statusCode + ' · ' + (Date.now() - started) + 'ms · ' +
          (proxyRes.headers['content-type'] || '')
      )
    } catch (e) {
      verbose('回包处理出错：' + e.message)
      try {
        fail(res, 502, '处理上游响应时出错：' + e.message)
      } catch (e2) {}
    }
  })

  proxyReq.setTimeout(TIMEOUT, function () {
    proxyReq.abort()
    fail(res, 504, '上游超时（' + TIMEOUT + 'ms 没回话）')
  })

  proxyReq.on('error', function (e) {
    verbose('上游错误 ' + tag + ' ' + req.method + ' ' + req.url + '：' + e.message)
    fail(
      res,
      502,
      tag === '本地'
        ? '连不上本机的课堂系统（' + LOCAL.raw + '）：' + e.message + ' —— 确认课堂系统在本机跑着'
        : '连不上上游：' + e.message
    )
  })

  req.on('aborted', function () {
    proxyReq.abort()
  })
  res.on('close', function () {
    if (!res.finished) proxyReq.abort()
  })

  req.pipe(proxyReq)
}

function fail(res, code, msg) {
  if (res.headersSent) {
    try {
      res.end()
    } catch (e) {}
    return
  }
  var body =
    '<!doctype html><meta charset="utf-8"><title>' + code + '</title>' +
    '<body style="font:16px/1.7 system-ui;padding:40px"><h2>代理没能转发出去（' + code + '）</h2><p>' +
    String(msg).replace(/[<>&]/g, '') +
    '</p><p style="color:#666">检查：上游/本机课堂系统能不能访问？端口对不对？</p>'
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

/* ---------------- WebSocket / 投屏同步 ---------------- */
function onUpgrade(req, socket, head) {
  socket.setTimeout(0)
  socket.setNoDelay(true)
  socket.setKeepAlive(true, 30000)

  var pick = pickTarget(req.url)
  var target = pick.t
  var headers = copyHeaders(req.headers)
  headers.host = target.hostHeader

  var upstream
  if (target.protocol === 'https:') {
    upstream = tls.connect(
      { host: target.host, port: target.port, rejectUnauthorized: !INSECURE, servername: target.host },
      function () {
        pipeUpgrade(req, socket, head, upstream, headers, target)
      }
    )
  } else {
    upstream = net.connect(target.port, target.host, function () {
      pipeUpgrade(req, socket, head, upstream, headers, target)
    })
  }

  upstream.on('error', function (e) {
    verbose('WebSocket 失败（' + pick.tag + '）：' + e.message)
    try {
      socket.destroy()
    } catch (e2) {}
  })
  socket.on('error', function () {
    try {
      upstream.destroy()
    } catch (e2) {}
  })
  verbose(pick.tag + ' WebSocket 升级：' + req.url)
}

function pipeUpgrade(req, socket, head, upstream, headers, target) {
  var lines = [req.method + ' ' + target.basePath + req.url + ' HTTP/' + (req.httpVersion || '1.1')]
  for (var k in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, k)) continue
    var v = headers[k]
    if (Array.isArray(v)) v = v.join(', ')
    lines.push(k + ': ' + v)
  }
  upstream.write(lines.join('\r\n') + '\r\n\r\n')
  if (head && head.length) upstream.write(head)
  socket.pipe(upstream)
  upstream.pipe(socket)
  socket.on('close', function () {
    try {
      upstream.destroy()
    } catch (e) {}
  })
  upstream.on('close', function () {
    try {
      socket.destroy()
    } catch (e) {}
  })
}

/* ---------------- 服务 ---------------- */
var server = http.createServer(function (req, res) {
  if (req.url === '/__proxy_health') {
    var pick = pickTarget('/api/health')
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        ok: true,
        role: 'lan-proxy',
        listen: LISTEN_HOST + ':' + LISTEN_PORT,
        target: UP.raw,
        localTarget: LOCAL ? LOCAL.raw : '(不分流)',
        localPaths: LOCAL ? LOCAL_PATHS : [],
        sampleRoute: pick.t === LOCAL ? '本地' : '公网',
        uptimeSec: Math.round(process.uptime()),
      })
    )
    return
  }
  var p = pickTarget(req.url)
  upstreamRequest(req, res, p.t, p.tag)
})

server.on('upgrade', onUpgrade)
server.on('clientError', function (err, socket) {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  } catch (e) {}
})

server.listen(LISTEN_PORT, LISTEN_HOST, function () {
  var ips = []
  var ifs = os.networkInterfaces()
  for (var name in ifs) {
    var list = ifs[name] || []
    for (var i = 0; i < list.length; i++) {
      if (list[i].family === 'IPv4' && !list[i].internal) ips.push(name + ' ' + list[i].address)
    }
  }
  console.log('='.repeat(64))
  console.log('  课堂系统 · 局域网代理')
  console.log('='.repeat(64))
  console.log('  监听：' + (LISTEN_HOST === '0.0.0.0' ? '所有网卡' : LISTEN_HOST) + ' : ' + LISTEN_PORT)
  console.log('  页面/接口 → ' + UP.raw)
  if (LOCAL) {
    console.log('  实时流量 → ' + LOCAL.raw + '（本机，不出公网）')
    console.log('    本地路径：' + LOCAL_PATHS.join(' '))
  } else {
    console.log('  实时流量 → 跟页面一样走公网（--no-local）')
  }
  console.log('  自检：' + (LISTEN_HOST === '0.0.0.0' ? '127.0.0.1' : LISTEN_HOST) + ':' + LISTEN_PORT + '/__proxy_health')
  if (ips.length) {
    console.log('  教学机各网卡（学生用「局域网」那个）：')
    for (var j = 0; j < ips.length; j++) console.log('    · ' + ips[j])
  }
  console.log('  停止：Ctrl + C')
  console.log('='.repeat(64))
})

process.on('SIGINT', function () {
  console.log('\n收到 Ctrl+C，收尾退出…')
  server.close(function () {
    process.exit(0)
  })
  setTimeout(function () {
    process.exit(0)
  }, 1500)
})
process.on('SIGTERM', function () {
  server.close(function () {
    process.exit(0)
  })
})
