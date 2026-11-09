/*
 * routes/content.js —— 课程内容（讲义 / 材料 / 代码示例 / 试卷 / 资源）
 *
 * 内容跟着课程走：data/courses/<课程>/content/{lecture,materials,代码示例,exams,assets}
 *
 * 两条硬规矩：
 *   1) **路径必须在内容根之内** —— 每次 resolve 之后都要 startsWith 校验，
 *      否则 `?path=../../data/config.json` 就能把口令读走；
 *   2) 讲义（lecture）是老师讲稿、只给老师看；学生只能读 materials / 代码示例 / assets。
 */
import fs from 'node:fs'
import path from 'node:path'
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound, forbidden } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import { contentRootOf } from './courses.js'

/** 五类内容目录（顺序即前端展示顺序） */
const DIRS = ['lecture', 'materials', '代码示例', 'exams', 'assets']
/** 老师专属（讲稿里有答案） */
const TEACHER_ONLY = new Set(['lecture'])

/** 文本类扩展名（可以直接当文本读） */
const TEXT_EXT = new Set(['.md', '.txt', '.js', '.mjs', '.cjs', '.json', '.css', '.html', '.vue', '.ts', '.jsx', '.tsx', '.sql', '.yml', '.yaml', '.sh', '.bat', '.py', '.java', '.c', '.cpp', '.h', '.xml', '.svg', '.csv'])

/** 把 ?path= 解析成绝对路径，出界就 400 */
function resolveInside(root, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const full = path.resolve(root, clean)
  const base = path.resolve(root)
  if (full !== base && !full.startsWith(base + path.sep)) throw badRequest('路径越界：' + clean)
  return { full, clean }
}

/** 目录树（只列一层，前端点开再请求下一层） */
function listDir(root, rel) {
  const { full, clean } = resolveInside(root, rel)
  if (!fs.existsSync(full)) throw notFound('目录不存在：' + (clean || '/'))
  if (!fs.statSync(full).isDirectory()) throw badRequest('不是目录：' + clean)
  const entries = fs
    .readdirSync(full, { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.'))
    .map((d) => {
      const childRel = (clean ? clean + '/' : '') + d.name
      const childFull = path.join(root, childRel)
      const st = fs.statSync(childFull)
      return {
        name: d.name,
        path: childRel,
        type: d.isDirectory() ? 'dir' : 'file',
        size: d.isDirectory() ? undefined : st.size,
        mtime: st.mtime.toISOString(),
      }
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1))
  return { path: clean, entries }
}

/** 递归整棵树（前端做目录导航时一次拿全；内容目录不大，够用） */
function treeOf(root, rel, depth) {
  const { full, clean } = resolveInside(root, rel)
  if (!fs.existsSync(full)) return null
  const st = fs.statSync(full)
  if (!st.isDirectory()) return { name: path.basename(full), path: clean, type: 'file', size: st.size }
  const node = { name: path.basename(full) || clean, path: clean, type: 'dir', children: [] }
  if (depth <= 0) return node
  for (const d of fs.readdirSync(full, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue
    const childRel = (clean ? clean + '/' : '') + d.name
    if (d.isDirectory()) node.children.push(treeOf(root, childRel, depth - 1))
    else {
      const cf = path.join(root, childRel)
      node.children.push({ name: d.name, path: childRel, type: 'file', size: fs.statSync(cf).size })
    }
  }
  node.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1))
  return node
}

/** 取课程 + 内容根（不存在就 404） */
function context(req) {
  const course = repo.getCourse(req.params.id)
  if (!course) throw notFound('课程不存在')
  const root = contentRootOf(course)
  if (!fs.existsSync(root)) throw notFound('这门课还没有内容目录')
  return { course, root }
}

/** 学生不许看讲义 */
function guardTeacherOnly(user, rel) {
  if (!user || user.role !== 'student') return
  const first = String(rel || '').replace(/\\/g, '/').split('/')[0]
  if (TEACHER_ONLY.has(first)) throw forbidden('讲义（老师讲稿）只有老师能看')
}

export default async function contentRoutes(app) {
  /**
   * 内容概览：五类目录各有多少文件（学生端首页/教师端导航用）
   * 学生看不到 lecture。
   */
  app.get('/api/courses/:id/content', { preHandler: requireAuth() }, async (req) => {
    const { course, root } = context(req)
    const isStudent = req.user.role === 'student'
    const items = []
    for (const dir of DIRS) {
      if (isStudent && TEACHER_ONLY.has(dir)) continue
      const full = path.join(root, dir)
      let files = 0
      let bytes = 0
      if (fs.existsSync(full)) {
        const walk = (p) => {
          for (const d of fs.readdirSync(p, { withFileTypes: true })) {
            if (d.name.startsWith('.')) continue
            const q = path.join(p, d.name)
            if (d.isDirectory()) walk(q)
            else {
              files++
              bytes += fs.statSync(q).size
            }
          }
        }
        walk(full)
      }
      items.push({ dir, files, bytes })
    }
    return { courseId: course.id, courseName: course.name, root: path.relative(repo.dbPath().replace(/teach\.db$/, ''), root), dirs: items }
  })

  /** 列一层目录：?dir=lecture&path=lecture/第01课 */
  app.get('/api/courses/:id/content/list', { preHandler: requireAuth() }, async (req) => {
    const { root } = context(req)
    const rel = String(req.query.path || req.query.dir || '')
    guardTeacherOnly(req.user, rel)
    return listDir(root, rel)
  })

  /** 整棵树（前端目录导航一次拿全）：?dir=lecture&depth=4 */
  app.get('/api/courses/:id/content/tree', { preHandler: requireAuth() }, async (req) => {
    const { root } = context(req)
    const rel = String(req.query.dir || req.query.path || '')
    guardTeacherOnly(req.user, rel)
    const depth = Math.min(Math.max(Number(req.query.depth) || 4, 1), 8)
    const node = treeOf(root, rel, depth)
    if (!node) throw notFound('目录不存在：' + rel)
    return node
  })

  /** 读文本文件：?path=lecture/第01课/a.md */
  app.get('/api/courses/:id/content/file', { preHandler: requireAuth() }, async (req) => {
    const { root } = context(req)
    const rel = String(req.query.path || '')
    if (!rel) throw badRequest('缺少 path')
    guardTeacherOnly(req.user, rel)
    const { full, clean } = resolveInside(root, rel)
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw notFound('文件不存在：' + clean)
    const ext = path.extname(full).toLowerCase()
    if (!TEXT_EXT.has(ext)) throw badRequest('这个文件不是文本（用 /content/asset 下载）：' + ext)
    const st = fs.statSync(full)
    if (st.size > 4 * 1024 * 1024) throw badRequest('文件太大（>4MB），请直接下载')
    return { path: clean, size: st.size, mtime: st.mtime.toISOString(), text: fs.readFileSync(full, 'utf8') }
  })

  /** 下载/预览二进制（图片、pdf、zip…）：?path=assets/a.png */
  app.get('/api/courses/:id/content/asset', { preHandler: requireAuth() }, async (req, reply) => {
    const { root } = context(req)
    const rel = String(req.query.path || '')
    if (!rel) throw badRequest('缺少 path')
    guardTeacherOnly(req.user, rel)
    const { full, clean } = resolveInside(root, rel)
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw notFound('文件不存在：' + clean)
    const st = fs.statSync(full)
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"'
    const inm = String(req.headers['if-none-match'] || '').trim()
    /*
     * 同上（compat.js 那个同名接口）：材料里的资源 public 可缓存，
     * 讲义（lecture/）下的保留 private —— 那些只有教师该看，
     * 标成 public 会被教学机代理缓存、然后发给学生。
     */
    const isLecture = clean.split('/')[0] === 'lecture'
    const headers = {
      'Cache-Control': isLecture ? 'private, max-age=300' : 'public, max-age=86400',
      'Last-Modified': st.mtime.toUTCString(),
      ETag: etag,
    }
    if (inm && inm.split(',').map((x) => x.trim()).indexOf(etag) >= 0) {
      return reply.status(304).headers(headers).send()
    }
    const ext = path.extname(full).toLowerCase()
    const MIME = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.mp4': 'video/mp4',
    }
    return reply
      .status(200)
      .headers(Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size }, headers))
      .send(fs.createReadStream(full))
  })
}
