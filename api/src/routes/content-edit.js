/*
 * routes/content-edit.js —— 课程内容的在线编辑 + 整目录导入导出
 *
 * 逻辑全部复用旧 lib（纯函数、不碰数据库）：
 *   lib/coursefiles.js  列目录 / 新建 / 写文本 / 读文本 / 上传 / 改名 / 删除
 *   lib/contentio.js    整个目录打 zip 导出 / 预检 / 应用 / 模板
 * 我们这层只负责：取内容根、验身份、把结果包成新 API 的形状。
 */
import path from 'node:path'
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound, forbidden } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import { contentRootOf } from './courses.js'
import { coursefiles, contentio } from '../lib/legacy.js'

/** 课程 + 内容根；学生不许碰讲义 */
function ctxOf(req, needTeacher = true) {
  const course = repo.getCourse(req.params.id)
  if (!course) throw notFound('课程不存在')
  const root = contentRootOf(course)
  return { course, root }
}

function guardLecture(user, rel) {
  if (!user || user.role !== 'student') return
  const first = String(rel || '').replace(/\\/g, '/').split('/')[0]
  if (first === 'lecture') throw forbidden('讲义（老师讲稿）只有老师能看')
}

/** 下载用的响应头 */
function sendZip(reply, filename, buffer) {
  return reply
    .status(200)
    .headers({
      'Content-Type': 'application/zip',
      'Content-Length': buffer.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
    })
    .send(buffer)
}

export default async function contentEditRoutes(app) {
  /* ---------------- 在线编辑 ---------------- */

  /** 列一层目录 */
  app.get('/api/courses/:id/files', { preHandler: requireAuth() }, async (req) => {
    const { root } = ctxOf(req)
    const rel = String(req.query.path || '')
    guardLecture(req.user, rel)
    return coursefiles.list(root, rel)
  })

  /** 读文本 */
  app.get('/api/courses/:id/files/text', { preHandler: requireAuth() }, async (req) => {
    const { root } = ctxOf(req)
    const rel = String(req.query.path || '')
    if (!rel) throw badRequest('缺少 path')
    guardLecture(req.user, rel)
    return coursefiles.readText(root, rel)
  })

  /** 新建文件夹 */
  app.post('/api/courses/:id/files/mkdir', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['path', 'name'],
        properties: { path: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 80 } },
      },
    },
    handler: async (req) => coursefiles.mkdir(ctxOf(req).root, req.body.path, req.body.name),
  })

  /** 写文本（新建或覆盖） */
  app.post('/api/courses/:id/files/save', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string', minLength: 1 }, text: { type: 'string' } },
      },
    },
    handler: async (req) => coursefiles.writeText(ctxOf(req).root, req.body.path, req.body.text || ''),
  })

  /** 改名 / 移动 */
  app.post('/api/courses/:id/files/rename', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['from', 'to'],
        properties: { from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } },
      },
    },
    handler: async (req) => coursefiles.rename(ctxOf(req).root, req.body.from, req.body.to),
  })

  /** 删除（目录非空要 recursive） */
  app.post('/api/courses/:id/files/delete', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string', minLength: 1 }, recursive: { type: 'boolean' } },
      },
    },
    handler: async (req) => coursefiles.remove(ctxOf(req).root, req.body.path, !!req.body.recursive),
  })

  /** 上传单个文件：?path=lecture/ 或 ?path=lecture/名字.md，body 是原始字节 */
  app.post('/api/courses/:id/files/upload', { preHandler: requireAuth('teacher') }, async (req) => {
    const { root } = ctxOf(req)
    const rel = String(req.query.path || '')
    if (!rel) throw badRequest('缺少 path')
    const buf = req.rawBodyBuffer || Buffer.from(JSON.stringify(req.body || {}), 'utf8')
    if (!buf.length) throw badRequest('没有收到文件内容')
    return coursefiles.upload(root, rel, buf)
  })

  /* ---------------- 整目录导入导出 ---------------- */

  /** 导出一个内容目录（lecture / materials / 代码示例 / exams / assets） */
  app.get('/api/courses/:id/content.zip', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const { course } = ctxOf(req)
    const dir = String(req.query.dir || '')
    if (!dir) throw badRequest('缺少 dir')
    const { filename, buffer } = contentio.exportDir(course, dir)
    return sendZip(reply, filename, buffer)
  })

  /** 导入预检（不落盘）：body 是 zip */
  app.post('/api/courses/:id/content/inspect', { preHandler: requireAuth('teacher') }, async (req) => {
    const { course } = ctxOf(req)
    const dir = String(req.query.dir || '')
    if (!dir) throw badRequest('缺少 dir')
    const buf = req.rawBodyBuffer
    if (!buf || !buf.length) throw badRequest('没有收到 zip')
    return contentio.inspectDir(course, dir, buf)
  })

  /** 导入应用：?mode=merge|replace */
  app.post('/api/courses/:id/content/apply', { preHandler: requireAuth('teacher') }, async (req) => {
    const { course } = ctxOf(req)
    const dir = String(req.query.dir || '')
    if (!dir) throw badRequest('缺少 dir')
    const mode = String(req.query.mode || 'merge') === 'replace' ? 'replace' : 'merge'
    const buf = req.rawBodyBuffer
    if (!buf || !buf.length) throw badRequest('没有收到 zip')
    return contentio.applyDir(course, dir, buf, mode)
  })

  /** 空目录模板（老师填好再导回来） */
  app.get('/api/courses/:id/content/template.zip', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const dir = String(req.query.dir || '')
    if (!dir) throw badRequest('缺少 dir')
    const out = contentio.templateZip(dir)
    return sendZip(reply, out.filename || dir + '-模板.zip', out.buffer || out)
  })
}
