/**
 * 导出总评 / 流水 / 名单 / 模板：xlsx 内容验证
 *
 * 对照标准：
 *   数字部分 —— 页面上的 board 是唯一真相，逐人逐项要一致
 *   类型部分 —— 学号必须是**文本**（否则 Excel 把 2025010101 显示成 2.025E+09），
 *               分数必须是**数字**（否则老师没法求和排序）
 */
import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'

const BASE = 'http://127.0.0.1:18730'
/** 仓库根：api/src/test → ../.. = api → ../../.. = 仓库根 */
const ROOT = path.join(import.meta.dirname, '../../../')
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

const cls = (await fetch(BASE + '/api/classes', { headers: H }).then((r) => r.json())).items[0]
console.log('班级：' + cls.name)

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** 取 xlsx 并解析成二维数组 + 原始单元格类型 */
async function getSheet(url) {
  const r = await fetch(BASE + url, { headers: H })
  if (r.status !== 200) return { status: r.status, err: (await r.text()).slice(0, 120) }
  const buf = Buffer.from(await r.arrayBuffer())
  const ct = r.headers.get('content-type') || ''
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  const ws = wb.worksheets[0]
  const rows = []
  const types = [] // 每行的单元格类型（1=数字 3=字符串 …）
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = []
    const ts = []
    for (let c = 1; c <= row.cellCount; c++) {
      const cell = row.getCell(c)
      vals.push(cell.value === null || cell.value === undefined ? '' : cell.value)
      ts.push(cell.type)
    }
    rows.push(vals)
    types.push(ts)
  })
  return { status: r.status, buf, ct, rows, types, sheetName: ws.name }
}

console.log('\n=== 1. 导出总评（xlsx）===')
const tot = await getSheet('/api/classes/' + cls.id + '/export?kind=totals')
ok('接口 200', tot.status === 200, tot.status + (tot.err ? ' ' + tot.err : ''))
ok('Content-Type 是 xlsx', (tot.ct || '').indexOf(XLSX_TYPE) !== -1, tot.ct)
ok('是真 zip（PK 开头）', tot.buf && tot.buf[0] === 0x50 && tot.buf[1] === 0x4b, tot.buf ? tot.buf.length + ' 字节' : '')
ok('工作表名是「总评」', tot.sheetName === '总评', tot.sheetName)

const head = tot.rows[0] || []
console.log('  表头：' + head.join(' | '))
ok('表头首列「学号」', head[0] === '学号', JSON.stringify(head[0]))

const sc = await fetch(BASE + '/api/classes/' + cls.id + '/scores', { headers: H }).then((r) => r.json())
const list = (sc.board && sc.board.list) || []
const items = sc.items || []
console.log('  页面 ' + list.length + ' 人 · ' + items.length + ' 项 · xlsx 数据行 ' + (tot.rows.length - 1))
ok('行数 = 名单人数', tot.rows.length - 1 === list.length, tot.rows.length - 1 + ' vs ' + list.length)
ok('列数 = 学号+姓名+各项+总评', head.length === items.length + 3, head.length + ' vs ' + (items.length + 3))

// 学号必须是文本（关键：防科学计数法）
const sidCells = tot.types.slice(1).map((ts) => ts[0])
const sidIsText = sidCells.every((tp) => tp === 3)
ok('学号列是文本格式（不会变 2.02E+09）', sidIsText, '类型集合=' + [...new Set(sidCells)].join(','))
const sidSample = String(tot.rows[1] && tot.rows[1][0])
ok('学号完整保留（前导 0 不丢）', sidSample === list[0].student.sid, sidSample + ' vs ' + list[0].student.sid)

// 分数必须是数字
const scoreTypes = new Set()
for (let k = 1; k < tot.types.length; k++) for (let c = 2; c < items.length + 3; c++) scoreTypes.add(tot.types[k][c])
ok('分数列是数字类型（可求和）', [...scoreTypes].every((x) => x === 1 || x === 2), '类型集合=' + [...scoreTypes].join(','))

// 逐人逐项
let mismatch = 0
let firstBad = ''
for (let k = 0; k < list.length; k++) {
  const stu = list[k]
  const row = tot.rows[k + 1]
  if (!row) {
    mismatch++
    continue
  }
  if (String(row[0]) !== stu.student.sid) {
    mismatch++
    if (!firstBad) firstBad = '第' + (k + 2) + '行学号 ' + row[0] + ' ≠ ' + stu.student.sid
    continue
  }
  for (let j = 0; j < items.length; j++) {
    const want = (stu.rows.find((x) => x.item.key === items[j].key) || {}).score
    const w = Number(want === undefined || want === null ? 0 : want)
    const got = Number(row[2 + j] === '' ? 0 : row[2 + j])
    if (got !== w) {
      mismatch++
      if (!firstBad) firstBad = stu.student.name + '「' + (items[j].short || items[j].name) + '」xlsx=' + got + ' 页面=' + w
    }
  }
  const gotTotal = Number(row[row.length - 1] === '' ? 0 : row[row.length - 1])
  if (gotTotal !== Number(stu.total)) {
    mismatch++
    if (!firstBad) firstBad = stu.student.name + ' 总评 xlsx=' + gotTotal + ' 页面=' + stu.total
  }
}
ok('逐人逐项与页面一致', mismatch === 0, mismatch ? mismatch + ' 处不符，首例：' + firstBad : list.length + ' 人 × ' + (items.length + 1) + ' 列全对')

console.log('\n=== 2. 导出流水（xlsx）===')
const ev = await getSheet('/api/classes/' + cls.id + '/export?kind=events')
ok('接口 200', ev.status === 200, ev.status)
ok('工作表名是「记分记录」', ev.sheetName === '记分记录', ev.sheetName)
console.log('  表头：' + (ev.rows[0] || []).join(' | '))
const dbEvents = sc.events || []
ok('行数 = 记分记录数', ev.rows.length - 1 === dbEvents.length, ev.rows.length - 1 + ' vs ' + dbEvents.length)
const voidedDb = dbEvents.filter((e) => e.voided || e.voidedAt).length
const voidedXlsx = ev.rows.slice(1).filter((r) => String(r.join(' ')).indexOf('已撤销') !== -1).length
ok('已撤销记录带「已撤销」', voidedDb === 0 || voidedXlsx > 0, '库里 ' + voidedDb + ' · xlsx ' + voidedXlsx)
ok('时间列是文本（不被 Excel 改格式）', ev.types.slice(1).every((ts) => ts[0] === 3), '首行类型=' + (ev.types[1] || [])[0])

console.log('\n=== 3. 名单导出（xlsx）===')
const ros = await getSheet('/api/classes/' + cls.id + '/roster.xlsx')
ok('接口 200', ros.status === 200, ros.status)
ok('表头「学号,姓名,备注」', (ros.rows[0] || []).join(',') === '学号,姓名,备注', (ros.rows[0] || []).join(','))
ok('行数 = 名单人数', ros.rows.length - 1 === list.length, ros.rows.length - 1 + ' vs ' + list.length)
ok('学号是文本', ros.types.slice(1).every((ts) => ts[0] === 3), '类型=' + [...new Set(ros.types.slice(1).map((x) => x[0]))].join(','))
ok('第一个学号与名单一致', String(ros.rows[1][0]) === list[0].student.sid, String(ros.rows[1][0]))

console.log('\n=== 4. 名单空模板（xlsx）===')
const tpl = await getSheet('/api/classes/' + cls.id + '/roster/template.xlsx')
ok('接口 200', tpl.status === 200, tpl.status)
ok('表头三列', (tpl.rows[0] || []).join(',') === '学号,姓名,备注', (tpl.rows[0] || []).join(','))
ok('带 2 行示例', tpl.rows.length === 3, tpl.rows.length + ' 行（含表头）')
ok('示例学号是文本', tpl.types[1] && tpl.types[1][0] === 3, '类型=' + (tpl.types[1] || [])[0])

console.log('\n' + (fail === 0 ? '全部通过 ✓' : '有失败 ✗') + '（通过 ' + pass + ' · 失败 ' + fail + '）')
if (bad.length) {
  console.log('\n失败项：')
  for (const b of bad) console.log('  · ' + b)
}
process.exit(fail === 0 ? 0 : 1)
