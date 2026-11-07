/**
 * 机试全链路（e2e，需要服务在 18730 跑着）
 *
 * 覆盖：
 *   · 设卷时卷面满分与方案 rawFull 不一致 → 要给警告（不是静默打折）
 *   · 学生开考 → 答题 → 交卷 → 自动判分
 *   · 教师录卷面分 → 按方案折算成本项分
 *   · 学生看到的分 = 计分引擎算的分
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
const SID = '2515230114'
const stok = (await j('POST', '/api/auth/login/student', { sid: SID, name: '马婷婷', courseId: 'web-front-dev' })).j.token

const sch = (await j('GET', '/api/scheme', undefined, T)).j
const exItem = (sch.items || []).find((i) => i.key === 'exam')
const RAW_FULL = Number(exItem.rawFull || 100)
const FACTOR = exItem.factor === undefined ? Number(exItem.full) / RAW_FULL : Number(exItem.factor)

console.log('')
console.log('机试项 ' + exItem.full + ' 分 · 卷面 ' + RAW_FULL + ' × ' + FACTOR)

/** 造一份指定卷面总分的卷：选择 + 填空，便于自动判分 */
function paper(total) {
  const per = 5
  const n = Math.floor(total / per)
  const questions = Array.from({ length: n }, (_, i) => ({
    id: 'q' + i, stem: '第 ' + (i + 1) + ' 题', options: ['A', 'B'], answer: 'A',
  }))
  return {
    kind: 'paper', title: 'e2e 卷（' + n * per + ' 分）', duration: 30,
    sections: [{ id: 's1', title: '一、单选（每题 ' + per + ' 分）', type: 'choice', score: per, questions }],
  }
}

let aid = ''
try {
  const made = await j('POST', '/api/assignments', {
    title: 'e2e·机试流程', itemKey: 'exam',
    dueAt: new Date(Date.now() + 3600 * 1000).toISOString(), allowLate: true,
  }, T)
  aid = made.j && made.j.assignment && made.j.assignment.id
  ok('建机试作业 → 201', made.s === 201 && !!aid, 'id=' + aid)
  if (!aid) throw new Error('没拿到 id')
  await j('POST', '/api/assignments/' + aid + '/start', {}, T)

  /* ---------- 卷面满分不匹配 → 警告 ---------- */
  const small = await j('POST', '/api/exams/' + aid + '/paper', { source: paper(30) }, T)
  ok('设 30 分卷 → 200', small.s === 200, 'status=' + small.s)
  ok(
    '卷面与方案不一致时给出警告',
    (small.j.warnings || []).some((w) => w.indexOf('卷面满分') >= 0),
    (small.j.warnings || [])[0] ? String((small.j.warnings || [])[0]).slice(0, 60) + '…' : '(无警告)'
  )

  /* ---------- 按方案出卷 → 无警告 ---------- */
  const full = await j('POST', '/api/exams/' + aid + '/paper', { source: paper(RAW_FULL) }, T)
  ok('设 ' + RAW_FULL + ' 分卷 → 200', full.s === 200, 'status=' + full.s)
  ok('卷面与方案一致时没有警告', (full.j.warnings || []).length === 0, JSON.stringify((full.j.warnings || []).slice(0, 2)))
  ok('卷面满分 = ' + RAW_FULL, full.j.summary && full.j.summary.fullScore === RAW_FULL, String(full.j.summary && full.j.summary.fullScore))

  /* ---------- 学生答题 ---------- */
  const st = await j('POST', '/api/student/exams/' + aid + '/start', {}, stok)
  ok('学生开考 → 200', st.s === 200, 'status=' + st.s)

  const n = Math.floor(RAW_FULL / 5)
  const answers = {}
  for (let i = 0; i < n; i++) answers['q' + i] = i < n - 2 ? 'A' : 'B' // 最后两题故意答错
  await j('POST', '/api/student/exams/' + aid + '/answers', { answers }, stok)
  const sub = await j('POST', '/api/student/exams/' + aid + '/submit', {}, stok)
  const wantAuto = (n - 2) * 5
  ok('交卷自动判分 = ' + wantAuto, sub.j && sub.j.autoScore === wantAuto, sub.j ? String(sub.j.autoScore) : '?')

  /* ---------- 教师判卷面 ---------- */
  const one = await j('GET', '/api/exams/' + aid, undefined, T)
  const row = ((one.j && one.j.rows) || []).find((x) => x.sid === SID)
  ok('教师能看到这份答卷', !!row, row ? 'id=' + row.id : '(没有)')
  if (!row) throw new Error('没有答卷')

  const g100 = await j('POST', '/api/exams/' + aid + '/submissions/' + row.id + '/grade', { raw: RAW_FULL }, T)
  const s100 = g100.j && g100.j.submission
  const want100 = grade.rawScoreOf(exItem, RAW_FULL)
  ok('录卷面 ' + RAW_FULL + ' → ' + want100 + ' 分', s100 && s100.score === want100, s100 ? String(s100.score) : '?')

  const g80 = await j('POST', '/api/exams/' + aid + '/submissions/' + row.id + '/grade', { raw: 80 }, T)
  const s80 = g80.j && g80.j.submission
  const want80 = grade.rawScoreOf(exItem, 80)
  ok('录卷面 80 → ' + want80 + ' 分', s80 && s80.score === want80, s80 ? String(s80.score) : '?')

  /* ---------- 超上限 ---------- */
  const over = await j('POST', '/api/exams/' + aid + '/submissions/' + row.id + '/grade', { raw: RAW_FULL * 5 }, T)
  ok('卷面分超上限 → 400', over.s === 400, 'status=' + over.s)

  /* 关键：校验失败不能把已经有效的成绩弄丢（原来的实现是「先作废旧账再校验」） */
  {
    const my0 = await j('GET', '/api/student/score', undefined, stok)
    const r0 = ((my0.j && my0.j.rows) || []).find((x) => x.key === 'exam')
    ok('校验失败后学生分仍是 ' + want80 + '（没被清掉）', r0 && r0.score === want80, r0 ? String(r0.score) : '?')
  }

  /* ---------- 学生看到的分 = 计分引擎 ---------- */
  {
    const my = await j('GET', '/api/student/score', undefined, stok)
    const r2 = ((my.j && my.j.rows) || []).find((x) => x.key === 'exam')
    ok('学生看到机试分 = ' + want80, r2 && r2.score === want80, r2 ? String(r2.score) : '?')

    // 失败时把证据打出来，别只留一个 0
    if (!r2 || r2.score !== want80) {
      const evs = ((r2 && r2.events) || []).filter((e) => e.item === 'exam' || e.raw !== undefined)
      console.log('     诊断：exam 行共 ' + ((r2 && r2.events) || []).length + ' 条事件')
      for (const e of evs.slice(0, 5)) {
        console.log('       raw=' + JSON.stringify(e.raw) + ' typeof=' + typeof e.raw + ' voided=' + e.voided + ' at=' + (e.createdAt || e.at || ''))
      }
      const ex = await j('GET', '/api/exams/' + aid, undefined, T)
      console.log('      服务端答卷 score=' + JSON.stringify((ex.j.rows || []).map((x) => x.score)))
    }
  }
} finally {
  if (aid) await j('DELETE', '/api/assignments/' + aid, undefined, T)
}

console.log('')
console.log(fail === 0 ? '机试全链路：全部通过 ✓' : '机试全链路：有失败 ✗')
console.log('（通过 ' + pass + ' · 失败 ' + fail + '）')
process.exit(fail === 0 ? 0 : 1)
