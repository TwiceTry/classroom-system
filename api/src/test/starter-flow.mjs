/**
 * 课堂作业的「起手代码」三层状态（e2e，需要服务在 18730 跑着）
 *
 *   ① 起手代码   data/assignments/<作业id>/code/          全班共用，题目初始状态
 *   ② 我的提交   data/students/<班级>/<学号>/作业/<作业id>/  点提交时冻结
 *   ③ 本地草稿   浏览器 localStorage                        前端自己管
 *
 * 取用顺序：有提交 → ②；没有 → ①；都没有 → 空。
 * 「恢复最初状态」= 强制 ①，但**不动 ②**（提交上挂着分数，删了等于撤分）。
 *
 * 这条链以前整段是断的：建作业不落 code/，工作台又只会拉 /api/examples，
 * 于是学生打开作业看到的是课程示例，而不是自己那份。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const B = process.env.TS_BASE || 'http://127.0.0.1:18730'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/config.json'), 'utf8'))
const PWD = String(cfg.teacherPassword || 'teacher').trim()

let pass = 0
let fail = 0
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n + (d ? '  → ' + d : '')) }
  else { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')) }
}

const j = async (m, u, b, tk) => {
  const o = { method: m, headers: { 'content-type': 'application/json' } }
  if (tk) o.headers.authorization = 'Bearer ' + tk
  if (b !== undefined) o.body = JSON.stringify(b)
  const r = await fetch(B + u, o)
  const t = await r.text()
  let x = null
  try { x = JSON.parse(t) } catch (e) { /* */ }
  return { s: r.status, j: x }
}

const T = (await j('POST', '/api/auth/login/teacher', { password: PWD })).j.token
const SID = '2515230114'
const S = (await j('POST', '/api/auth/login/student', { sid: SID, name: '马婷婷', courseId: 'web-front-dev' })).j.token

let aid = ''
try {
  /* ---------- 建作业就该有起手代码 ---------- */
  const made = await j('POST', '/api/assignments', { title: 'e2e·起手代码', itemKey: 'homework' }, T)
  aid = made.j.assignment.id
  ok('建作业 → 201', made.s === 201 && !!aid, 'id=' + aid)
  ok('codeSource = starter（没绑示例目录）', made.j.assignment.codeSource === 'starter', String(made.j.assignment.codeSource))
  ok('hasStarter = true（真去磁盘看的）', made.j.assignment.hasStarter === true, String(made.j.assignment.hasStarter))

  const codeDir = path.join(ROOT, 'data/assignments', aid, 'code')
  ok('磁盘上落了 code/index.html', fs.existsSync(path.join(codeDir, 'index.html')), codeDir.replace(ROOT, ''))

  await j('POST', '/api/assignments/' + aid + '/start', {}, T)

  /* ---------- 第一次打开：给起手代码 ---------- */
  const c1 = await j('GET', '/api/assignments/' + aid + '/code', undefined, S)
  ok('第一次打开 → 200', c1.s === 200, 'status=' + c1.s)
  ok('source = starter', c1.j.source === 'starter', String(c1.j.source))
  ok('dir 用 @a: 前缀（本地草稿按它分桶）', String(c1.j.dir).indexOf('@a:') === 0, String(c1.j.dir))
  ok('拿到 index.html', (c1.j.files || []).some((f) => f.path === 'index.html'), (c1.j.files || []).map((f) => f.path).join(','))

  /* ---------- 提交后再打开：给「我提交的那份」 ---------- */
  await j('POST', '/api/student/assignments/' + aid + '/submit', {
    files: [
      { path: 'index.html', text: '<h1>改过了</h1>' },
      { path: 'app.js', text: 'console.log(1)' },
    ],
  }, S)

  const c2 = await j('GET', '/api/assignments/' + aid + '/code', undefined, S)
  ok('交过之后 source = submission', c2.j.source === 'submission', String(c2.j.source))
  ok('dir 用 @s: 前缀', String(c2.j.dir).indexOf('@s:') === 0, String(c2.j.dir))
  ok(
    '内容是自己交的那份',
    (c2.j.files || []).some((f) => f.path === 'index.html' && f.text.indexOf('改过了') >= 0),
    (c2.j.files || []).map((f) => f.path).join(',')
  )

  /* ---------- 恢复最初状态：给起手代码，但不删提交 ---------- */
  const c3 = await j('GET', '/api/assignments/' + aid + '/code?from=starter', undefined, S)
  ok('?from=starter → source = starter', c3.j.source === 'starter', String(c3.j.source))
  ok('恢复出来的是起手代码（不是提交内容）', !(c3.j.files || []).some((f) => f.text.indexOf('改过了') >= 0), (c3.j.files || []).length + ' 个文件')

  const det = await j('GET', '/api/student/assignments/' + aid, undefined, S)
  ok('恢复之后提交还在（分数不会丢）', (det.j.mine || []).length === 1, 'mine=' + (det.j.mine || []).length)
  ok('提交的文件也还在', JSON.stringify((det.j.mine[0] || {}).files) === '["index.html","app.js"]', JSON.stringify((det.j.mine[0] || {}).files))

  const c4 = await j('GET', '/api/assignments/' + aid + '/code', undefined, S)
  ok('不带参数再取 → 仍给提交', c4.j.source === 'submission', String(c4.j.source))

  /* ---------- 越权：别人拿不到我的 ---------- */
  const other = (await j('POST', '/api/auth/login/student', { sid: '2515270101', name: '王志博', courseId: 'web-front-dev' })).j.token
  const c5 = await j('GET', '/api/assignments/' + aid + '/code', undefined, other)
  ok('别人取 → 拿到的是起手代码（他没交过）', c5.s === 200 && c5.j.source === 'starter', 'status=' + c5.s + ' source=' + (c5.j && c5.j.source))

  /* ---------- 删作业要顺手清掉 code/ ---------- */
  const del = await j('DELETE', '/api/assignments/' + aid, undefined, T)
  ok('删作业 → 204', del.s === 204, 'status=' + del.s)
  ok('data/assignments/<id>/ 已清掉（不留垃圾）', !fs.existsSync(path.join(ROOT, 'data/assignments', aid)), path.join('data/assignments', aid))
  aid = ''
} finally {
  if (aid) await j('DELETE', '/api/assignments/' + aid, undefined, T)
}

console.log('')
console.log(fail === 0 ? '起手代码三层状态：全部通过 ✓' : '起手代码三层状态：有失败 ✗')
console.log('（通过 ' + pass + ' · 失败 ' + fail + '）')
process.exit(fail === 0 ? 0 : 1)
