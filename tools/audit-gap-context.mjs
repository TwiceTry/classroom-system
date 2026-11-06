#!/usr/bin/env node
/*
 * audit-gap-context.mjs —— gap 到底是用在 grid 还是 flex？
 *
 * 这条区别很关键：
 *   grid 容器里的 gap  → Chrome 57 就有（老机器完全没问题）
 *   flex 容器里的 gap  → Chrome 84 才有（Chrome 78 上直接失效，子元素会挤在一起）
 *
 * 只看「文件里有 gap:」会得出「33 个文件都有问题」的错误结论 ——
 * 实际上大部分 gap 都写在 grid 里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const SRC = path.join(APP, 'web', 'src')

function listFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p)
      } else if (/\.(vue|css)$/.test(e.name)) out.push(p)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

/** 从 CSS 文本里切出「选择器 { 声明 }」块（够用，不处理 @media 嵌套里的复杂情况） */
function blocks(css) {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css)) !== null) {
    out.push({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] })
  }
  return out
}

const files = listFiles(SRC)
const gridGap = []
const flexGap = []
const unknownGap = []

for (const f of files) {
  const ext = path.extname(f).toLowerCase()
  const src = fs.readFileSync(f, 'utf8')
  const cssChunks = []

  if (ext === '.css') cssChunks.push(src)
  else {
    const styles = src.match(/<style[^>]*>([\s\S]*?)<\/style>/g) || []
    for (const s of styles) cssChunks.push(s.replace(/^<style[^>]*>/, '').replace(/<\/style>$/, ''))
    // template 里的 inline style 也要看（style="display:grid; gap:8px"）
    const inlines = src.match(/style="([^"]*)"/g) || []
    for (const i of inlines) cssChunks.push('inline{' + i.slice(7, -1) + '}')
  }

  for (const css of cssChunks) {
    for (const b of blocks(css)) {
      if (!/(^|[^-\w])gap\s*:/.test(b.body) && !/(^|[^-\w])(row|column)-gap\s*:/.test(b.body)) continue
      const rel = path.relative(APP, f).replace(/\\/g, '/') + '  ' + b.sel.slice(0, 46)
      if (/display\s*:\s*(inline-)?grid/.test(b.body)) gridGap.push(rel)
      else if (/display\s*:\s*(inline-)?flex/.test(b.body)) flexGap.push(rel)
      else unknownGap.push(rel)
    }
  }
}

console.log('=== gap 用在 grid 容器里（Chrome 57，安全）' + gridGap.length + ' 处 ===')
for (const x of gridGap.slice(0, 8)) console.log('  ' + x)
if (gridGap.length > 8) console.log('  …共 ' + gridGap.length + ' 处')

console.log('\n=== gap 用在 flex 容器里（Chrome 84，78 上失效）' + flexGap.length + ' 处 ===')
for (const x of flexGap) console.log('  ✗ ' + x)
if (!flexGap.length) console.log('  （没有）')

console.log('\n=== gap 但同一块里没写 display（要看父级，多数是继承来的 grid/flex）' + unknownGap.length + ' 处 ===')
for (const x of unknownGap.slice(0, 12)) console.log('  ? ' + x)
if (unknownGap.length > 12) console.log('  …共 ' + unknownGap.length + ' 处')
