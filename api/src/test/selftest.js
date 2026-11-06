#!/usr/bin/env node
/*
 * test/selftest.js —— 新后端的接口自检
 *
 * 用 Fastify 的 inject（进程内发请求，不占端口）跑，数据目录指向临时目录，
 * **不碰 data/ 里的真实数据**。
 *
 *   node src/test/selftest.js            跑全部
 *   node src/test/selftest.js --keep     跑完保留临时目录（排查用）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KEEP = process.argv.includes('--keep')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-api-test-'))
process.env.TS_DATA_DIR = TMP
process.env.TS_LOG_LEVEL = 'silent'
process.env.TS_PASSWORD = 'selftest-pwd'

let pass = 0
let fail = 0
const results = []
function check(name, cond, detail) {
  if (cond) {
    pass++
    results.push('  ✓ ' + name + (detail ? '  → ' + detail : ''))
  } else {
    fail++
    results.push('  ✗ ' + name + (detail ? '  → ' + detail : ''))
  }
}

const { buildApp } = await import('../app.js')
const { applySchema, openDb } = await import('../db/index.js')

// 建空库
{
  const db = openDb()
  applySchema(db)
  db.close()
}

const app = await buildApp({ logger: false })
const inject = (opts) => app.inject(opts)
const json = (res) => {
  try {
    return JSON.parse(res.body)
  } catch (e) {
    return null
  }
}

console.log('课堂系统 API 自检（Fastify + SQLite）')
console.log('临时数据目录：' + TMP)
console.log('')

/* -------------------- 1. 健康检查 -------------------- */
{
  const r = await inject({ method: 'GET', url: '/api/health' })
  const j = json(r)
  check('GET /api/health 200', r.statusCode === 200 && j && j.ok === true, r.statusCode + ' runtime=' + (j && j.runtime))
}

/* -------------------- 2. 认证 -------------------- */
let teacherToken = ''
let stuToken = ''
let courseId = ''
let classId = ''

{
  const bad = await inject({ method: 'POST', url: '/api/auth/login/teacher', payload: { password: 'wrong' } })
  check('教师口令错误 → 401', bad.statusCode === 401, 'status=' + bad.statusCode)

  const ok = await inject({ method: 'POST', url: '/api/auth/login/teacher', payload: { password: 'selftest-pwd' } })
  const j = json(ok)
  teacherToken = j && j.token
  check('教师登录 → 200 且有令牌', ok.statusCode === 200 && !!teacherToken, 'role=' + (j && j.role))

  const noAuth = await inject({ method: 'GET', url: '/api/courses' })
  check('无令牌访问课程 → 401', noAuth.statusCode === 401, 'status=' + noAuth.statusCode)

  const me = await inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: 'Bearer ' + teacherToken } })
  const mj = json(me)
  check('GET /api/auth/me → teacher', me.statusCode === 200 && mj && mj.role === 'teacher', JSON.stringify(mj))
}

/* -------------------- 3. 课程 -------------------- */
{
  const created = await inject({
    method: 'POST',
    url: '/api/courses',
    headers: { authorization: 'Bearer ' + teacherToken },
    payload: { name: '自检课程', semester: '2026秋' },
  })
  const j = json(created)
  courseId = j && j.id
  check('建课 → 201', created.statusCode === 201 && !!courseId, 'id=' + courseId)
  check('建课时建出了内容目录', !!courseId && fs.existsSync(path.join(TMP, 'courses', courseId, 'content', 'lecture')), '')

  const list = await inject({ method: 'GET', url: '/api/courses', headers: { authorization: 'Bearer ' + teacherToken } })
  const lj = json(list)
  check('课程列表里有它', list.statusCode === 200 && lj.items.some((c) => c.id === courseId), 'total=' + (lj && lj.total))

  const badId = await inject({
    method: 'POST',
    url: '/api/courses',
    headers: { authorization: 'Bearer ' + teacherToken },
    payload: { id: 'BAD ID', name: 'x' },
  })
  check('非法课程 id → 400', badId.statusCode === 400, 'status=' + badId.statusCode)
}

/* -------------------- 4. 班级与名册 -------------------- */
{
  const c = await inject({
    method: 'POST',
    url: '/api/classes',
    headers: { authorization: 'Bearer ' + teacherToken },
    payload: { name: '自检班', courseId },
  })
  const cj = json(c)
  classId = cj && cj.id
  check('建班 → 201', c.statusCode === 201 && !!classId, 'id=' + classId)

  const add = await inject({
    method: 'POST',
    url: '/api/classes/' + classId + '/students',
    headers: { authorization: 'Bearer ' + teacherToken },
    payload: {
      students: [
        { sid: 'S9001', name: '张三' },
        { sid: 'S9002', name: '李四' },
        { sid: 'S9003', name: '王五' },
      ],
    },
  })
  const aj = json(add)
  check('批量加学生 → 201（3 人）', add.statusCode === 201 && aj.items.length === 3, 'total=' + (aj && aj.total))

  const again = await inject({
    method: 'POST',
    url: '/api/classes/' + classId + '/students',
    headers: { authorization: 'Bearer ' + teacherToken },
    payload: { students: [{ sid: 'S9001', name: '张三三' }] },
  })
  const agj = json(again)
  check('重复学号是覆盖姓名（不重复插入）', again.statusCode === 201 && agj.items.length === 3 && agj.items.find((s) => s.sid === 'S9001').name === '张三三', 'total=' + (agj && agj.total))

  const stu = await inject({
    method: 'POST',
    url: '/api/auth/login/student',
    payload: { sid: 'S9001', name: '张三三' },
  })
  const sj = json(stu)
  stuToken = sj && sj.token
  check('学生登录（学号+姓名对名册）→ 200', stu.statusCode === 200 && !!stuToken, 'classId=' + (sj && sj.classId))

  const wrongName = await inject({ method: 'POST', url: '/api/auth/login/student', payload: { sid: 'S9001', name: '李四' } })
  check('姓名对不上 → 401', wrongName.statusCode === 401, 'status=' + wrongName.statusCode)

  const forbidden = await inject({ method: 'GET', url: '/api/courses', headers: { authorization: 'Bearer ' + stuToken } })
  check('学生访问教师接口 → 403', forbidden.statusCode === 403, 'status=' + forbidden.statusCode)
}

/* -------------------- 5. 记分（append-only） -------------------- */
let eventId = ''
{
  const e = await inject({
    method: 'POST',
    url: '/api/classes/' + classId + '/events',
    headers: { authorization: 'Bearer ' + teacherToken },
    payload: { sid: 'S9001', item: 'interact', delta: 2, reason: '回答得好' },
  })
  const ej = json(e)
  eventId = ej && ej.id
  check('记一笔分 → 201', e.statusCode === 201 && !!eventId, 'delta=' + (ej && ej.delta) + ' operator=' + (ej && ej.operator))

  const empty = await inject({
    method: 'POST',
    url: '/api/classes/' + classId + '/events',
    headers: { authorization: 'Bearer ' + teacherToken },
    payload: { sid: 'S9001', item: 'interact' },
  })
  check('没有任何分值/等级 → 400', empty.statusCode === 400, 'status=' + empty.statusCode)

  const notInClass = await inject({
    method: 'POST',
    url: '/api/classes/' + classId + '/events',
    headers: { authorization: 'Bearer ' + teacherToken },
    payload: { sid: 'NOBODY', item: 'interact', delta: 1 },
  })
  check('不在本班的学生 → 404', notInClass.statusCode === 404, 'status=' + notInClass.statusCode)

  const list = await inject({
    method: 'GET',
    url: '/api/classes/' + classId + '/events?limit=10',
    headers: { authorization: 'Bearer ' + teacherToken },
  })
  const lj = json(list)
  check('记分列表（分页）→ 有 1 条', list.statusCode === 200 && lj.items.length === 1, 'nextCursor=' + (lj && lj.nextCursor))

  const voided = await inject({
    method: 'POST',
    url: '/api/classes/' + classId + '/events/' + eventId + '/void',
    headers: { authorization: 'Bearer ' + teacherToken },
    payload: { reason: '记错了' },
  })
  const vj = json(voided)
  check('撤销 → voided=true（不删记录）', voided.statusCode === 200 && vj.voided === true, 'by=' + (vj && vj.voidedBy))

  const still = await inject({
    method: 'GET',
    url: '/api/classes/' + classId + '/events',
    headers: { authorization: 'Bearer ' + teacherToken },
  })
  const stj = json(still)
  check('撤销后记录还在（append-only）', stj.items.length === 1, 'items=' + (stj && stj.items.length))

  const restored = await inject({
    method: 'POST',
    url: '/api/classes/' + classId + '/events/' + eventId + '/restore',
    headers: { authorization: 'Bearer ' + teacherToken },
  })
  check('恢复 → voided=false', restored.statusCode === 200 && json(restored).voided === false, '')
}

/* -------------------- 6. 在场 / 投屏状态 -------------------- */
{
  const ping = await inject({ method: 'POST', url: '/api/presence/ping', headers: { authorization: 'Bearer ' + stuToken } })
  check('学生心跳 → 200', ping.statusCode === 200, 'online=' + (json(ping) && json(ping).online))

  const pres = await inject({
    method: 'GET',
    url: '/api/classes/' + classId + '/presence',
    headers: { authorization: 'Bearer ' + teacherToken },
  })
  const pj = json(pres)
  check('在场名单里能看到他', pres.statusCode === 200 && pj.onlineCount >= 1, 'onlineCount=' + (pj && pj.onlineCount))

  const anon = await inject({ method: 'GET', url: '/api/cast/status' })
  check('投屏状态未登录 → 401', anon.statusCode === 401, 'status=' + anon.statusCode)

  const asStu = await inject({ method: 'GET', url: '/api/cast/status', headers: { authorization: 'Bearer ' + stuToken } })
  check('投屏状态登录后可读 → 200', asStu.statusCode === 200, 'mode=' + (json(asStu) && json(asStu).mode))
}

/* -------------------- 7. 边缘端上报签名 -------------------- */
{
  const { createHmac } = await import('node:crypto')
  const { config } = await import('../config.js')

  const anon = await inject({ method: 'POST', url: '/api/presence/snapshot', payload: { students: [] } })
  check('边缘端上报未签名 → 401', anon.statusCode === 401, 'status=' + anon.statusCode)

  const bodyObj = { students: [{ token: stuToken, online: true, casting: false }] }
  const raw = JSON.stringify(bodyObj)
  const ts = String(Math.floor(Date.now() / 1000))
  const source = 'selftest-edge'
  const sign = createHmac('sha256', config.edgeKey).update(source + '\n' + ts + '\n' + raw).digest('hex')

  const okRes = await inject({
    method: 'POST',
    url: '/api/presence/snapshot',
    headers: { 'content-type': 'application/json', 'x-edge-source': source, 'x-edge-ts': ts, 'x-edge-sign': sign },
    payload: raw,
  })
  check('边缘端上报签名正确 → 200', okRes.statusCode === 200 && json(okRes).online >= 1, JSON.stringify(json(okRes)))

  const replay = await inject({
    method: 'POST',
    url: '/api/presence/snapshot',
    headers: { 'content-type': 'application/json', 'x-edge-source': source, 'x-edge-ts': ts, 'x-edge-sign': sign },
    payload: raw,
  })
  check('同一包重放 → 401', replay.statusCode === 401, 'status=' + replay.statusCode)
}

/* -------------------- 8. 内容管理（讲义/材料） -------------------- */
{
  const contentRoot = path.join(TMP, 'courses', courseId, 'content')
  fs.writeFileSync(path.join(contentRoot, 'materials', '第01课-示例.md'), '# 第一课\n\n这是给学生看的材料。\n', 'utf8')
  fs.writeFileSync(path.join(contentRoot, 'lecture', '第01课-讲稿.md'), '# 讲稿\n\n这里有答案，学生不该看到。\n', 'utf8')

  const head = { authorization: 'Bearer ' + teacherToken }
  const stuHead = { authorization: 'Bearer ' + stuToken }

  const over = await inject({ method: 'GET', url: '/api/courses/' + courseId + '/content', headers: head })
  const oj = json(over)
  check('内容概览：列出材料目录、材料已计入', over.statusCode === 200 && oj.dirs.some((d) => d.dir === 'materials' && d.files === 1), JSON.stringify(oj && oj.dirs))

  const overStu = await inject({ method: 'GET', url: '/api/courses/' + courseId + '/content', headers: stuHead })
  const osj = json(overStu)
  check('学生看不到讲义目录（lecture）', overStu.statusCode === 200 && !osj.dirs.some((d) => d.dir === 'lecture'), JSON.stringify(osj && osj.dirs.map((d) => d.dir)))

  const list = await inject({ method: 'GET', url: '/api/courses/' + courseId + '/content/list?path=materials', headers: head })
  const lj = json(list)
  check('列目录：materials 下有那个 md', list.statusCode === 200 && lj.entries.some((e) => e.name === '第01课-示例.md' && e.type === 'file'), JSON.stringify(lj && lj.entries))

  const read = await inject({ method: 'GET', url: '/api/courses/' + courseId + '/content/file?path=' + encodeURIComponent('materials/第01课-示例.md'), headers: head })
  const rj = json(read)
  check('读文本：内容对得上', read.statusCode === 200 && rj.text.includes('给学生看的材料'), 'size=' + (rj && rj.size))

  const stuLecture = await inject({ method: 'GET', url: '/api/courses/' + courseId + '/content/file?path=' + encodeURIComponent('lecture/第01课-讲稿.md'), headers: stuHead })
  check('学生读讲义 → 403', stuLecture.statusCode === 403, 'status=' + stuLecture.statusCode)

  const escape = await inject({ method: 'GET', url: '/api/courses/' + courseId + '/content/file?path=' + encodeURIComponent('../../../data/config.json'), headers: head })
  check('路径越界（../../）→ 400', escape.statusCode === 400, 'status=' + escape.statusCode)

  const missing = await inject({ method: 'GET', url: '/api/courses/' + courseId + '/content/file?path=' + encodeURIComponent('materials/没有.md'), headers: head })
  check('不存在的文件 → 404', missing.statusCode === 404, 'status=' + missing.statusCode)
}

/* -------------------- 考勤与分数 -------------------- */
{
  const head = { authorization: 'Bearer ' + teacherToken }
  const base = '/api/classes/' + classId

  const view = await inject({ method: 'GET', url: base + '/attendance?slot=' + encodeURIComponent('1-2节'), headers: head })
  const vj = json(view)
  check('考勤视图：拿到考勤项与名单', view.statusCode === 200 && !!vj.itemKey && vj.students.length === 3, 'item=' + (vj && vj.itemName))
  check('考勤扣分表来自方案（缺勤 -2 / 迟到 -1）', vj && vj.kinds.some((k) => k.kind === '缺勤' && k.delta === -2) && vj.kinds.some((k) => k.kind === '迟到' && k.delta === -1), JSON.stringify(vj && vj.kinds))

  const day = new Date().toISOString().slice(0, 10)
  const submit = await inject({
    method: 'POST',
    url: base + '/attendance',
    headers: head,
    payload: {
      date: day,
      slot: '1-2节',
      entries: [
        { sid: 'S9001', kind: '缺勤' },
        { sid: 'S9002', kind: '迟到' },
        { sid: 'S9003', kind: '出勤' },
      ],
    },
  })
  const sj = json(submit)
  check(
    '提交考勤：缺勤/迟到各记一条，出勤不记账',
    submit.statusCode === 200 && sj.created === 2 && sj.present === 1,
    JSON.stringify(sj)
  )

  const after = await inject({ method: 'GET', url: base + '/attendance?slot=' + encodeURIComponent('1-2节') + '&date=' + day, headers: head })
  const aj = json(after)
  check('回显：这一节 2 条标记', after.statusCode === 200 && aj.marks.length === 2, JSON.stringify(aj && aj.marks))

  const scores = await inject({ method: 'GET', url: base + '/scores', headers: head })
  const scj = json(scores)
  // 分数榜是 computeClass 的原始形状：list[].student.sid / list[].rows[].item.key
  const s9001 = scj && ((scj.board && scj.board.list) || []).find((x) => x.student.sid === 'S9001')
  const attendRow = s9001 && s9001.rows.find((r) => r.item.key === vj.itemKey)
  check(
    '分数榜：缺勤的人考勤项被扣分',
    scores.statusCode === 200 && !!attendRow && attendRow.score < 10,
    'S9001 考勤=' + (attendRow && attendRow.score) + ' / 总评=' + (s9001 && s9001.total)
  )

  // 同一人同一节改成「迟到」→ 覆盖（旧的撤掉，不叠加）
  const mark = await inject({
    method: 'POST',
    url: base + '/attendance/mark',
    headers: head,
    payload: { sid: 'S9001', kind: '迟到', date: day, slot: '1-2节' },
  })
  const mj = json(mark)
  check('单人改状态：先撤旧账再记新账', mark.statusCode === 200 && mj.voided === 1 && !!mj.eventId, JSON.stringify(mj))

  const after2 = await inject({ method: 'GET', url: base + '/attendance?slot=' + encodeURIComponent('1-2节') + '&date=' + day, headers: head })
  const aj2 = json(after2)
  const mine = aj2.marks.filter((m) => m.sid === 'S9001')
  check('改完之后同一个人只剩一条（迟到）', mine.length === 1 && mine[0].kind === '迟到' && mine[0].delta === -1, JSON.stringify(mine))

  // 点回「出勤」= 撤销
  const back = await inject({
    method: 'POST',
    url: base + '/attendance/mark',
    headers: head,
    payload: { sid: 'S9001', kind: '出勤', date: day, slot: '1-2节' },
  })
  const bj = json(back)
  const after3 = await inject({ method: 'GET', url: base + '/attendance?slot=' + encodeURIComponent('1-2节') + '&date=' + day, headers: head })
  const mine3 = json(after3).marks.filter((m) => m.sid === 'S9001')
  check('点回出勤 = 撤销（不再有他的标记）', bj.voided === 1 && bj.eventId === '' && mine3.length === 0, JSON.stringify(bj))

  const schemeInfo = await inject({ method: 'GET', url: '/api/scheme', headers: head })
  const sij = json(schemeInfo)
  check(
    '方案概要：有考核项、模块与及格线',
    schemeInfo.statusCode === 200 &&
      sij.items.length >= 4 &&
      sij.modules.length >= 1 &&
      typeof sij.scheme.passLine === 'number',
    'items=' + (sij && sij.items.map((i) => i.key).join(',')) + ' modules=' + (sij && sij.modules.length)
  )
}

/* -------------------- 作业：发布 · 提交 · 批阅 -------------------- */
let assignmentId = ''
{
  const head = { authorization: 'Bearer ' + teacherToken }
  const stuHead = { authorization: 'Bearer ' + stuToken }

  const created = await inject({
    method: 'POST',
    url: '/api/assignments',
    headers: head,
    payload: { title: '自检作业', itemKey: 'homework', courseId, note: '交一份 md' },
  })
  const cj = json(created)
  assignmentId = cj && cj.assignment.id
  check('建作业 → 201（默认未开放）', created.statusCode === 201 && !!assignmentId && cj.assignment.status === 'closed', 'kind=' + (cj && cj.kind))

  const badItem = await inject({
    method: 'POST',
    url: '/api/assignments',
    headers: head,
    payload: { title: 'x', itemKey: '不存在的项' },
  })
  check('考核项不存在 → 400', badItem.statusCode === 400, 'status=' + badItem.statusCode)

  const listClosed = await inject({ method: 'GET', url: '/api/student/assignments', headers: stuHead })
  check('未开放时学生看不到', listClosed.statusCode === 200 && json(listClosed).items.length === 0, 'total=' + (json(listClosed) && json(listClosed).total))

  const open = await inject({ method: 'POST', url: '/api/assignments/' + assignmentId + '/start', headers: head })
  check('开放 → status=open', open.statusCode === 200 && json(open).assignment.status === 'open', 'status=' + ((json(open) && json(open).assignment || {}).status))

  const listOpen = await inject({ method: 'GET', url: '/api/student/assignments', headers: stuHead })
  check('开放后学生能看到 1 条', listOpen.statusCode === 200 && json(listOpen).items.length === 1, 'total=' + (json(listOpen) && json(listOpen).total))

  const submit = await inject({
    method: 'POST',
    url: '/api/student/assignments/' + assignmentId + '/submit',
    headers: stuHead,
    payload: { files: [{ name: '答案.md', text: '# 我的答案\n\n第一题……\n' }], note: '交作业' },
  })
  const sj = json(submit)
  check('学生提交 → 201（文件落盘）', submit.statusCode === 201 && sj.files.length === 1, JSON.stringify(sj && sj.files))
  const onDisk = path.join(TMP, 'students', classId, 'S9001', '作业', assignmentId, '答案.md')
  check('提交的文件真的写到磁盘', fs.existsSync(onDisk), onDisk.replace(TMP, '<tmp>'))

  const detail = await inject({ method: 'GET', url: '/api/assignments/' + assignmentId, headers: head })
  const dj = json(detail)
  check(
    '教师看提交清单：1 份 · 未交 2 人',
    detail.statusCode === 200 && dj.submissions.length === 1 && dj.stats.missing.length === 2,
    'submitted=' + (dj && dj.stats.submittedStudents) + ' missing=' + (dj && dj.stats.missing.length)
  )

  const readBack = await inject({
    method: 'GET',
    url: '/api/assignments/' + assignmentId + '/submissions/S9001',
    headers: head,
  })
  const rj = json(readBack)
  check('能读回提交的正文', readBack.statusCode === 200 && rj.files[0].text.includes('我的答案'), 'files=' + (rj && rj.files.length))

  // 批阅：homework 的规则是 avg（判等级）
  const grade = await inject({
    method: 'POST',
    url: '/api/assignments/' + assignmentId + '/submissions/S9001/grade',
    headers: head,
    payload: { grade: 'A', comment: '写得好' },
  })
  const gj = json(grade)
  check(
    '批阅（A）→ 有分数、有计分记录',
    grade.statusCode === 200 && typeof gj.submission.score === 'number' && !!gj.submission.eventId,
    'score=' + (gj && gj.submission.score) + ' eventId=' + (gj && gj.submission.eventId && gj.submission.eventId.slice(0, 8))
  )

  const scores = await inject({ method: 'GET', url: '/api/classes/' + classId + '/scores', headers: head })
  const scj = json(scores)
  const row = scj && ((scj.board && scj.board.list) || []).find((x) => x.student.sid === 'S9001')
  const hw = row && row.rows.find((r) => r.item.key === 'homework')
  check('分数榜里作业项有分了', scores.statusCode === 200 && hw && hw.score > 0, 'homework=' + (hw && hw.score))

  // 改分：旧账必须被撤销，只留一条生效
  const regrade = await inject({
    method: 'POST',
    url: '/api/assignments/' + assignmentId + '/submissions/S9001/grade',
    headers: head,
    payload: { grade: 'C', comment: '重新看了下' },
  })
  const rgj = json(regrade)
  const evs = await inject({
    method: 'GET',
    url: '/api/classes/' + classId + '/events?item=homework',
    headers: head,
  })
  const ej = json(evs)
  const live = ej.items.filter((e) => !e.voided)
  check(
    '改分后只有一条生效（旧的被撤销）',
    regrade.statusCode === 200 && live.length === 1 && rgj.submission.eventId === live[0].id,
    'live=' + live.length + ' all=' + ej.items.length
  )

  const redo = await inject({
    method: 'POST',
    url: '/api/assignments/' + assignmentId + '/submissions/S9001/redo',
    headers: head,
  })
  check('打回重做 → 分数清空', redo.statusCode === 200 && json(redo).submission.score === undefined, JSON.stringify(json(redo).submission.score))

  const close = await inject({ method: 'POST', url: '/api/assignments/' + assignmentId + '/stop', headers: head })
  check('关闭作业 → status=closed', close.statusCode === 200 && json(close).assignment.status === 'closed', '')
  const submitAfterClose = await inject({
    method: 'POST',
    url: '/api/student/assignments/' + assignmentId + '/submit',
    headers: stuHead,
    payload: { files: [{ name: 'a.md', text: 'x' }] },
  })
  check('关闭后学生提交 → 409', submitAfterClose.statusCode === 409, 'status=' + submitAfterClose.statusCode)
}

/* -------------------- 机试：出卷 · 开考 · 交卷 · 判分 -------------------- */
let examAssignmentId = ''
{
  const head = { authorization: 'Bearer ' + teacherToken }
  const stuHead = { authorization: 'Bearer ' + stuToken }

  const created = await inject({
    method: 'POST',
    url: '/api/assignments',
    headers: head,
    payload: { title: '自检机试', itemKey: 'exam', courseId },
  })
  const cj = json(created)
  examAssignmentId = cj && cj.assignment.id
  check('建机试 → kind=paper', created.statusCode === 201 && cj.assignment.kind === 'paper', 'kind=' + (cj && cj.kind))

  const paper = {
    kind: 'paper',
    title: '自检机试卷',
    duration: 30,
    fullScore: 20,
    sections: [
      {
        id: 's1',
        title: '单选',
        type: 'choice',
        score: 20,
        questions: [
          {
            id: 'q1',
            stem: '1 + 1 = ?',
            options: [
              { key: 'A', text: '2' },
              { key: 'B', text: '3' },
            ],
            answer: 'A',
          },
        ],
      },
    ],
  }

  const imported = await inject({
    method: 'POST',
    url: '/api/exams/' + examAssignmentId + '/paper',
    headers: head,
    payload: { source: paper },
  })
  const ij = json(imported)
  check('导入试卷 → 200（出纸质卷）', imported.statusCode === 200 && ij.summary.sections.length === 1, 'fullScore=' + (ij && ij.summary.fullScore))
  check('纸质卷文件真的生成', fs.existsSync(path.join(TMP, 'exams', examAssignmentId, '试卷.md')), '')

  const startBefore = await inject({ method: 'POST', url: '/api/student/exams/' + examAssignmentId + '/start', headers: stuHead })
  check('没开考就开考 → 403', startBefore.statusCode === 403, 'status=' + startBefore.statusCode)

  await inject({ method: 'POST', url: '/api/assignments/' + examAssignmentId + '/start', headers: head })

  const started = await inject({ method: 'POST', url: '/api/student/exams/' + examAssignmentId + '/start', headers: stuHead })
  const stj = json(started)
  check('开考 → 拿到卷子（不含答案）', started.statusCode === 200 && stj.paper.sections.length === 1, 'remaining=' + (stj && stj.remaining))
  check('卷子里没有标准答案', started.statusCode === 200 && JSON.stringify(stj.paper).indexOf('"answer"') < 0, '')

  const again = await inject({ method: 'POST', url: '/api/student/exams/' + examAssignmentId + '/start', headers: stuHead })
  check('重复开考是同一份卷（幂等）', again.statusCode === 200 && json(again).submissionId === stj.submissionId, '')

  const ans = await inject({
    method: 'POST',
    url: '/api/student/exams/' + examAssignmentId + '/answers',
    headers: stuHead,
    payload: { answers: { q1: 'A' } },
  })
  check('保存答案 → 200', ans.statusCode === 200 && json(ans).answered === 1, 'answered=' + (json(ans) && json(ans).answered))

  const submit = await inject({ method: 'POST', url: '/api/student/exams/' + examAssignmentId + '/submit', headers: stuHead })
  const sj = json(submit)
  check('交卷 → 自动判分并记账', submit.statusCode === 200 && typeof sj.score === 'number', 'autoScore=' + (sj && sj.autoScore) + ' score=' + (sj && sj.score))

  const after = await inject({
    method: 'POST',
    url: '/api/student/exams/' + examAssignmentId + '/answers',
    headers: stuHead,
    payload: { answers: { q1: 'B' } },
  })
  check('交卷后不能再改答案 → 409', after.statusCode === 409, 'status=' + after.statusCode)

  const overview = await inject({ method: 'GET', url: '/api/exams/' + examAssignmentId, headers: head })
  const oj2 = json(overview)
  check(
    '教师看机试：1 份答卷、已交卷',
    overview.statusCode === 200 && oj2.rows.length === 1 && !!oj2.rows[0].submittedAt,
    'answered=' + (oj2 && oj2.rows[0] && oj2.rows[0].answered)
  )

  const regrade = await inject({
    method: 'POST',
    url: '/api/exams/' + examAssignmentId + '/submissions/' + stj.submissionId + '/grade',
    headers: head,
    payload: { raw: 15, comment: '简答给了部分分' },
  })
  check('教师改机试分（卷面 15）→ 记账', regrade.statusCode === 200 && typeof json(regrade).submission.score === 'number', 'score=' + (json(regrade) && json(regrade).submission.score))

  const paperFile = await inject({
    method: 'GET',
    url: '/api/exams/' + examAssignmentId + '/paper-file/md',
    headers: head,
  })
  check('下载空白卷 → 200 md', paperFile.statusCode === 200 && paperFile.body.indexOf('1 + 1') >= 0, 'len=' + paperFile.body.length)
}

/* -------------------- 9. 删除保护 -------------------- */
{
  const delCourse = await inject({ method: 'DELETE', url: '/api/courses/' + courseId, headers: { authorization: 'Bearer ' + teacherToken } })
  check('课程下还有班级 → 409（不级联删）', delCourse.statusCode === 409, 'status=' + delCourse.statusCode)

  const delClass = await inject({ method: 'DELETE', url: '/api/classes/' + classId, headers: { authorization: 'Bearer ' + teacherToken } })
  check('班级里还有学生 → 409（要 force=1）', delClass.statusCode === 409, 'status=' + delClass.statusCode)

  const delClassForce = await inject({
    method: 'DELETE',
    url: '/api/classes/' + classId + '?force=1',
    headers: { authorization: 'Bearer ' + teacherToken },
  })
  check('force=1 才真删 → 204', delClassForce.statusCode === 204, 'status=' + delClassForce.statusCode)

  const delCourse2 = await inject({ method: 'DELETE', url: '/api/courses/' + courseId, headers: { authorization: 'Bearer ' + teacherToken } })
  check('班级清掉后删课 → 204', delCourse2.statusCode === 204, 'status=' + delCourse2.statusCode)
}

/* -------------------- 9. 未知接口 -------------------- */
{
  const r = await inject({ method: 'GET', url: '/api/nope' })
  const j = json(r)
  check('未知接口 → 404 + 统一错误体', r.statusCode === 404 && j && j.error && j.error.code === 'not_found', JSON.stringify(j))
}

/* -------------------- 10. 投屏中继（WebSocket，真实端口） --------------------
 * 用 injectWS 测不了「关闭 → 清理」：它不会触发服务端的 close 事件。
 * 这几条必须走真端口 + 真 WS 客户端，否则就是假通过。
 */
{
  const { setTimeout: delay } = await import('node:timers/promises')
  await app.listen({ port: 0, host: '127.0.0.1' })
  const PORT = app.server.address().port
  const WS_BASE = 'ws://127.0.0.1:' + PORT + '/ws'

  /** 连上一条 WS，并把收到的消息攒起来（二进制记成 { bin }，文本解析成对象） */
  const openWs = (role) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_BASE + '?role=' + role)
      ws.binaryType = 'arraybuffer' // 默认给 Blob，转成 ArrayBuffer 才好按字节比
      const msgs = []
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') {
          try {
            msgs.push(JSON.parse(ev.data))
          } catch (e) {
            /* ignore */
          }
        } else {
          msgs.push({ bin: Buffer.from(ev.data) })
        }
      })
      ws.addEventListener('open', () => resolve({ ws, msgs }))
      ws.addEventListener('error', reject)
    })
  /**
   * 等一条**新**消息（从 from 开始扫）。
   * 不能从头扫 —— 认证时会先补发一条 { t:'mode', mode:'idle' }，
   * 从头扫的「老师断开后收到 idle」永远是假通过。
   */
  const waitFrom = async (msgs, from, pred, ms = 1500) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      for (let i = from; i < msgs.length; i++) if (pred(msgs[i])) return msgs[i]
      await delay(20)
    }
    return null
  }
  const waitFor = (msgs, pred, ms) => waitFrom(msgs, 0, pred, ms)

  const ctl = await openWs('ctl')
  const stu = await openWs('student')
  await delay(60)

  // 认证前推帧：必须被忽略（学生收不到）
  ctl.ws.send(Buffer.from([0, 1, 2, 3]))

  ctl.ws.send(JSON.stringify({ t: 'hello', token: teacherToken }))
  stu.ws.send(JSON.stringify({ t: 'hello', token: stuToken }))

  const modeIdle = await waitFor(stu.msgs, (m) => m.t === 'mode')
  check('学生观看认证后收到当前 mode', !!modeIdle, JSON.stringify(modeIdle))

  // 老师开播 → 学生应该立刻收到 mode=watch
  ctl.ws.send(JSON.stringify({ t: 'mode', mode: 'watch' }))
  const modeWatch = await waitFor(stu.msgs, (m) => m.t === 'mode' && m.mode === 'watch')
  check('开播后学生收到 mode=watch', !!modeWatch, JSON.stringify(modeWatch))

  // 推一帧整屏（帧头第 2 字节 flags&1）→ 学生收到的字节应当完全一致
  const frame = Buffer.alloc(64)
  frame[0] = 1 // version
  frame[1] = 1 // flags: 整屏关键帧
  for (let i = 2; i < frame.length; i++) frame[i] = i & 0xff
  ctl.ws.send(frame)
  const got = await waitFor(stu.msgs, (m) => m.bin)
  check('整屏帧字节无损转发', !!got && got.bin.equals(frame), got ? got.bin.length + ' 字节' : '没收到')

  await delay(80)
  const st = await inject({ method: 'GET', url: '/api/cast/status', headers: { authorization: 'Bearer ' + teacherToken } })
  const sj = json(st)
  check('投屏状态：mode=watch · 1 人在看', sj && sj.mode === 'watch' && sj.students === 1, JSON.stringify(sj))

  // 老师断开 → 学生应该被通知回到 idle（否则对着最后一帧干等）
  const n0 = stu.msgs.length
  ctl.ws.close()
  const backIdle = await waitFrom(stu.msgs, n0, (m) => m.t === 'mode' && m.mode === 'idle', 2000)
  check('老师断开后学生收到 mode=idle（新的那条）', !!backIdle, JSON.stringify(backIdle))

  stu.ws.close()
  // 关闭事件是异步的，多等一会儿再问状态
  let sj2 = null
  for (let i = 0; i < 25; i++) {
    await delay(100)
    const st2 = await inject({ method: 'GET', url: '/api/cast/status', headers: { authorization: 'Bearer ' + teacherToken } })
    sj2 = json(st2)
    if (sj2 && sj2.students === 0) break
  }
  check('学生断开后在看人数归零 · 模式回到 idle', sj2 && sj2.students === 0 && sj2.mode === 'idle', JSON.stringify(sj2))
}

await app.close()
const { closeDb } = await import('../lib/repo.js')
closeDb()

console.log(results.join('\n'))
console.log('')
console.log((fail ? '有 ' + fail + ' 项没通过' : '全部通过 ✓') + '（通过 ' + pass + ' · 失败 ' + fail + '）')

if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true })
else console.log('临时目录保留在：' + TMP)
process.exit(fail ? 1 : 0)
