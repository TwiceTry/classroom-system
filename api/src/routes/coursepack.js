/*
 * routes/coursepack.js —— 课程包 / 班级包的导入导出
 *
 * 关键点：格式与校验**完全复用旧 lib**（coursepack / coursepack-import / classio），
 * 它们把 db 当参数传进来，所以这里塞一个「指向 SQLite 的适配器」就能原样跑。
 * 好处：导出的包在旧版课堂系统里也能打开，反之亦然 —— 升级不会锁死数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import { dbAdapter } from '../lib/db-adapter.js'
import { coursepack, coursepackImport, classio } from '../lib/legacy.js'

/** 把上传上来的 zip 落到临时文件（旧 lib 的 readPackage 要路径） */
function writeTempZip(buf) {
  const file = path.join(os.tmpdir(), 'ts-pack-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.zip')
  fs.writeFileSync(file, buf)
  return file
}

const sendZip = (reply, filename, buffer) =>
  reply
    .status(200)
    .headers({
      'Content-Type': 'application/zip',
      'Content-Length': buffer.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
    })
    .send(buffer)

export default async function coursepackRoutes(app) {
  /* ---------------- 课程包 ---------------- */

  /** 预检：这个包会带来什么（不落盘） */
  app.post('/api/courses/import/inspect', { preHandler: requireAuth('teacher') }, async (req) => {
    const buf = req.rawBodyBuffer
    if (!buf || !buf.length) throw badRequest('没有收到 zip')
    const tmp = writeTempZip(buf)
    try {
      const pkg = await coursepackImport.readPackage(tmp)
      return await coursepackImport.inspect(dbAdapter, pkg)
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch (e) {
        /* ignore */
      }
    }
  })

  /** 应用：真正导入 */
  app.post('/api/courses/import/apply', { preHandler: requireAuth('teacher') }, async (req) => {
    const buf = req.rawBodyBuffer
    if (!buf || !buf.length) throw badRequest('没有收到 zip')
    const strategy = String(req.query.strategy || 'merge')
    const force = String(req.query.force || '') === '1'
    const tmp = writeTempZip(buf)
    try {
      const pkg = await coursepackImport.readPackage(tmp)
      return await coursepackImport.apply(dbAdapter, pkg, { strategy, force })
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch (e) {
        /* ignore */
      }
    }
  })

  /** 空壳课程包模板 */
  app.get('/api/courses/template.zip', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const out = coursepack.templatePack()
    const buffer = out.buffer || out
    return sendZip(reply, out.filename || '课程包模板.zip', buffer)
  })

  /** 导出一门课（可选只导某几块：scheme,classes,content） */
  app.get('/api/courses/:id/package.zip', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const course = repo.getCourse(req.params.id)
    if (!course) throw notFound('课程不存在')
    const parts = String(req.query.parts || 'scheme,classes,content')
    const out = coursepack.exportCourse(dbAdapter, course.id, { parts })
    const buffer = out.buffer || out
    const filename = out.filename || course.id + '.zip'
    return sendZip(reply, filename, buffer)
  })

  /** 导出前先看清单（多少文件、多大） */
  app.get('/api/courses/:id/package/summary', { preHandler: requireAuth('teacher') }, async (req) => {
    const course = repo.getCourse(req.params.id)
    if (!course) throw notFound('课程不存在')
    return coursepack.summary(dbAdapter, course.id)
  })

  /** 复制一门课（内容 + 方案另存一份） */
  app.post('/api/courses/:id/duplicate', {
    preHandler: requireAuth('teacher'),
    schema: { body: { type: 'object', properties: { name: { type: 'string', maxLength: 60 }, id: { type: 'string' } } } },
    handler: async (req, reply) => {
      const src = repo.getCourse(req.params.id)
      if (!src) throw notFound('课程不存在')
      const newId = String(req.body.id || 'co' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
      if (repo.getCourse(newId)) throw badRequest('课程 ' + newId + ' 已存在')

      const newCourse = repo.upsertCourse(
        Object.assign({}, src, {
          id: newId,
          name: String(req.body.name || src.name + '（副本）').slice(0, 60),
          schemeId: newId,
          contentDir: 'courses/' + newId + '/content',
          createdAt: new Date().toISOString(),
        })
      )

      // 内容目录整体拷一份
      const { contentRootOf } = await import('./courses.js')
      const fromRoot = contentRootOf(src)
      const toRoot = contentRootOf(newCourse)
      fs.mkdirSync(path.dirname(toRoot), { recursive: true })
      if (fs.existsSync(fromRoot)) fs.cpSync(fromRoot, toRoot, { recursive: true })

      // 方案也另存一份（id 跟着新课程，版本从 1 起）
      const { scheme, withCourseScheme } = await import('../lib/scheme.js')
      const raw = scheme.readRawById(src.schemeId || src.id)
      if (raw) {
        const copy = Object.assign({}, raw, { id: newId, name: newCourse.name, version: 1, changes: [] })
        withCourseScheme(src, () => scheme.saveAs(copy, newId, req.user.name || '教师', '从 ' + src.name + ' 复制'))
      }

      reply.status(201)
      return { id: newCourse.id, name: newCourse.name, schemeId: newCourse.schemeId }
    },
  })

  /* ---------------- 班级包 ---------------- */

  /** 导出整门课的班级与名单（zip） */
  app.get('/api/courses/:id/classes.zip', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const course = repo.getCourse(req.params.id)
    if (!course) throw notFound('课程不存在')
    const out = classio.exportClasses(dbAdapter, course)
    return sendZip(reply, out.filename || course.id + '-班级.zip', out.buffer || out)
  })

  /** 班级包空模板 */
  app.get('/api/courses/:id/classes/template.zip', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const out = classio.templateZip()
    return sendZip(reply, out.filename || '班级包模板.zip', out.buffer || out)
  })

  /** 班级包预检 */
  app.post('/api/courses/:id/classes/inspect', { preHandler: requireAuth('teacher') }, async (req) => {
    const course = repo.getCourse(req.params.id)
    if (!course) throw notFound('课程不存在')
    const buf = req.rawBodyBuffer
    if (!buf || !buf.length) throw badRequest('没有收到 zip')
    return classio.plan(dbAdapter, course, buf)
  })

  /** 班级包应用：?mode=merge|replace */
  app.post('/api/courses/:id/classes/apply', { preHandler: requireAuth('teacher') }, async (req) => {
    const course = repo.getCourse(req.params.id)
    if (!course) throw notFound('课程不存在')
    const buf = req.rawBodyBuffer
    if (!buf || !buf.length) throw badRequest('没有收到 zip')
    const mode = String(req.query.mode || 'merge') === 'replace' ? 'replace' : 'merge'
    return classio.apply(dbAdapter, course, buf, mode)
  })
}
