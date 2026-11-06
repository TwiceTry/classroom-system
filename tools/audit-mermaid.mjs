#!/usr/bin/env node
/*
 * audit-mermaid.mjs —— 扫课程材料里的 mermaid 代码块，找出会被渲染成「Syntax error」的写法
 *
 * 为什么需要它：
 *   mermaid 渲染失败时**不会抛错、也不会留空**，而是画一个 svg 把
 *   「Syntax error in text」写进图里。于是页面上就是「图显示不出来、只有一个报错框」，
 *   而接口返回 200、console 也没有 error —— 接口测试完全发现不了。
 *
 *   真实踩到的一例（materials 第09课）：
 *     E[emit] -->|子通知父"发生了事件"| F[父的逻辑响应]
 *   边标签里用了英文双引号，mermaid 10 解析不了。
 *
 * 用法：node tools/audit-mermaid.mjs [目录]
 * 退出码：0 干净 / 1 有可疑写法
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const DEFAULT_DIR = path.join(APP, 'data/courses')

/** 常见会让 mermaid 解析失败的写法 */
const RULES = [
  {
    why: '标签里用了英文双引号（mermaid 会当成语法字符）',
    test: (line) => /^[^%]*["]/.test(line) && !/^\s*%%/.test(line),
    fix: '换成「」或 \'（中文引号最省事）',
  },
  {
    why: '边标签里出现未转义的圆括号',
    test: (line) => /\|.*\(.*\).*\|/.test(line),
    fix: '用 #40; #41; 或者改成全角（）',
  },
]

function scan(dir) {
  const hits = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md')) {
        const s = fs.readFileSync(p, 'utf8')
        const re = /```mermaid([\s\S]*?)```/g
        let m
        let idx = 0
        while ((m = re.exec(s)) !== null) {
          idx++
          const lines = m[1].split('\n')
          lines.forEach((line, i) => {
            for (const r of RULES) {
              if (!r.test(line)) continue
              hits.push({
                file: path.relative(APP, p).replace(/\\/g, '/'),
                block: idx,
                line: i + 1,
                text: line.trim().slice(0, 90),
                why: r.why,
                fix: r.fix,
              })
              break
            }
          })
        }
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return hits
}

const target = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DIR
const hits = scan(target)

console.log('扫描 ' + target.replace(/\\/g, '/').replace(APP.replace(/\\/g, '/'), '.') + ' 下的 mermaid 块')
if (!hits.length) {
  console.log('  没有可疑写法 ✓')
  process.exit(0)
}

console.log('  发现 ' + hits.length + ' 处可能导致「Syntax error in text」：\n')
for (const h of hits) {
  console.log('  ' + h.file + '  （第 ' + h.block + ' 个 mermaid 块，行 ' + h.line + '）')
  console.log('      ' + h.text)
  console.log('      → ' + h.why)
  console.log('      → 改法：' + h.fix + '\n')
}
process.exit(1)
