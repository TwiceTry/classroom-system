/**
 * 导出类接口全量体检：每个都要能拿到**合法 zip**，且结构对得上。
 * 只读操作，不改任何数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readZip } from 'file:///e:/myItems/frontend-teach/课堂系统/api/src/lib/zip.js'

const BASE = 'http://127.0.0.1:18730'
const ROOT = 'e:/myItems/frontend-teach/课堂系统'
const cfg = JSON.parse(fs.readFileSync(ROOT + '/data/config.json', 'utf8'))

let pass = 0
let fail = 0
const bad = []
const ok = (name, cond, info) => {
  if (cond) {
    pass++
    console.log('  ✓ ' + name + (info ? '  → ' + info : ''))
  } else {
    fail++
    bad.push(name + (info ? '  → ' + info : ''))
    console.log('  ✗ ' + name + (info ? '  → ' + info : ''))
  }
}

const t = await fetch(BASE + '/api/auth/login/teacher', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: cfg.teacherPassword || 'teacher' }),
}).then((r) => r.json())
const H = { authorization: 'Bearer ' + t.token }

const courses = await fetch(BASE + '/api/courses', { headers: H }).then((r) => r.json())
const course = courses.items[0]
const cid = course.id
const classes = await fetch(BASE + '/api/classes', { headers: H }).then((r) => r.json())
const cls = classes.items[0]

/** 取二进制并校验是 zip（PK 开头）+ 能解析 */
async function getZip(label, url, opts) {
  const r = await fetch(BASE + url, { headers: H })
  if (r.status !== 200) {
    ok(label, false, 'status=' + r.status + ' ' + (await r.text()).slice(0, 80))
    return null
  }
  const buf = Buffer.from(await r.arrayBuffer())
  const isPk = buf[0] === 0x50 && buf[1] === 0x4b
  if (!isPk) {
    ok(label, false, '不是 zip（前 2 字节 ' + buf[0] + ',' + buf[1] + '）')
    return null
  }
  let files = []
  try {
    files = readZip(buf)
  } catch (e) {
    ok(label, false, 'zip 解析失败：' + e.message)
    return null
  }
  ok(label, files.length > 0, (buf.length / 1024).toFixed(0) + 'KB · ' + files.length + ' 个文件')
  return { buf, files }
}

console.log('\n=== 1. 课程包导出 ===')
const pack = await getZip('整课导出 package.zip', '/api/courses/' + cid + '/package.zip')
if (pack) {
  const names = pack.files.map((f) => f.name)
  ok('  含 pack.json', names.some((n) => /pack\.json$/.test(n)))
  ok('  含 course.json', names.some((n) => /course\.json$/.test(n)))
  ok('  含 scheme.json', names.some((n) => /scheme\.json$/.test(n)))
  ok('  含 classes/index.json', names.some((n) => /classes\/index\.json$/.test(n)))
  ok('  含内容（lecture/materials/代码示例）', names.some((n) => /content\/lecture\//.test(n)) && names.some((n) => /content\/materials\//.test(n)))
  ok('  不含 node_modules / .git', !names.some((n) => /node_modules|\.git\//.test(n)))
}

const sum = await fetch(BASE + '/api/courses/' + cid + '/package/summary', { headers: H }).then(async (r) => ({ s: r.status, j: await r.json() }))
ok('导出前体检 summary', sum.s === 200 && sum.j && (sum.j.files !== undefined || sum.j.counts), JSON.stringify(sum.j).slice(0, 120))

console.log('\n=== 2. 内容目录导出（5 个类别）===')
for (const dir of ['lecture', 'materials', '代码示例', 'exams', 'assets']) {
  await getZip('内容导出 ' + dir, '/api/courses/' + cid + '/content.zip?dir=' + encodeURIComponent(dir))
}

console.log('\n=== 3. 各类模板 ===')
for (const [label, url] of [
  ['课程包模板', '/api/courses/template.zip'],
  ['班级包模板', '/api/courses/' + cid + '/classes/template.zip'],
  ['内容目录模板 lecture', '/api/courses/' + cid + '/content/template.zip?dir=lecture'],
  ['作业库模板', '/api/courses/' + cid + '/designs/template.zip'],
]) {
  await getZip(label, url)
}

console.log('\n=== 4. 班级包 / 成绩表 ===')
await getZip('班级包导出 classes.zip', '/api/courses/' + cid + '/classes.zip')
{
  // 这个是 CSV（成绩表），不是 zip —— 单独判
  const r = await fetch(BASE + '/api/classes/' + cls.id + '/export', { headers: H })
  const txt = await r.text()
  const head = txt.split(/\r?\n/)[0] || ''
  ok('成绩表导出是 CSV', r.status === 200 && /学号/.test(head), r.status + ' · 首行: ' + head.slice(0, 60))
}

console.log('\n=== 5. 方案导出 ===')
{
  const r = await fetch(BASE + '/api/scheme/export.json', { headers: H })
  const j = await r.json().catch(() => null)
  ok('方案导出 export.json', r.status === 200 && j && j.items, j ? 'items=' + (j.items || []).length + ' 项' : 'status=' + r.status)
}

console.log('\n=== 6. 作业库（设计稿）清单 ===')
{
  const r = await fetch(BASE + '/api/courses/' + cid + '/designs', { headers: H })
  const j = await r.json().catch(() => null)
  ok('作业库清单可读', r.status === 200 && Array.isArray(j.items), j && Array.isArray(j.items) ? j.items.length + ' 个设计稿' : 'status=' + r.status)
}

console.log('\n' + (fail === 0 ? '全部通过 ✓' : '有失败 ✗') + '（通过 ' + pass + ' · 失败 ' + fail + '）')
if (bad.length) {
  console.log('\n失败项：')
  for (const b of bad) console.log('  · ' + b)
}
process.exit(fail === 0 ? 0 : 1)
