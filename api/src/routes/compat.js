/*
 * routes/compat.js —— 前端已经在用、但重组时按资源重新命名了的那些接口
 *
 * 这里的目的不是「保留旧 API」，而是让**现有前端在 S4 适配前也能跑**：
 * 每个接口都用新后端的数据（SQLite + 新 repo），只是路径/形状与旧版保持一致。
 * S4 改完前端后，这个文件可以整体删掉（也可以留着当兼容层）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { requireAuth } from '../plugins/auth.js'
import { fromRequest } from '../lib/auth.js'
import { ApiError, badRequest, notFound, forbidden } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import { UPLOAD_DIR } from '../config.js'
import * as store from '../lib/submitstore.js'
import * as scheme from '../lib/scheme.js'
import { scoring, withCourseScheme } from '../lib/scheme.js'
import * as content from '../lib/content.js'
import { contentRootOf } from './courses.js'
import { broadcast } from './cast.js'

/** 讲义跟随：同一时刻只跟一个位置（一个老师在讲课，全班只看一处） */
let followState = null

/** 当前点名聚焦（存在 state 表的 spot:<班级>） */
function liveSpot(classId) {
  return repo.getState('spot:' + classId, null)
}

/** 课程内容根（课程不存在就 404） */
function rootOfCourseId(courseId) {
  const c = courseId ? repo.getCourse(courseId) : null
  if (!c) throw notFound('课程不存在：' + courseId)
  return { course: c, root: contentRootOf(c) }
}

export default async function compatRoutes(app) {
  /* ---------------- 公开信息（登录页要用） ---------------- */

  /**
   * 登录页的课程下拉 —— **只给 id 和名字**。
   *
   * 之前还带 `classes`（几个班）和 `students`（总人数），登录页拿它显示
   * 「1 门课，117 人次」。但那意味着**任何人打开登录页就能知道这个学校有几个班、
   * 多少学生** —— 而登录页只需要让用户选一门课，这些数字一个都用不上。
   *
   * 字段名必须是 `items` —— 前端 `Login.vue` 读的是 `res.items`。
   * 原来这里叫 `courses`，结果课程明明存在，登录页还是显示
   * 「老师还没有建课程」：它不是报错，是拿不到列表却没有任何提示。
   */
  app.get('/api/courses/public', async () => ({
    items: repo
      .listCourses()
      .filter((c) => !c.archived)
      .map((c) => ({ id: c.id, name: c.name })),
  }))

  /** 当前课程 + 课次清单（公开，可缓存） */
  app.get('/api/public/course', async (req, reply) => {
    const q = req.query.courseId ? String(req.query.courseId) : ''
    const course = q ? repo.getCourse(q) : repo.listCourses().find((c) => !c.archived) || null
    const body = {
      course: course ? { id: course.id, name: course.name } : null,
      lessons: course
        ? content.listLessons(contentRootOf(course)).map((x) => ({
            id: x.id,
            no: x.no,
            title: x.title,
            kind: x.kind,
            hasLecture: !!x.lecture,
            hasMaterials: !!x.materials,
          }))
        : [],
    }
    reply.header('Cache-Control', 'public, max-age=60')
    return body
  })

  /* ---------------- 内容：课次清单 / 文档正文 ---------------- */

  /** 课次清单（讲义/材料都有哪些章节） */
  app.get('/api/content/lessons', { preHandler: requireAuth() }, async (req) => {
    const course = req.query.courseId
      ? repo.getCourse(String(req.query.courseId))
      : repo.listCourses().find((c) => !c.archived) || null
    if (!course) return { lessons: [] }
    return {
      lessons: content.listLessons(contentRootOf(course)).map((x) => ({
        id: x.id,
        no: x.no,
        title: x.title,
        kind: x.kind,
        hasLecture: !!x.lecture,
        hasMaterials: !!x.materials,
      })),
    }
  })

  /** 一篇文档的正文：?type=materials|lecture&id=第01课 */
  app.get('/api/content/doc', async (req) => {
    const type = String(req.query.type || '') === 'lecture' ? 'lecture' : 'materials'
    const id = String(req.query.id || '')
    if (!id) throw badRequest('缺少 id')

    const t = fromRequest(req.raw)
    if (type === 'lecture' && (!t || t.role !== 'teacher')) throw forbidden('讲义仅教师可见')

    const courseId = String(req.query.courseId || '')
    const { course, root } = rootOfCourseId(courseId || (repo.listCourses().find((c) => !c.archived) || {}).id)

    const doc = content.getDoc(type, id, root)
    if (!doc) throw notFound('没有这篇文档')
    // 正文里的 ../assets/… 换成能直接打开的地址
    if (doc.markdown) doc.markdown = content.rewriteAssets(doc.markdown, course.id)
    return doc
  })

  /* ---------------- 代码示例 ---------------- */

  /**
   * 代码示例清单（代码工作台左侧的目录下拉）。
   * 前端读的是 `res.lessons`（每项要有 dir）—— 字段名一变，
   * 工作台就永远停在「正在读取示例清单…」。
   */
  app.get('/api/examples', { preHandler: requireAuth() }, async (req) => {
    const course = req.query.courseId
      ? repo.getCourse(String(req.query.courseId))
      : repo.listCourses().find((c) => !c.archived) || null
    if (!course) return { lessons: [] }
    const root = contentRootOf(course)
    return {
      lessons: content.listExamples(root).map((x) => ({
        dir: x.dir,
        title: x.title,
        no: x.no,
        fileCount: x.fileCount,
      })),
    }
  })

  /** 某个示例目录的完整文件（代码工作台载入用；前端要 res.files[{path,text}]） */
  app.get('/api/examples/:dir', { preHandler: requireAuth() }, async (req) => {
    const course = req.query.courseId
      ? repo.getCourse(String(req.query.courseId))
      : repo.listCourses().find((c) => !c.archived) || null
    if (!course) throw notFound('还没有课程')
    const root = contentRootOf(course)
    // 注意参数顺序：content.getExampleBundle(dir, root)
    const bundle = content.getExampleBundle(String(req.params.dir), root)
    if (!bundle) throw notFound('这个示例目录不存在：' + req.params.dir)
    return bundle
  })

  /**
   * 示例工程的静态文件服务（预览 iframe 的 <base> 指到这里）。
   *
   * 为什么需要它：示例页面写的是 `<script src="../vue.global.js">` ——
   * vue.global.js / vue3-sfc-loader.js / playground/sfc-boot.js 这些**共享运行时**
   * 放在「代码示例/」根目录，不在每个示例目录里。
   *
   * 预览是 iframe srcdoc，相对路径按 <base> 解析；如果 base 指向一个取不到文件的地址，
   * `../vue.global.js` 会落到 SPA 兜底、拿回 index.html，
   * 于是控制台报 `Uncaught SyntaxError: Unexpected token '<'` —— Vue 示例全部渲染不出来。
   *
   * 这里直接把「代码示例/」当静态目录提供服务：
   *   · 内存文件字典优先（学生改动走内存），没命中的才走这个接口
   *   · 浏览器可缓存，不必把 2.4MB 的 sfc-loader 塞进 /api/examples 的 JSON 里
   */
  /*
   * 这三个是**共享运行时**（第三方库 + 启动脚本），不是老师的课程内容：
   *   vue.global.js        Vue 3 全局构建
   *   vue3-sfc-loader.js   浏览器里编译 .vue
   *   playground/sfc-boot.js 把窗口里的 .vue 挂上去
   * 它们由模板里的 `<script src="../xxx">` 直接加载 —— 那是**浏览器原生请求，
   * 带不了 Authorization 头**，所以不能要求登录，否则 Vue 示例全部白屏。
   * 其余文件（老师写的示例代码）仍然要登录才给。
   */
  const SHARED_RUNTIME = new Set(['vue.global.js', 'vue3-sfc-loader.js', 'playground/sfc-boot.js'])

  app.get('/api/example-files/*', async (req, reply) => {
    const rel = String(req.params['*'] || '').replace(/\\/g, '/')
    if (!rel) throw badRequest('缺少文件路径')

    const isShared = SHARED_RUNTIME.has(rel)
    if (!isShared && !fromRequest(req.raw)) throw new ApiError(401, 'unauthorized', '需要登录')

    const course = req.query.courseId
      ? repo.getCourse(String(req.query.courseId))
      : repo.listCourses().find((c) => !c.archived) || null
    if (!course) throw notFound('还没有课程')

    const exRoot = content.dirsOf(contentRootOf(course)).examples

    // 路径安全：不允许 ..、不允许绝对路径、不允许跳出示例根
    const full = path.resolve(exRoot, rel)
    const rootAbs = path.resolve(exRoot)
    if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) throw forbidden('路径越界')
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw notFound('文件不存在：' + rel)

    const ext = path.extname(full).toLowerCase()
    const MIME = {
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
    }
    reply.type(MIME[ext] || 'text/plain; charset=utf-8')
    reply.header('cache-control', 'private, max-age=300')
    return fs.createReadStream(full)
  })

  /* ---------------- 学生成绩（只有他自己） ---------------- */

  app.get('/api/student/score', { preHandler: requireAuth('student') }, async (req) => {
    const t = req.user
    const cls = repo.getClass(t.classId)
    if (!cls) throw notFound('班级不存在')
    const course = cls.courseId ? repo.getCourse(cls.courseId) : null
    const events = repo.eventsOf(cls.id, { limit: 1000, sid: t.sid }).items
    return withCourseScheme(course, () => {
      const result = scoring.computeStudent(events, t.sid)
      return {
        student: { sid: t.sid, name: t.name, className: cls.name, classId: cls.id },
        items: scheme.items().map((it) => ({
          key: it.key,
          name: it.name,
          short: it.short,
          full: it.full,
          hint: it.hint,
          extra: !!it.extra,
        })),
        rows: result.rows.map((row) => ({
          key: row.item.key,
          name: row.item.name,
          full: row.item.full,
          extra: !!row.item.extra,
          score: row.score,
          events: row.events
            .slice()
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
            .map((e) => ({
              id: e.id,
              summary: scoring.eventSummary(e),
              reason: e.reason,
              createdAt: e.createdAt,
              voided: !!e.voided,
            })),
        })),
        total: result.total,
        base: result.base,
        extra: result.extra,
        capped: result.capped,
      }
    })
  })

  /* ---------------- 点名聚焦（教师抽人、学生看我被点了吗） ---------------- */

  app.get('/api/spotlight', { preHandler: requireAuth() }, async (req) => {
    const t = req.user
    if (!t.classId) return { spotlight: null }
    return { spotlight: liveSpot(t.classId) }
  })

  /* ---------------- 讲义跟随 ---------------- */

  app.post('/api/teacher/follow', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['lessonId', 'anchor'],
        properties: {
          lessonId: { type: 'string' },
          anchor: { type: 'string' },
          sectionTitle: { type: 'string', maxLength: 80 },
          courseId: { type: 'string' },
        },
      },
    },
    handler: async (req) => {
      followState = {
        lessonId: String(req.body.lessonId),
        anchor: String(req.body.anchor),
        sectionTitle: String(req.body.sectionTitle || '').slice(0, 80),
        courseId: String(req.body.courseId || ''),
        at: Date.now(),
      }
      const delivered = broadcast(Object.assign({ t: 'follow' }, followState))
      return { ok: true, delivered, follow: followState }
    },
  })

  app.get('/api/follow', { preHandler: requireAuth() }, async () => followState || { lessonId: '', anchor: '', sectionTitle: '', at: 0 })

  /* ---------------- 附件下载 ---------------- */

  /** 教师下载学生交的附件（学生只能下自己的） */
  app.get('/api/files/assignments/:aid/:sid/:name', { preHandler: requireAuth() }, async (req, reply) => {
    const t = req.user
    const a = repo.getAssignment(req.params.aid)
    if (!a) throw notFound('作业不存在')
    const sid = String(req.params.sid)
    if (t.role === 'student' && (sid !== t.sid || a.courseId)) {
      // 学生只允许下自己的；而且必须真的交过
      const own = repo.findSubmission(a.id, t.sid)
      if (!own) throw forbidden('你没有交这份作业')
    }
    const sub = repo.findSubmission(a.id, sid)
    if (!sub) throw notFound('没有这份提交')
    const full = store.filePathOf(a.kind, sub.classId, sid, a.id, req.params.name)
    if (!full) throw notFound('文件不存在')
    const st = fs.statSync(full)
    return reply
      .status(200)
      .headers({
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(full)),
      })
      .send(fs.createReadStream(full))
  })

  /* ---------------- 证据图片上传（记分时贴截图） ---------------- */

  /**
   * body: { name, dataUrl } → 存进 data/uploads/，返回可访问地址。
   * 走 base64 而不是 multipart：前端只有这一处 file→dataUrl 的调用，
   * 为它加一套 multipart 解析器不划算。
   */
  app.post('/api/teacher/upload', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['dataUrl'],
        properties: { name: { type: 'string', maxLength: 100 }, dataUrl: { type: 'string' } },
      },
    },
    handler: async (req) => {
      const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(String(req.body.dataUrl))
      if (!m) throw badRequest('文件格式不正确')
      const buf = Buffer.from(m[2], 'base64')
      if (buf.length > 6 * 1024 * 1024) throw new ApiError(413, 'too_large', '单个图片不能超过 6MB')

      const safe = String(req.body.name || 'shot').replace(/[\\/:*?"<>|]/g, '_').slice(-80)
      const stored = Date.now().toString(36) + '-' + safe
      fs.mkdirSync(UPLOAD_DIR, { recursive: true })
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf)
      return { ok: true, name: safe, stored, size: buf.length, url: '/api/uploads/' + encodeURIComponent(stored) }
    },
  })

  /** 上面返回的 url 落到这里 */
  app.get('/api/uploads/:name', { preHandler: requireAuth() }, async (req, reply) => {
    const safe = path.basename(String(req.params.name))
    const full = path.join(UPLOAD_DIR, safe)
    if (!fs.existsSync(full)) throw notFound('文件不存在')
    const st = fs.statSync(full)
    const ext = path.extname(full).toLowerCase()
    const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
    return reply
      .status(200)
      .headers({
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'private, max-age=600',
      })
      .send(fs.createReadStream(full))
  })

  /* ---------------- 附件下载（旧路径别名） ---------------- */

  const sendStudentFile = async (req, reply, kind) => {
    const t = req.user
    const a = repo.getAssignment(req.params.aid)
    if (!a) throw notFound('作业不存在')
    const sid = String(req.params.sid)
    if (t.role === 'student' && sid !== t.sid) throw forbidden('只能看自己的')
    const sub = repo.findSubmission(a.id, sid)
    if (!sub) throw notFound('没有这份提交')
    const full = store.filePathOf(kind || a.kind, sub.classId, sid, a.id, req.params.name)
    if (!full) throw notFound('文件不存在')
    const st = fs.statSync(full)
    return reply
      .status(200)
      .headers({
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(full)),
      })
      .send(fs.createReadStream(full))
  }


  /**
   * 素材目录的静态服务：`/api/assets/brands/vue.svg` → `content/assets/brands/vue.svg`
   *
   * 为什么需要：讲义 / 材料 / 示例里写的是相对路径 `../assets/brands/vue.svg`。
   *   · 讲义页：相对 `/teacher/lecture` 解析 → `/assets/...`（不存在）
   *   · 代码练习的预览 iframe：<base> 是 `/api/example-files/<dir>/`，
   *     `../../assets/...` 上跳两级 → `/api/assets/...`
   * 于是图片全 404（代码练习页控制台就有一条 `vue.svg 404`）。
   *
   * **不需要登录**：`assets/` 是公开素材 —— 课程材料（materials）对游客可见，
   * 它引用的图必须能显示。（讲义专属的图请放 lecture/ 下，那里仍旧只给教师。）
   */
  app.get('/api/assets/*', async (req, reply) => {
    const rel = String(req.params['*'] || '').replace(/\\/g, '/')
    if (!rel) throw badRequest('缺少文件路径')

    const course = req.query.courseId
      ? repo.getCourse(String(req.query.courseId))
      : repo.listCourses().find((c) => !c.archived) || null
    if (!course) throw notFound('还没有课程')

    const assetsRoot = path.join(contentRootOf(course), 'assets')
    const full = path.resolve(assetsRoot, rel)
    const base = path.resolve(assetsRoot)
    if (full !== base && !full.startsWith(base + path.sep)) throw badRequest('路径越界')
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw notFound('文件不存在：' + rel)

    const ext = path.extname(full).toLowerCase()
    const MIME = {
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.pdf': 'application/pdf',
      '.mp4': 'video/mp4',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    }
    reply.type(MIME[ext] || 'application/octet-stream')
    reply.header('cache-control', 'public, max-age=600')
    return fs.createReadStream(full)
  })

  /** 讲义里的图片：?courseId=&path=lecture/img/a.png（讲义仅教师） */
  app.get('/api/content/asset', async (req, reply) => {
    const t = fromRequest(req.raw)
    const rel = String(req.query.path || '')
    if (!rel) throw badRequest('缺少 path')
    if (rel.replace(/\\/g, '/').split('/')[0] === 'lecture' && (!t || t.role !== 'teacher')) {
      throw forbidden('讲义仅教师可见')
    }
    const courseId = String(req.query.courseId || '')
    const { root } = rootOfCourseId(courseId || (repo.listCourses().find((c) => !c.archived) || {}).id)
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '')
    const full = path.resolve(root, clean)
    const base = path.resolve(root)
    if (full !== base && !full.startsWith(base + path.sep)) throw badRequest('路径越界')
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw notFound('文件不存在')
    const st = fs.statSync(full)
    const ext = path.extname(full).toLowerCase()
    const MIME = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.mp4': 'video/mp4',
    }
    return reply
      .status(200)
      .headers({
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'private, max-age=300',
      })
      .send(fs.createReadStream(full))
  })

  /* ---------------- 大作业详情（前端用旧路径） ---------------- */

  /** 大作业提交：与 /api/student/assignments/:id/submit 同一套逻辑（只是旧路径） */
  app.post('/api/student/projects/:id/submit', { preHandler: requireAuth('student') }, async (req, reply) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/student/assignments/' + encodeURIComponent(req.params.id) + '/submit',
      headers: { authorization: String(req.headers.authorization || '') },
      payload: req.body || {},
    })
    reply.status(r.statusCode)
    return r.body ? JSON.parse(r.body) : {}
  })

  app.get('/api/student/projects/:id', { preHandler: requireAuth('student') }, async (req) => {
    const t = req.user
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    if (a.status !== 'open' && !repo.findSubmission(a.id, t.sid)) throw forbidden('这次大作业还没开放')
    const mine = repo.findSubmission(a.id, t.sid)
    return {
      assignment: a,
      mySubmission: mine || null,
      files: mine && a.kind !== 'project' ? store.readTextFiles(a.kind, mine.classId, mine.sid, a.id, mine.files) : [],
    }
  })
}
