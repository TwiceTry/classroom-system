/**
 * 课堂作业全链路（e2e，需要服务在 18730 跑着）
 *
 * 覆盖几处曾经出过错的地方：
 *   · 学生列表不按 itemKey 过滤 → 三个模块显示同一份
 *   · 列表字段是 myLatest（前端读的）而接口给 mySubmission → 交了也显示「还没交过」
 *   · 批阅按固定 100 折算 → 满分 20 的项存成 100
 *   · 前端预览与后端落库口径不一致
 *
 * 最后一条在这里做**对账**：submission.score 必须等于计分引擎算出的项分，
 * 也必须等于 web/src/utils/grade.js 算出的值 —— 三处同一个数才算过。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const B = process.env.TS_BASE || 'http://127.0.0.1:18730'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/config.json'), 'utf8'))
const PWD = String(cfg.teacherPassword || 'teacher').trim()

const grade = await import(pathToFileURL(path.join(ROOT, 'web/src/utils/grade.js')).href)

let pass = 0
let fail = 0
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n + (d ? '  → ' + d : '')) }
  else { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')) }
}

async function j(method, url, body, tk) {
  const opt = { method, headers: { 'content-type': 'application/json' } }
  if (tk) opt.headers.authorization = 'Bearer ' + tk
  if (body !== undefined) opt.body = JSON.stringify(body)
  const r = await fetch(B + url, opt)
  const t = await r.text()
  let o = null
  try { o = JSON.parse(t) } catch (e) { /* */ }
  return { s: r.status, j: o, t }
}

const T = (await j('POST', '/api/auth/login/teacher', { password: PWD })).j.token
const STU = [
  { sid: '2515230114', name: '马婷婷' },
  { sid: '2515270101', name: '王志博' },
]
const tok = {}
for (const s of STU) {
  tok[s.sid] = (await j('POST', '/api/auth/login/student', { sid: s.sid, name: s.name, courseId: 'web-front-dev' })).j.token
}

/* 方案里作业项的满分与等级表（期望值从这儿推） */
const sch = (await j('GET', '/api/scheme', undefined, T)).j
const hwItem = (sch.items || []).find((i) => i.key === 'homework')
const gA = (hwItem.grades || []).find((g) => g.key === 'A')
const gB = (hwItem.grades || []).find((g) => g.key === 'B')
const FULL = Number(hwItem.full)

console.log('')
console.log('作业项满分 ' + FULL + ' · 等级 ' + (hwItem.grades || []).map((g) => g.key + '=' + g.factor).join(' '))

let aid = ''
try {
  /* ---------- 建单 ---------- */
  const due = new Date(Date.now() + 3600 * 1000).toISOString()
  const made = await j('POST', '/api/assignments', { title: 'e2e·作业流程', itemKey: 'homework', dueAt: due, allowLate: true }, T)
  ok('建作业 → 201', made.s === 201, 'status=' + made.s)
  aid = made.j && made.j.assignment && made.j.assignment.id
  if (!aid) throw new Error('没拿到作业 id')

  await j('POST', '/api/assignments/' + aid + '/start', {}, T)
  const d1 = await j('GET', '/api/assignments/' + aid, undefined, T)
  ok('开始收后状态 open', d1.j.assignment.status === 'open', d1.j.assignment.status)

  /* ---------- 学生列表：itemKey 过滤 ---------- */
  const lHw = await j('GET', '/api/student/assignments?itemKey=homework', undefined, tok['2515230114'])
  ok('列表按 itemKey=homework 能查到', (lHw.j.items || []).some((x) => x.id === aid), '条数=' + (lHw.j.items || []).length)

  const lPj = await j('GET', '/api/student/assignments?itemKey=project', undefined, tok['2515230114'])
  ok(
    'itemKey=project 不包含这份作业',
    !(lPj.j.items || []).some((x) => x.id === aid),
    'project 条数=' + (lPj.j.items || []).length
  )

  /* ---------- 列表契约：mySubmission ---------- */
  const mine = (lHw.j.items || []).find((x) => x.id === aid)
  ok('列表项带 mySubmission 字段（前端读它判断交没交）', mine && 'mySubmission' in mine, mine ? JSON.stringify(Object.keys(mine)).slice(0, 80) : '没有该项')
  ok('还没交时 mySubmission 为 null', mine && mine.mySubmission === null, String(mine && mine.mySubmission))

  /* ---------- 学生提交 ---------- */
  const sub = await j('POST', '/api/student/assignments/' + aid + '/submit', {
    files: [{ path: 'index.html', text: '<h1>e2e</h1>' }], note: 'e2e 提交',
  }, tok['2515230114'])
  ok('提交 → 201', sub.s === 201, 'status=' + sub.s)

  const lHw2 = await j('GET', '/api/student/assignments?itemKey=homework', undefined, tok['2515230114'])
  const mine2 = (lHw2.j.items || []).find((x) => x.id === aid)
  ok('交完以后 mySubmission 不为 null', mine2 && mine2.mySubmission && !!mine2.mySubmission.id, mine2 && mine2.mySubmission ? 'id=' + mine2.mySubmission.id : 'null')

  /*
   * 详情接口：学生端两个详情页都按「列表」写（mine.length / v-for / mine[last]），
   * 而接口原来只给 mySubmission → 交完作业「我的提交」整块不显示、附件也下不回来。
   */
  const det = await j('GET', '/api/student/assignments/' + aid, undefined, tok['2515230114'])
  ok('学生详情带 mine 数组（长度 1）', Array.isArray(det.j.mine) && det.j.mine.length === 1, 'len=' + ((det.j.mine || []).length))
  ok(
    '未打分时 graded=false',
    det.j.mine && det.j.mine[0] && det.j.mine[0].graded === false,
    String(det.j.mine && det.j.mine[0] && det.j.mine[0].graded)
  )

  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  const ev0 = await j(
    'POST',
    '/api/assignments/' + aid + '/submissions/' + STU[0].sid + '/evidence',
    { name: 'x.png', dataUrl: PNG },
    T
  )
  ok('未打分时传证据 → 400（先给分再传）', ev0.s === 400, 'status=' + ev0.s)

  /* 附件下载第二段必须是**学号**，传提交记录 id 一律 404 */
  {
    const bySid = await fetch(B + '/api/files/assignments/' + aid + '/' + STU[0].sid + '/index.html', {
      headers: { authorization: 'Bearer ' + tok['2515230114'] },
    })
    ok('附件按学号下载 → 200', bySid.status === 200, 'status=' + bySid.status)
    const subId = det.j.mine[0].id
    const byId = await fetch(B + '/api/files/assignments/' + aid + '/' + subId + '/index.html', {
      headers: { authorization: 'Bearer ' + tok['2515230114'] },
    })
    ok('传提交 id 而非学号 → 404（原来下载按钮打不开就是这个）', byId.status === 404, 'status=' + byId.status)
  }

  /* ---------- 学生看不到别人的 ---------- */
  const other = await j('GET', '/api/student/assignments/' + aid + '/submissions/' + STU[0].sid, undefined, tok['2515270101'])
  ok('学生看别人的提交 → 403', other.s === 403, 'status=' + other.s)

  /* ---------- 批阅：等级 A ---------- */
  const g1 = await j('POST', '/api/assignments/' + aid + '/submissions/' + STU[0].sid + '/grade', { grade: 'A' }, T)
  const s1 = g1.j && g1.j.submission
  const wantA = grade.letterScoreOf(hwItem, 'A', false)
  ok('判 A 落库 = ' + wantA + '（按本项满分，不是 100）', s1 && s1.score === wantA, s1 ? String(s1.score) : '?')

  /* 证据：submissionView 原来根本不带 evidence 字段，传了也看不到、删不掉 */
  {
    const det2 = await j('GET', '/api/student/assignments/' + aid, undefined, tok['2515230114'])
    ok('打分后 graded=true', det2.j.mine && det2.j.mine[0] && det2.j.mine[0].graded === true, String(det2.j.mine && det2.j.mine[0] && det2.j.mine[0].graded))
    const ev1 = await j(
      'POST',
      '/api/assignments/' + aid + '/submissions/' + STU[0].sid + '/evidence',
      { name: '评分截图.png', dataUrl: PNG },
      T
    )
    const list = (ev1.j && ev1.j.submission && ev1.j.submission.evidence) || []
    ok('打分后传证据 → 200 且列表非空', ev1.s === 200 && list.length === 1, 'status=' + ev1.s + ' 条数=' + list.length)
  }

  /* ---------- 批阅：B + 迟交 ---------- */
  const g2 = await j('POST', '/api/assignments/' + aid + '/submissions/' + STU[0].sid + '/grade', { grade: 'B', late: true }, T)
  const s2 = g2.j && g2.j.submission
  const wantB = grade.letterScoreOf(hwItem, 'B', true)
  ok('判 B + 迟交 落库 = ' + wantB, s2 && s2.score === wantB, s2 ? String(s2.score) : '?')

  /* ---------- 与计分引擎对账 ---------- */
  /* 用学生自己的分数接口：它就是计分引擎的输出，而且顺带验了「学生看到的分」 */
  {
    const my = await j('GET', '/api/student/score', undefined, tok[STU[0].sid])
    ok('学生分数接口 200', my.s === 200, 'status=' + my.s)
    const row = ((my.j && my.j.rows) || []).find((r) => r.key === 'homework')
    ok(
      '计分引擎算的作业分 = 批阅落库分（' + wantB + '）',
      row && row.score === wantB,
      row ? String(row.score) : '(rows 里没有 homework)'
    )
  }

  /* ---------- 非法等级 ---------- */
  const bad = await j('POST', '/api/assignments/' + aid + '/submissions/' + STU[0].sid + '/grade', { grade: 'ZZ' }, T)
  ok('等级不在方案里 → 400', bad.s === 400, 'status=' + bad.s)

  /* 关键：校验失败不能把已经有效的成绩弄丢 */
  {
    const my0 = await j('GET', '/api/student/score', undefined, tok[STU[0].sid])
    const r0 = ((my0.j && my0.j.rows) || []).find((x) => x.key === 'homework')
    ok('校验失败后作业分仍是 ' + wantB + '（没被清掉）', r0 && r0.score === wantB, r0 ? String(r0.score) : '?')
  }

  /* ---------- 打回重做 ---------- */
  const redo = await j('POST', '/api/assignments/' + aid + '/submissions/' + STU[0].sid + '/redo', {}, T)
  const rs = redo.j && redo.j.submission
  ok('打回重做后 grade 清空', rs && !rs.grade, rs ? JSON.stringify(rs.grade) : '?')

  /* ---------- 结束收卷后不能交 ---------- */
  await j('POST', '/api/assignments/' + aid + '/stop', {}, T)
  const late = await j('POST', '/api/student/assignments/' + aid + '/submit', {
    files: [{ path: 'x.html', text: 'x' }],
  }, tok['2515270101'])
  ok('结束收卷后提交 → 409', late.s === 409, 'status=' + late.s)
} finally {
  if (aid) await j('DELETE', '/api/assignments/' + aid, undefined, T)
}

console.log('')
console.log(fail === 0 ? '作业全链路：全部通过 ✓' : '作业全链路：有失败 ✗')
console.log('（通过 ' + pass + ' · 失败 ' + fail + '）')
process.exit(fail === 0 ? 0 : 1)
