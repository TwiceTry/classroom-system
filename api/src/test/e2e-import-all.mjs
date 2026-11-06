/**
 * 导入类接口体检：**用自己刚导出的东西再导回去**，期望「未变」。
 * inspect 是干跑，不写数据；只对 assets 做一次真 apply（内容完全一致，无副作用）。
 */
import fs from 'node:fs'

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
const arr = (v) => (Array.isArray(v) ? v.length : Number(v || 0))

const t = await fetch(BASE + '/api/auth/login/teacher', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: cfg.teacherPassword || 'teacher' }),
}).then((r) => r.json())
const H = { authorization: 'Bearer ' + t.token }

const course = (await fetch(BASE + '/api/courses', { headers: H }).then((r) => r.json())).items[0]
const cid = course.id
const cls = (await fetch(BASE + '/api/classes', { headers: H }).then((r) => r.json())).items[0]

const getBin = (url) => fetch(BASE + url, { headers: H }).then((r) => r.arrayBuffer())
const postBin = async (url, buf) => {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: { authorization: H.authorization, 'content-type': 'application/zip' },
    body: Buffer.from(buf),
  })
  const txt = await r.text()
  let j = null
  try {
    j = JSON.parse(txt)
  } catch (e) {}
  return { s: r.status, j, txt }
}
const postJson = async (url, obj) => {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: { authorization: H.authorization, 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  })
  const txt = await r.text()
  let j = null
  try {
    j = JSON.parse(txt)
  } catch (e) {}
  return { s: r.status, j, txt }
}

console.log('\n=== 1. 内容目录：导出 → 干跑（应全部「未变」）===')
const zips = {}
for (const dir of ['lecture', 'materials', '代码示例', 'exams', 'assets']) {
  const buf = await getBin('/api/courses/' + cid + '/content.zip?dir=' + encodeURIComponent(dir))
  zips[dir] = buf
  const r = await postBin('/api/courses/' + cid + '/content/inspect?dir=' + encodeURIComponent(dir), buf)
  const j = r.j || {}
  ok(
    '干跑 ' + dir,
    r.s === 200 && arr(j.unchanged) === j.total && arr(j.added) === 0 && arr(j.changed) === 0,
    r.s + ' · 共' + j.total + ' 未变' + arr(j.unchanged) + ' 新增' + arr(j.added) + ' 变更' + arr(j.changed)
  )
}

console.log('\n=== 2. 内容目录：真导入 assets（内容一致，应无变化）===')
{
  const cntOf = async () => {
    const c = await fetch(BASE + '/api/courses/' + cid, { headers: H }).then((r) => r.json())
    return (c.content || []).find((x) => x.dir === 'assets').files
  }
  const before = await cntOf()
  const r = await postBin('/api/courses/' + cid + '/content/apply?dir=assets&mode=merge', zips['assets'])
  const after = await cntOf()
  ok('apply assets 成功', r.s === 200, r.s + ' ' + JSON.stringify(r.j).slice(0, 100))
  ok('导入后文件数不变', before === after, before + ' → ' + after)
}

console.log('\n=== 3. 班级包：导出 → 干跑 ===')
{
  const buf = await getBin('/api/courses/' + cid + '/classes.zip')
  const r = await postBin('/api/courses/' + cid + '/classes/inspect', buf)
  const cs = (r.j && r.j.classes) || []
  ok('班级包干跑', r.s === 200 && cs.length === 2, r.s + ' · ' + cs.length + ' 个班 · ' + cs.map((c) => c.name + ':' + c.before + '→' + c.after).join(' / '))
  ok('干跑不落盘（before=after）', cs.every((c) => c.before === c.after && c.added === 0 && c.removed === 0), JSON.stringify(cs.map((c) => c.added + '/' + c.removed)))
}

console.log('\n=== 4. 名单：前端格式（学号,姓名,备注）干跑 ===')
{
  // 拿真实名单拼一份，再导回去（应与现状完全一致）
  const scores = await fetch(BASE + '/api/classes/' + cls.id + '/scores', { headers: H }).then((r) => r.json())
  const lines = ['学号,姓名,备注']
  for (const s of scores.students || []) lines.push(s.sid + ',' + (s.name || '') + ',')
  const csv = lines.join('\r\n')
  // 后端 parseRoster 认 `text`（粘贴文本）或 `students`（数组），不是 csv
  const inspect = await postJson('/api/classes/' + cls.id + '/roster/inspect', { text: csv, mode: 'merge' })
  ok('名单干跑', inspect.s === 200 && inspect.j, inspect.s + ' · ' + JSON.stringify(inspect.j).slice(0, 160))
  if (inspect.j) console.log('      字段: ' + Object.keys(inspect.j).join(', '))
}

console.log('\n=== 5. 方案：导出 → 干跑 ===')
{
  const sch = await fetch(BASE + '/api/scheme/export.json', { headers: H }).then((r) => r.json())
  const r = await postJson('/api/scheme/inspect', sch)
  ok('方案干跑', r.s === 200 && r.j && r.j.ok === true, r.s + ' · ' + JSON.stringify(r.j && r.j.diff).slice(0, 120))
}

console.log('\n' + (fail === 0 ? '全部通过 ✓' : '有失败 ✗') + '（通过 ' + pass + ' · 失败 ' + fail + '）')
if (bad.length) {
  console.log('\n失败项：')
  for (const b of bad) console.log('  · ' + b)
}
process.exit(fail === 0 ? 0 : 1)
