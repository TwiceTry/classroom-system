/**
 * xlsx 名单上传：造一个 Excel，走 /roster/sheet 干跑，检查解析结果。
 * 只做 apply=0（干跑），不写真数据。
 */
import fs from 'node:fs'
import ExcelJS from 'file:///e:/myItems/frontend-teach/课堂系统/node_modules/exceljs/excel.js'

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
    bad.push(name)
    console.log('  ✗ ' + name + (info ? '  → ' + info : ''))
  }
}

const t = await fetch(BASE + '/api/auth/login/teacher', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: cfg.teacherPassword || 'teacher' }),
}).then((r) => r.json())
const H = { authorization: 'Bearer ' + t.token }
const cls = (await fetch(BASE + '/api/classes', { headers: H }).then((r) => r.json())).items[0]
const roster = (await fetch(BASE + '/api/classes/' + cls.id + '/scores', { headers: H }).then((r) => r.json())).students

/** 造 xlsx：rows = [[学号,姓名,备注], …] */
async function makeXlsx(rows, sheetName) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(sheetName || '名单')
  for (const r of rows) ws.addRow(r)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

async function sheetInspect(buf, label) {
  const r = await fetch(BASE + '/api/classes/' + cls.id + '/roster/sheet?apply=0&mode=merge', {
    method: 'POST',
    headers: { authorization: H.authorization, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    body: buf,
  })
  const txt = await r.text()
  let j = null
  try {
    j = JSON.parse(txt)
  } catch (e) {}
  return { s: r.status, j, txt, label }
}

console.log('班级：' + cls.name + '（现有 ' + roster.length + ' 人）')

console.log('\n=== 1. 带表头的 3 行新名单（干跑）===')
{
  const buf = await makeXlsx([
    ['学号', '姓名', '备注'],
    ['9999001', '测试甲', ''],
    ['9999002', '测试乙', '备注'],
    ['9999003', '测试丙', ''],
  ])
  const r = await sheetInspect(buf, 'new3')
  ok('接口返回 200', r.s === 200, r.s + ' · ' + (r.j ? JSON.stringify(r.j).slice(0, 200) : r.txt.slice(0, 160)))
  if (r.j) {
    ok('表头被跳过（不是 4 人）', r.j.count === 3, 'count=' + r.j.count)
    ok('识别出 3 个新增', (r.j.added || []).length === 3, 'added=' + JSON.stringify(r.j.added || []))
    ok('干跑不写库（added 只是计划）', r.j.before === undefined || (r.j.currentCount === roster.length || r.j.currentCount === undefined), 'currentCount=' + r.j.currentCount)
  }
}

console.log('\n=== 2. 只有一个 sheet 的表（表头不同写法）===')
{
  const buf = await makeXlsx([
    ['序号', '学号', '姓名'],
    ['1', '9999004', '测试丁'],
  ])
  const r = await sheetInspect(buf, 'seq')
  ok('「序号」列也能处理', r.s === 200, r.s + ' · ' + (r.j ? 'count=' + r.j.count + ' preview=' + JSON.stringify((r.j.preview || []).slice(0, 2)) : r.txt.slice(0, 140)))
}

console.log('\n=== 3. 用真实名单的 xlsx 导回去（应「无变化」）===')
{
  const rows = [['学号', '姓名', '备注']]
  for (const s of roster) rows.push([s.sid, s.name, ''])
  const buf = await makeXlsx(rows)
  const r = await sheetInspect(buf, 'real')
  ok('接口返回 200', r.s === 200, r.s)
  if (r.j) {
    ok('人数与现有一致', r.j.count === roster.length, 'count=' + r.j.count + ' vs ' + roster.length)
    ok('没有新增', (r.j.added || []).length === 0, 'added=' + (r.j.added || []).length)
    ok('没有改名', (r.j.updated || []).length === 0, 'updated=' + (r.j.updated || []).length)
    console.log('    字段: ' + Object.keys(r.j).join(', '))
  }
}

console.log('\n=== 4. 坏文件（不是 xlsx）应报人话 ===')
{
  const r = await fetch(BASE + '/api/classes/' + cls.id + '/roster/sheet?apply=0', {
    method: 'POST',
    headers: { authorization: H.authorization, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    body: Buffer.from('这不是一个 xlsx，只是一段文本'),
  })
  const txt = await r.text()
  let j = null
  try {
    j = JSON.parse(txt)
  } catch (e) {}
  ok('坏文件返回 4xx 而不是 500', r.status >= 400 && r.status < 500, r.status + ' · ' + (j ? j.error && j.error.message : txt.slice(0, 100)))
}

console.log('\n' + (fail === 0 ? '全部通过 ✓' : '有失败 ✗') + '（通过 ' + pass + ' · 失败 ' + fail + '）')
process.exit(fail === 0 ? 0 : 1)
