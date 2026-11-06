/*
 * routes/library.js —— 作业/大作业的「设计稿库」
 *
 * 老师的做法：先在库里放几套作业设计（含起始代码、README、目录骨架），
 * 开课时从库里挑一套，直接生成一次作业。库是**课程级**的（同一门课的班共用）。
 *
 * 路径挂在课程下（`/api/courses/:id/designs`）而不是单独一个 /api/library：
 * 设计稿离开课程没有意义，资源层级上它就是课程的一部分。
 * 逻辑全在 lib/assignlib.js（纯文件操作），这层只管取参数和验身份。
 */
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import * as assignlib from '../lib/assignlib.js'

/** homework（代码工作台）或 project（材料表单） */
function kindOf(req) {
  const k = String(req.query.kind || 'homework')
  return k === 'project' ? 'project' : 'homework'
}

function courseOf(req) {
  const c = repo.getCourse(req.params.id)
  if (!c) throw notFound('课程不存在：' + req.params.id)
  return c
}

export default async function libraryRoutes(app) {
  /** 库里的设计稿列表 */
  app.get('/api/courses/:id/designs', { preHandler: requireAuth('teacher') }, async (req) => {
    const course = courseOf(req)
    const kind = kindOf(req)
    return { courseId: course.id, kind, items: assignlib.listDesigns(course.id, kind) }
  })

  /** 导入一份设计稿（zip） */
  app.post('/api/courses/:id/designs/import', { preHandler: requireAuth('teacher') }, async (req) => {
    const course = courseOf(req)
    const kind = kindOf(req)
    const buf = req.rawBodyBuffer
    if (!buf || !buf.length) throw badRequest('没有收到 zip')
    return { ok: true, design: assignlib.importDesign(course.id, kind, buf) }
  })

  /** 导出某份设计稿 */
  app.get('/api/courses/:id/designs/:did/export.zip', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const course = courseOf(req)
    const kind = kindOf(req)
    const out = assignlib.exportDesign(course.id, kind, req.params.did)
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
  app.delete('/api/courses/:id/designs/:did', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const course = courseOf(req)
    const kind = kindOf(req)
    const ok = assignlib.removeDesign(course.id, kind, req.params.did)
    if (!ok) throw notFound('设计稿不存在')
    reply.status(204).send()
  })

  /** 空模板（含 README 与目录骨架） */
  app.get('/api/courses/:id/designs/template.zip', { preHandler: requireAuth('teacher') }, async (req, reply) => {
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
  app.get('/api/courses/:id/designs/:did/code', { preHandler: requireAuth('teacher') }, async (req) => {
    const course = courseOf(req)
    const out = assignlib.designCode(course.id, req.params.did)
    if (!out) throw notFound('设计稿不存在')
    return out
  })
}
