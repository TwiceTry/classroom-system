/*
 * routes/misc.js —— 健康检查 / 课程表 / 首屏 bootstrap
 *
 * 注意 bootstrap 的**形状是前端既有契约**（store.js 一次拿全）：
 *   { lessons, courses, classes, items, scheme }  —— 按身份裁剪，见路由内注释
 * 其中 classes 里的字段名是 `count`（不是 studentCount）—— 前端按这个渲染
 * 「（60 人）」。这类名字不能自作主张改，否则页面直接显示「还没建班级」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { config, ROOT } from '../config.js'
import { requireAuth } from '../plugins/auth.js'
import { fromRequest } from '../lib/auth.js'
import * as repo from '../lib/repo.js'
import * as scheme from '../lib/scheme.js'
import { scoring, withCourseScheme } from '../lib/scheme.js'
import * as content from '../lib/content.js'
import * as timetable from '../lib/timetable.js'
import { contentRootOf } from './courses.js'

const START = Date.now()
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'api', 'package.json'), 'utf8'))

/** 当前课程：?courseId= 优先，否则第一门未归档的课 */
function currentCourse(req, user) {
  const id = String(req.query.courseId || '')
  if (id) {
    const c = repo.getCourse(id)
    if (c) return c
  }
  if (user && user.role === 'student' && user.classId) {
    const cls = repo.getClass(user.classId)
    if (cls && cls.courseId) {
      const c = repo.getCourse(cls.courseId)
      if (c) return c
    }
  }
  return repo.listCourses().find((c) => !c.archived) || null
}

/** 班级对外的形状：字段名是 count（前端按这个显示人数） */
const publicClass = (c) => ({
  id: c.id,
  courseId: c.courseId || '',
  name: c.name,
  count: repo.rosterOf(c.id).length,
  createdAt: c.createdAt || '',
})

export default async function miscRoutes(app) {
  /** 健康检查（公开）：部署后先看这个 */
  app.get('/api/health', async () => ({
    ok: true,
    role: 'api',
    version: PKG.version,
    runtime: 'fastify + sqlite',
    node: process.version,
    uptimeSec: Math.round((Date.now() - START) / 1000),
    db: path.basename(repo.dbPath()),
  }))

  /**
   * 作息时间表：返回「此刻是周几、第几节、时段」。
   * 前端侧栏那行时钟就是它算的 —— 形状一变就显示 "undefined undefined"。
   * 计算逻辑在旧 lib/timetable.js（纯函数，按服务器时间算，机房机器时间不准也不影响）。
   */
  app.get('/api/timetable', { preHandler: requireAuth() }, async () => timetable.at(new Date()))

  /**
   * 首屏：一次把「课次清单 + 课程 + 班级 + 考核项 + 方案 + 投屏状态」拿回来。
   * 不登录也能调（游客只看课次清单），前端据此决定渲染什么。
   */
  app.get('/api/bootstrap', async (req) => {
    const user = fromRequest(req.raw)
    const course = currentCourse(req, user)

    return withCourseScheme(course, () => {
      const lessons = course
        ? content.listLessons(contentRootOf(course)).map((x) => ({
            id: x.id,
            no: x.no,
            title: x.title,
            kind: x.kind,
            hasLecture: !!x.lecture,
            hasMaterials: !!x.materials,
          }))
        : []

      /*
       * 按身份给不同档位（游客 / 学生 / 教师），而不是一份全量：
       *
       *   items   教师才有 —— 「各项考核的分值表头」，只有教师端班级页（记分表）用；
       *           学生读分走 /api/student/score，游客更不该看到分值结构（4.6KB 白给）
       *   classes 学生只给「自己那个班」（切班下拉只对教师有意义）
       *
        * 刻意**不**返回的两项：
        *   cast             前端只有赋值没有读取，却含投屏状态与局域网地址
        *   passwordIsDefault 等于告诉任何人「直接试默认口令」；
        *                    口令提醒改在服务端控制台打印（api/src/server.js），不对外发
        */
       const role = user ? user.role : 'guest'
       const isTeacher = role === 'teacher'
       const myClassId = user && user.classId

       let classes = repo
         .listClasses(course ? course.id : undefined)
         .filter((c) => (course ? c.courseId === course.id || !c.courseId : true))
         .map(publicClass)
       if (role === 'student') classes = classes.filter((c) => c.id === myClassId)

       return {
         lessons,
         courses: repo.listCourses().map((c) => ({ id: c.id, name: c.name, archived: !!c.archived })),
         classes: role === 'guest' ? [] : classes,
         items: isTeacher ? scheme.items() : [],
         scheme: role === 'guest' ? null : scheme.publicInfo(),
       }
    })
  })
}
