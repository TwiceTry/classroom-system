#!/usr/bin/env node
/*
 * check-compat.mjs —— 两条兼容基线的自动体检。
 *
 *   基线 1：后端跑在服务器上（Node >= 20 LTS）。**Win7 已不支持**，不再追 Node 13。
 *   基线 2：前端跑在 Chrome 109 —— 这是**机房现有设备的底线**，不是 Win7 遗留要求。
 *           这条不能松：机房没换代之前把 build.target 抬上去，就是白屏。
 *
 * 两条作用域不同：Node 只在服务器上跑；教师机 / 学生机只开浏览器。
 *
 * 为什么要脚本化：这两个版本号不会因为「今天跑得起来」就永远安全。
 * npm 升级、build.target 被顺手抬高一档、某个新库用了 toSorted / color-mix，
 * 在开发机（Win11 + 新版 Chrome + Node 22）上全都毫无症状，到机房才炸。
 *
 * 用法：
 *   node tools/check-compat.mjs            # 全查
 *   node tools/check-compat.mjs --backend  # 只查运行时基线
 *   node tools/check-compat.mjs --frontend # 只查浏览器基线
 *
 * 后端那一半用**当前** Node 跑（不再去找便携 Node 13 —— 那条离线包路线已下线）。
 *
 * 退出码：0 全绿 / 1 有问题 / 2 参数或环境不满足。输出保持纯 ASCII。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url)) // …/tools
const APP = path.resolve(HERE, '..') // 课堂系统/
const REPO = path.resolve(APP, '..') // 仓库根（系统目录的上一级；系统已从课程目录里独立出来）
const WEB = path.join(APP, 'web')

const args = process.argv.slice(2)
const doBackend = !args.length || args.includes('--backend')
const doFrontend = !args.length || args.includes('--frontend')

let problems = 0
let skipped = 0

function hit(label, ok, detail) {
  if (!ok) problems++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

/* ========================== 后端：Node 20 ========================== */

/* 后端基线是**服务器上跑的 Node 20 LTS**（`api/package.json` 的 engines、部署文档都按这个）。
 *
 * 这里只钉「Node 20 不支持的 API」—— 写进代码就是运行期 TypeError，改天换台机器才炸。
 *
 * 历史上这张表是给 Node 13.6 准备的：那时 `?.` / `??` 是**语法错误**，
 * `.at` / `replaceAll` / `AbortController` 也都没有，所以逐条列着。
 * 放弃 Win7 之后这些全都过时了 —— Node 20 原生支持，钉着它们只会天天误报。
 */
const BASELINE_BANNED = [
  ['Object.groupBy(', 'Node 21'],
  ['Map.groupBy(', 'Node 21'],
  ['Array.fromAsync(', 'Node 22'],
  ['Promise.withResolvers(', 'Node 22'],
  ['Promise.try(', 'Node 24'],
  ['fs.glob(', 'Node 22'],
]

/*
 * 这里曾经有个 findBaselineNode()：去 package-win7/node/node.exe 与 _tmp/node 下
 * 找一份 Node 13 来跑后端语法检查。放弃 Win7 后那份便携 Node 已下线，
 * 而且它从来没有调用方（checkBackend 用的是 process.execPath）—— 已删。
 * 后端基线现在就是「当前 Node 能加载全部 api/src」。
 */

function listFiles(dir, exts, skipDirs) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (!skipDirs.includes(e.name)) walk(p)
      } else if (exts.some((x) => e.name.endsWith(x))) out.push(p)
    }
  }
  walk(dir)
  return out
}

function checkBackend() {
  console.log('')
  console.log('[backend] server-side Node (>= 20)')
  const major = Number(String(process.versions.node).split('.')[0])
  hit('runtime: node ' + process.version + ' is >= 20', major >= 20, 'this process is node ' + process.version)
  const node = { exe: process.execPath, version: 'v' + process.versions.node }

  /*
   * 注意路径：后端代码在 api/src（旧的 server/ 已随重构删除）。
   * 这里曾经指向 server/，目录没了之后 listFiles 返回空数组，
   * 「0 个文件全部通过」看着是绿的，实际一个文件都没查 —— 检查工具自己先瞎了。
   */
  const files = listFiles(path.join(APP, 'api', 'src'), ['.js', '.mjs'], ['node_modules', 'dist'])
  let syntaxBad = 0
  for (const f of files) {
    try {
      execFileSync(node.exe, ['--check', f], { stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '' } })
    } catch (e) {
      syntaxBad++
      const msg = String(e.stderr || e.message)
        .split('\n')
        .find((l) => l.includes('Error')) || ''
      console.log(`  FAIL  syntax  ${path.relative(APP, f)}  ${msg.trim()}`)
    }
  }
  hit(
    `syntax: ${files.length} backend file(s) load under ${node.version}`,
    // 一个文件都没扫到 = 路径写错了，不能算通过
    files.length > 0 && syntaxBad === 0,
    files.length === 0 ? 'no files found under api/src — path is wrong' : syntaxBad ? `${syntaxBad} failed` : ''
  )

  let banned = 0
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    for (const [needle, why] of BASELINE_BANNED) {
      lines.forEach((line, i) => {
        // 注释行不算（说明文字里提到 API 名字是正常的）
        if (!line.includes(needle)) return
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) return
        banned++
        console.log(`  FAIL  ${path.relative(APP, f)}:${i + 1}  uses ${needle}  (${why})`)
      })
    }
  }
  // 命中就是真的不能用（服务器 Node 20 上没有那个 API），不是「提示」
  hit(`api: no API newer than Node 20`, banned === 0, banned ? banned + ' hit(s)' : '')
}

/* ============================ 前端：Chrome 109 ============================ */

/* Chrome 109 之后才有的东西。命中的后果分两档：
 *   JS 内置缺失 → 调用处直接抛 TypeError（页面看着正常，一点就废）
 *   CSS 特性缺失 → 规则被整条丢弃（边框、布局悄悄塌掉）
 * 纯语法级（??、?.、可选链）由 build.target 兜底，esbuild 会降级，不用在这里查。 */
const CHROME_TOO_NEW = [
  ['toSorted(', 'Chrome 110'],
  ['toReversed(', 'Chrome 110'],
  ['toSpliced(', 'Chrome 110'],
  ['Object.groupBy(', 'Chrome 117'],
  ['Map.groupBy(', 'Chrome 117'],
  ['Promise.withResolvers(', 'Chrome 119'],
  ['URL.canParse(', 'Chrome 120'],
  ['Array.fromAsync(', 'Chrome 121'],
  ['URL.parse(', 'Chrome 126'],
  ['Promise.try(', 'Chrome 128'],
  ['isWellFormed(', 'Chrome 111'],
  ['color-mix(', 'Chrome 111'],
  ['oklch(', 'Chrome 111'],
  ['oklab(', 'Chrome 111'],
  ['light-dark(', 'Chrome 123'],
  ['text-wrap: balance', 'Chrome 114'],
  ['text-wrap:balance', 'Chrome 114'],
  ['text-wrap: pretty', 'Chrome 117'],
  ['subgrid', 'Chrome 117'],
  ['field-sizing', 'Chrome 123'],
  ['position-anchor(', 'Chrome 125'],
  ['anchor-name', 'Chrome 125'],
  ['@scope', 'Chrome 118'],
  ['::view-transition', 'Chrome 111'],
  ['interpolate-size', 'Chrome 129'],
]

/* 第三方库里「写着但不会被我们触发」的命中。压缩产物里没法区分上下文，
 * 所以按模式精确放过；放过时也会打印一行，避免有人以为脚本没查。 */
const INERT_IN_LIBS = [
  {
    re: /\{return [A-Za-z_$][\w$]*\(this\)\.(toSorted|toReversed|toSpliced)\(/,
    why: 'Vue reactive-array method stub (only throws if called; our code never calls it)',
  },
  { re: /["'`]@scope["'`]/, why: 'CodeMirror CSS at-rule keyword table (string literal)' },
  { re: /["'`]@view-transition["'`]/, why: 'CodeMirror CSS at-rule keyword table (string literal)' },
  { re: /get anchor\(\)/, why: 'CodeMirror selection getter (property named anchor)' },
]

function contextOf(src, idx, needle) {
  return src.slice(Math.max(0, idx - 80), Math.min(src.length, idx + needle.length + 40))
}

function scanFiles(files, label, allowInert) {
  let bad = 0
  let inert = 0
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    for (const [needle, why] of CHROME_TOO_NEW) {
      let idx = src.indexOf(needle)
      while (idx >= 0) {
        const ctx = contextOf(src, idx, needle)
        const known = allowInert && INERT_IN_LIBS.find((x) => x.re.test(ctx))
        if (known) {
          inert++
        } else {
          bad++
          const line = src.slice(0, idx).split('\n').length
          console.log(`  FAIL  ${path.relative(REPO, f)}:${line}  uses ${needle}  (${why})`)
        }
        idx = src.indexOf(needle, idx + 1)
      }
    }
  }
  hit(
    `${label}: no post-Chrome-109 feature`,
    bad === 0,
    bad ? `${bad} hit(s)` : inert ? `${inert} known-inert hit(s) in libs` : ''
  )
  return bad
}

function checkFrontend() {
  console.log('')
  console.log('[frontend] Chrome 109 baseline')

  /* 1. 构建目标不能高于 chrome109（现在定的是 chrome78，越低越保险） */
  const viteCfg = path.join(WEB, 'vite.config.js')
  if (fs.existsSync(viteCfg)) {
    const cfg = fs.readFileSync(viteCfg, 'utf8')
    const m = cfg.match(/target\s*:\s*\[?([^\]\n]+)/)
    const target = m ? m[1].trim().replace(/,\s*$/, '') : '(not set)'
    const tooHigh = /chrome(1[1-9]\d|[2-9]\d\d)|esnext|es202[3-9]/.test(target)
    hit(`build.target = ${target}`, !tooHigh, tooHigh ? 'higher than chrome109 — lower it' : '')
  } else {
    hit('web/vite.config.js exists', false)
  }

  /* 2. 我们自己的源码先查一遍：报错能指到具体文件行号 */
  const srcDir = path.join(WEB, 'src')
  if (fs.existsSync(srcDir)) {
    scanFiles(listFiles(srcDir, ['.js', '.mjs', '.vue'], []), 'src', false)
  }

  /* 3. 真正发到机房的产物 + 本地 vendor 库 */
  const dist = path.join(WEB, 'dist')
  if (!fs.existsSync(dist)) {
    console.log('  SKIP  web/dist missing — run `npm --prefix web run build` first')
    skipped++
  } else {
    const assets = path.join(dist, 'assets')
    const distFiles = fs.existsSync(assets)
      ? fs.readdirSync(assets).filter((n) => /\.(js|css)$/.test(n)).map((n) => path.join(assets, n))
      : []
    scanFiles(distFiles, `dist (${distFiles.length} file(s))`, true)
  }

  const vendor = path.join(WEB, 'public', 'vendor')
  if (fs.existsSync(vendor)) {
    const vf = fs.readdirSync(vendor).filter((n) => n.endsWith('.js')).map((n) => path.join(vendor, n))
    scanFiles(vf, `vendor (${vf.length} file(s))`, true)
  }

  /* 4. CSS 嵌套（Chrome 112+）：只警告。我们的样式不该用，但别让它挡住发布 */
  const cssFiles = listFiles(srcDir, ['.css', '.vue'], []).filter((f) => fs.existsSync(f))
  let nest = 0
  for (const f of cssFiles) {
    const src = fs.readFileSync(f, 'utf8')
    if (/[;{}]\s*&[\s:#.[&>+~:]/.test(src)) {
      nest++
      console.log(`  WARN  ${path.relative(REPO, f)}  uses CSS nesting (&)  (Chrome 112+)`)
    }
  }
  if (!nest) hit('source CSS: no nesting (&)', true)
  else console.log(`  WARN  source CSS: ${nest} file(s) use nesting (&) — Chrome 112+`)

  /* 5. 入口页的兼容性检测脚本必须是 ES5
   *    它要在「任何框架代码之前」执行，浏览器如果连 ES6 都不认，这段自己就崩了、
   *    兜底页根本出不来 —— 那才是真正的白屏。所以这里禁止箭头函数 / const / let / 模板字符串 / ?. / ?? */
  const entry = path.join(WEB, 'index.html')
  if (!fs.existsSync(entry)) {
    console.log('  SKIP  web/index.html missing')
  } else {
    const html = fs.readFileSync(entry, 'utf8')
    const inline = []
    const re = /<script(?![^>]*\bsrc=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/gi
    let m
    while ((m = re.exec(html))) inline.push(m[1])
    const gate = inline.find((s) => s.indexOf('__compat') >= 0) || ''
    if (!gate) {
      hit('index.html: has a compat gate script', false, 'no inline script sets window.__compat')
    } else {
      const bad = []
      if (/=>/.test(gate)) bad.push('arrow function')
      if (/\bconst\b|\blet\b/.test(gate)) bad.push('const/let')
      if (/\?\.[A-Za-z_$[(]/.test(gate)) bad.push('optional chaining')
      if (/\?\?/.test(gate)) bad.push('nullish coalescing')
      if (bad.length) {
        hit('index.html compat gate stays ES5', false, bad.join(' / '))
      } else {
        hit('index.html compat gate stays ES5', true)
      }
    }
  }
}

if (doBackend) checkBackend()
if (doFrontend) checkFrontend()

/* .bat 体检：只在 cmd.exe 里才炸的三类毛病（LF 行尾 / 块里裸括号 / chcp 65001） */
if (doFrontend) {
  console.log('')
  console.log('-- batch files --')
  const r = spawnSync(process.execPath, [path.join(HERE, 'check-bat.mjs')], { encoding: 'utf8' })
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    if (line.startsWith('  FAIL')) problems++
    console.log(line)
  }
  if (r.status !== 0 && !String(r.stdout || '').includes('FAIL')) problems++
}

console.log('')
if (problems) {
  console.log(`RESULT: ${problems} problem(s)`)
  process.exit(1)
}
console.log(skipped ? 'RESULT: ok (with skips)' : 'RESULT: all green')
