/*
 * routes/library.js —— 作业/大作业的「设计稿库」
 *
 * 老师的做法：先在库里放几套作业设计（含起始代码、README、目录骨架），
 * 开课时从库里挑一套，直接生成一次作业。库是**课程级**的（同一门课的班共用）。
 * 逻辑全在 lib/assignlib.js（纯文件操作），这层只管取参数和验身份。
 */
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import { assignlib } from '../lib/legacy.js'

/** homework（代码工作台）或 project（材料表单） */
function kindOf(req) {
  const k = String(req.query.kind || req.bodyKind || 'homework')
  return k === 'project' ? 'project' : 'homework'
}

function courseIdOf(req) {
  const id = String(req.query.courseId || '')
  if (id) {
    if (!repo.getCourse(id)) throw notFound('课程不存在：' + id)
    return id
  }
  const c = repo.listCourses().find((x) => !x.archived)
  if (!c) throw notFound('还没有课程')
  return c.id
}

export default async function libraryRoutes(app) {
  /** 库里的设计稿列表 */
  app.get('/api/library/designs', { preHandler: requireAuth('teacher') }, async (req) => {
    const courseId = courseIdOf(req)
    const kind = kindOf(req)
    return { courseId, kind, items: assignlib.listDesigns(courseId, kind) }
  })

  /** 导入一份设计稿（zip） */
  app.post('/api/library/designs/import', { preHandler: requireAuth('teacher') }, async (req) => {
    const courseId = courseIdOf(req)
    const kind = kindOf(req)
    const buf = req.rawBodyBuffer
    if (!buf || !buf.length) throw badRequest('没有收到 zip')
    const out = assignlib.importDesign(courseId, kind, buf)
    return { ok: true, design: out }
  })

  /** 导出某份设计稿 */
  app.get('/api/library/designs/:id.zip', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const courseId = courseIdOf(req)
    const kind = kindOf(req)
    const out = assignlib.exportDesign(courseId, kind, req.params.id)
    if (!out) throw notFound('设计稿不存在')
    return reply
      .status(200)
      .headers({
        'Content-Type': 'application/zip',
        'Content-Length': out.buffer.length,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(out.filename),
      })
      .send(out.buffer)
  })

  /** 删一份设计稿 */
  app.delete('/api/library/designs/:id', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const courseId = courseIdOf(req)
    const kind = kindOf(req)
    const ok = assignlib.removeDesign(courseId, kind, req.params.id)
    if (!ok) throw notFound('设计稿不存在')
    reply.status(204).send()
  })

  /** 空模板（含 README 与目录骨架） */
  app.get('/api/library/template.zip', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const kind = kindOf(req)
    const out = assignlib.templateZip(kind)
    const buffer = out.buffer || out
    const filename = out.filename || kind + '-模板.zip'
    return reply
      .status(200)
      .headers({
        'Content-Type': 'application/zip',
        'Content-Length': buffer.length,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
      })
      .send(buffer)
  })

  /** 设计稿里的起始代码（新建作业时预览用） */
  app.get('/api/library/designs/:id/code', { preHandler: requireAuth('teacher') }, async (req) => {
    const courseId = courseIdOf(req)
    const out = assignlib.designCode(courseId, req.params.id)
    if (!out) throw notFound('设计稿不存在')
    return out
  })
}
