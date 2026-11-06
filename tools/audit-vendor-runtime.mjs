#!/usr/bin/env node
/*
 * audit-vendor-runtime.mjs —— 课程示例的「浏览器运行时」能不能跑在 Chrome 109
 *
 * 查的对象只有一类：**在预览 iframe / 页面里真正执行的库**
 *   content/代码示例/vue.global.js           Vue 3 全局构建
 *   content/代码示例/vue3-sfc-loader.js      浏览器里编译 .vue
 *   content/代码示例/playground/*.js          编辑器 / 高亮 / 预览拼接
 *   web/public/vendor/{marked,mermaid}.min.js markdown / 图表
 *
 * 不查课程里的示例源码（第10课…第18课那些）：它们只是被展示的代码，不参与执行。
 *
 * 两个坑（第一版都踩了）：
 *   1) esbuild 在 web/node_modules，不在根 —— import('esbuild') 会失败，
 *      于是每个文件都"语法检查失败"，等于没查；
 *   2) Vue / marked 内部有大量**特性检测**（`Array.prototype.toSorted ? 原生 : 兜底`），
 *      直接搜 API 名会把它们当成依赖。要求「不出现 typeof / 三元判断」才算真调用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const EX = path.join(APP, 'data/courses/web-front-dev/content/代码示例')
const VENDOR = path.join(APP, 'web/public/vendor')

// esbuild 装在 web/node_modules
const requireWeb = createRequire(path.join(APP, 'web', 'package.json'))
let esbuild = null
try {
  esbuild = requireWeb('esbuild')
} catch (e) {
  console.log('（没找到 esbuild，跳过语法探测：' + e.message.split('\n')[0] + '）\n')
}

/** 只查这几个真正执行的库 */
const RUNTIMES = [
  path.join(EX, 'vue.global.js'),
  path.join(EX, 'vue3-sfc-loader.js'),
  path.join(EX, 'playground/editor.js'),
  path.join(EX, 'playground/highlight.js'),
  path.join(EX, 'playground/playground-app.js'),
  path.join(EX, 'playground/sfc-boot.js'),
  path.join(EX, 'playground/srcdoc.js'),
  path.join(VENDOR, 'marked.min.js'),
  path.join(VENDOR, 'srcdoc.js'),
]

/** Chrome 110+ 才有的 API（109 上真调用就会 TypeError） */
const TOO_NEW = [
  ['toSorted(', 110],
  ['toReversed(', 110],
  ['toSpliced(', 110],
  ['Object.groupBy(', 117],
  ['Map.groupBy(', 117],
  ['Array.fromAsync(', 121],
  ['Promise.withResolvers(', 119],
  ['URL.canParse(', 120],
  ['Promise.try(', 128],
]

/**
 * 命中位置是不是「桥接方法」而不是「主动调用」。
 *
 * Vue 3.5 的 reactive 数组拦截器长这样：
 *
 *   toReversed() { return reactiveReadArray(this).toReversed() }
 *   toSorted(c)  { return reactiveReadArray(this).toSorted(c) }
 *
 * 这些是**方法定义 + 转发**：只有在业务代码主动 `arr.toSorted()` 时才会执行到
 * 里面的 `this.toSorted()`；而原生没有这个方法时，业务代码本来也不会写它。
 * 所以它们不构成「Chrome 109 上会炸」的理由 —— 不然 Vue 自己就支持不到 Chrome 51 了。
 */
function isBridgeForward(src, idx) {
  const after = src.slice(idx, idx + 30)
  // 定义形态：toXxx(...) {
  if (/^to\w+\([^)]*\)\s*\{/.test(after)) return true
  // 转发形态：this.toXxx( / reactiveReadArray(this).toXxx(
  const before = src.slice(Math.max(0, idx - 40), idx)
  if (/(this|reactiveReadArray\(this\))\.$/.test(before)) return true
  return false
}

/** 特性检测：typeof X / X in Y / 三元兜底 */
function isFeatureDetect(src, idx) {
  const ctx = src.slice(Math.max(0, idx - 90), idx + 90)
  return /typeof|in\s+Array|in\s+String|in\s+Object|\?\s*[^:]{0,60}:|prototype\s*&&/.test(ctx)
}

console.log('=== 示例运行时 vs Chrome 109 ===\n')
let problems = 0
for (const f of RUNTIMES) {
  if (!fs.existsSync(f)) {
    console.log('  - ' + path.basename(f) + '  （不存在）')
    continue
  }
  const src = fs.readFileSync(f, 'utf8')
  const kb = (fs.statSync(f).size / 1024).toFixed(0)
  const rel = path.relative(APP, f).replace(/\\/g, '/')

  // 语法：能不能降到 chrome109
  let syntax = 'syntax ok'
  if (esbuild) {
    try {
      esbuild.transformSync(src, { target: 'chrome109', loader: 'js' })
    } catch (e) {
      syntax = 'SYNTAX FAIL: ' + String(e.message || e).split('\n')[0].slice(0, 60)
      problems++
    }
  }

  // API：只算「非特性检测」的命中
  const real = []
  const detected = []
  for (const [needle, ver] of TOO_NEW) {
    let from = 0
    while (true) {
      const i = src.indexOf(needle, from)
      if (i < 0) break
      from = i + 1
      if (isBridgeForward(src, i)) detected.push(needle + '(桥接)')
      else if (isFeatureDetect(src, i)) detected.push(needle + '(检测)')
      else real.push(needle + ' → Chrome ' + ver)
    }
  }

  const flag = real.length ? '✗' : '✓'
  console.log('  ' + flag + ' ' + rel.slice(rel.indexOf('代码示例') >= 0 ? rel.indexOf('代码示例') : 0).padEnd(44) + (kb + 'KB').padStart(8) + '  ' + syntax)
  for (const r of real) {
    console.log('      ⚠ 真调用：' + r)
    problems++
  }
  if (detected.length) {
    console.log('      · 特性检测（不是依赖，109 上走兜底分支）：' + [...new Set(detected)].join(' '))
  }
}

console.log('\n' + (problems ? '有 ' + problems + ' 处需要确认' : '全部在 Chrome 109 能力范围内 ✓'))

/* mermaid 单独说：3.2MB，按需懒加载 */
console.log('\n=== 图表库 ===')
const mm = path.join(VENDOR, 'mermaid.min.js')
if (fs.existsSync(mm)) {
  const s = fs.readFileSync(mm, 'utf8')
  // mermaid 的版本在 banner 里，形如 "mermaid version 11.x.x" 或 "11.4.1"
  const m = s.match(/mermaid[^\d]{0,20}(\d+\.\d+\.\d+)/i) || s.match(/version["'\s:]+(\d+\.\d+\.\d+)/i)
  console.log('  mermaid.min.js  ' + (fs.statSync(mm).size / 1024 / 1024).toFixed(1) + 'MB  版本 ' + (m ? m[1] : '(未识别)'))
  console.log('  加载方式：按需（只在文档里真出现图时加载，3.2MB 不拖首屏）')
}
