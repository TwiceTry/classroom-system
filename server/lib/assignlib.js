'use strict'
/*
 * assignlib.js —— 作业设计库（课堂作业 / 大作业分开两套）
 *
 * 为什么要有「库」：作业是有规范的设计（题目 + 起手代码 / 题目 + 附件要求），
 * 老师不该每次新建都从空白开始，也不该把「设计」和「这次收了几个班」混在一起。
 *
 *   data/designs/<课程id>/homework/<设计id>/homework.json + code/**
 *   data/designs/<课程id>/project/<设计id>/project.json
 *
 * 设计包（zip）就是上面那个目录的内容，根目录对根目录：
 *
 *   课堂作业设计包                      大作业设计包
 *   ├─ homework.json                   ├─ project.json
 *   ├─ code/index.html                 └─ README.txt（可选）
 *   ├─ code/main.js
 *   ├─ code/style.css
 *   └─ README.txt（可选）
 *
 * 新建作业 = 从库里挑一个设计（复制起手代码到 data/assignments/<作业id>/code/），
 * 或者直接上传一个设计包（先入库，再建）。
 */
const fs = require('fs')
const path = require('path')
const config = require('../config')
const { HttpError } = require('./http')
const { makeZip, readZip } = require('./zip')

const KINDS = ['homework', 'project']
const FILE_OF = { homework: 'homework.json', project: 'project.json' }
const MAX_BYTES = 50 * 1024 * 1024

function libRoot(courseId, kind) {
  if (KINDS.indexOf(kind) < 0) throw new HttpError(400, '作业分两类：homework（课堂作业）/ project（大作业）')
  return path.join(config.dataDir, 'designs', String(courseId), kind)
}

function designDir(courseId, kind, id) {
  const safe = String(id || '')
    .replace(/\.zip$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
  if (!safe || safe === '.' || safe === '..') throw new HttpError(400, '设计 id 不合法')
  return path.join(libRoot(courseId, kind), safe)
}

function safeRel(name) {
  const rel = String(name || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!rel) return ''
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return ''
  return parts.join('/')
}

/** 标题 → 目录 id（中文保留，只把危险字符换掉） */
function idOf(title, fallback) {
  const base = String(title || '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9_-]+/g, '-') // 只留 中文/字母/数字/-/_
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base || fallback || 'design-' + Date.now().toString(36)
}

function uniqueDir(root, id) {
  let n = 2
  let cur = id
  while (fs.existsSync(path.join(root, cur))) {
    cur = id + '-' + n
    n++
  }
  return cur
}

/* ---------------- 读 ---------------- */

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return null
  }
}

/** 一个设计的摘要（列表用，不带代码内容） */
function summaryOf(courseId, kind, dirName) {
  const dir = path.join(libRoot(courseId, kind), dirName)
  const meta = readJsonFile(path.join(dir, FILE_OF[kind])) || {}
  let fileCount = 0
  let bytes = 0
  const walk = (abs) => {
    let items = []
    try {
      items = fs.readdirSync(abs, { withFileTypes: true })
    } catch (e) {
      return
    }
    for (const it of items) {
      const full = path.join(abs, it.name)
      if (it.isDirectory()) walk(full)
      else if (it.isFile()) {
        fileCount++
        try {
          bytes += fs.statSync(full).size
        } catch (e) {
          /* ignore */
        }
      }
    }
  }
  if (kind === 'homework') walk(path.join(dir, 'code'))
  return {
    id: dirName,
    kind,
    title: String(meta.title || dirName),
    note: String(meta.note || ''),
    weight: meta.weight === undefined ? 1 : Number(meta.weight) || 1,
    dueAt: String(meta.dueAt || ''),
    allowLate: meta.allowLate === undefined ? true : !!meta.allowLate,
    requireFile: meta.requireFile === undefined ? kind === 'project' : !!meta.requireFile,
    requireUrl: !!meta.requireUrl,
    attachments: Array.isArray(meta.attachments) ? meta.attachments : [],
    fileCount,
    bytes,
    meta,
  }
}

function listDesigns(courseId, kind) {
  const root = libRoot(courseId, kind)
  let dirs = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (e) {
    return []
  }
  return dirs.sort().map((d) => summaryOf(courseId, kind, d))
}

/** 设计里带的起手代码（课堂作业才有），形状同工作台 bundle */
function designCode(courseId, id) {
  const dir = path.join(designDir(courseId, 'homework', id), 'code')
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
      else if (it.isFile()) files.push({ path: r, text: fs.readFileSync(full, 'utf8') })
    }
  }
  walk(dir, '')
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/* ---------------- 导入 / 导出 ---------------- */

/** 解一个设计包到库：根目录就是 json + code/；重名自动加 -2 */
function importDesign(courseId, kind, buf) {
  if (buf.length > MAX_BYTES) throw new HttpError(413, '设计包太大（上限 ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB）')
  let zipped = []
  try {
    zipped = readZip(buf)
  } catch (e) {
    throw new HttpError(400, '这不是一个可用的 zip：' + e.message)
  }
  const want = FILE_OF[kind]
  const jsonEntry = zipped.find((f) => safeRel(f.name) === want || safeRel(f.name).endsWith('/' + want))
  if (!jsonEntry) {
    throw new HttpError(400, '设计包里缺少 ' + want + '（根目录下要有这个文件，格式见模板）')
  }
  let meta = null
  try {
    meta = JSON.parse(jsonEntry.data.toString('utf8'))
  } catch (e) {
    throw new HttpError(400, want + ' 不是合法 JSON：' + e.message)
  }
  if (!meta || typeof meta !== 'object') throw new HttpError(400, want + ' 内容必须是一个对象')
  const title = String(meta.title || '').trim()
  if (!title) throw new HttpError(400, want + ' 里必须有 title（作业标题）')

  // 去掉可能的外部包装目录：以 json 所在层为根
  const prefix = safeRel(jsonEntry.name).slice(0, safeRel(jsonEntry.name).length - want.length)
  const pick = []
  for (const f of zipped) {
    const rel = safeRel(f.name)
    if (!rel || rel.endsWith('/')) continue
    if (prefix && rel.indexOf(prefix) !== 0) continue
    const inner = prefix ? rel.slice(prefix.length) : rel
    if (!inner) continue
    pick.push({ path: inner, data: f.data })
  }

  if (kind === 'homework') {
    const hasCode = pick.some((f) => /^code\/.+/.test(f.path))
    if (!hasCode) throw new HttpError(400, '课堂作业设计包里要有 code/ 目录（学生的起手代码）')
  } else if (pick.some((f) => /^code\//.test(f.path))) {
    throw new HttpError(400, '大作业没有代码，设计包里不该有 code/ 目录（只放 project.json）')
  }

  const root = libRoot(courseId, kind)
  fs.mkdirSync(root, { recursive: true })
  const dirName = uniqueDir(root, idOf(meta.id || title))
  const dir = path.join(root, dirName)
  for (const f of pick) {
    const abs = path.join(dir, f.path)
    if (!abs.startsWith(dir + path.sep)) continue
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, f.data)
  }
  return { design: summaryOf(courseId, kind, dirName), files: pick.length }
}

/** 导出一个设计包 */
function exportDesign(courseId, kind, id) {
  const src = designDir(courseId, kind, id)
  if (!fs.existsSync(src)) throw new HttpError(404, '这个设计不在库里')
  const entries = []
  const walk = (abs, rel) => {
    for (const it of fs.readdirSync(abs, { withFileTypes: true })) {
      if (it.name === 'node_modules' || it.name.startsWith('.')) continue
      const r = rel ? rel + '/' + it.name : it.name
      const full = path.join(abs, it.name)
      if (it.isDirectory()) walk(full, r)
      else if (it.isFile()) entries.push({ path: r, data: fs.readFileSync(full) })
    }
  }
  walk(src, '')
  const s = summaryOf(courseId, kind, id)
  return {
    filename: (kind === 'homework' ? 'homework-' : 'project-') + id + '.zip',
    buffer: makeZip(entries),
    title: s.title,
    files: entries.length,
  }
}

function removeDesign(courseId, kind, id) {
  const dir = designDir(courseId, kind, id)
  if (!fs.existsSync(dir)) return false
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}

/* ---------------- 模板 ---------------- */

const HOMEWORK_README = `课堂作业设计包

包里放什么
  homework.json      作业定义（title 必填；其余见下）
  code/              学生的起手代码（至少要有一个文件，通常 index.html + main.js + style.css）
  README.txt         这份说明，可以删

homework.json 支持的字段
  title        作业标题（必填，≤ 60 字）
  note         作业要求（可选，≤ 500 字）
  weight       这次作业占「课堂作业」这一项的比重（默认 1）
  dueAt        截止时间，ISO 字符串，如 "2026-11-09T23:59:00+08:00"；留空 = 不限
  allowLate    过了截止还收不收（默认 true；收了会自动标「迟交」，按方案里的迟交系数打折）
  id           设计 id（留空则按标题生成；只影响库里的目录名）

code/ 里怎么写
  和「代码示例」同一套学生端工作台：双击 index.html 能跑，或在页面里实时预览。
  纯静态 HTML/CSS/JS 即可；要写成 Vue 单文件组件，请按 代码示例/README 里的结构。

导入之后
  它出现在「课堂作业 · 新建 → 从作业目录选」，选中即复制成一次作业（改作业不会影响库里的设计）。
  也可以在「作业目录」里直接导出成 zip 带走、或给同事。
`

const PROJECT_README = `大作业设计包

包里放什么
  project.json       作业定义（title 必填）
  README.txt         这份说明，可以删
（大作业没有代码，学生交的是「说明 + 链接 + 附件」）

project.json 支持的字段
  title        作业标题（必填，≤ 60 字）
  note         作业要求 / 评分说明（可选，≤ 500 字）
  weight       这次作业占「大作业」这一项的比重（默认 1）
  dueAt        截止时间，ISO 字符串；留空 = 不限
  allowLate    过了截止还收不收（默认 true，自动标「迟交」）
  requireFile  必须交附件（默认 true）
  requireUrl   必须填链接（默认 false）
  attachments  允许的附件类型（默认 ["zip","pdf","md","png","mp4","pptx"]）
  id           设计 id（留空则按标题生成）

学生交什么
  附件：代码包 .zip（必须，若要） / 讲解文档 .pdf .md .png .mp4 .pptx
  链接：部署地址或仓库地址（可选）
  → 只保留最新一次提交；老师批阅时下载附件看。
`

function templateZip(kind) {
  if (kind === 'homework') {
    const meta = {
      title: '作业标题（示例）',
      note: '把 code/ 里的页面改成……，完成后提交。',
      weight: 1,
      dueAt: '',
      allowLate: true,
    }
    return {
      filename: 'homework-design-template.zip',
      buffer: makeZip([
        { path: 'homework.json', data: Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8') },
        {
          path: 'code/index.html',
          data: Buffer.from(
            `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>课堂作业</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1>作业标题</h1>
    <p>按题目要求改 main.js。</p>
    <div id="app"></div>
    <script src="main.js"></script>
  </body>
</html>
`,
            'utf8'
          ),
        },
        {
          path: 'code/main.js',
          data: Buffer.from(`// 学生要在这份代码上改
const app = document.getElementById('app')
app.textContent = '还没开始写'
`, 'utf8'),
        },
        {
          path: 'code/style.css',
          data: Buffer.from(`body { font-family: system-ui, 'Microsoft YaHei', sans-serif; margin: 32px; line-height: 1.7; }
`, 'utf8'),
        },
        { path: 'README.txt', data: Buffer.from(HOMEWORK_README, 'utf8') },
      ]),
    }
  }
  const meta = {
    title: '大作业标题（示例）',
    note: '做一个完整的页面/应用，交代码包与讲解文档。',
    weight: 1,
    dueAt: '',
    allowLate: true,
    requireFile: true,
    requireUrl: false,
    attachments: ['zip', 'pdf', 'md', 'png', 'mp4', 'pptx'],
  }
  return {
    filename: 'project-design-template.zip',
    buffer: makeZip([
      { path: 'project.json', data: Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8') },
      { path: 'README.txt', data: Buffer.from(PROJECT_README, 'utf8') },
    ]),
  }
}

module.exports = {
  KINDS,
  FILE_OF,
  libRoot,
  designDir,
  listDesigns,
  designCode,
  importDesign,
  exportDesign,
  removeDesign,
  templateZip,
  summaryOf,
  HOMEWORK_README,
  PROJECT_README,
}
