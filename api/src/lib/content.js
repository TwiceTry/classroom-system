/*
 * content.js —— 课程内容索引（只读磁盘，不复制、不搬家）
 *
 * 为什么不去建数据库：materials / lecture / 代码示例 是老师日常直接编辑的
 * 真源，一旦导入库里就会「两份内容、互相不同步」。所以这里只做索引和读取，
 * 文件改完刷新页面就生效。
 *
 * 编号统一用「第 NN 课」，不用「章」；补充资料按 `补充-xxx.md` 识别。
 */

/**
 * 三门内容目录。root 必须给 —— 每门课都有自己的 content 目录。
 *
 * 旧实现允许不传 root 就退回「全局配置里的单课程目录」，那是单课程老布局的兜底；
 * 多课程之后这个兜底只会指向一个不存在的目录，把「忘了传参数」变成「静默读到空内容」。
 */

import fs from 'node:fs'
import path from 'node:path'

function dirsOf(root) {
  if (!root) throw new Error('dirsOf(root)：必须传课程的内容根目录')
  return {
    lecture: path.join(root, 'lecture'),
    materials: path.join(root, 'materials'),
    examples: path.join(root, '代码示例'),
  }
}

const MAX_TEXT = 512 * 1024 // 单个文件读取上限（示例代码里没有这么大的文本）

const RE_LESSON = /^第(\d+)课[-－\s]*(.+)\.md$/i
const RE_SUPP = /^补充[-－\s]*(.+)\.md$/i

function listFiles(dir, ext) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(ext))
      .sort((a, b) => a.localeCompare(b, 'zh'))
  } catch (e) {
    return []
  }
}

function parseName(file) {
  const base = file.replace(/\.md$/i, '')
  let m = RE_LESSON.exec(file)
  if (m) {
    const no = parseInt(m[1], 10)
    return { id: String(no), no, title: m[2].trim(), kind: 'lesson' }
  }
  m = RE_SUPP.exec(file)
  if (m) return { id: 'extra-' + base.replace(/^补充[-－\s]*/i, ''), no: 0, title: '补充：' + m[1].trim(), kind: 'extra' }
  return { id: base, no: 0, title: base, kind: 'other' }
}

/** 课程清单：以 materials 为准，标注讲义是否存在 */
function listLessons(root) {
  const d = dirsOf(root)
  const materials = listFiles(d.materials, '.md')
  const lectures = listFiles(d.lecture, '.md')
  const lectureSet = new Set(lectures)

  const byId = new Map()

  for (const f of materials) {
    const meta = parseName(f)
    byId.set(meta.id, Object.assign(meta, { materials: f, lecture: lectureSet.has(f) ? f : null }))
  }
  for (const f of lectures) {
    const meta = parseName(f)
    const hit = byId.get(meta.id)
    if (hit) {
      hit.lecture = f
      if (!hit.materials) hit.title = meta.title
    } else {
      byId.set(meta.id, Object.assign(meta, { materials: null, lecture: f }))
    }
  }

  const list = Array.from(byId.values())
  list.sort((a, b) => {
    if (a.kind === 'lesson' && b.kind === 'lesson') return a.no - b.no
    if (a.kind === 'lesson') return -1
    if (b.kind === 'lesson') return 1
    return String(a.title).localeCompare(String(b.title), 'zh')
  })
  return list
}

/** 按 id 取文档（type: 'materials' | 'lecture'） */
function getDoc(type, id, root) {
  const d = dirsOf(root)
  const dir = type === 'lecture' ? d.lecture : d.materials
  const item = listLessons(root).find((x) => x.id === id)
  if (!item) return null
  const file = type === 'lecture' ? item.lecture : item.materials
  if (!file) return null
  const full = path.join(dir, file)
  if (!fs.existsSync(full)) return null
  const stat = fs.statSync(full)
  if (stat.size > MAX_TEXT) return { id, title: item.title, markdown: '', tooLarge: true }
  return {
    id,
    no: item.no,
    kind: item.kind,
    title: item.title,
    file,
    mtime: stat.mtime.toISOString(),
    markdown: fs.readFileSync(full, 'utf8'),
  }
}

/* ---------------- 代码示例 ---------------- */

const TEXT_EXT = new Set(['.html', '.htm', '.vue', '.js', '.mjs', '.cjs', '.css', '.json', '.md', '.txt', '.svg'])

/** 代码示例下的课程目录清单（含页面清单） */
function listExamples(root) {
  const ex = dirsOf(root).examples
  let dirs = []
  try {
    dirs = fs.readdirSync(ex).filter((d) => {
      try {
        return fs.statSync(path.join(ex, d)).isDirectory()
      } catch (e) {
        return false
      }
    })
  } catch (e) {
    return []
  }

  const out = []
  for (const d of dirs) {
    if (d === 'playground') continue // 工具目录，不是课程示例
    const files = walk(path.join(ex, d)).filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()))
    const pages = files.filter((f) => /\.html?$/i.test(f))
    if (!files.length) continue
    const m = RE_LESSON.exec(d + '.md')
    out.push({
      dir: d,
      title: m ? '第 ' + parseInt(m[1], 10) + ' 课 · ' + m[2] : d,
      no: m ? parseInt(m[1], 10) : 999,
      pages,
      fileCount: files.length,
    })
  }
  out.sort((a, b) => a.no - b.no || a.dir.localeCompare(b.dir, 'zh'))
  return out
}

function walk(root, prefix) {
  const rel = prefix || ''
  const out = []
  let items = []
  try {
    items = fs.readdirSync(path.join(root, rel))
  } catch (e) {
    return out
  }
  for (const name of items) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const relPath = rel ? rel + '/' + name : name
    let st
    try {
      st = fs.statSync(path.join(root, relPath))
    } catch (e) {
      continue
    }
    if (st.isDirectory()) out.push.apply(out, walk(root, relPath))
    else out.push(relPath)
  }
  return out
}

/** 取一个示例目录下的全部文本文件（供 Playground 在内存里编辑） */
function getExampleBundle(dir, root) {
  const base = path.join(dirsOf(root).examples, dir)
  if (!fs.existsSync(base)) return null
  const files = walk(base).filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()))
  const list = []
  for (const f of files) {
    const full = path.join(base, f)
    let st
    try {
      st = fs.statSync(full)
    } catch (e) {
      continue
    }
    if (st.size > MAX_TEXT) continue
    list.push({ path: f.split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8'), size: st.size })
  }
  return { dir, files: list }
}

/* ---------------- 图片地址改写 ----------------
 * 讲义 / 材料 / 示例里写的是相对路径（../assets/brands/vue.svg），
 * 但浏览器把 <img> 当普通请求：既不带 Authorization，路径也按页面地址算，
 * 于是图片打不开。改成带课程 id 的接口地址，多门课也不会串。
 */
function assetUrl(courseId, rel) {
  return '/api/content/asset?course=' + encodeURIComponent(courseId) + '&path=' + encodeURIComponent(rel)
}

function rewriteAssets(text, courseId) {
  if (!text || !courseId) return text
  // 注意捕获组：文件名必须自己括起来，否则第二个参数是「匹配位置」而不是文件名
  return String(text).replace(/(\.\.\/)+assets\/([A-Za-z0-9_\-.\/]+)/g, (m, up, rel) => assetUrl(courseId, 'assets/' + rel))
}

export { dirsOf, listLessons, getDoc, listExamples, getExampleBundle, rewriteAssets, TEXT_EXT }