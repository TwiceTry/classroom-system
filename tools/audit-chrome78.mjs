#!/usr/bin/env node
/*
 * audit-chrome78.mjs —— 「前端能不能降到 Chrome 78」的体检
 *
 * 分三类看，因为它们的「降级可能性」完全不同：
 *
 *   1) 语法（?. ?? ||= class fields …）
 *      由 build.target 交给 esbuild 降级 → 只要 target=chrome78 就已经解决了，不用管。
 *
 *   2) JS 运行时 API（structuredClone / .at() / replaceAll …）
 *      降级不了，机器上没有就是 TypeError。必须逐个对版本。
 *
 *   3) CSS 特性（flex gap / :is() / clamp() / aspect-ratio …）
 *      esbuild 也不降级 CSS。不支持就是整条规则被丢弃，布局悄悄塌掉 —— 最难发现。
 *
 * 用法：node tools/audit-chrome78.mjs
 * 退出码：0 没有 blocker / 1 有 blocker（78 上会坏）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const SRC = path.join(APP, 'web', 'src')
const INDEX = path.join(APP, 'web', 'index.html')

const TARGET = 78 // 想验证的 Chrome 版本

/* ---------------- 清单 ---------------- */

/** JS 运行时 API：名字 → 从哪个 Chrome 开始有 */
const JS_API = [
  // 78 及以前就有（列出来是为了确认「不担心」的项也有据可查）
  ['globalThis', 71],
  ['Promise.allSettled', 76],
  ['String.prototype.matchAll', 73],
  ['matchAll(', 73],
  ['Object.fromEntries', 73],
  ['Array.prototype.flat', 69],
  ['flatMap(', 69],
  ['BigInt', 67],
  ['queueMicrotask', 71],
  ['.flat(', 69],

  // 78 之后才有 → 这些才是 blocker 候选
  ['structuredClone', 98],
  ['Object.hasOwn', 93],
  ['.at(', 92],
  ['.replaceAll(', 85],
  ['replaceAll(', 85],
  ['Promise.any', 85],
  ['allSettled(', 76],
  ['WeakRef', 84],
  ['FinalizationRegistry', 84],
  ['findLast(', 97],
  ['findLastIndex(', 97],
  ['Object.groupBy', 117],
  ['Map.groupBy', 117],
  ['Array.fromAsync', 121],
  ['Promise.withResolvers', 119],
  ['URL.canParse', 120],
  ['Array.prototype.toSorted', 110],
  ['toSorted(', 110],
  ['toReversed(', 110],
  ['toSpliced(', 110],
  ['createImageBitmap', 50],
  ['IntersectionObserver', 51],
  ['ResizeObserver', 64],
  ['reportError', 95],
  ['AbortSignal.timeout', 103],
  ['AbortSignal.any', 116],
  ['crypto.randomUUID', 92],
  ['navigator.clipboard', 66],
  ['Element.scrollIntoView', 61],
  ['scrollIntoViewIfNeeded', 0],
  ['structuredClone(', 98],
  ['Intl.RelativeTimeFormat', 71],
  ['Intl.DateTimeFormat', 24],
  ['formatRange', 76],
  ['scheduler.', 94],
  ['CSS.registerProperty', 85],
  ['dialog.showModal', 37],
  ['showModal(', 37],
  ['HTMLDialogElement', 37],
  ['requestIdleCallback', 47],
  ['FontFaceObserver', 0],
  ['visualViewport', 61],
  ['ResizeObserver(', 64],
  ['matchMedia(', 9],
  ['File.prototype.text', 76],
  ['.text()', 76],
  ['File.arrayBuffer', 76],
  ['arrayBuffer()', 76],
  ['Blob.prototype.text', 76],
  ['webkitdirectory', 13],
  ['showDirectoryPicker', 86],
  ['getDisplayMedia', 72],
  ['captureStream', 51],
  ['MediaRecorder', 47],
  ['WebSocket', 5],
  ['AudioContext', 35],
].sort((a, b) => a[1] - b[1])

/** CSS 特性：名字 → 从哪个 Chrome 开始有 */
const CSS_FEATURE = [
  // —— 78 及以前 ——
  ['var(--', 49],
  ['display: grid', 57],
  ['display:grid', 57],
  ['position: sticky', 56],
  ['object-fit', 32],
  ['backdrop-filter', 76],
  ['scroll-behavior', 61],
  ['overscroll-behavior', 63],
  ['@supports', 28],
  ['touch-action', 36],
  ['user-select', 54],
  ['appearance', 84],
  ['place-items', 59],
  ['fr;', 57],

  // —— 78 之后（blocker 候选）——
  ['gap:', 84], // flex 布局里的 gap 是 84；grid 的 gap 是 57，需人工判断上下文
  ['column-gap', 84],
  ['row-gap', 84],
  ['clamp(', 79],
  ['min(', 79],
  ['max(', 79],
  [':is(', 88],
  [':where(', 88],
  [':has(', 105],
  ['aspect-ratio', 88],
  ['inset:', 87],
  ['inset-inline', 87],
  ['inset-block', 87],
  ['margin-block', 87],
  ['margin-inline', 87],
  ['padding-block', 87],
  ['padding-inline', 87],
  ['border-start', 69],
  ['border-end', 69],
  [':focus-visible', 86],
  ['accent-color', 93],
  ['color-mix(', 111],
  ['oklch(', 111],
  ['oklab(', 111],
  ['light-dark(', 123],
  ['subgrid', 117],
  ['@container', 105],
  ['text-wrap: balance', 114],
  ['text-wrap: pretty', 117],
  ['field-sizing', 123],
  ['dvh', 108],
  ['svh', 108],
  ['lvh', 108],
  ['scrollbar-gutter', 94],
  ['content-visibility', 85],
  ['@layer', 99],
  ['contain-intrinsic', 95],
  ['mix-blend-mode', 41],
  ['font-variation-settings', 62],
  ['@property', 85],
  ['view-transition', 111],
  ['scroll-timeline', 115],
  ['anchor-name', 125],
].sort((a, b) => a[1] - b[1])

/* ---------------- 扫描 ---------------- */

function listFiles(dir, exts) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'dist') walk(p)
      } else if (exts.some((x) => e.name.endsWith(x))) out.push(p)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

const files = listFiles(SRC, ['.js', '.vue', '.css', '.mjs'])
if (fs.existsSync(INDEX)) files.push(INDEX)

console.log('扫描 ' + files.length + ' 个文件（web/src + web/index.html）')
console.log('目标：Chrome ' + TARGET + '\n')

const jsHits = new Map() // api → {ver, files:[]}
const cssHits = new Map()

/** 去掉注释，避免注释里提到 API 名字被算成用了 */
function stripComments(src, ext) {
  if (ext === '.css') return src.replace(/\/\*[\s\S]*?\*\//g, '')
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`\\])\/\/[^\n]*/g, '$1')
}

for (const f of files) {
  const ext = path.extname(f).toLowerCase()
  let src = ''
  try {
    src = fs.readFileSync(f, 'utf8')
  } catch (e) {
    continue
  }

  // .vue 拆成 <template> / <script> / <style> 三块分别看，避免 CSS 规则被当 JS
  const blocks = []
  if (ext === '.vue') {
    const tpl = src.match(/<template[\s\S]*?<\/template>/)
    const scr = src.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || []
    const sty = src.match(/<style[^>]*>([\s\S]*?)<\/style>/g) || []
    if (tpl) blocks.push({ kind: 'template', text: tpl[0] })
    for (const s of scr) blocks.push({ kind: 'script', text: s })
    for (const s of sty) blocks.push({ kind: 'style', text: s })
  } else if (ext === '.css') {
    blocks.push({ kind: 'style', text: src })
  } else {
    blocks.push({ kind: 'script', text: src })
  }

  for (const b of blocks) {
    const text = stripComments(b.text, ext)
    const rel = path.relative(APP, f).replace(/\\/g, '/')

    // JS API 只在 script / template 的内联表达式里找
    if (b.kind !== 'style') {
      for (const [needle, ver] of JS_API) {
        if (!text.includes(needle)) continue
        if (!jsHits.has(needle)) jsHits.set(needle, { ver, files: new Set() })
        jsHits.get(needle).files.add(rel)
      }
    }
    // CSS 只在 style / template 里找（template 里有 class + inline style）
    if (b.kind !== 'script') {
      for (const [needle, ver] of CSS_FEATURE) {
        if (!text.includes(needle)) continue
        if (!cssHits.has(needle)) cssHits.set(needle, { ver, files: new Set() })
        cssHits.get(needle).files.add(rel)
      }
    }
  }
}

/* ---------------- 报告 ---------------- */

function report(title, hits, note) {
  console.log('=== ' + title + ' ===')
  const blockers = []
  const safe = []
  for (const [name, { ver, files }] of hits) {
    if (ver > TARGET) blockers.push([name, ver, files])
    else safe.push([name, ver, files])
  }
  blockers.sort((a, b) => a[1] - b[1])

  if (!safe.length) console.log('  （无）')
  for (const [name, ver, files] of safe) {
    console.log('  ok    Chrome ' + String(ver).padStart(3) + '+  ' + name.padEnd(26) + files.size + ' 文件')
  }

  console.log('')
  if (!blockers.length) {
    console.log('  ' + note + '：没有超出 Chrome ' + TARGET + ' 的项目 ✓')
  } else {
    console.log('  ✗ 超出 Chrome ' + TARGET + ' 的项目（' + blockers.length + ' 个）：')
    for (const [name, ver, files] of blockers) {
      console.log('    Chrome ' + String(ver).padStart(3) + '+  ' + name.padEnd(26) + files.size + ' 文件')
      console.log('         ' + [...files].slice(0, 4).join(', ') + (files.size > 4 ? ' …' : ''))
    }
  }
  console.log('')
  return blockers
}

const jsBlockers = report('JS 运行时 API（降级不了，缺了就 TypeError）', jsHits, 'JS API')
const cssBlockers = report('CSS 特性（esbuild 不降级，不支持就整条规则丢掉）', cssHits, 'CSS')

/* ---------------- 结论 ---------------- */
const all = [...jsBlockers.map((x) => ['JS', ...x]), ...cssBlockers.map((x) => ['CSS', ...x])]
console.log('=== 结论 ===')
if (!all.length) {
  console.log('  前端运行时只用到 Chrome ' + TARGET + ' 就有的 API / CSS。')
  console.log('  语法已由 build.target 降级到 chrome78，因此**降到 78 在技术上可行**。')
} else {
  console.log('  有 ' + all.length + ' 项阻塞，Chrome ' + TARGET + ' 上会坏：')
  for (const [kind, name, ver] of all.sort((a, b) => a[2] - b[2])) {
    console.log('    [' + kind + '] ' + name + ' 需要 Chrome ' + ver + '+')
  }
}
process.exit(all.length ? 1 : 0)
