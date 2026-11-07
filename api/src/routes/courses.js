/*
 * routes/courses.js —— 课程
 *
 * 课程是「内容 + 方案 + 班级」的挂靠点：
 *   课程 → content/{lecture,materials,代码示例,exams,assets}
 *        → schemeId（考核方案，data/schemes/<id>.json）
 *        → 班级
 */
import fs from 'node:fs'
import path from 'node:path'
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound, conflict } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import { config } from '../config.js'
import * as schemeLib from '../lib/scheme.js'

/** 新课程的内容目录骨架 */
const CONTENT_DIRS = ['lecture', 'materials', '代码示例', 'exams', 'assets']

export function courseRoot(id) {
  return path.join(config.dataDir, 'courses', String(id))
}

export function contentRootOf(course) {
  if (!course) return ''
  if (course.contentDir) {
    // 绝对路径：原样用
    if (path.isAbsolute(course.contentDir)) return course.contentDir
    // 相对路径：**一律相对 data 目录**
    // 新布局存的是 `courses/<id>/content`，不能拿 config.courseDir 去拼 ——
    // 那是老布局（整个仓库外放一个课程目录）的兜底路径，拼上去会指向不存在的地方。
    return path.resolve(config.dataDir, course.contentDir)
  }
  // 没有 contentDir：老布局兜底
  if (config.courseDir) return path.join(config.courseDir, 'content')
  return path.join(courseRoot(course.id), 'content')
}

function ensureContentSkeleton(id) {
  const root = path.join(courseRoot(id), 'content')
  for (const d of CONTENT_DIRS) fs.mkdirSync(path.join(root, d), { recursive: true })
  return root
}

/** 各内容目录里的文件数（课程管理页每门课显示「lecture 20」这种小标） */
function contentStats(course) {
  const root = contentRootOf(course)
  const out = []
  for (const dir of CONTENT_DIRS) {
    let files = 0
    const full = path.join(root, dir)
    if (fs.existsSync(full)) {
      const walk = (p) => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue
          const q = path.join(p, e.name)
          if (e.isDirectory()) walk(q)
          else files++
        }
      }
      walk(full)
    }
    out.push({ dir, files })
  }
  return out
}

/**
 * 课程对外形状。
 * 前端课程管理页要 `classes 个 · students 人`、`scheme.name v3 · N 项`、`content[].files`
 * —— 少一项页面上就是空白，所以这里一次算齐。
 */
const view = (c) => {
  const classes = repo.listClasses(c.id)
  const students = classes.reduce((n, x) => n + repo.rosterOf(x.id).length, 0)
  const schemeRaw = c.schemeId ? safeReadScheme(c.schemeId) : null
  return {
    id: c.id,
    name: c.name,
    note: c.note || '',
    semester: c.semester || '',
    schemeId: c.schemeId || '',
    archived: !!c.archived,
    createdAt: c.createdAt || '',
    contentRoot: contentRootOf(c),
    contentDir: c.contentDir || '',
    classes: classes.length,
    students,
    scheme: schemeRaw
      ? { id: schemeRaw.id, name: schemeRaw.name, version: schemeRaw.version, items: (schemeRaw.items || []).length }
      : null,
    content: contentStats(c),
  }
}

/** 读方案文件（读不到就当作未绑定，不让课程列表整个挂掉） */
function safeReadScheme(schemeId) {
  try {
    return schemeLib.readRawById(schemeId)
  } catch (e) {
    return null
  }
}

export default async function courseRoutes(app) {
  /** 课程列表 */
  app.get('/api/courses', { preHandler: requireAuth('teacher') }, async (req) => {
    const includeArchived = String(req.query.includeArchived || '') === '1'
    const items = repo.listCourses().filter((c) => includeArchived || !c.archived).map(view)
    return { items, total: items.length }
  })

  /** 单门课程 */
  app.get('/api/courses/:id', { preHandler: requireAuth('teacher') }, async (req) => {
    const c = repo.getCourse(req.params.id)
    if (!c) throw notFound('课程不存在')
    return view(c)
  })

  /** 建课（只建壳：课程记录 + 内容目录骨架） */
  app.post('/api/courses', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,39}$' },
          name: { type: 'string', minLength: 1, maxLength: 60 },
          note: { type: 'string' },
          semester: { type: 'string' },
          /* 新建时从哪份方案复制（前端下拉「复制现有方案：xxx」） */
          copySchemeFrom: { type: 'string' },
        },
      },
    },
    handler: async (req, reply) => {
      const id = String(req.body.id || 'co' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
      if (repo.getCourse(id)) throw conflict('课程 ' + id + ' 已存在')
      const c = repo.upsertCourse({
        id,
        name: req.body.name.trim(),
        note: req.body.note || '',
        semester: req.body.semester || '',
        contentDir: path.relative(config.dataDir, path.join(courseRoot(id), 'content')).split(path.sep).join('/'),
        createdAt: new Date().toISOString(),
        archived: false,
      })
      ensureContentSkeleton(id)

      /*
       * 把选定课程的方案复制一份过来。
       *
       * 原先 POST 的 schema 里没有 copySchemeFrom，前端传了也被 Fastify 丢掉，
       * 于是新课程从来没有 data/schemes/<id>.json —— 打开「考核方案」页看到的
       * 其实是**示例课程**的默认方案（scheme.id = example-course），
       * 和老师以为的「复制了刚才那门课」完全不是一回事。
       *
       * 复制过来的是新课程的第一版：版本从 1 开始，不继承别人的变更历史。
       */
      const copyFrom = String(req.body.copySchemeFrom || '').trim()
      if (copyFrom && copyFrom !== id) {
        try {
          /*
           * 目标位置若有残留（历史遗留的 <id>.json），先清掉再写。
           * 否则 saveAs 会把它当"上一版"，版本号从 v2 起、还继承旧的变更日志。
           */
          try {
            const dst = schemeLib.fileOf(id)
            if (fs.existsSync(dst)) fs.unlinkSync(dst)
          } catch (e) {
            /* 删不掉就算了，后面写文件会覆盖 */
          }

          const src = schemeLib.readRawById(copyFrom)
          if (src) {
            const raw = JSON.parse(JSON.stringify(src))
            raw.id = id
            raw.name = req.body.name.trim()
            delete raw.version // saveAs 会置成 1
            raw.changes = []
            schemeLib.saveAs(raw, id, req.user && req.user.name ? req.user.name : '教师', '新建课程时复制自 ' + copyFrom)
            /*
             * 光有文件还不够：withCourseScheme 认的是 course.schemeId，
             * 为空就退回默认方案（example-course）。不把课程指过去的话，
             * 老师进「考核方案」看到的仍是示例课程的配置。
             */
            const fresh = repo.getCourse(id)
            if (fresh) repo.upsertCourse(Object.assign({}, fresh, { schemeId: id }))
          }
        } catch (e) {
          // 复制失败不该让建课失败：课程已经建好，老师之后能在「考核方案」页手选或导入
        }
      }

      reply.status(201)
      return view(c)
    },
  })

  /** 改课（改名 / 备注 / 学期 / 归档） */
  app.patch('/api/courses/:id', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 },
          note: { type: 'string' },
          semester: { type: 'string' },
          archived: { type: 'boolean' },
          schemeId: { type: 'string' },
        },
      },
    },
    handler: async (req) => {
      const cur = repo.getCourse(req.params.id)
      if (!cur) throw notFound('课程不存在')
      const next = Object.assign({}, cur)
      for (const k of ['name', 'note', 'semester', 'archived', 'schemeId']) {
        if (req.body[k] !== undefined) next[k] = req.body[k]
      }
      if (next.name !== undefined && !String(next.name).trim()) throw badRequest('课程名不能为空')
      return view(repo.upsertCourse(next))
    },
  })

  /** 删课（不级联删班级：班级有数据，必须先明确处理） */
  app.delete('/api/courses/:id', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const c = repo.getCourse(req.params.id)
    if (!c) throw notFound('课程不存在')
    const classes = repo.listClasses(c.id)
    if (classes.length) {
      throw conflict('这门课下面还有 ' + classes.length + ' 个班，先把班级删掉或挪到别的课', {
        classes: classes.map((x) => ({ id: x.id, name: x.name })),
      })
    }
    repo.deleteCourse(c.id)

    /*
     * 方案文件跟着删。
     * 不删的话 data/schemes 会攒一堆没人认领的 <课程id>.json，
     * 而且下次建同名课程时 saveAs 会读到旧文件 —— 版本号从 v2 起、
     * 变更日志继承上一个课程的历史，看起来像是"继承了别人的记录"。
     * 默认方案（example-course）永远留着，那是新课程的兜底。
     */
    try {
      const f = schemeLib.fileOf(c.id)
      if (f && fs.existsSync(f) && c.id !== schemeLib.DEFAULT_ID) fs.unlinkSync(f)
    } catch (e) {
      /* 清不掉不该让删课失败 */
    }

    reply.status(204).send()
  })
}
