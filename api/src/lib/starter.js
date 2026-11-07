/*
 * lib/starter.js —— 课堂作业的「起手代码」
 *
 * 三层状态（学生的作业就像做题）：
 *   ① 起手代码   data/assignments/<作业id>/code/        题目初始状态，**全班共用一份**
 *   ② 我的提交   data/students/<班级>/<学号>/作业/<作业id>/  点「提交」时冻结的那份
 *   ③ 本地草稿   浏览器 localStorage                      还没提交的改动（前端自己管）
 *
 * 学生打开作业时的工作台内容，按这个顺序取：
 *   有提交 → ②，没有 → ①，都没有 → 空（界面上要说清楚是老师没给起手代码）。
 * 「恢复最初状态」= 强制回到 ①，但**不动已提交的 ②**（否则分数和计分记录会被连带作废）。
 *
 * 为什么全班共用一份：起手代码是「题目」，本来就该一致；
 * 学生的改动落在自己的提交里，动不到它。省掉 117 份一模一样的副本。
 */

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

/** 只有课堂作业（work）有起手代码 */
export function hasStarterKind(kind) {
  return kind === 'work'
}

export function dirOf(assignmentId) {
  return path.join(config.dataDir, 'assignments', String(assignmentId), 'code')
}

/** 起手代码的「对外标识」：工作台拿它当本地草稿的分桶键 */
export function dirToken(assignmentId) {
  return '@a:' + assignmentId
}

const DEFAULT_INDEX = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>我的作业</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 40px; line-height: 1.7; }
    h1 { margin: 0 0 12px; }
    .tip { color: #888; }
  </style>
</head>
<body>
  <h1>从这里开始</h1>
  <p class="tip">这是老师给的初始代码。写完点右上角「提交」，之后再进来会接着改你交的那份。</p>
</body>
</html>
`

/** 读起手代码；没有或读不到返回 null */
export function readStarter(assignmentId) {
  const dir = dirOf(assignmentId)
  const files = []
  const walk = (abs, rel) => {
    let items = []
    try {
      items = fs.readdirSync(abs, { withFileTypes: true })
    } catch (e) {
      return
    }
    for (const it of items) {
      const r = rel ? rel + '/' + it.name : it.name
      const full = path.join(abs, it.name)
      if (it.isDirectory()) walk(full, r)
      else if (it.isFile()) {
        try {
          const st = fs.statSync(full)
          if (st.size > 512 * 1024) continue // 起手代码只放文本，超大文件跳过
          files.push({ path: r, text: fs.readFileSync(full, 'utf8') })
        } catch (e) {
          /* 单个文件读不了就跳过 */
        }
      }
    }
  }
  walk(dir, '')
  if (!files.length) return null
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { dir: dirToken(assignmentId), files }
}

export function hasStarter(assignmentId) {
  return !!readStarter(assignmentId)
}

/**
 * 删作业时把起手代码一起清掉。
 * 不清的话，data/assignments/ 下会攒一堆没人认领的 <作业id>/code/ 目录
 * —— 旧版本留下的 17 个就是这么来的。
 */
export function removeStarter(assignmentId) {
  const root = path.join(config.dataDir, 'assignments', String(assignmentId))
  try {
    fs.rmSync(root, { recursive: true, force: true })
    return true
  } catch (e) {
    return false
  }
}

/** 覆盖写入起手代码（作业库那条路用） */
export function writeStarter(assignmentId, files) {
  const dir = dirOf(assignmentId)
  fs.mkdirSync(dir, { recursive: true })
  const list = Array.isArray(files) ? files.filter((f) => f && f.path) : []
  if (!list.length) return false
  for (const f of list) {
    const rel = String(f.path).replace(/\\/g, '/')
    if (rel.indexOf('..') >= 0 || rel.startsWith('/')) continue // 不许越界
    const abs = path.join(dir, rel)
    if (!abs.startsWith(dir)) continue
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, String(f.text === undefined ? '' : f.text), 'utf8')
  }
  return true
}

/**
 * 保证有起手代码：
 *   · 传入 files（来自作业库设计包）→ 用它覆盖
 *   · 没传且目录里也没有 → 写一个空白 index.html 兜底
 * 返回是否可用。
 */
export function ensureStarter(assignmentId, files) {
  const list = Array.isArray(files) ? files.filter((f) => f && f.path) : []
  if (list.length) return writeStarter(assignmentId, list)
  if (hasStarter(assignmentId)) return true
  try {
    return writeStarter(assignmentId, [{ path: 'index.html', text: DEFAULT_INDEX }])
  } catch (e) {
    // 磁盘不可写：作业照建，学生进来会提示「没有起手代码」，不至于让建作业失败
    return false
  }
}
