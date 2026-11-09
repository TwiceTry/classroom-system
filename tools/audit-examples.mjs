/*
 * 检查课程示例的「能不能跑」问题：
 *   用了 Vue API 却没 import（createApp / ref / computed …）
 *   html 里裸写 createApp(...) 又没先从 Vue 解构
 *
 * 用法（在 课堂系统/ 下执行）：
 *   node tools/audit-examples.mjs
 *   node tools/audit-examples.mjs ../../web前端框架开发/代码示例
 *
 * 背景：2026-11 发现 7 个 main.mjs 缺 `import { createApp } from 'vue'`，
 * 代码练习打开直接白屏（控制台只有一行 createApp is not defined）。
 * 这种错误肉眼很难发现——文件看起来"就是典型 Vue 入口的样子"。
 */
import fs from 'node:fs'
import path from 'node:path'

/* 需要 import 的 Vue API（编译器宏不算） */
const APIS = [
  'createApp', 'ref', 'reactive', 'computed', 'watch', 'watchEffect', 'nextTick',
  'provide', 'inject', 'defineComponent', 'h', 'onMounted', 'onUnmounted',
  'onBeforeMount', 'onBeforeUnmount', 'onUpdated', 'onActivated', 'onDeactivated',
  'toRefs', 'toRef', 'readonly', 'shallowRef', 'shallowReactive', 'markRaw',
  'defineAsyncComponent', 'useSlots', 'useAttrs', 'toValue', 'effectScope',
  'onErrorCaptured', 'resolveComponent', 'isRef', 'unref', 'cloneVNode',
]
/* 编译器宏，不需要 import */
const MACROS = new Set([
  'defineProps', 'defineEmits', 'defineExpose', 'defineOptions', 'defineModel', 'withDefaults',
])

const problems = []

function usedApis(code) {
  const clean = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  const found = []
  for (const api of APIS) {
    const re = new RegExp('(?<![.\\w$])' + api + '\\s*[({<]')
    if (re.test(clean)) found.push(api)
  }
  return found
}

function importedApis(code) {
  const out = new Set()
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]vue['"]/g)) {
    m[1].split(',').forEach((s) => {
      const name = s.trim().split(/\s+as\s+/)[0].trim()
      if (name) out.add(name)
    })
  }
  return out
}

function checkMjs(file, rel) {
  const t = fs.readFileSync(file, 'utf8')
  const missing = usedApis(t).filter((a) => !MACROS.has(a) && !importedApis(t).has(a))
  if (missing.length) problems.push([rel, '缺 import: ' + missing.join(', ')])
}

function checkVue(file, rel) {
  const t = fs.readFileSync(file, 'utf8')
  const m = t.match(/<script[^>]*setup[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return
  const missing = usedApis(m[1]).filter((a) => !MACROS.has(a) && !importedApis(m[1]).has(a))
  if (missing.length) problems.push([rel, '缺 import: ' + missing.join(', ')])
}

function checkHtml(file, rel) {
  const t = fs.readFileSync(file, 'utf8')
  const clean = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
  /* `const { createApp, ref } = Vue` 之后再裸写是**正确**的，要先认出来 */
  const destructured = new Set()
  for (const m of clean.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*Vue\b/g)) {
    m[1].split(',').forEach((s) => {
      const name = s.trim().split(/\s*:\s*/)[0].trim()
      if (name) destructured.add(name)
    })
  }
  if (/(?<![.\w$])createApp\s*\(/.test(clean) && !destructured.has('createApp')) {
    problems.push([rel, 'html 裸写 createApp(...)，应 Vue.createApp(...) 或先解构'])
  }
  if (/(?<![.\w$])ref\s*\(/.test(clean) && !destructured.has('ref')) {
    problems.push([rel, 'html 裸写 ref(...)，应 Vue.ref(...) 或先解构'])
  }
}

function walk(dir, relBase) {
  for (const x of fs.readdirSync(dir)) {
    const p = path.join(dir, x)
    if (fs.statSync(p).isDirectory()) {
      walk(p, relBase + x + '/')
      continue
    }
    const rel = relBase + x
    if (/\.mjs$/.test(x)) checkMjs(p, rel)
    else if (/\.vue$/.test(x)) checkVue(p, rel)
    else if (/\.html?$/.test(x)) checkHtml(p, rel)
  }
}

/*
 * 默认查两个地方（都相对 课堂系统/ 这个 cwd）：
 *   ../web前端框架开发/代码示例              课程源（真源，在父仓库里）
 *   data/courses/<课>/content/代码示例        导入后的副本
 */
const DEFAULT_ROOTS = [
  '../web前端框架开发/代码示例',
  'data/courses/web-front-dev/content/代码示例',
]
const roots = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROOTS

let scanned = 0
for (const r of roots) {
  if (!fs.existsSync(r)) continue
  scanned++
  walk(r, path.basename(r) + '/')
}

console.log('  扫描 ' + scanned + ' 个目录，发现问题 ' + problems.length + ' 处')
problems.forEach(([f, why]) => console.log('    ' + f + '   <<  ' + why))
if (problems.length) process.exitCode = 1
