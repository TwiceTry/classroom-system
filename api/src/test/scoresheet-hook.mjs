/**
 * 学生目录里的分数表：给分后会不会自动刷新
 *
 * 这条链曾经断过（重构时函数搬了、调用点没搬），所以必须有测试卡住：
 * 插入一条记分 → 等去抖 → 学生目录里应出现 总评.xlsx / 明细.xlsx；
 * 撤销 → 明细里那条应变成「已撤销」。
 *
 * 用临时班级 + 临时学生，测完删干净，不碰真实数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'

const ROOT = path.join(import.meta.dirname, '../../../')
const LIB = 'file:///' + path.join(ROOT, 'api/src/lib/').replace(/\\/g, '/') + '/'
const repo = await import(LIB + 'repo.js')
const students = await import(LIB + 'students.js')
const scoresheet = await import(LIB + 'scoresheet.js')

const CID = 'hooktest-' + Date.now().toString(36)
const SID = 'T0001'

let pass = 0
let fail = 0
const ok = (n, c, info) => {
  if (c) {
    pass++
    console.log('  ✓ ' + n + (info ? '  → ' + info : ''))
  } else {
    fail++
    console.log('  ✗ ' + n + (info ? '  → ' + info : ''))
  }
}

const base = students.dirOf(CID, SID)
console.log('临时班级：' + CID + ' · 学生：' + SID)

repo.insertClass({ id: CID, name: '钩子测试班', courseId: (repo.listCourses()[0] || {}).id || '' })
repo.addStudents(CID, [{ sid: SID, name: '测试学生' }])
ok('临时班级与学生已建', !!repo.getClass(CID))

// 注册真钩子（和 server.js 一致）
repo.setEventHook((classId, sid) => scoresheet.schedule(classId, sid))

console.log('\n=== 插入一条记分，等 700ms 让去抖触发 ===')
const ev = repo.insertEvent({
  id: 'ev-' + Date.now().toString(36),
  classId: CID,
  sid: SID,
  item: 'interact',
  delta: 2,
  kind: 'manual',
  reason: '钩子测试',
  operator: '测试',
  createdAt: new Date().toISOString(),
})
ok('记分已写入', !!ev)

await new Promise((r) => setTimeout(r, 700))

const f1 = path.join(base, '记分', '总评.xlsx')
const f2 = path.join(base, '记分', '明细.xlsx')
ok('总评.xlsx 已自动生成', fs.existsSync(f1), fs.existsSync(f1) ? Math.round(fs.statSync(f1).size / 1024) + 'KB' : '不存在')
ok('明细.xlsx 已自动生成', fs.existsSync(f2))

if (fs.existsSync(f2)) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(fs.readFileSync(f2))
  const n = wb.worksheets[0].rowCount - 1
  ok('明细里正好 1 条记录', n === 1, '行数=' + n)
}

console.log('\n=== 撤销这条记分 ===')
repo.voidEvent(CID, ev.id, '测试撤销')
await new Promise((r) => setTimeout(r, 700))
if (fs.existsSync(f2)) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(fs.readFileSync(f2))
  let status = ''
  wb.worksheets[0].eachRow((r, i) => {
    if (i > 1) status = String(r.getCell(6).value || '')
  })
  ok('撤销后明细状态变成「已撤销」', status === '已撤销', '状态=' + status)
}

console.log('\n=== 清理 ===')
repo.deleteClass(CID)
try {
  fs.rmSync(path.join(ROOT, 'data/students', CID), { recursive: true, force: true })
} catch (e) {}
repo.setEventHook(null)
ok('临时班级已删', !repo.getClass(CID))
ok('临时目录已删', !fs.existsSync(path.join(ROOT, 'data/students', CID)))

console.log('\n' + (fail === 0 ? '全部通过 ✓' : '有失败 ✗') + '（通过 ' + pass + ' · 失败 ' + fail + '）')
repo.closeDb()
process.exit(fail === 0 ? 0 : 1)
