/*
 * contentio.js —— 单个内容目录的导入 / 导出（讲义 / 课程材料 / 代码示例 / 试卷）
 *
 * 为什么要单独一套：课程包是整个课程级别的搬运（配置 + 全部内容），适合「换机器 / 交给同事」；
 * 但老师日常更多是「这一批讲义更新一下」「这几个示例换掉」——那就不该打整包。
 * 所以每个内容 tab 自己带一对「导出本页 / 导入本页」，zip 里就是该目录的内容，根目录对根目录。
 *
 * 安全边界与 coursefiles 一致：只能碰 CONTENT_ROOTS 里的四个目录，路径不许越界。
 * replace 模式下本地多出来的文件同样进 data/.trash/（不真删）。
 */

import fs from 'fs'
import path from 'path'
import { config } from '../config.js'
import { HttpError } from './legacy-http.js'
import { makeZip, readZip } from './zip.js'
import * as coursepack from './coursepack.js'

const DIRS = coursepack.CONTENT_ROOTS
const MAX_BYTES = 100 * 1024 * 1024 // 单个目录的包上限（够放几百讲讲义与示例）

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

function dirOf(course, dir) {
  const d = String(dir || '').trim()
  if (DIRS.indexOf(d) < 0) {
    throw new HttpError(400, '只能对这四个目录导入导出：' + DIRS.join(' / '))
  }
  return { dir: d, root: path.join(coursepack.contentRootOf(course), d) }
}

/** 目录里所有文件的相对路径（/ 分隔），跳过系统垃圾文件 */
const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
function walkRelative(root) {
  const out = []
  const walk = (abs, rel) => {
    let items = []
    try {
      items = fs.readdirSync(abs, { withFileTypes: true })
    } catch (e) {
      return
    }
    for (const it of items) {
      if (SKIP.has(it.name)) continue
      const r = rel ? rel + '/' + it.name : it.name
      if (it.isDirectory()) walk(path.join(abs, it.name), r)
      else if (it.isFile()) out.push(r)
    }
  }
  walk(root, '')
  return out.sort()
}

/** zip 里的条目名 → 安全的相对路径（不许 .. / 绝对路径 / 反斜杠） */
function safeRel(name) {
  const rel = String(name || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!rel || rel.indexOf('\u0000') >= 0) return ''
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return ''
  return parts.join('/')
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/* ---------------- 导出 ---------------- */

function exportDir(course, dir) {
  const { dir: d, root } = dirOf(course, dir)
  const entries = []
  let bytes = 0
  for (const rel of walkRelative(root)) {
    let buf
    try {
      buf = fs.readFileSync(path.join(root, rel))
    } catch (e) {
      continue
    }
    bytes += buf.length
    if (bytes > MAX_BYTES) {
      throw new HttpError(413, '「' + d + '」目录超过 ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB，请拆开导出')
    }
    entries.push({ path: rel, data: buf })
  }
  if (!entries.length) throw new HttpError(400, '「' + d + '」目录里还没有文件，没什么可导出的')
  const buffer = makeZip(entries)
  return {
    filename: course.id + '_' + d + '_' + stamp() + '.zip',
    buffer,
    dir: d,
    files: entries.length,
    bytes,
  }
}

/* ---------------- 导入 ---------------- */

/** 干跑：包里每个文件与本地比一比，不落盘 */
function inspectDir(course, dir, buf) {
  const { dir: d, root } = dirOf(course, dir)
  if (buf.length > MAX_BYTES) throw new HttpError(413, '包太大（上限 ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB）')

  let zipped = []
  try {
    zipped = readZip(buf)
  } catch (e) {
    throw new HttpError(400, '这不是一个可用的 zip：' + e.message)
  }
  if (!zipped.length) throw new HttpError(400, '包里没有文件')

  const added = []
  const changed = []
  const unchanged = []
  const names = new Set()
  for (const f of zipped) {
    const rel = safeRel(f.name)
    if (!rel) throw new HttpError(400, '包里有一个不合法的路径：' + f.name)
    if (names.has(rel)) throw new HttpError(400, '包里有两个同名文件：' + rel)
    names.add(rel)
    const abs = path.join(root, rel)
    let old = null
    try {
      old = fs.readFileSync(abs)
    } catch (e) {
      old = null
    }
    if (!old) added.push(rel)
    else if (sha256(old) === sha256(f.data)) unchanged.push(rel)
    else changed.push(rel)
  }

  const extra = walkRelative(root).filter((rel) => !names.has(rel))

  return {
    dir: d,
    total: zipped.length,
    added,
    changed,
    unchanged,
    extra,
    samples: added.concat(changed).slice(0, 8),
  }
}

/** 真写：把包里文件铺到该目录；replace 时本地多出的进回收站 */
function applyDir(course, dir, buf, mode) {
  const plan = inspectDir(course, dir, buf)
  const { dir: d, root } = dirOf(course, dir)
  const zipped = readZip(buf)

  let written = 0
  let skipped = 0
  for (const f of zipped) {
    const rel = safeRel(f.name)
    if (!rel) continue
    const abs = path.join(root, rel)
    if (!abs.startsWith(root + path.sep)) continue
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, f.data)
    written++
  }
  skipped = plan.unchanged.length

  let trash = null
  if (mode === 'replace' && plan.extra.length) {
    const ts = stamp()
    const trashRoot = path.join(config.dataDir, '.trash', ts, course.id, 'content', d)
    let moved = 0
    for (const rel of plan.extra) {
      const abs = path.join(root, rel)
      const dest = path.join(trashRoot, rel)
      if (!abs.startsWith(root + path.sep) || !dest.startsWith(trashRoot + path.sep)) continue
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.renameSync(abs, dest)
        moved++
      } catch (e) {
        /* 挪不动就留着，别删 */
      }
    }
    trash = { count: moved, dir: ['.trash', ts, course.id, 'content', d].join('/') }
  }

  return {
    dir: d,
    mode,
    written,
    unchanged: skipped,
    added: plan.added.length,
    changed: plan.changed.length,
    removed: trash ? trash.count : 0,
    trash,
  }
}

/* ---------------- 模板：新部署时「该放什么、叫什么名字」 ----------------
 * 模板正文放在 server/templates/<目录>/ 里，是**真文件** —— 改模板就是改那些文件，
 * 不用在 JS 里拼 Markdown 字符串（也不怕正文里的反引号）。
 */
const TPL_ROOT = path.join(import.meta.dirname, '..', 'templates')

function walkTemplate(abs, rel, out) {
  for (const it of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? rel + '/' + it.name : it.name
    if (it.isDirectory()) walkTemplate(path.join(abs, it.name), r, out)
    else if (it.isFile()) out.push({ path: r, data: fs.readFileSync(path.join(abs, it.name)) })
  }
}

/** 按目录给一份模板 zip：新部署时老师照着改就行 */
function templateZip(dir) {
  const d = String(dir || '').trim()
  if (DIRS.indexOf(d) < 0) throw new HttpError(400, '只能对这四个目录取模板：' + DIRS.join(' / '))
  const entries = []
  try {
    walkTemplate(path.join(TPL_ROOT, d), '', entries)
  } catch (e) {
    entries.length = 0
  }
  if (d === 'exams') {
    // 试卷 json 直接用维护中的那份真模板，避免两处各写一份
    try {
      entries.push({
        path: '试卷模板.json',
        data: fs.readFileSync(path.join(config.appDir, 'data', 'exams', '_template.json')),
      })
    } catch (e) {
      /* 没有就只给 README */
    }
  }
  if (!entries.length) throw new HttpError(500, '模板文件缺失：server/templates/' + d + '/')
  return { filename: 'template-' + d + '.zip', buffer: makeZip(entries), dir: d, files: entries.length }
}

export { DIRS, exportDir, inspectDir, applyDir, templateZip }
