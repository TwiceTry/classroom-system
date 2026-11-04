#!/usr/bin/env node
/*
 * check-bat.mjs —— 批处理（.bat）体检，专治「在 Win7 上才炸」的三类毛病。
 *
 *   1) 行尾必须是 CRLF
 *      cmd.exe 是逐字节按 CRLF 解析 .bat 的；纯 LF 的文件它会当成一行，
 *      于是 if/括号全乱，报「xxx was unexpected at this time.」（真实踩过）
 *
 *   2) if / for 块里的 echo 不能带裸括号
 *      块里的 `)` 会被 cmd 当成「块结束」，后面的内容就成了语法错，
 *      同样报「was unexpected at this time」。要写括号就用 ^( ^) 转义。
 *
 *   3) 不要 chcp 65001
 *      Win7 的控制台在 65001 代码页下写不出东西，会报
 *      「The system cannot write to the specified device.」
 *      （我们这些 bat 都是 ASCII-only，本来也不需要改代码页）
 *
 * 另外顺带看一眼：文件里有没有非 ASCII 字符（cmd 在某些代码页下会读花）。
 *
 * 用法：node tools/check-bat.mjs            # 查整个仓库
 *      node tools/check-bat.mjs <目录>      # 只查某个目录
 * 退出码：0 全绿 / 1 有问题
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 只查「课堂系统」这个仓库本身（tools/ 的上一级）；课程内容与临时目录不在范围内
const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const SKIP = /[\\/]node_modules[\\/]|[\\/]dist[\\/]|[\\/]runtime[\\/]|[\\/]\.git[\\/]|[\\/]data[\\/]courses[\\/]/

const files = []
const walk = (d) => {
  let entries = []
  try {
    entries = fs.readdirSync(d, { withFileTypes: true })
  } catch (e) {
    return
  }
  for (const e of entries) {
    const f = path.join(d, e.name)
    if (e.isDirectory()) {
      if (!SKIP.test(f)) walk(f)
    } else if (/\.bat$/i.test(e.name)) {
      files.push(f)
    }
  }
}
walk(ROOT)

let problems = 0
const hit = (name, ok, detail) => {
  if (ok) {
    console.log('  PASS  ' + name)
  } else {
    problems++
    console.log('  FAIL  ' + name + (detail ? '  ->  ' + detail : ''))
  }
}

console.log('batch files: ' + files.length)
for (const f of files) {
  const rel = path.relative(ROOT, f)
  const raw = fs.readFileSync(f)
  const text = raw.toString('utf8')
  const lines = text.split(/\r?\n/)

  // 1) 行尾
  const crlf = (text.match(/\r\n/g) || []).length
  const lf = (text.match(/\n/g) || []).length
  hit(rel + ': CRLF line endings', crlf === lf, 'CRLF=' + crlf + ' LF=' + lf)

  // 2) if/for 块里的 echo 裸括号
  const badEcho = []
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (/^(if|for)\b/i.test(t) && /\($/.test(t)) inBlock = true
    if (inBlock && /^echo\b/i.test(t)) {
      const stripped = t.replace(/\^[\(\)]/g, '') // 去掉转义过的括号
      if (/[()]/.test(stripped)) badEcho.push(i + 1)
    }
    if (inBlock && /^\)$/.test(t)) inBlock = false
  }
  hit(rel + ': no bare parentheses inside if/for blocks', badEcho.length === 0, 'lines ' + badEcho.join(','))

  // 3) chcp 65001
  hit(rel + ': no chcp 65001', !/chcp\s+65001/i.test(text))

  // 4) 非 ASCII（提示用，不算失败）
  const nonAscii = lines.filter((l) => /[^\x00-\x7f]/.test(l))
  if (nonAscii.length) {
    console.log('  NOTE  ' + rel + ': ' + nonAscii.length + ' line(s) with non-ASCII text')
  }
}

console.log('')
if (problems) {
  console.log('RESULT: ' + problems + ' problem(s)')
  process.exit(1)
}
console.log('RESULT: all green')
