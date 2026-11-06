/*
 * coursefiles.js —— 课程内容的在线管理（列目录 / 新建 / 上传 / 改名 / 删除 / 读写文本）
 *
 * 边界（重要）：
 *   · 只能碰 <contentRoot> 里面，且第一层必须是 CONTENT_ROOTS 之一（lecture / materials / 代码示例 / exams）
 *   · 任何 `..`、绝对路径、盘符一律拒绝（realpath 校验，防符号链接逃逸）
 *   · 删目录时默认只允许空目录；要连根删得显式 recursive
 *   · 单文件读文本上限 512KB（再大就不适合在浏览器里改，请下载下来用编辑器）
 *
 * 为什么不做数据库索引：这些目录就是老师日常直接编辑的真源（见 content.js 的说明），
 * 在线管理只是给「加一份讲义 / 传一批示例 / 改个文件名」提供便利，磁盘始终是唯一真相。
 */

import fs from 'fs'
import path from 'path'
import { HttpError } from './legacy-http.js'
import { CONTENT_ROOTS, safeRelPath } from './coursepack.js'

const TEXT_MAX = 512 * 1024
const UPLOAD_MAX = 100 * 1024 * 1024

/** 把相对路径解析成绝对路径，并确认它确实落在 root 内 */
function resolveInside(root, rel) {
  const raw = String(rel == null ? '' : rel).replace(/\\/g, '/').trim()
  const clean = raw.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!clean) return { full: path.resolve(root), rel: '' }
  // 第一层必须是四类内容目录之一
  const first = clean.split('/')[0]
  if (CONTENT_ROOTS.indexOf(first) < 0) {
    throw new HttpError(400, '只能在 ' + CONTENT_ROOTS.join(' / ') + ' 下面操作（收到：' + first + '）')
  }
  const full = path.resolve(root, clean)
  const base = path.resolve(root)
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new HttpError(400, '路径越界：' + rel)
  }
  // 再按真实路径确认一次（防符号链接指到外面）
  try {
    const realBase = fs.realpathSync(base)
    const realFull = fs.existsSync(full) ? fs.realpathSync(full) : path.join(realBase, path.relative(base, full))
    if (realFull !== realBase && !realFull.startsWith(realBase + path.sep)) {
      throw new HttpError(400, '路径越界：' + rel)
    }
  } catch (e) {
    if (e instanceof HttpError) throw e
    /* 文件不存在时 realpath 会抛，忽略 */
  }
  return { full, rel: clean }
}

/** 文件名合法性：不许空、不许路径分隔符、不许 .. */
function checkName(name) {
  const s = String(name == null ? '' : name).trim()
  if (!s) throw new HttpError(400, '名字不能为空')
  if (s === '.' || s === '..' || /[\\/:*?"<>|]/.test(s)) {
    throw new HttpError(400, '名字里不能有 \\ / : * ? " < > | 这些字符：' + s)
  }
  if (s.length > 120) throw new HttpError(400, '名字太长（上限 120 字）：' + s)
  return s
}

function statOf(full, base) {
  const st = fs.statSync(full)
  return {
    name: path.basename(full),
    dir: st.isDirectory(),
    size: st.isDirectory() ? 0 : st.size,
    mtime: st.mtime.toISOString(),
    path: path.relative(base, full).replace(/\\/g, '/'),
  }
}

/** 列一个目录（rel 为空 = 列出四个内容目录本身） */
function list(root, rel) {
  const { full, rel: clean } = resolveInside(root, rel)
  if (clean && !fs.existsSync(full)) throw new HttpError(404, '目录不存在：' + clean)
  if (!fs.existsSync(full)) {
    // 内容根还没建：把四类目录建出来再列
    for (const d of CONTENT_ROOTS) fs.mkdirSync(path.join(root, d), { recursive: true })
  }
  const base = path.resolve(root)
  const entries = fs
    .readdirSync(full, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const s = statOf(path.join(full, e.name), base)
      return s
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1))

  return {
    path: clean,
    roots: CONTENT_ROOTS,
    entries,
    parent: clean ? clean.split('/').slice(0, -1).join('/') : '',
  }
}

function mkdir(root, rel, name) {
  const { full, rel: clean } = resolveInside(root, rel)
  const dir = path.join(full, checkName(name))
  if (fs.existsSync(dir)) throw new HttpError(409, '已有同名目录或文件：' + path.relative(root, dir))
  fs.mkdirSync(dir, { recursive: true })
  return { ok: true, path: path.relative(root, dir).replace(/\\/g, '/') }
}

function writeText(root, rel, text) {
  const { full, rel: clean } = resolveInside(root, rel)
  if (!clean || clean.split('/').length < 2) throw new HttpError(400, '要给出完整文件路径（含所在目录）')
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) throw new HttpError(409, '这是个目录：' + clean)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, String(text == null ? '' : text), 'utf8')
  return { ok: true, path: clean, size: Buffer.byteLength(String(text || ''), 'utf8') }
}

function readText(root, rel) {
  const { full, rel: clean } = resolveInside(root, rel)
  if (!fs.existsSync(full)) throw new HttpError(404, '文件不存在：' + clean)
  const st = fs.statSync(full)
  if (st.isDirectory()) throw new HttpError(400, '这是个目录：' + clean)
  if (st.size > TEXT_MAX) throw new HttpError(413, '文件太大（' + Math.round(st.size / 1024) + 'KB），超过 512KB 请下载到本机改')
  return { ok: true, path: clean, size: st.size, text: fs.readFileSync(full, 'utf8') }
}

function upload(root, rel, buf) {
  const { full, rel: clean } = resolveInside(root, rel)
  if (!clean || clean.split('/').length < 2) throw new HttpError(400, '要给出完整文件路径（含所在目录）')
  if (!buf || !buf.length) throw new HttpError(400, '上传内容为空')
  if (buf.length > UPLOAD_MAX) throw new HttpError(413, '文件太大（上限 100MB）')
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) throw new HttpError(409, '这是个目录：' + clean)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, buf)
  return { ok: true, path: clean, size: buf.length }
}

/** 把外部已经写好的文件搬到内容目录里（上传走流式，不在内存里拼 buffer） */
function moveIn(root, rel, tmpFile) {
  const { full, rel: clean } = resolveInside(root, rel)
  if (!clean || clean.split('/').length < 2) throw new HttpError(400, '要给出完整文件路径（含所在目录）')
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) throw new HttpError(409, '这是个目录：' + clean)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.renameSync(tmpFile, full)
  return { ok: true, path: clean, size: fs.statSync(full).size }
}

function rename(root, from, to) {
  const a = resolveInside(root, from)
  const name = checkName(to)
  const dest = path.join(path.dirname(a.full), name)
  if (!fs.existsSync(a.full)) throw new HttpError(404, '不存在：' + a.rel)
  if (fs.existsSync(dest)) throw new HttpError(409, '已有同名文件或目录：' + name)
  fs.renameSync(a.full, dest)
  return { ok: true, path: path.relative(path.resolve(root), dest).replace(/\\/g, '/') }
}

function remove(root, rel, recursive) {
  const { full, rel: clean } = resolveInside(root, rel)
  if (!clean) throw new HttpError(400, '不能删内容根目录')
  if (!fs.existsSync(full)) throw new HttpError(404, '不存在：' + clean)
  const st = fs.statSync(full)
  if (st.isDirectory()) {
    const kids = fs.readdirSync(full)
    if (kids.length && !recursive) throw new HttpError(409, '目录里还有 ' + kids.length + ' 个文件，确认要连目录一起删吗？')
    fs.rmSync(full, { recursive: true, force: true })
  } else {
    fs.unlinkSync(full)
  }
  return { ok: true, path: clean }
}

export { list, mkdir, writeText, readText, upload, moveIn, rename, remove, TEXT_MAX, UPLOAD_MAX, resolveInside }
