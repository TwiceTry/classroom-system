'use strict'
/*
 * api.js —— 系统全部 HTTP 接口
 *
 * 权限边界（重要）：
 *   - 只有 teacher 令牌能写：建班、导入名单、记分、撤分、点名、上传证据；
 *   - 学生令牌里锁死 classId + sid，学生端「我的分数」不接受前端传 sid，
 *     因此无法通过改参数看别人的分。
 */
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const config = require('../config')
const auth = require('../lib/auth')
const content = require('../lib/content')
const scoring = require('../lib/scoring')
const presence = require('../lib/presence')
const timetable = require('../lib/timetable')
const submissions = require('../lib/submissions')
const students = require('../lib/students')
const { RULES } = require('../lib/rules')
const coursepack = require('../lib/coursepack')
const coursepackImport = require('../lib/coursepack-import')
const courseFiles = require('../lib/coursefiles')
const contentIO = require('../lib/contentio')
const assignCode = require('../lib/assigncode')
const assignLib = require('../lib/assignlib')
const classIO = require('../lib/classio')
const schemeIO = require('../lib/schemeio')
const compat = require('../lib/compat')
const sheetLib = require('../lib/sheet')
const { stringifyGrid } = require('../lib/csv')
const { Router, ok, fail, json, readJson, readBuffer, readToFile, sendFile, HttpError } = require('../lib/http')

/**
 * 收一个大文件到临时文件，跑完自动删。
 * 课程包最大 500MB，全内存拼接会把服务器拖死，所以整条链路（收 → 解析 → 解包）都走磁盘。
 */
async function withUploadedFile(req, limitBytes, suffix, fn) {
  const dir = os.tmpdir()
  const file = path.join(dir, 'ts-up-' + crypto.randomBytes(8).toString('hex') + (suffix || ''))
  try {
    await readToFile(req, file, limitBytes)
    return await fn(file)
  } finally {
    try {
      fs.unlinkSync(file)
    } catch (e) {
      /* 没写成或已删 */
    }
  }
}

/** 课程包专用：收 zip 到临时文件再解析，跑完自动删 */
function withUploadedZip(req, limitBytes, fn) {
  return withUploadedFile(req, limitBytes, '.zip', fn)
}

/** 20261102-153012，给回收站目录用 */
function stampId() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

function uid(prefix) {
  return (prefix || '') + crypto.randomBytes(6).toString('hex')
}

module.exports = function createApi(db, cast) {
  const r = new Router()

  /* ---------------- 作息：现在几点、第几节 ---------------- */

  r.get('/api/timetable', async (req) => {
    need(req)
    return timetable.at(new Date())
  })

  /* ---------------- 健康检查（监控 / 反代用，不需要令牌） ---------------- */

  let startedAt = Date.now()
  r.get('/api/health', async () => ({
    ok: true,
    app: 'classroom-system',
    version: String(require('../../package.json').version || ''),
    node: process.version,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    now: new Date().toISOString(),
  }))

  /* ---------------- 小工具 ---------------- */

  function need(req, role) {
    const t = auth.fromRequest(req)
    if (!t) throw new HttpError(401, '登录已失效，请重新登录')
    if (role && t.role !== role) throw new HttpError(403, '当前身份无权访问')
    // 每个请求都先对齐一次「当前课程 → 当前方案」：计分、模块开关、方案页读的是同一份
    try {
      const cur = currentCourse(req, t)
      scoring.scheme.activate(cur ? cur.schemeId : '')
    } catch (e) {
      /* 课程表还没建好时不阻塞鉴权 */
    }
    return t
  }

  function getClass(id) {
    const c = db.getClass(id)
    if (!c) throw new HttpError(404, '班级不存在')
    return c
  }

  const eventsOf = (classId) => db.eventsOf(classId)

  /**
   * 当前课程：教师传 ?courseId= 就用它；学生按自己班级的课程；都没传就取第一门没归档的课。
   * 内容目录、讲义、材料、示例、作业列表都跟着它走。
   */
  function currentCourse(req, t) {
    let q = ''
    try {
      q = req ? new URL(req.url, 'http://x').searchParams.get('courseId') || '' : ''
    } catch (e) {
      q = ''
    }
    if (q) return db.getCourse(q)
    if (t && t.role === 'student' && t.classId) {
      const cls = db.getClass(t.classId)
      if (cls && cls.courseId) return db.getCourse(cls.courseId)
    }
    const list = db.listCourses().filter((c) => !c.archived)
    return list[0] || null
  }

  /** 当前课程的内容根目录（没有课程就退回全局配置的老布局） */
  function contentRoot(req, t) {
    const c = currentCourse(req, t)
    return c ? coursepack.contentRootOf(c) : ''
  }

  /** 数一个目录下有多少个文件（课程管理页显示内容是否就绪） */
  function countFiles(dir) {
    let n = 0
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) n += countFiles(path.join(dir, e.name))
        else n++
      }
    } catch (e2) {
      return 0
    }
    return n
  }

  function publicClass(c) {
    return { id: c.id, courseId: c.courseId || '', name: c.name, count: c.students.length, createdAt: c.createdAt }
  }

  function rosterOf(c) {
    return c.students.map((s) => ({ sid: s.sid, name: s.name }))
  }

  function summaryOf(e) {
    return { id: e.id, t: scoring.eventSummary(e) }
  }



  /* ---------------- 启动信息 / 登录 ---------------- */

  r.get('/api/bootstrap', async (req) => {
    // 先按「当前课程」激活方案：游客/学生看到的项与教师看到的一致
    try {
      const cur = currentCourse(req, auth.fromRequest(req) || null)
      if (cur) scoring.scheme.activate(cur.schemeId)
    } catch (e) {
      /* 课程表还没建好时不阻塞 */
    }
    return ({
    lessons: content.listLessons(contentRoot(req, null)).map((x) => ({
      id: x.id,
      no: x.no,
      title: x.title,
      kind: x.kind,
      hasLecture: !!x.lecture,
      hasMaterials: !!x.materials,
    })),
    courses: db.listCourses().map((c) => ({ id: c.id, name: c.name, archived: !!c.archived })),
    classes: db
      .listClasses()
      .filter((c) => {
        const cur = currentCourse(req, null)
        return cur ? c.courseId === cur.id : true
      })
      .map(publicClass),
    items: scoring.ITEMS,
    // 当前考核方案（改了 data/schemes/*.json 就会变，前端可以据此显示"按 v3 方案计算"）
    scheme: scoring.scheme.publicInfo(),
    passwordIsDefault: config.passwordIsDefault,
    cast: cast ? cast.state() : null,
    })
  })

  r.post('/api/login/teacher', async (req) => {
    const body = await readJson(req)
    if (!auth.checkPassword(body.password)) throw new HttpError(401, '口令不正确')
    const token = auth.issue({ role: 'teacher', name: '教师' })
    return { token, role: 'teacher' }
  })

  /** 登录页用：课程清单（不含任何学生信息，不需要登录） */
  r.get('/api/courses/public', async () => ({
    courses: db
      .listCourses()
      .filter((c) => !c.archived)
      .map((c) => ({
        id: c.id,
        name: c.name,
        classes: db.listClassesOf(c.id).length,
        students: db.listClassesOf(c.id).reduce((n, x) => n + x.students.length, 0),
      })),
  }))

  r.post('/api/login/student', async (req) => {
    const body = await readJson(req)
    const sid = String(body.sid || '').trim()
    const name = String(body.name || '').trim()
    const courseId = String(body.courseId || '').trim()

    // 新方式：选课程 + 学号 —— 班级由「课程内唯一学号」反查，学生不用知道自己在哪个班
    let cls = null
    let stu = null
    if (courseId) {
      const course = db.getCourse(courseId)
      if (!course) throw new HttpError(404, '课程不存在')
      const hit = db.findClassBySid(courseId, sid)
      if (!hit.cls) throw new HttpError(401, '这个学号不在本课程名单里，请核对课程与学号')
      if (hit.hits.length > 1) {
        throw new HttpError(409, '学号 ' + sid + ' 在本课程多个班里重复，请老师核对名单')
      }
      cls = hit.cls
      stu = cls.students.find((s) => s.sid === sid)
    } else {
      // 老方式：直接给班级 id（书签、旧页面还在用）
      cls = db.getClass(body.classId)
      if (!cls) throw new HttpError(404, '班级不存在')
      stu = cls.students.find((s) => s.sid === sid)
      if (!stu) throw new HttpError(401, '学号不在本班名单里，请核对后重试')
    }

    if (!stu) throw new HttpError(401, '学号不在名单里，请核对后重试')
    if (stu.name.trim() !== name) throw new HttpError(401, '姓名与学号不匹配')
    const course = db.getCourse(cls.courseId) || null
    const token = auth.issue({
      role: 'student',
      classId: cls.id,
      courseId: course ? course.id : '',
      sid: stu.sid,
      name: stu.name,
    })
    return {
      token,
      role: 'student',
      student: {
        sid: stu.sid,
        name: stu.name,
        classId: cls.id,
        className: cls.name,
        courseId: course ? course.id : '',
        courseName: course ? course.name : '',
      },
    }
  })

  r.get('/api/me', async (req) => {
    const t = need(req)
    if (t.role === 'student') {
      const cls = db.getClass(t.classId)
      // 课程名也要给：学生端侧栏头部显示的就是它，刷新后靠这个接口恢复
      const course = cls && cls.courseId ? db.getCourse(cls.courseId) : null
      return {
        role: 'student',
        student: {
          sid: t.sid,
          name: t.name,
          classId: t.classId,
          className: cls ? cls.name : '',
          courseId: course ? course.id : '',
          courseName: course ? course.name : '',
        },
      }
    }
    return { role: 'teacher' }
  })

  r.post('/api/logout', async (req) => {
    const h = req.headers['authorization'] || ''
    const m = /^Bearer\s+(.+)$/i.exec(h)
    if (m) auth.revoke(m[1].trim())
    return { ok: true }
  })

  /* ---------------- 班级与名单（教师） ---------------- */

  r.get('/api/teacher/classes', async (req) => {
    need(req, 'teacher')
    const cur = currentCourse(req, null)
    return {
      classes: db.listClasses()
        .filter((c) => (cur ? c.courseId === cur.id : true))
        .map((c) =>
        Object.assign(publicClass(c), {
          students: rosterOf(c),
          eventCount: eventsOf(c.id).length,
        })
      ),
    }
  })

  r.post('/api/teacher/classes', async (req) => {
    need(req, 'teacher')
    const body = await readJson(req)
    const name = String(body.name || '').trim() || '未命名班级'
    // 建班默认挂到当前课程（右上角选的那门）——老师一般就是在这个语境下建班
    const courseId = String(body.courseId || (currentCourse(req, null) || {}).id || '').trim()
    if (courseId && !db.getCourse(courseId)) throw new HttpError(404, '课程不存在：' + courseId)
    const c = db.createClass(uid('c'), name, courseId)
    return { class: Object.assign(publicClass(c), { students: [] }) }
  })

  r.patch('/api/teacher/classes/:id', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const body = await readJson(req)
    if (body.name) db.renameClass(c.id, String(body.name).slice(0, 40))
    return { class: Object.assign(publicClass(c), { students: rosterOf(c) }) }
  })

  r.del('/api/teacher/classes/:id', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    // 这个班每个学生的专属目录（作业正文 / 大作业 / 记分）整棵跟着删，否则磁盘上留一堆孤儿
    db.deleteClass(c.id)
    submissions.removeClass(c.id)
    // 班级没了，它的点名状态与会话也没有意义了
    db.setState('spot:' + p.id, null)
    db.setState('attend:' + p.id, null)
    return { ok: true }
  })

  /* ---------------- 名单导入：先算差异，再落盘 ---------------- */

  /** 校验一批名单，返回 { errors, plan } —— 只算不写 */
  function rosterPlan(c, incoming, mode) {
    const errors = []
    const seen = new Map()
    incoming.forEach((raw, i) => {
      const sid = String((raw && raw.sid) || '').trim()
      const name = String((raw && raw.name) || '').trim()
      const at = '第 ' + (i + 1) + ' 条'
      if (!sid) return errors.push(at + '：学号为空')
      if (!/^[A-Za-z0-9_-]{2,32}$/.test(sid)) errors.push(at + '：学号「' + sid + '」只能是字母数字与 - _（2–32 位）')
      if (!name) errors.push(at + '：姓名为空（学号 ' + sid + '）')
      else if (name.length > 20) errors.push(at + '：姓名太长（' + name.length + ' 字，上限 20）')
      if (seen.has(sid)) errors.push(at + '：学号 ' + sid + ' 与第 ' + seen.get(sid) + ' 条重复')
      else seen.set(sid, i + 1)
    })
    if (errors.length) return { errors, plan: null }

    const before = new Map(c.students.map((s) => [s.sid, s.name]))
    const after = new Map()
    let added = 0
    let updated = 0
    const renamed = []
    for (const raw of incoming) {
      const sid = String(raw.sid).trim()
      const name = String(raw.name).trim()
      after.set(sid, name)
      if (!before.has(sid)) {
        added++
      } else if (before.get(sid) !== name) {
        updated++
        renamed.push({ sid, from: before.get(sid), to: name })
      }
    }
    const removed =
      mode === 'replace' ? [...before.keys()].filter((sid) => !after.has(sid)) : []
    const unchanged = [...after.keys()].filter((sid) => before.has(sid) && before.get(sid) === after.get(sid)).length

    return {
      errors,
      plan: {
        mode,
        incoming: incoming.length,
        added,
        updated,
        unchanged,
        renamed: renamed.slice(0, 20),
        removed: removed.length,
        removedSids: removed.slice(0, 20),
        before: before.size,
        after: mode === 'replace' ? after.size : new Set([...before.keys(), ...after.keys()]).size,
      },
    }
  }

  function readRosterBody(body) {
    const incoming = (Array.isArray(body.students) ? body.students : []).map((x) => ({
      sid: String((x && x.sid) || '').trim(),
      name: String((x && x.name) || '').trim(),
    }))
    if (!incoming.length) throw new HttpError(400, '没有解析到任何学生，请检查表格格式')
    return { incoming, mode: body.mode === 'replace' ? 'replace' : 'merge' }
  }

  /** 第一步：只算差异，一个字节都不写（干跑） */
  r.post('/api/teacher/classes/:id/roster/inspect', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const body = await readJson(req, 4 * 1024 * 1024)
    const { incoming, mode } = readRosterBody(body)
    const { errors, plan } = rosterPlan(c, incoming, mode)
    if (errors.length) {
      const err = new HttpError(400, '名单有 ' + errors.length + ' 处问题')
      err.errors = errors
      throw err
    }
    return Object.assign({ ok: true, classId: c.id, className: c.name, preview: incoming.slice(0, 8) }, plan)
  })

  /** 第二步：真正写入（merge 只加新学号；replace 整班替换，已有记分记录不会被删） */
  r.post('/api/teacher/classes/:id/roster/apply', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const body = await readJson(req, 4 * 1024 * 1024)
    const { incoming, mode } = readRosterBody(body)
    const { errors, plan } = rosterPlan(c, incoming, mode)
    if (errors.length) {
      const err = new HttpError(400, '名单有 ' + errors.length + ' 处问题，一条都没导入')
      err.errors = errors
      throw err
    }

    if (mode === 'replace') c.students = []
    for (const raw of incoming) {
      const hit = c.students.find((s) => s.sid === raw.sid)
      if (hit) hit.name = raw.name
      else c.students.push({ sid: raw.sid, name: raw.name })
    }
    db.save()
    // 每个学生一进名单就有自己的目录（作业 / 大作业 / 机试 / 记分），不用等交作业才建
    students.ensureMany(c.id, c.students)
    for (const s of c.students) students.writeScoreSheet(c, s, eventsOf(c.id))
    // 被移出的学生只从名单里去掉，记分/作业记录都还在（events / submissions 按学号挂着）
    return Object.assign(plan, { ok: true, total: c.students.length, students: rosterOf(c) })
  })

  /**
   * 直接传表格文件（.xlsx / .csv / 制表符文本）：服务端解析，名单规则只有一份。
   *   ?mode=merge|replace  与 JSON 版一致
   *   ?apply=1             不带则只干跑（返回解析结果 + 差异报告），带了才落盘
   */
  r.post('/api/teacher/classes/:id/roster/sheet', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const q = new URL(req.url, 'http://x').searchParams
    const mode = q.get('mode') === 'replace' ? 'replace' : 'merge'
    const apply = q.get('apply') === '1'

    return withUploadedFile(req, 8 * 1024 * 1024, '', async (file) => {
      let parsed
      try {
        const read = await sheetLib.readUploaded(file)
        parsed = sheetLib.rowsToRoster(read.rows)
      } catch (e) {
        throw new HttpError(400, '表格解析失败：' + e.message)
      }

      if (!parsed.students.length) {
        const err = new HttpError(
          400,
          parsed.issues.length
            ? '表格里没有一行是完整的（学号 + 姓名），见问题清单'
            : '表格里没读到任何一行（检查是否选错了工作表，或表里没有「学号」「姓名」两列）'
        )
        err.errors = parsed.issues.slice(0, 12).map((it) => '第 ' + it.line + ' 行：' + it.msg)
        throw err
      }

      const { errors, plan } = rosterPlan(c, parsed.students, mode)
      if (errors.length) {
        const err = new HttpError(400, '名单有 ' + errors.length + ' 处问题')
        err.errors = errors
        throw err
      }

      const base = Object.assign({ ok: true, mode, parsed: parsed.students.length, issues: parsed.issues }, plan)
      if (!apply) return base

      if (mode === 'replace') c.students = []
      for (const raw of parsed.students) {
        const hit = c.students.find((s) => s.sid === raw.sid)
        if (hit) hit.name = raw.name
        else c.students.push({ sid: raw.sid, name: raw.name })
      }
      db.save()
      students.ensureMany(c.id, c.students)
      for (const s of c.students) students.writeScoreSheet(c, s, eventsOf(c.id))
      return Object.assign(base, { total: c.students.length, students: c.students.map((s) => ({ sid: s.sid, name: s.name })) })
    })
  })

  /** 老接口（兼容旧调用）：等同 apply */
  r.post('/api/teacher/classes/:id/roster', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const body = await readJson(req, 4 * 1024 * 1024)
    const { incoming, mode } = readRosterBody(body)
    const { errors, plan } = rosterPlan(c, incoming, mode)
    if (errors.length) {
      const err = new HttpError(400, '名单有 ' + errors.length + ' 处问题，一条都没导入')
      err.errors = errors
      throw err
    }
    if (mode === 'replace') c.students = []
    for (const raw of incoming) {
      const hit = c.students.find((s) => s.sid === raw.sid)
      if (hit) hit.name = raw.name
      else c.students.push({ sid: raw.sid, name: raw.name })
    }
    db.save()
    students.ensureMany(c.id, c.students)
    for (const s of c.students) students.writeScoreSheet(c, s, eventsOf(c.id))
    return { added: plan.added, updated: plan.updated, removed: plan.removed, removedSids: plan.removedSids, mode, total: c.students.length, students: rosterOf(c) }
  })

  /**
   * 改一个学生：姓名随时可改；学号只在「还没有任何记录」时允许改 ——
   * 记分事件、作业、机试答卷都是按学号挂的，改了就对不上，所以宁可拒绝也别留烂账。
   */
  r.patch('/api/teacher/classes/:id/students/:sid', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const stu = c.students.find((x) => x.sid === p.sid)
    if (!stu) throw new HttpError(404, '名单里没有这个学号')
    const body = await readJson(req)
    const name = (body.name === undefined ? stu.name : String(body.name)).trim()
    const sid = (body.sid === undefined ? stu.sid : String(body.sid)).trim()
    if (!name) throw new HttpError(400, '姓名不能为空')
    if (!sid) throw new HttpError(400, '学号不能为空')

    let renamed = ''
    if (sid !== stu.sid) {
      if (c.students.some((x) => x.sid === sid)) throw new HttpError(409, '这个学号已经在名单里了')
      const used = eventsOf(c.id).some((e) => e.sid === stu.sid)
      if (used) throw new HttpError(400, '这个学生已经有记分/作业记录，学号不能改（姓名可以改）')
      const from = students.dirOf(c.id, stu.sid)
      const to = students.dirOf(c.id, sid)
      try {
        if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to)
        renamed = from !== to ? sid : ''
      } catch (e) {
        /* 目录改名失败不拦人：ensure 会在下面补出新目录 */
      }
    }

    stu.name = name
    stu.sid = sid
    db.save()
    students.ensure(c.id, stu.sid)
    students.writeScoreSheet(c, stu, eventsOf(c.id))
    return { ok: true, student: { sid: stu.sid, name: stu.name }, renamed, students: rosterOf(c) }
  })

  r.del('/api/teacher/classes/:id/students/:sid', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    c.students = c.students.filter((s) => s.sid !== p.sid)
    db.save()
    return { students: rosterOf(c) }
  })

  /* ---------------- 考勤（一屏点名） ----------------
   * 60 个学生一屏点完，只在「提交」时落盘一次：
   *   出勤 = 不记（默认全勤）；迟到 / 缺勤 / 请假 / 早退 各记一条
   * 扣多少分**从方案参数算**（perAbsent / perLate），与记分表同一套规则。
   */

  /** 考勤项：优先用 ?itemKey= 指定的那一项，否则取方案里第一个 form=attendance 的 */
  function attendanceItem(req) {
    let want = ''
    try {
      want = req ? new URL(req.url, 'http://x').searchParams.get('itemKey') || '' : ''
    } catch (e) {
      want = ''
    }
    if (want) {
      const hit = scoring.scheme.itemByKey(want)
      if (hit) return hit
    }
    const list = scoring.scheme.items().filter((i) => i.form === 'attendance')
    return list[0] || scoring.scheme.itemByKey('attend') || null
  }

  /** 某类考勤该扣几分（跟 base 规则同口径） */
  function attendanceDelta(item, kind) {
    const p = (item.rule && item.rule.params) || {}
    const absentKind = (p.zeroRule && p.zeroRule.kind) || '缺勤'
    const perAbsent = p.perAbsent === undefined ? 2 : Number(p.perAbsent) || 0
    const perLate = p.perLate === undefined ? 1 : Number(p.perLate) || 0
    if (kind === absentKind) return -perAbsent
    if (kind === '迟到' || kind === '早退') return -perLate
    return 0
  }

  const dayOf = (iso) => String(iso || '').slice(0, 10)

  /** 一节课的槽位顺序（前端给五个选项，后端只按字符串分组，不做死校验） */
  const SLOTS = ['1-2节', '3-4节', '5-6节', '7-8节', '9-10节']

  /** 这条考勤账属于哪个节次：优先用事件上的 slot，老数据从 reason 里认 */
  function slotOf(e) {
    if (e.slot) return String(e.slot)
    const m = /(\d+-\d+节)/.exec(String(e.reason || ''))
    return m ? m[1] : ''
  }

  /** 这个班按天分组的考勤记录（页面回显「上次」和「今天」） */
  function attendanceDays(c, item) {
    const evs = eventsOf(c.id).filter((e) => e.item === item.key && !e.voided)
    const map = new Map()
    for (const e of evs) {
      const d = dayOf(e.createdAt)
      if (!map.has(d)) map.set(d, [])
      map.get(d).push(e)
    }
    const days = Array.from(map.keys()).sort().reverse()
    return { days, map }
  }

  r.get('/api/teacher/classes/:id/attendance', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const item = attendanceItem(req)
    if (!item) throw new HttpError(400, '考核方案里没有考勤项（form = attendance）')
    const q = new URL(req.url, 'http://x').searchParams
    const wantDay = q.get('date') || ''
    const { days, map } = attendanceDays(c, item)
    const day = wantDay || days[0] || ''
    const dayEvents = map.get(day) || []
    const slot = q.get('slot') || ''
    const picked = slot ? dayEvents.filter((e) => slotOf(e) === slot) : dayEvents
    const marks = picked.map((e) => ({ sid: e.sid, kind: e.kind, delta: e.delta, slot: slotOf(e), eventId: e.id }))
    const board = scoring.computeClass(c.students, eventsOf(c.id))
    return {
      itemKey: item.key,
      itemName: item.name,
      full: item.full,
      kinds: ['出勤', '迟到', '缺勤', '请假', '早退'].map((k) => ({ kind: k, delta: attendanceDelta(item, k) })),
      day,
      slot,
      slots: SLOTS,
      // 这一天每个节次各记了几条（页面上显示「1-2节 3 条」这种小标）
      slotStats: SLOTS.map((s) => ({ slot: s, count: dayEvents.filter((e) => slotOf(e) === s).length })).filter(
        (x) => x.count > 0
      ),
      days: days.slice(0, 30),
      marks,
      students: rosterOf(c),
      scores: board.list.map((r) => ({
        sid: r.student.sid,
        score: (r.rows.find((x) => x.item.key === item.key) || {}).score || 0,
        total: r.total,
      })),
    }
  })

  /** 提交一屏考勤：entries = [{ sid, kind }]，一次落盘 */
  r.post('/api/teacher/classes/:id/attendance', async (req, p) => {
    const t = need(req, 'teacher')
    const c = getClass(p.id)
    const item = attendanceItem(req)
    if (!item) throw new HttpError(400, '考核方案里没有考勤项（form = attendance）')
    const body = await readJson(req)
    const entries = Array.isArray(body.entries) ? body.entries : []
    if (!entries.length) throw new HttpError(400, '没有要提交的名单')
    const day = String(body.date || '').slice(0, 10) || dayOf(new Date().toISOString())
    const slot = String(body.slot || '').slice(0, 20)
    const includePresent = !!body.includePresent

    // 重记这一节：只撤「同一日期 + 同一节次」的考勤账（不碰别的节次，也不碰别的项）
    let voided = 0
    if (body.replaceDay) {
      for (const e of eventsOf(c.id)) {
        if (e.item !== item.key || e.voided) continue
        if (dayOf(e.createdAt) !== day) continue
        if (slot && slotOf(e) !== slot) continue
        const row = db.findEvent(c.id, e.id)
        if (!row) continue
        row.voided = true
        row.voidedAt = new Date().toISOString()
        row.voidedBy = t.name || '教师'
        voided++
      }
    }

    const reason = (slot ? day + ' ' + slot : day) + ' 考勤'
    const pending = []
    const touched = new Set()
    let created = 0
    let skipped = 0
    let present = 0
    for (const raw of entries) {
      const sid = String(raw.sid || '').trim()
      const kind = String(raw.kind || '').trim() || '出勤'
      const stu = c.students.find((x) => x.sid === sid)
      if (!stu) {
        skipped++
        continue
      }
      if (kind === '出勤' && !includePresent) {
        present++ // 全勤不记账：出勤扣 0 分，写一行只是噪音
        continue
      }
      pending.push({
        id: uid('e'),
        classId: c.id,
        sid,
        item: item.key,
        kind,
        slot,
        delta: attendanceDelta(item, kind),
        reason: String(raw.note || '').slice(0, 200) || reason,
        operator: t.name || '教师',
        createdAt: new Date(day + 'T' + new Date().toISOString().slice(11)).toISOString(),
        voided: false,
        evidence: [],
        schemeVersion: String(scoring.scheme.version()),
      })
      touched.add(sid)
      created++
    }
    db.addEvents(pending)
    db.save() // replaceDay 撤掉的那些也要落盘
    for (const sid of touched) {
      const stu = c.students.find((x) => x.sid === sid)
      if (stu) students.writeScoreSheet(c, stu, eventsOf(c.id))
    }
    return { ok: true, created, present, skipped, voided, day, slot }
  })

  /**
   * 单条即时标记：点一下某个学生就保存（重复点同一个 = 覆盖，回到「出勤」= 撤销）
   * 只影响「这一日期 + 这一节次 + 这个学生」，别的记录不动。
   */
  r.post('/api/teacher/classes/:id/attendance/mark', async (req, p) => {
    const t = need(req, 'teacher')
    const c = getClass(p.id)
    const item = attendanceItem(req)
    if (!item) throw new HttpError(400, '考核方案里没有考勤项（form = attendance）')
    const body = await readJson(req)
    const sid = String(body.sid || '').trim()
    const stu = c.students.find((x) => x.sid === sid)
    if (!stu) throw new HttpError(404, '该学生不在本班名单里')
    const kind = String(body.kind || '出勤').trim() || '出勤'
    const day = String(body.date || '').slice(0, 10) || dayOf(new Date().toISOString())
    const slot = String(body.slot || '').slice(0, 20)

    // 同一人、同一天、同一节次：先撤旧账（改状态时不叠加）
    let voided = 0
    for (const e of eventsOf(c.id)) {
      if (e.item !== item.key || e.voided) continue
      if (e.sid !== sid) continue
      if (dayOf(e.createdAt) !== day) continue
      if (slot && slotOf(e) !== slot) continue
      const row = db.findEvent(c.id, e.id)
      if (!row) continue
      row.voided = true
      row.voidedAt = new Date().toISOString()
      row.voidedBy = t.name || '教师'
      voided++
    }

    let eventId = ''
    if (kind !== '出勤') {
      const ev = {
        id: uid('e'),
        classId: c.id,
        sid,
        item: item.key,
        kind,
        slot,
        delta: attendanceDelta(item, kind),
        reason: String(body.note || '').slice(0, 200) || (slot ? day + ' ' + slot : day) + ' 考勤',
        operator: t.name || '教师',
        createdAt: new Date(day + 'T' + new Date().toISOString().slice(11)).toISOString(),
        voided: false,
        evidence: [],
        schemeVersion: String(scoring.scheme.version()),
      }
      db.addEvent(ev)
      eventId = ev.id
    } else {
      db.save()
    }
    students.writeScoreSheet(c, stu, eventsOf(c.id))
    const row = scoring.computeStudent(eventsOf(c.id), sid)
    const cell = (row.rows.find((x) => x.item.key === item.key) || {}).score || 0
    return { ok: true, sid, kind, slot, eventId, voided, score: cell, delta: attendanceDelta(item, kind) }
  })

  /* ---------------- 课堂互动（随机点名 + 当场加减分） ---------------- */

  /** 互动项：方案里 form=manual 且开了模块的那一项（优先 itemKey） */
  function interactItem(req) {
    let want = ''
    try {
      want = req ? new URL(req.url, 'http://x').searchParams.get('itemKey') || '' : ''
    } catch (e) {
      want = ''
    }
    if (want) {
      const hit = scoring.scheme.itemByKey(want)
      if (hit) return hit
    }
    const list = scoring.scheme.items().filter((i) => i.form === 'manual' && i.module && i.module.enabled)
    return list[0] || scoring.scheme.itemByKey('interact') || null
  }

  /** 互动页要的数据：名单 + 每人当前互动分 / 次数 + 本班最近的互动记录 + 在线 */
  r.get('/api/teacher/classes/:id/interact', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const item = interactItem(req)
    if (!item) throw new HttpError(400, '考核方案里没有可用的「手动记分」模块项')
    const events = eventsOf(c.id)
    const online = presence.onlineSet(c.id)
    const board = scoring.computeClass(c.students, events)
    const mine = events.filter((e) => e.item === item.key)
    const students = board.list.map((r) => {
      const row = (r.rows.find((x) => x.item.key === item.key) || { events: [], score: 0 })
      return {
        sid: r.student.sid,
        name: r.student.name,
        score: row.score || 0,
        count: (row.events || []).filter((e) => !e.voided).length,
        online: online.has(r.student.sid),
      }
    })
    return {
      itemKey: item.key,
      itemName: item.name,
      full: item.full,
      presets: Array.isArray(item.presets) ? item.presets : [],
      reasonRequired: item.reasonRequired !== false,
      reasonLabel: item.reasonLabel || '互动内容 / 原因',
      students,
      recent: mine
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 12)
        .map((e) => ({
          id: e.id,
          sid: e.sid,
          name: (c.students.find((x) => x.sid === e.sid) || {}).name || e.sid,
          delta: e.delta,
          reason: e.reason,
          at: e.createdAt,
          voided: !!e.voided,
        })),
      roll: {
        pickedCount: rollState(c.id).picked.length,
        remaining: Math.max(0, c.students.length - rollState(c.id).picked.length),
      },
    }
  })

  /* ---------------- 记分 ---------------- */

  r.get('/api/teacher/classes/:id/scores', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const events = eventsOf(c.id)
    return {
      class: publicClass(c),
      students: rosterOf(c),
      scheme: scoring.scheme.publicInfo(),
      items: scoring.ITEMS,
      board: scoring.computeClass(c.students, events),
      events: events.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    }
  })

  r.post('/api/teacher/classes/:id/events', async (req, p) => {
    const t = need(req, 'teacher')
    const c = getClass(p.id)
    const body = await readJson(req)
    const item = scoring.itemByKey(body.item)
    if (!item) throw new HttpError(400, '计分项不存在')
    const sid = String(body.sid || '')
    const stu = c.students.find((s) => s.sid === sid)
    if (!stu) throw new HttpError(404, '该学生不在本班名单里')

    if (item.reasonRequired && !String(body.reason || '').trim()) {
      throw new HttpError(400, '「' + item.reasonLabel + '」必填：每次加减分都要有原因')
    }

    const ev = {
      id: uid('e'),
      classId: c.id,
      sid,
      item: item.key,
      reason: String(body.reason || '').slice(0, 500),
      operator: String(body.operator || t.name || '教师').slice(0, 40),
      createdAt: new Date().toISOString(),
      voided: false,
      evidence: Array.isArray(body.evidence) ? body.evidence.slice(0, 6) : [],
      schemeVersion: String(scoring.scheme.version()),
    }

    if (item.mode === 'base' || item.mode === 'acc') {
      const d = Number(body.delta)
      if (!isFinite(d)) throw new HttpError(400, '分值必须是数字')
      ev.kind = String(body.kind || '').slice(0, 20)
      // 「出勤 / 请假」这类记录分值就是 0，但必须留痕，所以带类型时允许 0；
      // 互动 / 加分这种没有类型的，0 分没有意义，挡掉。
      if (d === 0 && !ev.kind) throw new HttpError(400, '分值必须是非零数字')
      ev.delta = d
    } else if (item.mode === 'avg') {
      const g = (item.grades.find((x) => x.key === body.grade) || {}).key
      if (!g) throw new HttpError(400, '请选择作业等级')
      ev.grade = g
      ev.late = !!body.late
      ev.weight = weightOf(body.weight)
    } else if (item.mode === 'raw') {
      const raw = Number(body.raw)
      if (!isFinite(raw) || raw < 0 || raw > item.rawFull) throw new HttpError(400, '卷面分应在 0–' + item.rawFull + ' 之间')
      ev.raw = raw
    } else if (item.mode === 'rubric') {
      ev.dims = {}
      for (const d of item.dims) {
        const v = Number((body.dims || {})[d.key])
        ev.dims[d.key] = scoring.clamp(isFinite(v) ? v : 0, 0, d.full)
      }
    }

    db.addEvent(ev)
    // 记一次分就刷一次这个学生的记分表快照（派生物，写失败不影响记分）
    students.writeScoreSheet(c, stu, eventsOf(c.id))

    const after = scoring.computeStudent(eventsOf(c.id), sid)
    return {
      event: ev,
      summary: scoring.eventSummary(ev),
      score: {
        rows: after.rows.map((row) => ({ key: row.item.key, score: row.score })),
        total: after.total,
      },
    }
  })

  function setVoid(req, p, voided) {
    const t = need(req, 'teacher')
    const c = getClass(p.id)
    const ev = db.findEvent(c.id, p.eid)
    if (!ev) throw new HttpError(404, '记录不存在')
    ev.voided = voided
    if (voided) {
      ev.voidedAt = new Date().toISOString()
      ev.voidedBy = t.name || '教师'
    } else {
      ev.voidedAt = ''
      ev.voidedBy = ''
    }
    db.save()
    const stu = c.students.find((s) => s.sid === ev.sid)
    if (stu) students.writeScoreSheet(c, stu, eventsOf(c.id)) // 撤分 / 恢复后快照也要跟着变
    return {
      event: ev,
      board: scoring.computeClass(c.students, eventsOf(c.id)),
    }
  }

  r.post('/api/teacher/classes/:id/events/:eid/void', async (req, p) => setVoid(req, p, true))
  r.post('/api/teacher/classes/:id/events/:eid/restore', async (req, p) => setVoid(req, p, false))

  /* ---------------- 在场状态（登录即在场） ---------------- */

  r.post('/api/presence/ping', async (req) => {
    const t = need(req, 'student')
    presence.touch(t.classId, t.sid, t.name)
    // 顺便把投屏状态捎回去：WS 被代理/内网设备掐掉时，学生端靠这个 10 秒一次的心跳兜底
    return { ok: true, online: presence.onlineSet(t.classId).size, cast: cast ? cast.state().mode : 'idle' }
  })

  /** 关页面 / 退出登录时调用（前端用 keepalive 发，保证页面卸载后也能送到） */
  r.post('/api/presence/leave', async (req) => {
    const t = need(req, 'student')
    presence.leave(t.classId, t.sid)
    return { ok: true }
  })

  r.get('/api/teacher/classes/:id/presence', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const roster = rosterOf(c)
    const online = presence.onlineSet(c.id)
    const casting = presence.castingSet(c.id)
    return {
      onlineCount: online.size,
      castingCount: casting.size,
      total: c.students.length,
      online: roster.filter((s) => online.has(s.sid)),
      offline: roster.filter((s) => !online.has(s.sid)),
      casting: roster.filter((s) => casting.has(s.sid)),
      ttlSeconds: Math.round(presence.TTL / 1000),
    }
  })

  /* ---------------- 讲义跟随（教师推节点、学生端跟着跳） ---------------- */

  // 同一时刻只跟一个位置：一个老师在讲课，全班只看一处
  let followState = null

  r.post('/api/teacher/follow', async (req) => {
    need(req, 'teacher')
    const body = await readJson(req)
    const lessonId = String(body.lessonId || '')
    const anchor = String(body.anchor || '')
    if (!lessonId || !anchor) throw new HttpError(400, '缺少 lessonId / anchor')
    followState = {
      lessonId,
      anchor,
      sectionTitle: String(body.sectionTitle || '').slice(0, 80),
      at: Date.now(),
    }
    const delivered = cast ? cast.broadcast(Object.assign({ t: 'follow' }, followState)) : 0
    return { ok: true, delivered, follow: followState }
  })

  r.get('/api/follow', async (req) => {
    need(req)
    return followState || { lessonId: '', anchor: '', sectionTitle: '', at: 0 }
  })

  /* ---------------- 学生端「我的分数」 ---------------- */

  r.get('/api/student/score', async (req) => {
    const t = need(req, 'student')
    const c = db.getClass(t.classId)
    if (!c) throw new HttpError(404, '班级不存在')
    const stu = c.students.find((s) => s.sid === t.sid)
    const events = eventsOf(c.id).filter((e) => e.sid === t.sid)
    const result = scoring.computeStudent(events, t.sid)
    return {
      student: { sid: t.sid, name: t.name, className: c.name, classId: c.id },
      items: scoring.ITEMS.map((it) => ({
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
      base: result.base,
      extra: result.extra,
      total: result.total,
      capped: result.capped,
      rank: rankOf(c, t.sid),
    }
  })

  function rankOf(c, sid) {
    const board = scoring.computeClass(c.students, eventsOf(c.id))
    const sorted = board.list.slice().sort((a, b) => b.total - a.total)
    const idx = sorted.findIndex((x) => x.student.sid === sid)
    return idx < 0 ? null : { index: idx + 1, count: sorted.length }
  }

  /* ---------------- 点名 ---------------- */

  function rollState(classId) {
    return db.rollState(classId)
  }

  r.get('/api/teacher/classes/:id/rollcall', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const st = rollState(c.id)
    const picked = st.picked
      .map((sid) => c.students.find((s) => s.sid === sid))
      .filter(Boolean)
      .map((s) => ({ sid: s.sid, name: s.name }))
    return {
      roster: rosterOf(c),
      picked,
      remaining: c.students.length - picked.length,
      round: st.round,
    }
  })

  /* ---------------- 点名投到学生端 ----------------
   * 教师在考勤 / 课堂互动里抽到谁，学生端要同步看到「现在点的是谁」。
   * 走的是已有的 presence WebSocket（不只是投屏通道），所以学生开着任意页面都能收到。
   */
  const SPOT_KEY = (cid) => 'spot:' + cid
  const ATT_KEY = (cid) => 'attend:' + cid
  // 老师忘了点「结束」、直接关页面（甚至关电脑）时，学生端不该一直顶着锁定浮层：
  // 超过 5 分钟没有新的点名，就当作过期，读的时候顺手清掉。
  // 可用 TS_SPOT_TTL_MS 覆盖（调试 / 特殊场景），默认 5 分钟
  const SPOT_TTL = Number(process.env.TS_SPOT_TTL_MS) || 5 * 60 * 1000

  /** 读一个「还有效」的点名状态；过期就当没有并清掉 */
  function liveSpot(cid) {
    const hit = db.getState(SPOT_KEY(cid))
    if (!hit) return null
    if (hit.at && Date.now() - Number(hit.at) > SPOT_TTL) {
      db.setState(SPOT_KEY(cid), null)
      return null
    }
    return hit
  }

  /** 点名时发给学生端的候选名字（滚动动画用；只有姓名，不含学号，最多 40 个） */
  function spotPool(c, stu) {
    if (!stu) return []
    const names = c.students.map((s) => String(s.name || '').trim()).filter(Boolean)
    if (names.length <= 1) return names
    // 洗牌后取 40 个，并把被抽中的那位放回去（否则滚到最后一下不是他，很怪）
    const bag = names.slice()
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = bag[i]
      bag[i] = bag[j]
      bag[j] = t
    }
    const pool = bag.slice(0, 40)
    if (pool.indexOf(stu.name) < 0) pool[pool.length - 1] = stu.name
    return pool
  }

  /**
   * 点名状态：既广播给学生端，也落到 state 表。
   * 这样教师端刷新（重新打开考勤页）、学生端刷新（F5 或晚进教室）都能拿到「现在点到谁」。
   */
  function announceSpotlight(c, payload) {
    const sid = String(payload.sid || '')
    const stu = sid ? c.students.find((x) => x.sid === sid) : null
    const msg = {
      t: 'spotlight',
      clear: !!payload.clear,
      kind: payload.kind === 'interact' ? 'interact' : 'attend',
      sid,
      name: stu ? stu.name : String(payload.name || ''),
      className: c.name,
      label: String(payload.label || '').slice(0, 20),
      lock: payload.lock !== false, // 默认锁定：学生端不能自己关，等老师结束
      seq: Number(payload.seq) || 0,
      total: Number(payload.total) || c.students.length,
      // 学生端要做「名字快速滚动 → 停在结果」的效果，需要一批候选名字。
      // 只发脱敏后的姓名（不带学号），最多 40 个，随机取，包住被抽中的那个人。
      pool: spotPool(c, stu),
      at: Date.now(),
    }
    // 落盘：clear 就删掉，否则存最新一条（含 lock，学生端刷新后仍受同样的约束）
    db.setState(SPOT_KEY(c.id), msg.clear ? null : msg)
    if (!cast) return 0
    return cast.broadcast(msg)
  }

  /** 考勤页用：抽到谁就报一次；close=true 表示这轮结束，学生端收起浮层 */
  r.post('/api/teacher/classes/:id/spotlight', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const body = await readJson(req)
    const delivered = announceSpotlight(c, body)
    return { ok: true, delivered }
  })

  /* ---------------- 代码练习同步 ----------------
   * 老师在「代码练习」里点「同步代码」后，当前文件的内容随改动推给学生端。
   * 状态落库（state 表），晚进教室 / 刷新页面的学生也能接上。
   */
  const PG_KEY = (cid) => 'pgsync:' + cid

  r.post('/api/teacher/classes/:id/pg-sync', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const body = await readJson(req)
    if (body.active === false) {
      db.setState(PG_KEY(c.id), null)
      if (cast) cast.broadcast({ t: 'pgsync', active: false })
      return { ok: true }
    }
    const state = {
      active: true,
      dir: String(body.dir || '').slice(0, 200),
      file: String(body.file || '').slice(0, 300),
      page: String(body.page || '').slice(0, 300), // 老师正在预览的那个页面：学生端右侧也跳过去
      caret: Math.max(0, Number(body.caret) || 0), // 老师的光标位置（字符偏移）：学生端跟着跳并滚到那里
      
      code: String(body.code || '').slice(0, 400000),
      at: Date.now(),
    }
    db.setState(PG_KEY(c.id), state)
    const delivered = cast ? cast.broadcast(Object.assign({ t: 'pgsync' }, state)) : 0
    return { ok: true, delivered }
  })

  // 老师忘了点停止、直接关页面：30 分钟没动静就当作结束（否则学生那边一直只读跟着）
  const PG_TTL = 30 * 60 * 1000

  function livePg(cid) {
    const hit = db.getState(PG_KEY(cid))
    if (!hit) return null
    if (hit.at && Date.now() - Number(hit.at) > PG_TTL) {
      db.setState(PG_KEY(cid), null)
      return null
    }
    return hit
  }

  r.get('/api/teacher/classes/:id/pg-sync', async (req, p) => {
    need(req, 'teacher')
    return { pg: livePg(getClass(p.id).id) }
  })

  /** 学生端：我这一班现在有没有在同步代码 */
  r.get('/api/pgsync', async (req) => {
    const t = need(req)
    if (!t.classId) return { pg: null }
    return { pg: livePg(t.classId) }
  })

  /** 教师端刷新后接着来：当前点名 + 考勤点名会话（抽过谁、抽谁档、顺序还是随机） */
  r.get('/api/teacher/classes/:id/spotlight', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    return {
      spotlight: liveSpot(c.id),
      attend: db.getState(ATT_KEY(c.id)),
    }
  })

  /** 保存考勤点名会话（每抽一个人、每换一次档就顺手存；服务重启也不丢） */
  r.post('/api/teacher/classes/:id/attend-state', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const body = await readJson(req)
    if (body.clear) {
      db.setState(ATT_KEY(c.id), null)
      return { ok: true }
    }
    const state = {
      day: String(body.day || ''),
      slot: String(body.slot || ''),
      drawn: Array.isArray(body.drawn) ? body.drawn.map(String).slice(0, 500) : [],
      order: !!body.order,
      scope: String(body.scope || 'unmarked'),
      at: Date.now(),
    }
    db.setState(ATT_KEY(c.id), state)
    return { ok: true, attend: state }
  })

  /** 学生端：我这一班现在点到谁了（用于刷新后恢复浮层） */
  r.get('/api/spotlight', async (req) => {
    const t = need(req)
    if (!t.classId) return { spotlight: null }
    return { spotlight: liveSpot(t.classId) }
  })

  /** 抽人：exclude=true 时从「没抽过的人」里抽，抽满则提示重置 */
  r.post('/api/teacher/classes/:id/rollcall/draw', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const body = await readJson(req)
    const st = rollState(c.id)
    const count = Math.max(1, Math.min(12, Number(body.count) || 1))
    const exclude = body.exclude !== false
    const pickedSet = new Set(st.picked)
    const pool = c.students.filter((s) => (exclude ? !pickedSet.has(s.sid) : true))
    if (!pool.length) throw new HttpError(400, '所有人都抽过了，请先「重置抽取」')

    const n = Math.min(count, pool.length)
    const chosen = []
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * pool.length)
      chosen.push(pool.splice(idx, 1)[0])
    }
    for (const s of chosen) if (!pickedSet.has(s.sid)) st.picked.push(s.sid)
    st.updatedAt = new Date().toISOString()
    db.save()
    // 抽一个人时同步到学生端（多人批量抽不播，屏幕上也显示不过来）
    if (chosen.length === 1) {
      announceSpotlight(c, {
        kind: 'interact',
        sid: chosen[0].sid,
        lock: body.lock !== false,
        label: '', // 由学生端按类型显示「课堂点名」，不写「请回答」
        seq: st.picked.length,
        total: c.students.length,
      })
    }

    return {
      drawn: chosen.map((s) => ({ sid: s.sid, name: s.name })),
      pickedCount: st.picked.length,
      remaining: Math.max(0, c.students.length - st.picked.length),
      round: st.round,
    }
  })

  r.post('/api/teacher/classes/:id/rollcall/remove', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const body = await readJson(req)
    const st = rollState(c.id)
    st.picked = st.picked.filter((sid) => sid !== body.sid)
    st.updatedAt = new Date().toISOString()
    db.save()
    return { pickedCount: st.picked.length, remaining: c.students.length - st.picked.length }
  })

  r.post('/api/teacher/classes/:id/rollcall/reset', async (req, p) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const st = rollState(c.id)
    st.picked = []
    st.round = (st.round || 1) + 1
    st.updatedAt = new Date().toISOString()
    db.save()
    announceSpotlight(c, { clear: true })
    return { round: st.round, remaining: c.students.length, pickedCount: 0 }
  })

  /* ---------------- 课堂作业 ----------------
   *
   * 规则（老师的要求，写死在这里）：
   *   1) 新建的作业一律「未开始」，学生端看不到入口，也不会被催着交；
   *   2) 老师点「开始」才开放提交，点「结束」立刻关门（交过的照样能看）；
   *   3) 学生交的是「整份文件」，正文落在 data/students/<班级>/<学号>/作业/ 下，CSV 只记索引；
   *   4) 提交记录一律按时间正序排（先交的在前），老师按顺序过一遍就行。
   */

  const examplesByDir = (root) => {
    const map = new Map()
    for (const x of content.listExamples(root || contentRoot())) map.set(x.dir, x)
    return map
  }

  /** 这条提交是不是已经有分/有评语了（批过就不许学生再覆盖） */
  function isGraded(sub) {
    if (!sub) return false
    if (sub.gradedAt) return true
    if (sub.grade) return true
    if (sub.score !== undefined && sub.score !== null) return true
    if (sub.dims && Object.keys(sub.dims).length) return true
    return false
  }

  /** 大作业的「交什么」要求：跟着它建作业时用的那个设计走；设计没了就用默认值 */
  function projectAsk(a) {
    const fallback = { requireFile: true, requireUrl: false, attachments: ['zip', 'pdf', 'md', 'png', 'mp4', 'pptx'] }
    if (!a || !a.designId) return fallback
    try {
      const d = assignLib.listDesigns(a.courseId || '', 'project').find((x) => x.id === a.designId)
      if (!d) return fallback
      return {
        requireFile: d.requireFile,
        requireUrl: d.requireUrl,
        attachments: d.attachments && d.attachments.length ? d.attachments : fallback.attachments,
      }
    } catch (e) {
      return fallback
    }
  }

  function publicAssignment(a, dirs) {
    const meta = (dirs || examplesByDir()).get(a.dir)
    return {
      id: a.id,
      kind: a.kind === 'project' ? 'project' : 'work',
      itemKey: a.itemKey,
      weight: a.weight === undefined ? 1 : Number(a.weight) || 1,
      title: a.title,
      dir: a.dir,
      dirTitle: meta ? meta.title : a.dir,
      lessonNo: meta ? meta.no : 0,
      note: a.note,
      status: a.status === 'open' ? 'open' : 'closed',
      started: !!a.openedAt,
      dueAt: a.dueAt || '',
      allowLate: a.allowLate === undefined ? true : !!a.allowLate,
      overDue: !!(a.dueAt && Date.parse(a.dueAt) < Date.now()),
      // 课堂作业的起手代码放在作业自己身上（dir 是 @a:<id> 这种虚拟目录，没有「第几课」）
      selfCode: String(a.dir || '').indexOf('@a:') === 0,
      // 大作业的提交要求来自设计包：附件必填？必须填链接？收哪些类型？
      requireFile: projectAsk(a).requireFile,
      requireUrl: projectAsk(a).requireUrl,
      attachments: projectAsk(a).attachments,
      createdAt: a.createdAt,
      openedAt: a.openedAt,
      closedAt: a.closedAt,
      updatedAt: a.updatedAt,
    }
  }

  function getAssignment(id) {
    const a = db.getAssignment(id)
    if (!a) throw new HttpError(404, '作业不存在')
    return a
  }

  /* ---------------- 考核方案 → 模块 ----------------
   * 模块存不存在、叫什么、走哪个路由，全由方案里 item.module 决定：
   *   form ∈ {graded, rubric, paper} 且 module.enabled = true  → 有模块
   *   submit = code  → 「改代码 + 跑渲染」的工作台（学生交整份代码）
   *   submit = files → 「说明 + 链接 + 附件」的表单（学生交材料）
   * 一个模块 = 方案里的一个考核项，所以「加一项考核 = 自动多一个模块」。
   */
  const MODULE_FORMS = ['attendance', 'manual', 'graded', 'rubric', 'paper']

  function isModuleItem(item) {
    return !!(item && item.module && item.module.enabled && MODULE_FORMS.indexOf(item.form) >= 0)
  }

  function submitOf(item) {
    return (item && item.module && item.module.submit) || 'files'
  }

  /** 兼容老调用：kind 是「交代码 / 交材料」的粗分类，从 submit 推出来 */
  function kindOfModule(item) {
    // 考勤 / 课堂互动这类「老师当场记」的模块：不交代码也不交材料
    if (item && item.form === 'attendance') return 'attendance'
    if (item && item.form === 'manual') return 'manual'
    return submitOf(item) === 'code' ? 'work' : 'project'
  }

  /** 某个 kind 当前是否有已启用的模块（被关掉就返回 null） */
  function moduleOfKind(kind) {
    const hit = scoring.scheme.items().find((i) => isModuleItem(i) && kindOfModule(i) === kind)
    return hit || null
  }

  /** 按考核项找模块（作业挂在哪个 itemKey 上，就用哪个模块的配置） */
  function moduleOfItem(itemKey) {
    const item = scoring.scheme.itemByKey(itemKey)
    return isModuleItem(item) ? item : null
  }

  function assertModule(kind) {
    if (!moduleOfKind(kind)) {
      throw new HttpError(403, '这个模块在考核方案里没有启用（data/schemes 里把 module.enabled 打开就好）')
    }
  }

  /** 权重：默认 1，允许 0.1–20（小数也行，比如 0.5 = 半次作业） */
  function weightOf(v) {
    const n = Number(v)
    if (!isFinite(n) || n <= 0) return 1
    return Math.min(20, Math.max(0.1, Math.round(n * 100) / 100))
  }

  function assertModuleItem(itemKey) {
    if (!moduleOfItem(itemKey)) {
      throw new HttpError(403, '「' + itemKey + '」在考核方案里没有启用对应模块')
    }
  }

  /** 给前端的「方案 + 可用模块」：导航、入口、页面守卫都读它 */
  /**
   * 课堂显示开关（学生端菜单）：不属于考核方案，是「这节课开不开这个入口」的运行时状态。
   * 存 state 表（stuvis:<courseId>），值为「隐藏了哪些 itemKey」——用隐藏列表而不是可见列表，
   * 这样方案里以后新加的模块默认就是显示的，不会出现「加了模块却没入口」。
   */
  const STUVIS_KEY = (cid) => 'stuvis:' + cid

  function stuVisOf(courseId) {
    const v = courseId ? db.getState(STUVIS_KEY(courseId)) : null
    const hidden = v && Array.isArray(v.hidden) ? v.hidden.map(String) : []
    return { hidden, at: Number((v && v.at) || 0) }
  }

  function setStuVis(courseId, hidden) {
    const clean = [...new Set((Array.isArray(hidden) ? hidden : []).map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 50)
    // 全可见 = 没有这条状态，别在 state 表里留空行
    db.setState(STUVIS_KEY(courseId), clean.length ? { hidden: clean, at: Date.now() } : null)
    return clean
  }

  function resolvedScheme(course) {
    const s = scoring.scheme.current()
    const hiddenKeys = stuVisOf(course && course.id).hidden
    // 考勤只保留一个入口（一门课一个考勤页）；就算方案里开了两个考勤项，也只给第一个
    let attendanceTaken = false
    const modules = s.items
      .filter(isModuleItem)
      .filter((i) => {
        if (i.form !== 'attendance') return true
        if (attendanceTaken) return false
        attendanceTaken = true
        return true
      })
      .map((i) => {
        const kind = kindOfModule(i)
        return {
          itemKey: i.key,
          title: (i.module && i.module.title) || i.name,
          form: i.form,
          submit: submitOf(i),
          kind,
          teacherRoute: '/teacher/modules/' + encodeURIComponent(i.key),
          // 考勤 / 课堂互动只有老师端：学生不需要（也不该）进这些页面
          studentRoute: kind === 'attendance' || kind === 'manual' ? '' : '/student/modules/' + encodeURIComponent(i.key),
          // 学生端菜单里显不显示：读「课堂开关」，与考核方案无关（方案只管有没有这个模块）
          studentVisible: hiddenKeys.indexOf(i.key) < 0,
        }
      })
    return {
      scheme: { id: s.id, name: s.name, version: s.version, totalFull: s.totalFull, passLine: s.passLine, cap: s.cap },
      items: s.items.map((i) => ({
        key: i.key,
        name: i.name,
        short: i.short,
        full: i.full,
        extra: !!i.extra,
        form: i.form,
        module: !!i.module && !!i.module.enabled,
      })),
      modules,
      // 学生端也用这份来判断（刷新/晚进教室时靠它，实时的靠后面的 stuvis 广播）
      hidden: hiddenKeys,
    }
  }

  function submissionView(s, className) {
    let evidence = []
    try {
      const ev = s.eventId && db.findEvent(s.classId, s.eventId)
      if (ev && Array.isArray(ev.evidence)) {
        evidence = ev.evidence.map((x) => ({
          name: x.name || '',
          size: x.size || 0,
          // 证据是老师侧材料：不给公开的 /uploads 链接，走带令牌的接口
          url: '/api/files/evidence/' + encodeURIComponent(s.assignmentId || '') + '/' + encodeURIComponent(s.id) + '/' + encodeURIComponent(x.name || ''),
        }))
      }
    } catch (e) {
      evidence = []
    }
    return {
      id: s.id,
      evidence,
      assignmentId: s.assignmentId,
      classId: s.classId,
      className: className || '',
      sid: s.sid,
      name: s.name,
      dir: s.dir,
      createdAt: s.createdAt,
      // files = 整份交上来的（教师端要跑起来看渲染）；changed = 学生真改过的那几个
      files: Array.isArray(s.files) ? s.files.slice() : [],
      changed: Array.isArray(s.changed) ? s.changed.slice() : [],
      fileCount: Array.isArray(s.files) ? s.files.length : 0,
      changedCount: Array.isArray(s.changed) ? s.changed.length : 0,
      note: s.note || '',
      url: s.url || '',
      grade: s.grade || '',
      late: !!s.late,
      raw: typeof s.raw === 'number' ? s.raw : null,
      dims: s.dims || null,
      score: typeof s.score === 'number' ? s.score : null,
      comment: s.comment || '',
      gradedAt: s.gradedAt || '',
    }
  }

  function broadcastAssignment(action, a) {
    if (!cast) return 0
    try {
      return cast.broadcast({
        t: 'assignment',
        action,
        id: a.id,
        title: a.title,
        status: a.status,
        at: Date.now(),
      })
    } catch (e) {
      return 0
    }
  }

  /** 当前考核方案 + 可用模块（导航、入口、页面守卫都读这一份） */
  r.get('/api/scheme', async (req) => {
    const t = need(req)
    let course = null
    try {
      course = currentCourse(req, t)
    } catch (e) {
      /* 课程表还没建好：按「没有隐藏项」处理 */
    }
    return resolvedScheme(course)
  })

/* ---- 学生端显示开关（课堂开关，不是方案的一部分） ---- */

  /** 读：当前隐藏了哪些模块 + 可显示的模块清单（给面板渲染开关用） */
  r.get('/api/teacher/courses/:id/stuvis', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const raw = c.schemeId ? scoring.scheme.readRawById(c.schemeId) : null
    const modules = []
    for (const it of (raw && raw.items) || []) {
      if (!it || !it.module || !it.module.enabled) continue
      const kind = kindOfModule(it)
      if (kind === 'attendance' || kind === 'manual') continue // 考勤 / 互动只有教师端
      modules.push({ itemKey: it.key, title: (it.module && it.module.title) || it.name, kind })
    }
    return Object.assign({ courseId: c.id, modules }, stuVisOf(c.id))
  })

  /** 改：整体覆盖隐藏列表，然后广播 → 学生端菜单立刻增减，不用刷新 */
  r.post('/api/teacher/courses/:id/stuvis', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const body = await readJson(req)
    const hidden = setStuVis(c.id, body.hidden)
    const delivered = cast ? cast.broadcast({ t: 'stuvis', courseId: c.id, hidden, at: Date.now() }) : 0
    return { ok: true, hidden, delivered }
  })

  /* ---------------- 课程（教师） ----------------
   * 一门课 = 内容目录（讲义/材料/代码示例/试卷）+ 考核方案 + 若干班级。
   * 两种建课方式：表单（先建壳，内容自己拷进去）/ 导入课程包（一次到位）。
   */

  function courseView(c) {
    const classes = db.listClassesOf(c.id)
    const students = classes.reduce((n, x) => n + x.students.length, 0)
    const root = coursepack.contentRootOf(c)
    const scheme = c.schemeId ? scoring.scheme.readRawById(c.schemeId) : null
    return {
      id: c.id,
      name: c.name,
      note: c.note || '',
      semester: c.semester || '',
      archived: !!c.archived,
      contentDir: root,
      content: coursepack.CONTENT_ROOTS.map((d) => ({
        dir: d,
        files: countFiles(path.join(root, d)),
      })),
      schemeId: c.schemeId || '',
      scheme: scheme ? { id: scheme.id, name: scheme.name, version: scheme.version, items: (scheme.items || []).length } : null,
      classes: classes.length,
      students,
      classList: classes.map((x) => ({ id: x.id, name: x.name, count: x.students.length })),
    }
  }

  r.get('/api/teacher/courses', async (req) => {
    need(req, 'teacher')
    return { courses: db.listCourses().map(courseView), roots: coursepack.CONTENT_ROOTS }
  })

  /** 表单建课：只建壳（课程记录 + 内容目录骨架 + 可选复制一份方案） */
  r.post('/api/teacher/courses', async (req) => {
    need(req, 'teacher')
    const body = await readJson(req)
    const name = String(body.name || '').trim().slice(0, 60)
    if (!name) throw new HttpError(400, '课程名不能为空')
    const id = String(body.id || '').trim() || uid('co')
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) {
      throw new HttpError(400, '课程 id 只能是 2–40 位小写字母 / 数字 / 短横线')
    }
    if (db.getCourse(id)) throw new HttpError(409, '课程 ' + id + ' 已存在')

    let schemeId = ''
    const from = String(body.copySchemeFrom || '')
    if (from) {
      const raw = scoring.scheme.readRawById(from)
      if (!raw) throw new HttpError(404, '要复制的方案不存在：' + from)
      const copy = Object.assign({}, raw, { id, name: name })
      scoring.scheme.saveAs(copy, id, '教师', '新建课程时复制自 ' + from)
      schemeId = id
    }

    const c = db.upsertCourse({
      id,
      name,
      note: String(body.note || '').slice(0, 500),
      semester: String(body.semester || '').trim().slice(0, 20),
      schemeId,
      contentDir: coursepack.defaultContentDir(id),
    })
    const root = coursepack.contentRootOf(c)
    for (const d of coursepack.CONTENT_ROOTS) fs.mkdirSync(path.join(root, d), { recursive: true })
    return { course: courseView(c) }
  })

  /* ---------------- 作业库（课堂作业 / 大作业两套设计） ----------------
   * 设计 = 题目 + 起手代码（课堂作业）或 题目 + 附件要求（大作业）。
   * 老师新建作业时从库里挑一个，或者直接上传一个设计包。
   */

  function designCourse(req, courseId) {
    const c = db.getCourse(courseId)
    if (!c) throw new HttpError(404, '课程不存在')
    return c
  }

  /** 库里有哪些设计（?kind=homework|project，不传两类都给） */
  r.get('/api/teacher/courses/:id/designs', async (req, p) => {
    need(req, 'teacher')
    const c = designCourse(req, p.id)
    const q = new URL(req.url, 'http://x').searchParams
    const kind = q.get('kind') || ''
    if (kind && assignLib.KINDS.indexOf(kind) < 0) throw new HttpError(400, 'kind 只能是 homework 或 project')
    const result = {}
    for (const k of kind ? [kind] : assignLib.KINDS) result[k] = assignLib.listDesigns(c.id, k)
    return result
  })

  /** 设计包模板（homework / project 各一份） */
  r.get('/api/teacher/courses/:id/designs/template.zip', async (req, p, res) => {
    need(req, 'teacher')
    designCourse(req, p.id)
    const q = new URL(req.url, 'http://x').searchParams
    const r = assignLib.templateZip(q.get('kind') === 'project' ? 'project' : 'homework')
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': r.buffer.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(r.filename),
      'Cache-Control': 'no-store',
    })
    res.end(r.buffer)
  })

  /** 上传一个设计包进库（唯一入口：新建作业时也能直接传） */
  r.post('/api/teacher/courses/:id/designs/import', async (req, p) => {
    need(req, 'teacher')
    const c = designCourse(req, p.id)
    const q = new URL(req.url, 'http://x').searchParams
    const kind = q.get('kind') === 'project' ? 'project' : 'homework'
    const buf = await readBuffer(req, 50 * 1024 * 1024)
    return assignLib.importDesign(c.id, kind, buf)
  })

  /** 把一个设计导出成 zip（带走 / 给同事 / 下学期再用） */
  r.get('/api/teacher/courses/:id/designs/:designId/zip', async (req, p, res) => {
    need(req, 'teacher')
    const c = designCourse(req, p.id)
    const q = new URL(req.url, 'http://x').searchParams
    const kind = q.get('kind') === 'project' ? 'project' : 'homework'
    const r = assignLib.exportDesign(c.id, kind, p.designId)
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': r.buffer.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(r.filename),
      'Cache-Control': 'no-store',
    })
    res.end(r.buffer)
  })

  /** 从库里删掉一个设计（已经建出来的作业不受影响，它有自己的副本） */
  r.del('/api/teacher/courses/:id/designs/:designId', async (req, p) => {
    need(req, 'teacher')
    const c = designCourse(req, p.id)
    const q = new URL(req.url, 'http://x').searchParams
    const kind = q.get('kind') === 'project' ? 'project' : 'homework'
    const okDel = assignLib.removeDesign(c.id, kind, p.designId)
    if (!okDel) throw new HttpError(404, '这个设计不在库里')
    return { ok: true }
  })

  /** 批阅一览：谁交了、谁没交、批了几个（课堂作业与大作业共用） */
  r.get('/api/teacher/assignments/:id/progress', async (req, p) => {
    need(req, 'teacher')
    const a = getAssignment(p.id)
    const cls = db.listClassesOf(a.courseId || '')
    const subs = db.submissionsOf(a.id)
    const bySid = new Map()
    for (const sub of subs) {
      const key = sub.classId + ':' + sub.sid
      const prev = bySid.get(key)
      if (!prev || String(sub.createdAt) > String(prev.createdAt)) bySid.set(key, sub)
    }
    const rows = []
    const missing = []
    let graded = 0
    for (const c of cls) {
      for (const st of c.students || []) {
        const sub = bySid.get(c.id + ':' + st.sid) || null
        const g = sub && (sub.grade || (sub.dims && Object.keys(sub.dims).length) || sub.score !== undefined)
        if (g) graded++
        if (!sub) missing.push({ classId: c.id, className: c.name, sid: st.sid, name: st.name })
        rows.push({
          classId: c.id,
          className: c.name,
          sid: st.sid,
          name: st.name,
          submitted: !!sub,
          submissionId: sub ? sub.id : '',
          late: !!(sub && sub.late),
          createdAt: sub ? sub.createdAt : '',
          graded: !!g,
          grade: sub ? sub.grade || '' : '',
          score: sub && sub.score !== undefined ? sub.score : null,
          comment: sub ? sub.comment || '' : '',
        })
      }
    }
    const studentCount = rows.length
    return {
      assignment: publicAssignment(a),
      studentCount,
      submitted: rows.filter((r) => r.submitted).length,
      graded,
      pending: rows.filter((r) => r.submitted && !r.graded).length,
      missing,
      rows,
    }
  })

  /* ---------------- 班级与名单的整体导入 / 导出 ----------------
   * 名单模板是一个班一份；新部署或换机器时要一个个班导。这里整门课打成一个 zip：
   * 一个 csv = 一个班，文件名就是班名。包里没有的班不会被删。
   */

  /** 导出整门课的班级与名单（zip） */
  r.get('/api/teacher/courses/:id/classes.zip', async (req, p, res) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const r = classIO.exportClasses(db, c)
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': r.buffer.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(r.filename),
      'Cache-Control': 'no-store',
    })
    res.end(r.buffer)
  })

  /** 空壳模板：一个示例班 + 说明 */
  r.get('/api/teacher/courses/:id/classes/template.zip', async (req, p, res) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const r = classIO.templateZip()
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': r.buffer.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(r.filename),
      'Cache-Control': 'no-store',
    })
    res.end(r.buffer)
  })

  /** 干跑：哪个班新建、每个班新增/改名/移出几个人 */
  r.post('/api/teacher/courses/:id/classes/inspect', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const buf = await readBuffer(req, 20 * 1024 * 1024)
    return classIO.plan(db, c, buf)
  })

  /** 真写：merge 只增不减 / replace 名单同步成包里的 */
  r.post('/api/teacher/courses/:id/classes/apply', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const q = new URL(req.url, 'http://x').searchParams
    const mode = q.get('mode') === 'replace' ? 'replace' : 'merge'
    const buf = await readBuffer(req, 20 * 1024 * 1024)
    return classIO.apply(db, c, buf, mode)
  })

  /* ---------------- 单个内容目录的导入 / 导出（讲义 / 材料 / 示例 / 试卷） ----------------
   * 课程管理只管整门课的课程包；这几个 tab 各自带一对「导出本页 / 导入本页」，
   * zip 里就是该目录的内容（根目录对根目录），不动课程信息、不动方案、不动名单。
   */

  /** 导出某个内容目录（zip） */
  r.get('/api/teacher/courses/:id/content.zip', async (req, p, res) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const q = new URL(req.url, 'http://x').searchParams
    const r = contentIO.exportDir(c, q.get('dir') || '')
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': r.buffer.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(r.filename),
      'Cache-Control': 'no-store',
    })
    res.end(r.buffer)
  })

  /** 该目录的空白模板（讲义 / 材料 / 示例 / 试卷各一份，新部署时照着改） */
  r.get('/api/teacher/courses/:id/content/template.zip', async (req, p, res) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const q = new URL(req.url, 'http://x').searchParams
    const r = contentIO.templateZip(q.get('dir') || '')
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': r.buffer.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(r.filename),
      'Cache-Control': 'no-store',
    })
    res.end(r.buffer)
  })

  /** 干跑：这个 zip 会新增 / 覆盖 / 保留哪些文件（不落盘） */
  r.post('/api/teacher/courses/:id/content/inspect', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const q = new URL(req.url, 'http://x').searchParams
    const buf = await readBuffer(req, 100 * 1024 * 1024)
    return contentIO.inspectDir(c, q.get('dir') || '', buf)
  })

  /** 真写：merge = 只增改，replace = 本地多出的进回收站 */
  r.post('/api/teacher/courses/:id/content/apply', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const q = new URL(req.url, 'http://x').searchParams
    const mode = q.get('mode') === 'replace' ? 'replace' : 'merge'
    const buf = await readBuffer(req, 100 * 1024 * 1024)
    return contentIO.applyDir(c, q.get('dir') || '', buf, mode)
  })

  /* ---------------- 课程内容在线管理 ---------------- */

  /** 列目录（path 省略 = 四个内容目录本身） */
  r.get('/api/teacher/courses/:id/files', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const q = new URL(req.url, 'http://x').searchParams
    return courseFiles.list(coursepack.contentRootOf(c), q.get('path') || '')
  })

  /** 读一个文本文件（≤512KB），给在线编辑用 */
  r.get('/api/teacher/courses/:id/files/text', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const q = new URL(req.url, 'http://x').searchParams
    return courseFiles.readText(coursepack.contentRootOf(c), q.get('path') || '')
  })

  /** 新建文件夹 */
  r.post('/api/teacher/courses/:id/files/mkdir', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const body = await readJson(req)
    return courseFiles.mkdir(coursepack.contentRootOf(c), body.path || '', body.name)
  })

  /** 保存文本（新建或覆盖） */
  r.post('/api/teacher/courses/:id/files/save', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const body = await readJson(req, 4 * 1024 * 1024)
    return courseFiles.writeText(coursepack.contentRootOf(c), body.path || '', body.text)
  })

  /** 上传一个文件：请求体是原始字节，?path=lecture/第01课/x.md */
  r.post('/api/teacher/courses/:id/files/upload', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const q = new URL(req.url, 'http://x').searchParams
    const root = coursepack.contentRootOf(c)
    const rel = q.get('path') || ''
    // 先落到临时文件（流式，不占内存），校验路径后再搬进内容目录
    const tmp = path.join(os.tmpdir(), 'ts-up-' + crypto.randomBytes(8).toString('hex'))
    try {
      const got = await readToFile(req, tmp, courseFiles.UPLOAD_MAX)
      if (!got.size) throw new HttpError(400, '上传内容为空')
      return courseFiles.moveIn(root, rel, tmp)
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch (e) {
        /* 已经搬走了 */
      }
    }
  })

  /** 改名 / 移动（给完整新名字，只换最后一段） */
  r.post('/api/teacher/courses/:id/files/rename', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const body = await readJson(req)
    return courseFiles.rename(coursepack.contentRootOf(c), body.from || '', body.to || '')
  })

  /** 删除（目录非空要带 recursive:true） */
  r.post('/api/teacher/courses/:id/files/delete', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const body = await readJson(req)
    return courseFiles.remove(coursepack.contentRootOf(c), body.path || '', !!body.recursive)
  })

  /** 浏览器兼容性兜底页要用：最低 Chrome 版本、有没有随系统放的绿色版 Chrome、找谁要（公开接口） */
  r.get('/api/compat', async () => compat.info())

  /** 下载空壳课程包模板（改完再导回来） */
  r.get('/api/teacher/courses/template.zip', async (req, p, res) => {
    need(req, 'teacher')
    const { filename, buffer } = coursepack.templatePack()
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': buffer.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
      'Cache-Control': 'no-store',
    })
    res.end(buffer)
  })

  /**
   * 导入课程包 · 第一步：干跑。
   * 请求体就是 zip 的原始字节（application/octet-stream），返回「会发生什么」，一个字节都不落盘。
   */
  r.post('/api/teacher/courses/import/inspect', async (req) => {
    need(req, 'teacher')
    return withUploadedZip(req, coursepack.LIMITS.packBytes, async (zipPath) => {
      const pkg = await coursepackImport.readPackage(zipPath)
      return coursepackImport.inspect(db, pkg)
    })
  })

  /**
   * 导入课程包 · 第二步：真正落盘。
   * ?strategy=merge|replace|fork（默认 merge）
   */
  r.post('/api/teacher/courses/import/apply', async (req) => {
    need(req, 'teacher')
    const q = new URL(req.url, 'http://x').searchParams
    const strategy = q.get('strategy') || 'merge'
    const schemeMode = q.get('schemeMode') || 'use'
    return withUploadedZip(req, coursepack.LIMITS.packBytes, async (zipPath) => {
      const pkg = await coursepackImport.readPackage(zipPath)
      const report = await coursepackImport.apply(db, pkg, { strategy, schemeMode })
      return { report, course: courseView(db.getCourse(report.courseId)) }
    })
  })

  /**
   * 导出课程包（zip）：course.json / scheme.json / classes/*.roster.csv / content/… + pack.json 清单。
   * 直接把二进制写回，不走 JSON 包装。
   */
  /** 导出前体检：多大 / 多少个文件 / 哪些文件超限没进包（不打包） */
  r.get('/api/teacher/courses/:id/package/summary', async (req, p) => {
    need(req, 'teacher')
    const q = new URL(req.url, 'http://x').searchParams
    const parts = String(q.get('parts') || '')
    const sum = coursepack.summary(db, p.id)
    // 不带内容时，体积与超限文件都不影响这次导出
    if (parts && parts.split(',').indexOf('content') < 0) {
      return Object.assign({}, sum, { files: 0, bytes: 0, mb: 0, skipped: [], overLimit: false })
    }
    return sum
  })

  r.get('/api/teacher/courses/:id/package.zip', async (req, p, res) => {
    need(req, 'teacher')
    // ?parts=scheme,classes,content 只打勾选的那几块（course.json 永远在）
    const q = new URL(req.url, 'http://x').searchParams
    const { filename, buffer } = coursepack.exportCourse(db, p.id, { parts: q.get('parts') || '' })
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': buffer.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
      'Cache-Control': 'no-store',
    })
    res.end(buffer)
  })

  /** 删课程：只允许删「还没产生任何记分」的课（建错了），有账的只能归档 */
  r.del('/api/teacher/courses/:id', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const classes = db.listClassesOf(c.id)
    const scored = classes.reduce((n, x) => n + eventsOf(x.id).length, 0)
    if (scored > 0) {
      throw new HttpError(409, '这门课已经有 ' + scored + ' 条记分记录，不能删除；请改用「归档」')
    }
    for (const cls of classes) {
      db.deleteClass(cls.id)
      submissions.removeClass(cls.id)
    }
    const root = coursepack.contentRootOf(c)
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch (e) {
      /* 内容目录可能不存在或被占用：忽略 */
    }
    // 顺带把空掉的上级目录（data/courses/<id>/）也删掉，别留一堆空壳
    try {
      fs.rmdirSync(path.dirname(root))
    } catch (e) {
      /* 里面还有别的东西就算了 */
    }
    const schemeId = c.schemeId || ''
    db.deleteCourse(c.id)
    // 这份方案如果已没有任何课程引用，就一并删掉，
    // 免得 data/schemes 里留下孤儿文件（自检 / 导入测试的残留就是这么来的）
    if (schemeId) {
      const stillUsed = db.listCourses().some((x) => (x.schemeId || '') === schemeId)
      if (!stillUsed) {
        try {
          fs.unlinkSync(path.join(config.dataDir, 'schemes', schemeId + '.json'))
        } catch (e) {
          /* 没有就算了 */
        }
      }
    }
    return { ok: true }
  })

  /**
   * 复制一门课（本地 fork，不走 zip）：下学期复用上学期那门课用。
   * 复制：课程字段 + 方案（另存到新 id）+ 整棵 content 目录；
   * 默认**不带**班级 / 名单 / 成绩（新学期的名单另导），要带上就 withClasses=true。
   */
  r.post('/api/teacher/courses/:id/duplicate', async (req, p) => {
    need(req, 'teacher')
    const src = db.getCourse(p.id)
    if (!src) throw new HttpError(404, '课程不存在')
    const body = await readJson(req)

    const name = String(body.name || '').trim().slice(0, 60) || src.name + ' 副本'
    let id = String(body.id || '').trim()
    if (id && !/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) {
      throw new HttpError(400, '课程 id 只能是 2–40 位小写字母 / 数字 / 短横线')
    }
    if (!id) {
      // 自动生成：<源 id>-2 / -3 …（不动源课程）
      let n = 2
      while (db.getCourse(src.id + '-' + n)) n++
      id = src.id + '-' + n
    }
    if (db.getCourse(id)) throw new HttpError(409, '课程 ' + id + ' 已存在，换个 id')

    // ① 方案：另存一份（版本从 1 起、变更日志清空），源方案不受影响
    let schemeId = ''
    const rawScheme = src.schemeId ? scoring.scheme.readRawById(src.schemeId) : null
    if (rawScheme) {
      const copy = Object.assign({}, JSON.parse(JSON.stringify(rawScheme)), {
        id,
        name,
        version: 1,
        changes: [],
        updatedAt: new Date().toISOString(),
      })
      scoring.scheme.saveAs(copy, id, '教师', '复制课程「' + src.name + '」')
      schemeId = id
    }

    // ② 课程记录
    const c = db.upsertCourse({
      id,
      name,
      note: src.note || '',
      semester: body.semester !== undefined ? String(body.semester).trim().slice(0, 20) : src.semester || '',
      schemeId,
      contentDir: coursepack.defaultContentDir(id),
      archived: false,
    })

    // ③ 内容目录整棵复制（讲义 / 材料 / 代码示例 / 试卷）
    const from = coursepack.contentRootOf(src)
    const to = coursepack.contentRootOf(c)
    fs.mkdirSync(to, { recursive: true })
    let files = 0
    const copyDir = (a, b) => {
      for (const it of fs.readdirSync(a, { withFileTypes: true })) {
        const sa = path.join(a, it.name)
        const sb = path.join(b, it.name)
        if (it.isDirectory()) {
          fs.mkdirSync(sb, { recursive: true })
          copyDir(sa, sb)
        } else if (it.isFile()) {
          fs.copyFileSync(sa, sb)
          files++
        }
      }
    }
    try {
      if (fs.existsSync(from)) copyDir(from, to)
    } catch (e) {
      throw new HttpError(500, '复制内容目录时出错：' + e.message)
    }
    for (const d of coursepack.CONTENT_ROOTS) fs.mkdirSync(path.join(to, d), { recursive: true })

    // ④ 可选：连班级与名单一起复制（成绩、作业提交不复制）
    let classes = 0
    let studentCount = 0
    if (body.withClasses) {
      for (const cls of db.listClassesOf(src.id)) {
        const nc = db.createClass(uid('c'), cls.name, id)
        nc.students = db.rosterOf(cls.id).map((x) => ({ sid: x.sid, name: x.name }))
        db.save()
        students.ensureMany(nc.id, nc.students)
        classes++
        studentCount += nc.students.length
      }
    }

    return { course: courseView(c), files, classes, students: studentCount }
  })

  r.patch('/api/teacher/courses/:id', async (req, p) => {
    need(req, 'teacher')
    const c = db.getCourse(p.id)
    if (!c) throw new HttpError(404, '课程不存在')
    const body = await readJson(req)
    const next = db.upsertCourse({
      id: c.id,
      name: body.name !== undefined ? String(body.name).trim().slice(0, 60) || c.name : c.name,
      note: body.note !== undefined ? String(body.note).slice(0, 500) : c.note,
      semester: body.semester !== undefined ? String(body.semester).trim().slice(0, 20) : c.semester,
      schemeId: body.schemeId !== undefined ? String(body.schemeId) : c.schemeId,
      archived: body.archived !== undefined ? !!body.archived : c.archived,
    })
    return { course: courseView(next) }
  })

  /* ---------------- 考核方案编辑（教师） ----------------
   * 老师端「考核方案」页：读原始 JSON → 改 → 试算对比 → 保存（版本 +1 + 变更日志）→ 结课归档。
   * 规则类型与参数表单由 RULES 的 schema 驱动，编辑器不需要为每条规则写一套界面。
   */

  /** 形态清单：编辑器里「采集形态」下拉用 */
  const FORMS = [
    { key: 'attendance', name: '考勤记录', hint: '起始满分按次加减' },
    { key: 'manual', name: '手动记分', hint: '互动 / 加分这类随手记' },
    { key: 'graded', name: '提交材料 + 等级批阅', hint: '作业 / 报告' },
    { key: 'rubric', name: '提交材料 + 量规批阅', hint: '大作业 / 课程设计' },
    { key: 'paper', name: '试卷 / 卷面分', hint: '机试、笔试' },
  ]

  r.get('/api/teacher/scheme', async (req) => {
    need(req, 'teacher')
    const cur = scoring.scheme.current()
    const file = cur.file || scoring.scheme.fileOf(scoring.scheme.DEFAULT_ID)
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      raw = null
    }
    const check = raw ? scoring.scheme.validate(raw) : { errors: ['方案文件读不出来：' + file], warnings: [] }
    return {
      raw,
      file,
      version: cur.version,
      errors: check.errors,
      warnings: check.warnings,
      forms: FORMS,
      rules: Object.keys(RULES).map((k) => ({
        type: RULES[k].type,
        name: RULES[k].name,
        desc: RULES[k].desc,
        schema: RULES[k].schema,
      })),
    }
  })

  r.patch('/api/teacher/scheme', async (req) => {
    const t = need(req, 'teacher')
    const body = await readJson(req, 2 * 1024 * 1024)
    const raw = body.raw || body
    let saved
    try {
      saved = scoring.scheme.save(raw, t.name || '教师', body.note)
    } catch (e) {
      if (e.errors) throw new HttpError(400, e.message)
      throw e
    }
    return {
      ok: true,
      version: saved.raw.version,
      warnings: saved.warnings,
      change: saved.raw.changes[saved.raw.changes.length - 1],
    }
  })

  /** 下载当前方案（原样 scheme.json，可跨机器 / 跨课程复用） */
  r.get('/api/teacher/scheme/export.json', async (req, p, res) => {
    need(req, 'teacher')
    const cur = schemeIO.currentRaw()
    const body = Buffer.from(JSON.stringify(cur.raw, null, 2) + '\n', 'utf8')
    const name = 'scheme_' + String(cur.id || 'scheme') + '_v' + cur.version + '.json'
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  })

  /** 导入方案 · 第一步：干跑（只算差异，不写盘） */
  r.post('/api/teacher/scheme/inspect', async (req) => {
    need(req, 'teacher')
    const body = await readJson(req, 2 * 1024 * 1024)
    const raw = body.raw || body.scheme || body
    if (!raw || typeof raw !== 'object') throw new HttpError(400, '文件内容不是一个方案对象')
    return schemeIO.inspect(raw)
  })

  /** 导入方案 · 第二步：按模式落盘（use 覆盖 / keep 不动 / copy 另存） */
  r.post('/api/teacher/scheme/apply', async (req) => {
    const t = need(req, 'teacher')
    const mode = new URL(req.url, 'http://x').searchParams.get('mode') || 'use'
    const body = await readJson(req, 2 * 1024 * 1024)
    const raw = body.raw || body.scheme || body
    if (!raw || typeof raw !== 'object') throw new HttpError(400, '文件内容不是一个方案对象')
    return schemeIO.apply(raw, { mode, by: t.name || '教师' })
  })

  /** 试算：拿草稿方案跟当前方案各算一遍全班，给出平均分/及格率/变化最大的人 */
  r.post('/api/teacher/scheme/preview', async (req) => {
    need(req, 'teacher')
    const body = await readJson(req, 2 * 1024 * 1024)
    const c = getClass(String(body.classId || ''))
    const cur = scoring.scheme.current()
    const draft = scoring.scheme.materialize(body.raw || cur)
    const events = eventsOf(c.id)
    const before = scoring.computeClassWith(cur.items, cur.cap, cur.passLine, c.students, events)
    const after = scoring.computeClassWith(draft.items, draft.cap, draft.passLine, c.students, events)
    const moves = after.list
      .map((r, i) => ({
        sid: r.student.sid,
        name: r.student.name,
        before: before.list[i].total,
        after: r.total,
        delta: scoring.round1(r.total - before.list[i].total),
      }))
      .filter((x) => Math.abs(x.delta) > 0.05)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 12)
    return {
      count: c.students.length,
      className: c.name,
      before: { avg: before.totalAvg, passRate: before.passRate },
      after: { avg: after.totalAvg, passRate: after.passRate },
      moves,
    }
  })

  /** 结课归档：把「当前方案 + 全班总评」冻成一份 json + csv，之后方案再改也不影响这份档 */
  r.post('/api/teacher/scheme/archive', async (req) => {
    need(req, 'teacher')
    const body = await readJson(req)
    const c = getClass(String(body.classId || ''))
    const cur = scoring.scheme.current()
    const events = eventsOf(c.id)
    const board = scoring.computeClass(c.students, events)
    const dir = path.join(config.dataDir, 'archive')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const base = cur.id + '-' + c.id + '-' + stamp
    const jsonFile = path.join(dir, base + '.json')
    const payload = {
      archivedAt: new Date().toISOString(),
      scheme: { id: cur.id, name: cur.name, version: cur.version, totalFull: cur.totalFull, passLine: cur.passLine, items: cur.items },
      class: { id: c.id, name: c.name, count: c.students.length },
      students: board.list.map((r) => ({
        sid: r.student.sid,
        name: r.student.name,
        items: r.rows.map((x) => ({ key: x.item.key, name: x.item.name, full: x.item.full, score: x.score })),
        total: r.total,
      })),
      summary: { avg: board.totalAvg, passRate: board.passRate },
    }
    fs.writeFileSync(jsonFile, JSON.stringify(payload, null, 2), 'utf8')

    const head = ['学号', '姓名'].concat(cur.items.map((i) => i.name + '(' + i.full + ')')).concat(['总评'])
    const rows = [head].concat(
      board.list.map((r) =>
        [r.student.sid, r.student.name]
          .concat(cur.items.map((it) => (r.rows.find((x) => x.item.key === it.key) || {}).score || 0))
          .concat([r.total])
      )
    )
    const csvFile = path.join(dir, base + '.csv')
    fs.writeFileSync(csvFile, '\ufeff' + stringifyGrid(rows), 'utf8')
    return { ok: true, dir, json: path.basename(jsonFile), csv: path.basename(csvFile), count: c.students.length }
  })

  /* 教师端：作业列表（含提交计数，够画「已交 n / 共 m」） */
  r.get('/api/teacher/assignments', async (req) => {
    need(req, 'teacher')
    const dirs = examplesByDir(contentRoot(req, null))
    const classes = db.listClasses()
    const q = new URL(req.url, 'http://x').searchParams
    const wantItem = q.get('itemKey') || ''
    const wantKind = q.get('kind') || ''
    if (wantItem) assertModuleItem(wantItem)
    else if (wantKind) assertModule(wantKind)
    const course = currentCourse(req, null)
    const assignments = db
      .listAssignments()
      // 当前课程 + 一个模块 = 一个考核项：按 itemKey 过滤（老调用还在传 kind，也认）
      .filter((a) => (course ? a.courseId === course.id || !a.courseId : true))
      .filter((a) => (wantItem ? a.itemKey === wantItem : true))
      .filter((a) => (!wantItem && wantKind ? (a.kind === 'project' ? 'project' : 'work') === wantKind : true))
      .map((a) => {
        const subs = db.submissionsOf(a.id)
        const sids = new Set(subs.map((s) => s.sid))
        return Object.assign(publicAssignment(a, dirs), {
          submissionCount: subs.length,
          studentCount: sids.size,
          gradedCount: subs.filter((s) => typeof s.score === 'number').length,
          latestAt: subs.length ? subs[subs.length - 1].createdAt : '',
        })
      })
    return {
      assignments,
      dirs: content.listExamples().map((x) => ({ dir: x.dir, title: x.title, no: x.no, fileCount: x.fileCount })),
      classes: classes.map(publicClass),
    }
  })

  r.post('/api/teacher/assignments', async (req) => {
    need(req, 'teacher')
    const body = await readJson(req)
    // itemKey 决定一切：是不是模块、交代码还是交材料、进哪个计分项。
    // 老调用只传 kind：优先按同名考核项找（work→homework、project→project），找不到再按提交方式兜底
    const wantKey = String(body.itemKey || '')
    const legacyKey = body.kind === 'project' ? 'project' : 'homework'
    const item = (wantKey && moduleOfItem(wantKey)) || moduleOfItem(legacyKey) || moduleOfKind(body.kind === 'project' ? 'project' : 'work')
    if (!item) throw new HttpError(403, '这个模块在考核方案里没有启用（data/schemes 里把 module.enabled 打开就好）')
    const kind = kindOfModule(item)
    const title0 = String(body.title || '').trim().slice(0, 60)
    const id = uid('a')
    let dir = ''
    let title = title0
    const courseId = (currentCourse(req, null) || {}).id || ''
    const designId = String(body.designId || '').trim()

    if (submitOf(item) === 'code') {
      // 课堂作业自带起手代码（不再借用「代码示例/第NN课」）：
      //   ① 传 designId → 用作业库里的那个设计（复制它的 code/，套用它的定义）
      //   ② 传 fromExample → 复制某一课示例当起点
      //   ③ 都没传 → 一份空白三件套
      const from = String(body.fromExample || '').trim()
      if (designId) {
        const design = assignLib.listDesigns(courseId, 'homework').find((d) => d.id === designId)
        if (!design) throw new HttpError(404, '作业库里没有这个设计：' + designId)
        const srcCode = path.join(assignLib.designDir(courseId, 'homework', designId), 'code')
        if (!fs.existsSync(srcCode)) throw new HttpError(400, '这个设计里没有 code/ 目录')
        assignCode.copyFrom(id, srcCode)
        title = title0 || design.title
        // 设计里带的定义：没手动填的就跟着设计走
        if (body.weight === undefined) body.weight = design.weight
        if (body.note === undefined) body.note = design.note
        if (body.dueAt === undefined) body.dueAt = design.dueAt
        if (body.allowLate === undefined) body.allowLate = design.allowLate
      }
      if (!designId && from) {
        const root = contentRoot(req, null)
        const meta = examplesByDir(root).get(from)
        if (!meta) throw new HttpError(400, '要复制的示例目录不存在：' + from)
        assignCode.copyFrom(id, path.join(root, '代码示例', from))
        title = title0 || meta.title
      }
      if (!designId && !from) {
        assignCode.writeBlank(id)
      }
      title = title || (item.module && item.module.title) || item.name
      dir = '@a:' + id // 虚拟目录：/api/examples/@a:<id> 会读这份作业自己的代码
    } else {
      title = title0 || (item.module && item.module.title) || item.name
      // 大作业：从设计里带题目/要求/权重/截止（没手填的才跟着设计走）
      if (designId) {
        const design = assignLib.listDesigns(courseId, 'project').find((d) => d.id === designId)
        if (!design) throw new HttpError(404, '作业库里没有这个设计：' + designId)
        title = title0 || design.title
        if (body.weight === undefined) body.weight = design.weight
        if (body.note === undefined) body.note = design.note
        if (body.dueAt === undefined) body.dueAt = design.dueAt
        if (body.allowLate === undefined) body.allowLate = design.allowLate
      }
    }
    const a = db.createAssignment({
      id,
      designId,
      courseId,
      kind,
      itemKey: item.key,
      weight: weightOf(body.weight),
      title,
      dir,
      note: String(body.note || '').slice(0, 500),
      dueAt: String(body.dueAt || '').trim(),
      allowLate: body.allowLate === undefined ? true : !!body.allowLate,
    })
    return { assignment: Object.assign(publicAssignment(a), { submissionCount: 0, studentCount: 0, gradedCount: 0 }) }
  })

  r.patch('/api/teacher/assignments/:id', async (req, p) => {
    need(req, 'teacher')
    const a = getAssignment(p.id)
    const body = await readJson(req)
    const patch = {}
    if (body.title !== undefined) patch.title = String(body.title).trim().slice(0, 60) || a.title
    if (body.note !== undefined) patch.note = String(body.note).slice(0, 500)
    if (body.dueAt !== undefined) patch.dueAt = String(body.dueAt || '').trim()
    if (body.allowLate !== undefined) patch.allowLate = !!body.allowLate
    if (body.dir !== undefined) {
      const dir = String(body.dir || '').trim()
      if (!examplesByDir().get(dir)) throw new HttpError(400, '代码示例目录不存在')
      patch.dir = dir
    }
    if (body.weight !== undefined) patch.weight = weightOf(body.weight)
    db.updateAssignment(a.id, patch)
    return { assignment: publicAssignment(a) }
  })

  r.del('/api/teacher/assignments/:id', async (req, p) => {
    need(req, 'teacher')
    const a = getAssignment(p.id)
    // 这次作业批过的分先作废，再删作业 —— 否则分数会挂在一条已经不存在的作业上
    const touched = new Map()
    for (const sub of db.submissionsOf(a.id)) {
      if (sub.eventId) {
        const ev = db.findEvent(sub.classId, sub.eventId)
        if (ev && !ev.voided) {
          ev.voided = true
          ev.voidedAt = new Date().toISOString()
          ev.voidedBy = '删除作业'
        }
      }
      touched.set(sub.classId + ':' + sub.sid, { classId: sub.classId, sid: sub.sid })
    }
    assignCode.removeCode(a.id)
    db.deleteAssignment(a.id)
    // 受影响的同学，记分表重写一遍
    for (const it of touched.values()) {
      const c0 = db.getClass(it.classId)
      const stu0 = c0 ? c0.students.find((x) => x.sid === it.sid) : null
      if (c0 && stu0) students.writeScoreSheet(c0, stu0, eventsOf(c0.id))
    }
    // 连磁盘上的学生材料一起清掉（课堂作业正文 / 大作业附件 / 机试答卷）
    const delItem = scoring.scheme.itemByKey(a.itemKey) || {}
    if (delItem.form === 'paper') {
      try {
        fs.unlinkSync(examLib.sourceFile(a.id))
      } catch (e) {
        /* 没导过卷子就没有这个文件 */
      }
      // 试卷 / 答案卷那几份纸也一起清掉
      try {
        fs.rmdirSync(paperDirOf(a.id), { recursive: true })
      } catch (e) {
        /* 没有这个目录就算了 */
      }
      // 机试答卷在每个学生的「机试/<作业id>/」下
      for (const c of db.listClasses()) {
        for (const s of c.students) {
          submissions.removeStudentAssignment('exam', c.id, s.sid, a.id)
        }
      }
    } else if (submitOf(delItem) === 'files') submissions.removeProjectAssignment(a.id)
    else submissions.removeAssignment(a.id)
    return { ok: true }
  })

  r.post('/api/teacher/assignments/:id/start', async (req, p) => {
    need(req, 'teacher')
    const a = getAssignment(p.id)
    db.updateAssignment(a.id, { status: 'open', openedAt: new Date().toISOString() })
    const delivered = broadcastAssignment('open', a)
    return { assignment: publicAssignment(a), delivered }
  })

  r.post('/api/teacher/assignments/:id/stop', async (req, p) => {
    need(req, 'teacher')
    const a = getAssignment(p.id)
    db.updateAssignment(a.id, { status: 'closed', closedAt: new Date().toISOString() })
    const delivered = broadcastAssignment('close', a)
    return { assignment: publicAssignment(a), delivered }
  })

  /** 教师端看某次作业：提交清单（时间正序）+ 统计 / 未交名单 */
  r.get('/api/teacher/assignments/:id', async (req, p) => {
    need(req, 'teacher')
    const a = getAssignment(p.id)
    const url = new URL(req.url, 'http://x')
    const classId = url.searchParams.get('classId') || ''
    const all = db.submissionsOf(a.id)
    const nameOfClass = new Map(db.listClasses().map((c) => [c.id, c.name]))
    const scope = classId ? all.filter((s) => s.classId === classId) : all

    // 未交名单按班级范围算：老师切到哪个班就只统计哪个班
    const classes = classId ? db.listClasses().filter((c) => c.id === classId) : db.listClasses()
    const submitted = new Set(scope.map((s) => s.sid))
    const missing = []
    let total = 0
    for (const c of classes) {
      for (const s of c.students) {
        total++
        if (!submitted.has(s.sid)) missing.push({ sid: s.sid, name: s.name, classId: c.id, className: c.name })
      }
    }

    return {
      assignment: publicAssignment(a),
      submissions: scope.map((s) => submissionView(s, nameOfClass.get(s.classId))),
      stats: {
        classId,
        rosterCount: total,
        submittedStudents: submitted.size,
        submissionCount: scope.length,
        gradedCount: scope.filter((s) => typeof s.score === 'number').length,
        missing,
      },
    }
  })

  /** 教师端看某一份提交的文件正文 */
  r.get('/api/teacher/assignments/:id/submissions/:sid', async (req, p) => {
    need(req, 'teacher')
    const a = getAssignment(p.id)
    const sub = db.findSubmission(a.id, p.sid)
    if (!sub) throw new HttpError(404, '提交记录不存在')
    // 大作业交的是附件，不读文本；老师走 /api/files/project/... 下载
    return {
      submission: submissionView(sub),
      files: submitOf(scoring.scheme.itemByKey(a.itemKey) || {}) === 'files'
        ? []
        : submissions.readFiles(sub.classId, sub.sid, a.id, sub.id, sub.files),
    }
  })

  /**
   * 批阅一份提交。**批阅即记分**：这一项在计分管理里没有记分入口，分数只能从这里进。
   * 判分方式由方案的规则决定，不是写死的 kind：
   *   rule=avg    → 判等级 A/B/C/X（可勾迟交）→ 均分折算
   *   rule=rubric → 按维度逐项打分 → 求和
   *   rule=raw    → 录卷面分 → ×系数（机试 / 笔试）
   * 改分 / 清分时先撤掉上一次那条账（eventId 存在提交记录上），再记新的一条 ——
   * 计分表始终「只追加 + 撤销」，不会两条同时生效。
   */
  /** 判分 + 记账（机试判卷、作业批阅、大作业量规都走这一段，保证记账只有一处） */
  function gradeSubmission(a, sub, t, body) {
    const c = db.getClass(sub.classId)
    const stu = c ? c.students.find((s) => s.sid === sub.sid) : null

    // 1) 撤掉上一条账
    function voidPrev() {
      if (!sub.eventId) return
      const old = c && db.findEvent(c.id, sub.eventId)
      if (old && !old.voided) {
        old.voided = true
        old.voidedAt = new Date().toISOString()
        old.voidedBy = '重新批阅'
      }
      sub.eventId = ''
    }

    // 这一项用哪条规则判分，由方案决定（同一个页面能批作业、大作业、机试）
    const item = scoring.scheme.itemByKey(a.itemKey) || scoring.scheme.itemByKey('homework')
    const mode = item ? item.rule.type : 'avg'
    const isRubric = mode === 'rubric'
    const isRaw = mode === 'raw'
    const clear = isRubric
      ? body.dims === '' || body.dims === null || body.dims === undefined
      : isRaw
        ? body.raw === '' || body.raw === null || body.raw === undefined
        : !body.grade
    let score
    let ev = null

    voidPrev()

    if (!clear) {
      ev = {
        id: uid('e'),
        classId: sub.classId,
        sid: sub.sid,
        item: item.key,
        reason: a.title,
        operator: t.name || '教师',
        createdAt: new Date().toISOString(),
        voided: false,
        evidence: [],
        weight: weightOf(body.weight === undefined ? a.weight : body.weight),
        schemeVersion: String(scoring.scheme.version()),
      }

      if (isRubric) {
        ev.dims = {}
        let sum = 0
        for (const d of item.dims) {
          const v = scoring.clamp(Number((body.dims || {})[d.key]) || 0, 0, d.full)
          ev.dims[d.key] = v
          sum += v
        }
        score = scoring.round1(sum)
      } else if (isRaw) {
        const raw = Number(body.raw)
        if (!isFinite(raw) || raw < 0 || raw > item.rawFull) {
          throw new HttpError(400, '卷面分应在 0–' + item.rawFull + ' 之间')
        }
        ev.raw = raw
        score = scoring.round1(scoring.clamp(raw * item.factor, 0, item.full))
      } else {
        const g = item.grades.find((x) => x.key === body.grade)
        if (!g) throw new HttpError(400, '等级不在方案的等级表里')
        ev.grade = g.key
        ev.late = !!body.late
        score = scoring.round1(100 * g.factor * (ev.late ? item.lateFactor : 1))
      }
      db.addEvent(ev)
    }

    if (c && stu) students.writeScoreSheet(c, stu, eventsOf(c.id)) // 给分或撤分都重写一次
    db.updateSubmission(a.id, sub.id, {
      score: clear ? undefined : score,
      comment: String(body.comment || '').slice(0, 1000),
      gradedAt: clear ? '' : new Date().toISOString(),
      gradedBy: clear ? '' : t.name || '教师',
      eventId: ev ? ev.id : '',
      grade: ev && ev.grade ? ev.grade : '',
      late: !!(ev && ev.late),
      raw: ev && typeof ev.raw === 'number' ? ev.raw : undefined,
      dims: ev && ev.dims ? ev.dims : undefined,
    })
    if (clear && c) db.save()
    return submissionView(sub)
  }

  r.post('/api/teacher/assignments/:id/submissions/:sid/grade', async (req, p) => {
    const t = need(req, 'teacher')
    const a = getAssignment(p.id)
    const sub = db.findSubmission(a.id, p.sid)
    if (!sub) throw new HttpError(404, '提交记录不存在')
    const body = await readJson(req)
    return { submission: gradeSubmission(a, sub, t, body) }
  })

  /** 打回重做：分数与评语清空、计分记录作废，学生就能再交一次 */
  r.post('/api/teacher/assignments/:id/submissions/:sid/redo', async (req, p) => {
    const t = need(req, 'teacher')
    const a = getAssignment(p.id)
    const sub = db.findSubmission(a.id, p.sid)
    if (!sub) throw new HttpError(404, '提交记录不存在')
    const item = scoring.scheme.itemByKey(a.itemKey) || {}
    const clear = item.rule && item.rule.type === 'rubric' ? { dims: '' } : item.rule && item.rule.type === 'raw' ? { raw: '' } : { grade: '' }
    clear.comment = '（打回重做）'
    const view = gradeSubmission(a, sub, t, clear)
    return { submission: view, message: '已打回：分数与评语清空，学生可以重新提交' }
  })

  /* ---------------- 评分证据（老师侧的佐证材料） ----------------
   * 证据挂在「这条提交对应的计分记录」上，所以要先给分；学生端看不到。
   * 文件本体进 data/uploads/，索引由 students.writeScoreSheet 写成该学生的 大作业/证据清单.csv
   */
  r.post('/api/teacher/assignments/:id/submissions/:sid/evidence', async (req, p) => {
    const t = need(req, 'teacher')
    const a = getAssignment(p.id)
    const sub = db.findSubmission(a.id, p.sid)
    if (!sub) throw new HttpError(404, '提交记录不存在')
    if (!sub.eventId) throw new HttpError(400, '先给分，再传证据（证据要挂在这次评分上）')
    const ev = db.findEvent(sub.classId, sub.eventId)
    if (!ev) throw new HttpError(404, '计分记录不存在（可能已被撤销，重新给一次分）')

    const body = await readJson(req, 12 * 1024 * 1024)
    const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(String(body.dataUrl || ''))
    if (!m) throw new HttpError(400, '文件格式不正确')
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length > 6 * 1024 * 1024) throw new HttpError(413, '单个证据文件不能超过 6MB')
    const safe = String(body.name || 'evidence').replace(/[\\/:*?"<>|]/g, '_').slice(-80)
    const stored = Date.now().toString(36) + '-' + safe
    fs.mkdirSync(config.uploadDir, { recursive: true })
    fs.writeFileSync(path.join(config.uploadDir, stored), buf)

    ev.evidence = (ev.evidence || []).concat([{ name: safe, stored, size: buf.length, by: t.name || '教师', at: new Date().toISOString() }])
    db.save()
    const c0 = db.getClass(sub.classId)
    const stu0 = c0 ? c0.students.find((x) => x.sid === sub.sid) : null
    if (c0 && stu0) students.writeScoreSheet(c0, stu0, eventsOf(c0.id))
    return { submission: submissionView(sub, c0 ? c0.name : '') }
  })

  r.del('/api/teacher/assignments/:id/submissions/:sid/evidence', async (req, p) => {
    const t = need(req, 'teacher')
    const a = getAssignment(p.id)
    const sub = db.findSubmission(a.id, p.sid)
    if (!sub) throw new HttpError(404, '提交记录不存在')
    const ev = sub.eventId ? db.findEvent(sub.classId, sub.eventId) : null
    if (!ev) throw new HttpError(404, '计分记录不存在')
    const q = new URL(req.url, 'http://x').searchParams
    const name = String(q.get('name') || '')
    const list = ev.evidence || []
    const idx = list.findIndex((x) => x.name === name || x.stored === name)
    if (idx < 0) throw new HttpError(404, '没有这条证据')
    const hit = list.splice(idx, 1)[0]
    db.save()
    // 文件挪进回收站，不直接删
    try {
      const from = path.join(config.uploadDir, hit.stored || '')
      const to = path.join(config.dataDir, '.trash', 'evidence', stampId(), hit.stored || 'x')
      if (hit.stored && fs.existsSync(from)) {
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.renameSync(from, to)
      }
    } catch (e) {
      /* 挪不动就算了，索引已经删了 */
    }
    const c1 = db.getClass(sub.classId)
    const stu1 = c1 ? c1.students.find((x) => x.sid === sub.sid) : null
    if (c1 && stu1) students.writeScoreSheet(c1, stu1, eventsOf(c1.id))
    return { submission: submissionView(sub, c1 ? c1.name : '') }
  })

  r.del('/api/teacher/assignments/:id/submissions/:sid', async (req, p) => {
    need(req, 'teacher')
    const a = getAssignment(p.id)
    const sub = db.findSubmission(a.id, p.sid)
    if (!sub) throw new HttpError(404, '提交记录不存在')
    // 删掉一条已批的提交，它记进计分表的那笔账也要撤掉，否则分数挂在一条不存在的作业上
    if (sub.eventId) {
      const ev = db.findEvent(sub.classId, sub.eventId)
      if (ev && !ev.voided) {
        ev.voided = true
        ev.voidedAt = new Date().toISOString()
        ev.voidedBy = '删除提交'
      }
    }
    db.deleteSubmission(a.id, sub.id)
    if (submitOf(scoring.scheme.itemByKey(a.itemKey) || {}) === 'files') submissions.removeProjectSubmission(sub.classId, sub.sid, a.id, sub.id)
    else submissions.removeSubmission(sub.classId, sub.sid, a.id, sub.id)
    return { ok: true }
  })

  /* 学生端：作业清单（含我自己的提交，别人的一个字都不给）
   * ?itemKey=xxx 只看某个模块；不传就给「交代码」的那个模块（课堂作业） */
  r.get('/api/student/assignments', async (req) => {
    const t = need(req, 'student')
    const dirs = examplesByDir(contentRoot(req, t))
    const q = new URL(req.url, 'http://x').searchParams
    const wantItem = q.get('itemKey') || ''
    const wantKind = q.get('kind') || ''
    if (wantItem) assertModuleItem(wantItem)
    else assertModule(wantKind === 'project' ? 'project' : 'work')
    const assignments = db
      .listAssignments()
      .filter((a) => (wantItem ? a.itemKey === wantItem : (a.kind === 'project' ? 'project' : 'work') === (wantKind === 'project' ? 'project' : 'work')))
      .map((a) => {
        const mine = db
          .submissionsOf(a.id)
          .filter((s) => s.sid === t.sid && s.classId === t.classId)
          .map((s) => submissionView(s))
        return Object.assign(publicAssignment(a, dirs), {
          mine,
          myLatest: mine.length ? mine[mine.length - 1] : null,
        })
      })
    return { assignments }
  })

  r.get('/api/student/assignments/:id', async (req, p) => {
    const t = need(req, 'student')
    const a = getAssignment(p.id)
    assertModuleItem(a.itemKey)
    const mine = db
      .submissionsOf(a.id)
      .filter((s) => s.sid === t.sid && s.classId === t.classId)
      .map((s) => submissionView(s))
    return {
      assignment: publicAssignment(a),
      mine,
      myLatest: mine.length ? mine[mine.length - 1] : null,
      canSubmit: a.status === 'open' && !(a.dueAt && Date.parse(a.dueAt) < Date.now() && a.allowLate === false),
      overDue: !!(a.dueAt && Date.parse(a.dueAt) < Date.now()),
    }
  })

  /** 学生回看自己交过的文件（老师批完之后想复习一下自己写的东西） */
  r.get('/api/student/assignments/:id/submissions/:sid', async (req, p) => {
    const t = need(req, 'student')
    const a = getAssignment(p.id)
    const sub = db.findSubmission(a.id, p.sid)
    if (!sub || sub.sid !== t.sid || sub.classId !== t.classId) throw new HttpError(404, '提交记录不存在')
    return {
      submission: submissionView(sub),
      files: submitOf(scoring.scheme.itemByKey(a.itemKey) || {}) === 'files'
        ? []
        : submissions.readFiles(sub.classId, sub.sid, a.id, sub.id, sub.files),
    }
  })

  /**
   * 交作业：交「整份文件」（改过的取改动，没动过的取原文），这样老师那边能直接跑起来看渲染。
   * changed 单独记一份：审阅时用来标出「他究竟动了哪几个」，也用来判断这次到底改没改东西。
   */
  r.post('/api/student/assignments/:id/submit', async (req, p) => {
    const t = need(req, 'student')
    const a = getAssignment(p.id)
    if (submitOf(scoring.scheme.itemByKey(a.itemKey) || {}) !== 'code') {
      throw new HttpError(400, '这个模块交的是材料，请到对应模块里提交')
    }
    assertModuleItem(a.itemKey)
    if (a.status !== 'open') {
      throw new HttpError(403, a.openedAt ? '这次课堂作业已经结束了，交不上了' : '老师还没开始这次课堂作业')
    }
    // 截止时间：过了截止仍然允许交（除非老师关掉「允许迟交」），但会自动标 late，
    // 方案里的 lateFactor 会据此打折 —— 这条链本来就是通的，只是以前没人写 late。
    const due = a.dueAt ? Date.parse(a.dueAt) : 0
    const overDue = due > 0 && Date.now() > due
    if (overDue && a.allowLate === false) {
      throw new HttpError(403, '这次作业已经截止，不接受迟交')
    }
    const body = await readJson(req, 16 * 1024 * 1024)
    const files = Array.isArray(body.files) ? body.files : []
    // 只保留最新一次提交：老提交进 .trash（可捞回），库里也只剩一条记录
    const previous = db
      .submissionsOf(a.id)
      .filter((x) => x.sid === t.sid && x.classId === t.classId)
    // 已经批过的不能被悄悄覆盖（否则老师的分数挂在一份已经不存在的提交上）
    if (previous.some((x) => isGraded(x))) {
      throw new HttpError(403, '老师已经批阅过这次作业了；想重做，请让老师在批阅里点「打回重做」')
    }
    for (const old of previous) {
      try {
        const from = submissions.subDir(old.classId, old.sid, a.id, old.id)
        const to = path.join(config.dataDir, '.trash', 'submissions', stampId(), a.id, old.sid, old.id)
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.renameSync(from, to)
      } catch (e) {
        /* 挪不动就留着，不打断学生提交 */
      }
      db.deleteSubmission(a.id, old.id)
    }
    const id = uid('sb')
    const written = submissions.writeFiles(t.classId, t.sid, a.id, id, files)
    // changed 只认「这次真交上来的路径」，防止前端塞一个不存在的文件名进去
    const sent = new Set(written.paths)
    const changed = (Array.isArray(body.changed) ? body.changed : [])
      .map((x) => submissions.normalizePath(x))
      .filter((x) => x && sent.has(x))
      .sort()
    const sub = {
      id,
      assignmentId: a.id,
      classId: t.classId,
      sid: t.sid,
      name: t.name,
      dir: a.dir,
      createdAt: new Date().toISOString(),
      files: written.paths,
      changed,
      late: overDue,
      score: undefined,
      comment: '',
      gradedAt: '',
      gradedBy: '',
    }
    db.addSubmission(sub)
    return {
      submission: submissionView(sub),
      count: db.submissionsOf(a.id).filter((s) => s.sid === t.sid && s.classId === t.classId).length,
    }
  })

  /* ---------------- 大作业（项目） ----------------
   * 跟课堂作业共用 assignments / submissions 两张表，靠 kind='project' 分开。
   * 交的东西不一样：大作业是「说明 + 链接 + 附件（源码包 / 截图 / PDF）」，
   * 附件落在 data/students/<班级>/<学号>/大作业/<作业 id>/<提交 id>/ 下。
   */

  r.post('/api/student/projects/:id/submit', async (req, p) => {
    const t = need(req, 'student')
    const a = getAssignment(p.id)
    if (submitOf(scoring.scheme.itemByKey(a.itemKey) || {}) !== 'files') {
      throw new HttpError(400, '这个模块交的是代码，请到对应模块里提交')
    }
    assertModuleItem(a.itemKey)
    if (a.status !== 'open') {
      throw new HttpError(403, a.openedAt ? '这次大作业已经截止了，交不上了' : '老师还没开始收这次大作业')
    }
    const due = a.dueAt ? Date.parse(a.dueAt) : 0
    const overDue = due > 0 && Date.now() > due
    if (overDue && a.allowLate === false) throw new HttpError(403, '这次大作业已经截止，不接受迟交')

    const body = await readJson(req, 24 * 1024 * 1024)
    const note = String(body.note || '').trim().slice(0, 2000)
    const url = String(body.url || '').trim().slice(0, 500)
    const files = Array.isArray(body.files) ? body.files : []

    // 大作业的硬约束（作业级可配，默认来自设计包）：附件必填、链接可选、只认这几种文件
    const design = a.designId ? assignLib.listDesigns(a.courseId || '', 'project').find((d) => d.id === a.designId) : null
    const requireFile = design ? design.requireFile : true
    const requireUrl = design ? design.requireUrl : false
    const allow = (design && design.attachments && design.attachments.length ? design.attachments : ['zip', 'pdf', 'md', 'png', 'mp4', 'pptx']).map((x) => String(x).toLowerCase())
    if (requireFile && !files.length) throw new HttpError(400, '这次大作业必须交附件（代码包 .zip 或讲解文档）')
    if (requireUrl && !url) throw new HttpError(400, '这次大作业必须填一个链接（部署地址或仓库）')
    if (!files.length && !url) throw new HttpError(400, '附件与链接至少要有一项')
    for (const f of files) {
      const name = String((f && f.name) || '')
      const ext = (name.split('.').pop() || '').toLowerCase()
      if (allow.length && allow.indexOf(ext) < 0) {
        throw new HttpError(400, '不收 .' + ext + ' 类型的附件（这次允许：' + allow.map((x) => '.' + x).join(' ') + '）')
      }
    }
    if (files.length > 10) throw new HttpError(400, '附件最多 10 个')

    // 只保留最新一次：老提交（含附件）挪进 .trash
    const previous = db.submissionsOf(a.id).filter((x) => x.sid === t.sid && x.classId === t.classId)
    if (previous.some((x) => isGraded(x))) {
      throw new HttpError(403, '老师已经批阅过这次大作业了；想重做，请让老师在批阅里点「打回重做」')
    }
    for (const old of previous) {
      try {
        const from = submissions.projectDir(old.classId, old.sid, a.id, old.id)
        const to = path.join(config.dataDir, '.trash', 'submissions', stampId(), a.id, old.sid, old.id)
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.renameSync(from, to)
      } catch (e) {
        /* 挪不动就留着 */
      }
      db.deleteSubmission(a.id, old.id)
    }

    const id = uid('sb')
    const written = submissions.writeAttachments(t.classId, t.sid, a.id, id, files)
    const sub = {
      id,
      assignmentId: a.id,
      classId: t.classId,
      sid: t.sid,
      name: t.name,
      dir: '',
      createdAt: new Date().toISOString(),
      files: written.names,
      changed: [],
      note,
      url,
      late: overDue,
      score: undefined,
      comment: '',
      gradedAt: '',
      gradedBy: '',
    }
    db.addSubmission(sub)
    return {
      submission: submissionView(sub),
      count: db.submissionsOf(a.id).filter((s) => s.sid === t.sid && s.classId === t.classId).length,
    }
  })

  /** 下载模块附件：老师随时能下，学生只能下自己那份（<a href> 上带不了令牌，前端用 fetch+blob） */
  async function sendAttachment(req, p, res) {
    const t = need(req)
    const a = getAssignment(p.aid)
    if (submitOf(scoring.scheme.itemByKey(a.itemKey) || {}) !== 'files') throw new HttpError(404, '文件不存在')
    const sub = db.findSubmission(a.id, p.sid)
    if (!sub) throw new HttpError(404, '提交记录不存在')
    const mine = sub.sid === t.sid && sub.classId === t.classId
    if (t.role !== 'teacher' && !(t.role === 'student' && mine)) throw new HttpError(403, '无权查看这个文件')
    const file = submissions.attachmentPath(sub.classId, sub.sid, a.id, sub.id, p.name)
    if (!file) throw new HttpError(404, '文件不存在')
    sendFile(res, file, { cache: 'public, max-age=86400' })
    return undefined
  }

  /** 评分证据（老师侧材料）：必须带教师令牌，学生一律 403 */
  async function sendEvidence(req, p, res) {
    const t = need(req, 'teacher')
    const a = getAssignment(p.aid)
    const sub = db.findSubmission(a.id, p.sid)
    if (!sub) throw new HttpError(404, '提交记录不存在')
    const ev = sub.eventId ? db.findEvent(sub.classId, sub.eventId) : null
    const hit = ev && (ev.evidence || []).find((x) => x.name === p.name)
    if (!hit || !hit.stored) throw new HttpError(404, '这条证据不存在（可能已被删除）')
    const file = path.join(config.uploadDir, hit.stored)
    if (!file.startsWith(config.uploadDir + path.sep) || !fs.existsSync(file)) throw new HttpError(404, '证据文件不在了')
    sendFile(res, file, { cache: 'private, max-age=300', download: hit.name })
    return undefined
  }

  r.get('/api/files/evidence/:aid/:sid/:name', sendEvidence)

  // 新路径按「作业」走；老路径 /api/files/project/... 保留，已经贴出去的链接不会失效
  r.get('/api/files/assignments/:aid/:sid/:name', sendAttachment)
  r.get('/api/files/project/:aid/:sid/:name', sendAttachment)

  /* ---------------- 机试（试卷 / 题库 / 判卷 ----------------
   * 两种卷：kind=paper 统一卷、kind=bank 题库随机卷（按「作业 + 学号」定种子，重进同一份）。
   * 老师交一份 JSON（格式见 lib/exam.js 顶部与 data/exams/_template.json），系统负责：
   *   导入校验 → 给每个学生出卷 → 收答案 → 客观题自动判 / 主观题老师判 → 落计分表 → 出答卷文件。
   */
  const examLib = require('../lib/exam')

  /** 这一份作业必须是「试卷」形态的考核项 */
  function examItemOf(a) {
    const item = scoring.scheme.itemByKey(a.itemKey)
    if (!item || item.form !== 'paper') throw new HttpError(400, '这次作业的考核项不是「试卷」形态')
    return item
  }

  function loadExam(a) {
    const raw = examLib.readJson(examLib.sourceFile(a.id), null)
    if (!raw) throw new HttpError(404, '还没有导入试卷 / 题库')
    return examLib.normalize(raw)
  }

  function examState(a, sub) {
    const file = path.join(examLib.examDir(sub.classId, sub.sid, a.id, sub.id), 'exam.json')
    return { file, state: examLib.readJson(file, null) }
  }

  /** 这门课的名字（卷头要写） */
  function courseNameOf(classId) {
    const c = classId ? db.getClass(classId) : null
    const course = c && c.courseId ? db.getCourse(c.courseId) : null
    return course ? course.name : ''
  }

  /** 卷面的上下文（课程 / 学生 / 卷子 / 作答 / 得分），三种出纸共用 */
  function paperCtx(a, sub, state, comment) {
    const c = sub ? db.getClass(sub.classId) : null
    const found = c && sub ? c.students.find((s) => s.sid === sub.sid) : null
    return {
      course: (db.getCourse(a.courseId) || {}).name || courseNameOf(sub && sub.classId) || '',
      student: sub
        ? { sid: sub.sid, name: found ? found.name : sub.name, className: c ? c.name : '' }
        : null,
      assignment: a,
      paper: state.paper,
      answers: state.answers || {},
      graded: state.graded || null,
      gradedAt: (state.graded && state.graded.at) || '',
      comment: comment === undefined ? (sub ? sub.comment : '') : comment,
    }
  }

  /**
   * 写这份答卷的三个文件（都在学生自己的目录里）：
   *   exam.json  机器读：卷子 + 学生答案 + 逐题得分
   *   答卷.md    人看：卷头 + 每题作答 + 对错 + 得分 + 合计（像真卷子）
   *   答卷.html  打印版（A4，Ctrl+P 直接出卷）
   */
  function writeExamFiles(a, sub, state, comment) {
    const dir = examLib.examDir(sub.classId, sub.sid, a.id, sub.id)
    examLib.writeJson(path.join(dir, 'exam.json'), state)
    if (!state.graded) return
    const ctx = paperCtx(a, sub, state, comment)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '答卷.md'), examLib.renderReport(ctx), 'utf8')
    fs.writeFileSync(path.join(dir, '答卷.html'), examLib.renderHtml(ctx), 'utf8')
  }

  /** 试卷目录：data/exams/<作业id>/ —— 空白卷与答案卷放这儿 */
  function paperDirOf(assignmentId) {
    return path.join(config.dataDir, 'exams', String(assignmentId).replace(/[^A-Za-z0-9_.-]/g, '_'))
  }

  /** 导入后立刻出「试卷」「答案卷」各一份 md + html，老师随时打印 */
  function writePaperFiles(a, exam) {
    const dir = paperDirOf(a.id)
    fs.mkdirSync(dir, { recursive: true })
    const paper = examLib.printPaper(exam, a.id)
    const base = { course: (db.getCourse(a.courseId) || {}).name || '', assignment: a, paper, student: null, answers: {}, graded: null, gradedAt: '', comment: '' }
    fs.writeFileSync(path.join(dir, '试卷.md'), examLib.renderPaperMd(Object.assign({}, base, { withAnswer: false })), 'utf8')
    fs.writeFileSync(path.join(dir, '试卷.html'), examLib.renderHtml(Object.assign({}, base, { withAnswer: false })), 'utf8')
    fs.writeFileSync(path.join(dir, '答案卷.md'), examLib.renderPaperMd(Object.assign({}, base, { withAnswer: true })), 'utf8')
    fs.writeFileSync(path.join(dir, '答案卷.html'), examLib.renderHtml(Object.assign({}, base, { withAnswer: true })), 'utf8')
    return dir
  }

  /** 直接把一份卷子（或答卷）吐给浏览器：inline 显示，另存/打印都行 */
  function sendPaper(res, body, fmt, name) {
    const isMd = fmt === 'md'
    const ext = isMd ? '.md' : '.html'
    const raw = String(name || 'paper') + ext
    // HTTP 头里不能出现中文：ASCII 兜底，中文名放 filename*（RFC 5987）
    const ascii = raw.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '')
    res.writeHead(200, {
      'Content-Type': isMd ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
      'Content-Disposition': 'inline; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(raw),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  /** 老师导入试卷 / 题库（JSON） */
  r.post('/api/teacher/exams/:id/paper', async (req, p) => {
    need(req, 'teacher')
    const a = getAssignment(p.id)
    examItemOf(a)
    const body = await readJson(req, 4 * 1024 * 1024)
    const norm = examLib.normalize(body.source || body)
    const check = examLib.validate(norm)
    if (check.errors.length) throw new HttpError(400, check.errors.join('；'))
    examLib.writeJson(examLib.sourceFile(a.id), body.source || body)
    const paperDir = writePaperFiles(a, norm)
    return {
      ok: true,
      paperDir,
      warnings: check.warnings,
      summary: {
        kind: norm.kind,
        title: norm.title,
        duration: norm.duration,
        fullScore: norm.fullScore,
        sections: norm.sections.map((s) => ({
          id: s.id,
          title: s.title,
          type: s.type,
          typeName: examLib.TYPE_NAME[s.type],
          score: s.score,
          pick: s.pick,
          count: s.questions.length,
        })),
      },
    }
  })

  /** 老师看这一场：试卷摘要 + 每个学生的进度与得分 */
  r.get('/api/teacher/exams/:id', async (req, p) => {
    need(req, 'teacher')
    const a = getAssignment(p.id)
    examItemOf(a)
    const raw = examLib.readJson(examLib.sourceFile(a.id), null)
    const subs = db.submissionsOf(a.id)
    const rows = subs.map((s) => {
      const { state } = examState(a, s)
      return {
        submissionId: s.id,
        sid: s.sid,
        name: s.name,
        classId: s.classId,
        startedAt: (state && state.startedAt) || s.createdAt,
        submittedAt: (state && state.submittedAt) || '',
        answered: state && state.answers ? Object.keys(state.answers).length : 0,
        itemCount: state && state.paper ? state.paper.sections.reduce((n, x) => n + x.questions.length, 0) : 0,
        autoScore: state && state.graded ? state.graded.autoScore : null,
        manualScore: state && state.graded ? state.graded.manualScore : null,
        total: state && state.graded ? state.graded.total : null,
        score: typeof s.score === 'number' ? s.score : null,
        comment: s.comment || '',
      }
    })
    return {
      assignment: publicAssignment(a),
      paper: raw
        ? {
            kind: raw.kind === 'bank' ? 'bank' : 'paper',
            title: raw.kind ? raw.title : examLib.normalize(raw).title,
            duration: examLib.normalize(raw).duration,
            fullScore: examLib.normalize(raw).fullScore,
            sections: examLib.normalize(raw).sections.map((s) => ({
              title: s.title,
              type: s.type,
              typeName: examLib.TYPE_NAME[s.type],
              score: s.score,
              pick: s.pick,
              count: s.questions.length,
            })),
          }
        : null,
      rows,
    }
  })

  /** 试卷：老师预览或打印（?answers=1 是答案卷） */
  r.get('/api/teacher/exams/:id/paper-file/:fmt', async (req, p, res) => {
    need(req, 'teacher')
    const a = getAssignment(p.id)
    examItemOf(a)
    const exam = examLib.printPaper(loadExam(a), a.id)
    const withAnswer = new URL(req.url, 'http://x').searchParams.get('answers') === '1'
    const ctx = { course: (db.getCourse(a.courseId) || {}).name || '', assignment: a, paper: exam, student: null, answers: {}, graded: null, gradedAt: '', comment: '', withAnswer }
    const fmt = p.fmt === 'md' ? 'md' : 'html'
    sendPaper(res, fmt === 'md' ? examLib.renderPaperMd(ctx) : examLib.renderHtml(ctx), fmt, withAnswer ? 'answer-paper' : 'paper')
    return undefined
  })

  /** 学生的答卷（打印版）：老师随时能看能打，学生只能看自己那份 */
  async function sendAnswerSheet(req, p, res, t) {
    const a = getAssignment(p.aid || p.id)
    if (!a) throw new HttpError(404, '作业不存在')
    let sub
    if (p.subId) {
      sub = db.findSubmission(a.id, p.subId)
    } else {
      const mine = db.submissionsOf(a.id).filter((s) => s.sid === t.sid && s.classId === t.classId)
      sub = mine[mine.length - 1]
    }
    if (!sub) throw new HttpError(404, '还没有答卷')
    if (t.role === 'student' && (sub.sid !== t.sid || sub.classId !== t.classId)) {
      throw new HttpError(403, '只能看自己的答卷')
    }
    const { state } = examState(a, sub)
    if (!state) throw new HttpError(404, '这个学生还没开始考试')
    const ctx = paperCtx(a, sub, state)
    if (!ctx.graded) throw new HttpError(400, '还没判分，答卷等老师判完再看')
    const fmt = p.fmt === 'md' ? 'md' : 'html'
    sendPaper(res, fmt === 'md' ? examLib.renderReport(ctx) : examLib.renderHtml(ctx), fmt, sub.sid + '-答卷')
    return undefined
  }

  r.get('/api/teacher/exams/:id/submissions/:subId/paper-file/:fmt', async (req, p, res) => {
    const t = need(req, 'teacher')
    await sendAnswerSheet(req, p, res, t)
    return undefined
  })

  /** 学生看自己的答卷（判完才有） */
  r.get('/api/student/exams/:id/paper-file/:fmt', async (req, p, res) => {
    const t = need(req, 'student')
    await sendAnswerSheet(req, p, res, t)
    return undefined
  })

  /** 老师看某一份答卷（含学生答案与逐题得分） */
  r.get('/api/teacher/exams/:id/submissions/:subId', async (req, p) => {
    need(req, 'teacher')
    const a = getAssignment(p.id)
    const sub = db.findSubmission(a.id, p.subId)
    if (!sub) throw new HttpError(404, '提交记录不存在')
    const { state } = examState(a, sub)
    if (!state) throw new HttpError(404, '这个学生还没开始考试')
    return {
      submission: submissionView(sub),
      paper: state.paper,
      answers: state.answers || {},
      graded: state.graded || null,
      startedAt: state.startedAt,
      submittedAt: state.submittedAt,
    }
  })

  /** 老师判卷：主观题给分 → 总分自动算 → 记进计分表 → 重新出答卷文件 */
  r.post('/api/teacher/exams/:id/submissions/:subId/grade', async (req, p) => {
    const t = need(req, 'teacher')
    const a = getAssignment(p.id)
    const item = examItemOf(a)
    const sub = db.findSubmission(a.id, p.subId)
    if (!sub) throw new HttpError(404, '提交记录不存在')
    const body = await readJson(req)
    const ref = examState(a, sub)
    if (!ref.state) throw new HttpError(404, '这个学生还没开始考试')

    const graded = examLib.autoGrade(ref.state.paper, ref.state.answers || {}, body.scores || {})
    graded.at = new Date().toISOString()
    ref.state.graded = graded
    ref.state.submittedAt = ref.state.submittedAt || graded.at
    writeExamFiles(a, sub, ref.state, body.comment)

    // 卷面总分落进计分表（规则是 raw：卷面分 × 系数）
    const saved = gradeSubmission(a, sub, t, {
      raw: graded.total,
      comment: body.comment,
    })
    return { submission: saved, graded, fullScore: ref.state.paper.fullScore, ruleFull: item.rawFull }
  })

  /* ---- 学生端 ---- */

  /** 开考：没有就按种子出一份卷，有就接着答（同一个学生永远同一份） */
  function ensureExamSubmission(a, t) {
    const mine = db
      .submissionsOf(a.id)
      .filter((s) => s.sid === t.sid && s.classId === t.classId)
    let sub = mine[mine.length - 1] || null
    if (sub) {
      const ref = examState(a, sub)
      if (ref.state) return { sub, state: ref.state }
    }
    const exam = loadExam(a)
    const { paper } = examLib.paperFor(exam, a.id + ':' + t.sid)
    const id = uid('sb')
    sub = {
      id,
      assignmentId: a.id,
      classId: t.classId,
      sid: t.sid,
      name: t.name,
      dir: '',
      createdAt: new Date().toISOString(),
      files: [],
      changed: [],
      note: '',
      url: '',
      score: undefined,
      comment: '',
      gradedAt: '',
      gradedBy: '',
    }
    db.addSubmission(sub)
    const state = { paper, answers: {}, startedAt: new Date().toISOString(), submittedAt: '', graded: null }
    writeExamFiles(a, sub, state)
    return { sub, state }
  }

  function remainingOf(state) {
    if (!state.paper.duration) return null
    const end = new Date(state.startedAt).getTime() + state.paper.duration * 60000
    return Math.max(0, Math.round((end - Date.now()) / 1000))
  }

  r.post('/api/student/exams/:id/start', async (req, p) => {
    const t = need(req, 'student')
    const a = getAssignment(p.id)
    examItemOf(a)
    if (a.status !== 'open') {
      throw new HttpError(403, a.openedAt ? '这场机试已经结束了' : '老师还没开始这场机试')
    }
    const { sub, state } = ensureExamSubmission(a, t)
    return {
      submissionId: sub.id,
      paper: examLib.publicPaper(state.paper),
      answers: state.answers || {},
      startedAt: state.startedAt,
      submittedAt: state.submittedAt || '',
      remaining: remainingOf(state),
    }
  })

  r.get('/api/student/exams/:id/current', async (req, p) => {
    const t = need(req, 'student')
    const a = getAssignment(p.id)
    examItemOf(a)
    const mine = db.submissionsOf(a.id).filter((s) => s.sid === t.sid && s.classId === t.classId)
    const sub = mine[mine.length - 1]
    if (!sub) return { started: false }
    const { state } = examState(a, sub)
    if (!state) return { started: false }
    return {
      started: true,
      submissionId: sub.id,
      paper: examLib.publicPaper(state.paper),
      answers: state.answers || {},
      submittedAt: state.submittedAt || '',
      remaining: remainingOf(state),
      score: typeof sub.score === 'number' ? sub.score : null,
      comment: sub.comment || '',
    }
  })

  r.post('/api/student/exams/:id/answers', async (req, p) => {
    const t = need(req, 'student')
    const a = getAssignment(p.id)
    examItemOf(a)
    const body = await readJson(req, 2 * 1024 * 1024)
    const { sub, state } = ensureExamSubmission(a, t)
    if (state.submittedAt) throw new HttpError(400, '已经交卷了，不能再改')
    const left = remainingOf(state)
    if (left !== null && left <= 0) throw new HttpError(403, '考试时间到了，不能再作答')
    state.answers = Object.assign({}, state.answers, body.answers || {})
    writeExamFiles(a, sub, state)
    return { ok: true, remaining: left }
  })

  r.post('/api/student/exams/:id/submit', async (req, p) => {
    const t = need(req, 'student')
    const a = getAssignment(p.id)
    examItemOf(a)
    const { sub, state } = ensureExamSubmission(a, t)
    if (state.submittedAt) {
      return { ok: true, already: true, submissionId: sub.id }
    }
    state.submittedAt = new Date().toISOString()
    state.graded = examLib.autoGrade(state.paper, state.answers || {}, {})
    state.graded.at = state.submittedAt
    writeExamFiles(a, sub, state)
    return { ok: true, submissionId: sub.id, autoScore: state.graded.autoScore, total: state.graded.total }
  })

  /* ---------------- 内容（讲义 / 材料 / 示例） ---------------- */

  r.get('/api/content/lessons', async (req) => {
    const t = need(req)
    return {
      lessons: content.listLessons(contentRoot(req, t)).map((x) => ({
        id: x.id,
        no: x.no,
        title: x.title,
        kind: x.kind,
        hasLecture: !!x.lecture,
        hasMaterials: !!x.materials,
      })),
    }
  })

  // 教学公开：**课程材料（学生讲义）不需要登录**；讲义（教师讲稿）只有教师能看。
  // 缓存策略也跟着身份走：材料是公开内容 → public（代理与浏览器都能缓存）；
  // 讲义是教师内部内容 → private, no-store（谁都不许缓存）。
  r.get('/api/content/doc', async (req, p, res) => {
    const url = new URL(req.url, 'http://x')
    const type = url.searchParams.get('type') === 'lecture' ? 'lecture' : 'materials'
    const id = url.searchParams.get('id') || ''
    const t = auth.fromRequest(req) || null
    if (type === 'lecture' && (!t || t.role !== 'teacher')) throw new HttpError(403, '讲义仅教师可见')
    const doc = content.getDoc(type, id, contentRoot(req, t))
    if (!doc) throw new HttpError(404, '没有这篇文档')
    // 里面的图片（../assets/…）换成能直接打开的地址
    const c0 = currentCourse(req, t)
    if (doc.markdown) doc.markdown = content.rewriteAssets(doc.markdown, (c0 || {}).id || '')
    const cc = type === 'lecture' ? 'private, no-store' : 'public, max-age=60'
    return json(res, 200, doc, { 'Cache-Control': cc })
  })

  /** 课程内容里的图片：<img> 不带令牌，所以地址里带课程 id；只开放 assets/ 目录 */
  r.get('/api/content/asset', async (req, p, res) => {
    const url = new URL(req.url, 'http://x')
    const cid = String(url.searchParams.get('course') || '')
    const rel = String(url.searchParams.get('path') || '')
    const c = db.getCourse(cid)
    if (!c) throw new HttpError(404, '课程不存在')
    const safe = coursepack.safeRelPath(rel)
    if (!safe || safe.indexOf('assets/') !== 0) throw new HttpError(400, '只能取课程 assets 目录里的文件')
    const file = path.join(coursepack.contentRootOf(c), safe)
    if (!file.startsWith(coursepack.contentRootOf(c)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new HttpError(404, '文件不存在')
    }
    sendFile(res, file, { cache: 'private, max-age=300' })
    return undefined
  })

  r.get('/api/examples', async (req) => {
    const t = need(req)
    return { lessons: content.listExamples(contentRoot(req, t)) }
  })

  r.get('/api/examples/:dir', async (req, p) => {
    const t = need(req)
    const dir = p.dir

    // 课堂作业自己的代码：@a:<作业 id>（起手代码）/ @s:<作业 id>:<提交 id>（提交快照）
    // 前端工作台完全不用改：它只是拿到了一个「目录名」。
    if (dir.indexOf('@a:') === 0) {
      const aid = dir.slice(3)
      const a = db.getAssignment ? db.getAssignment(aid) : null
      if (!a) throw new HttpError(404, '作业不存在')
      if (t.role === 'student') {
        assertModuleItem(a.itemKey)
        if (a.courseId && t.courseId && a.courseId !== t.courseId) throw new HttpError(403, '这门课的作业不在你看的课程里')
      } else {
        need(req, 'teacher')
      }
      return assignCode.bundleFromDir(assignCode.codeDir(aid), dir)
    }

    if (dir.indexOf('@s:') === 0) {
      const rest = dir.slice(3)
      const cut = rest.lastIndexOf(':')
      const aid = cut > 0 ? rest.slice(0, cut) : ''
      const subId = cut > 0 ? rest.slice(cut + 1) : rest
      const a = db.getAssignment ? db.getAssignment(aid) : null
      if (!a) throw new HttpError(404, '作业不存在')
      const sub = db.findSubmission(aid, subId)
      if (!sub) throw new HttpError(404, '提交记录不存在')
      if (t.role === 'student' && (sub.sid !== t.sid || sub.classId !== t.classId)) {
        throw new HttpError(403, '只能看自己的提交')
      }
      const files = submissions.readFiles(sub.classId, sub.sid, aid, sub.id, sub.files)
      return { dir, files: files.filter((f) => !f.missing) }
    }

    const bundle = content.getExampleBundle(dir, contentRoot(req, null))
    if (!bundle) throw new HttpError(404, '示例目录不存在')
    // 示例里的图片（../../assets/…）同样换成能打开的地址
    const cid = ((currentCourse(req, t) || {}).id) || ''
    if (cid && Array.isArray(bundle.files)) {
      bundle.files = bundle.files.map((f) =>
        typeof f.text === 'string' ? Object.assign({}, f, { text: content.rewriteAssets(f.text, cid) }) : f
      )
    }
    return bundle
  })

  /* ---------------- 证据上传（教师） ---------------- */

  r.post('/api/teacher/upload', async (req) => {
    need(req, 'teacher')
    const body = await readJson(req, 8 * 1024 * 1024)
    const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(String(body.dataUrl || ''))
    if (!m) throw new HttpError(400, '文件格式不正确')
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length > 6 * 1024 * 1024) throw new HttpError(413, '单个文件不能超过 6MB')
    const safe = String(body.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-80)
    const name = Date.now().toString(36) + '-' + safe
    fs.writeFileSync(path.join(config.uploadDir, name), buf)
    return { name, url: '/uploads/' + encodeURIComponent(name), size: buf.length }
  })

  /* ---------------- 导出 CSV ---------------- */

  r.get('/api/teacher/classes/:id/export', async (req, p, res) => {
    need(req, 'teacher')
    const c = getClass(p.id)
    const kind = new URL(req.url, 'http://x').searchParams.get('kind') === 'events' ? 'events' : 'total'
    const events = eventsOf(c.id)
    let rows
    if (kind === 'events') {
      rows = [['时间', '学号', '姓名', '项目', '摘要', '原因', '操作人', '状态']]
      for (const e of events.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
        const stu = c.students.find((s) => s.sid === e.sid) || {}
        rows.push([
          fmtTime(e.createdAt),
          e.sid,
          stu.name || '',
          (scoring.itemByKey(e.item) || {}).name || e.item,
          scoring.eventSummary(e),
          e.reason || '',
          e.operator || '',
          e.voided ? '已撤销' : '有效',
        ])
      }
    } else {
      const board = scoring.computeClass(c.students, events)
      rows = [['学号', '姓名', '考勤', '互动', '作业', '机试', '大作业', '加分', '总评']]
      for (const row of board.list) {
        const get = (k) => (row.rows.find((x) => x.item.key === k) || {}).score || 0
        rows.push([
          row.student.sid,
          row.student.name,
          get('attend'),
          get('interact'),
          get('homework'),
          get('exam'),
          get('project'),
          get('bonus'),
          row.total,
        ])
      }
    }
    const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
    const fname = c.name + '-' + (kind === 'events' ? '流水' : '总评') + '.csv'
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
      'Cache-Control': 'no-store',
    })
    res.end(Buffer.from(csv, 'utf8'))
  })

  r.get('/api/cast/status', async () => (cast ? cast.state() : { students: 0, mode: 'idle' }))

  return { router: r, ok, fail, HttpError }
}

function csvCell(v) {
  const s = String(v == null ? '' : v)
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function fmtTime(iso) {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}
