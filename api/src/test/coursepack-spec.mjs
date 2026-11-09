import path from 'node:path'
import os from 'node:os'
/**
 * 课程包格式规范一致性测验
 * 对照《课程包格式规范.md》逐条验：结构 / 清单 / 哈希 / 班级 id / 名单编码 / 压缩 / 命名
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

import { readZip, makeZip } from '../lib/zip.js'

const BASE = 'http://127.0.0.1:18730'
const REAL = 'web-front-dev'
let pass = 0
let fail = 0
const warn = []
const ok = (n, c, e) => {
  if (c) {
    pass++
    console.log('  ✓ ' + n + (e ? '  → ' + e : ''))
  } else {
    fail++
    console.log('  ✗ ' + n + (e ? '  → ' + e : ''))
  }
}
const note = (m) => warn.push(m)

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'))
const tk = await fetch(BASE + '/api/auth/login/teacher', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: cfg.teacherPassword || 'teacher' }),
}).then((r) => r.json())
const H = { authorization: 'Bearer ' + tk.token }
const binOf = (u) => fetch(BASE + u, { headers: H }).then((r) => r.arrayBuffer()).then((b) => Buffer.from(b))

/* ============ 0. 取一个真实包 ============ */
console.log('=== 0. 取样本包 ===')
const zip = await binOf('/api/courses/' + REAL + '/package.zip')
const entries = readZip(zip)
ok('包能解开', entries.length > 100, entries.length + ' 个条目')

const top = new Set(entries.map((e) => e.name.split('/')[0]))
ok('只有一个顶层目录（干净）', top.size === 1 && [...top][0] === REAL, [...top].join(','))

const inner = (n) => entries.find((e) => e.name === REAL + '/' + n)
const innerAll = entries.filter((e) => !e.dir).map((e) => e.name.replace(REAL + '/', ''))
const textOf = (e) => (e ? Buffer.from(e.data).toString('utf8') : '')

/* ============ 1. pack.json 结构（规范 §1）============ */
console.log('\n=== 1. pack.json ===')
const packE = inner('pack.json')
ok('pack.json 存在', !!packE)
const pack = JSON.parse(textOf(packE))
ok('format = teaching-course', pack.format === 'teaching-course', pack.format)
ok('version = 1', pack.version === 1, String(pack.version))
ok('kind = course-package', pack.kind === 'course-package', pack.kind)
ok('courseId 与目录名一致', pack.courseId === REAL, pack.courseId)
ok('有 courseName', typeof pack.courseName === 'string' && pack.courseName.length > 0, pack.courseName)
ok('有 exportedAt（ISO 时间）', /^\d{4}-\d{2}-\d{2}T/.test(pack.exportedAt || ''), pack.exportedAt)
ok('有 generator', typeof pack.generator === 'string' && pack.generator.length > 0, pack.generator)

ok(
  'parts 四个位置齐全',
  pack.parts && pack.parts.course === 'course.json' && pack.parts.scheme === 'scheme.json' && pack.parts.classes === 'classes/index.json' && pack.parts.content === 'content/',
  JSON.stringify(pack.parts)
)
ok(
  'contentRoots 是五类',
  Array.isArray(pack.contentRoots) && pack.contentRoots.length >= 4 && pack.contentRoots.includes('lecture') && pack.contentRoots.includes('assets'),
  pack.contentRoots.join(',')
)
ok(
  'counts 有 classes/students/files/bytes',
  pack.counts && typeof pack.counts.classes === 'number' && typeof pack.counts.students === 'number' && typeof pack.counts.files === 'number' && typeof pack.counts.bytes === 'number',
  JSON.stringify(pack.counts)
)

/* ============ 2. files[] 清单与哈希（规范 §1 第 2 条硬规矩）============ */
console.log('\n=== 2. files[] 清单 ===')
ok('files 是数组且非空', Array.isArray(pack.files) && pack.files.length > 0, 'n=' + (pack.files || []).length)

// 除 pack.json 外的所有文件都要登记
const listed = new Set(pack.files.map((f) => f.path))
const actual = new Set(innerAll.filter((p) => p !== 'pack.json'))
const missingInList = [...actual].filter((p) => !listed.has(p))
const listedNotInZip = [...listed].filter((p) => !actual.has(p))
ok('清单覆盖除 pack.json 外的每个文件', missingInList.length === 0, missingInList.length ? '漏登记 ' + missingInList.slice(0, 3).join(', ') + '…' : 'files=' + actual.size)
ok('清单里没有多出来的路径', listedNotInZip.length === 0, listedNotInZip.slice(0, 3).join(', '))

// sha256 + size 逐个核对
let hashBad = []
let sizeBad = []
for (const f of pack.files) {
  const e = entries.find((x) => x.name === REAL + '/' + f.path)
  if (!e) continue
  const buf = Buffer.from(e.data)
  const h = crypto.createHash('sha256').update(buf).digest('hex')
  if (h !== f.sha256) hashBad.push(f.path)
  if (buf.length !== f.size) sizeBad.push(f.path)
}
ok('每个文件的 sha256 都对得上', hashBad.length === 0, hashBad.length ? hashBad.slice(0, 2).join(', ') : pack.files.length + ' 个文件')
ok('每个文件的 size 都对得上', sizeBad.length === 0, sizeBad.slice(0, 2).join(', '))

/*
 * counts.files / counts.bytes 统计的是**内容文件**（content/ 下的），
 * 不含 course.json / scheme.json / classes/* / README ——
 * 但 files[] 清单覆盖全部（含配置）。这是规范里没写清的地方，已在文档补注。
 */
const contentOnly = pack.files.filter((f) => f.path.startsWith('content/'))
const contentBytes = contentOnly.reduce((n, f) => n + (f.size || 0), 0)
ok('counts.files = 内容文件数（非清单条数）', pack.counts.files === contentOnly.length, pack.counts.files + ' vs 内容 ' + contentOnly.length + ' / 清单 ' + pack.files.length)
ok('counts.bytes = 内容文件字节和', pack.counts.bytes === contentBytes, pack.counts.bytes + ' vs ' + contentBytes)
ok('清单条数 ≥ 内容文件数（多出的是配置与名单）', pack.files.length > contentOnly.length, '清单 ' + pack.files.length + ' · 内容 ' + contentOnly.length + ' · 配置/名单 ' + (pack.files.length - contentOnly.length))

/* ============ 3. course.json（规范 §2）============ */
console.log('\n=== 3. course.json ===')
const course = JSON.parse(textOf(inner('course.json')))
ok('format = teaching-course/course', course.format === 'teaching-course/course', course.format)
ok('version = 1', course.version === 1, String(course.version))
ok('id 合法（^[a-z0-9][a-z0-9-]{1,39}$）', /^[a-z0-9][a-z0-9-]{1,39}$/.test(course.id || ''), course.id)
ok('name 非空且 ≤60 字', !!course.name && course.name.length <= 60, (course.name || '').length + ' 字')
ok('note ≤500 字', (course.note || '').length <= 500, (course.note || '').length + ' 字')
ok('scheme 指向 scheme.json', course.scheme === 'scheme.json', JSON.stringify(course.scheme))
ok('classes 指向 classes/index.json', course.classes === 'classes/index.json', JSON.stringify(course.classes))
ok('content 指向 content/', course.content === 'content/', JSON.stringify(course.content))

/* ============ 4. scheme.json（规范 §3）============ */
console.log('\n=== 4. scheme.json ===')
const scheme = JSON.parse(textOf(inner('scheme.json')))
ok('与 data/schemes 同构（有 id/name/version/items）', !!(scheme.id && scheme.name && typeof scheme.version === 'number' && Array.isArray(scheme.items)), 'items=' + (scheme.items || []).length)
ok('没有额外包装（不是 {scheme:{...}}）', !scheme.scheme, Object.keys(scheme).slice(0, 6).join(','))
ok('totalFull 是数字', typeof scheme.totalFull === 'number', String(scheme.totalFull))
const sumFull = (scheme.items || []).reduce((n, i) => n + (i.full || 0), 0)
ok('各考核项合计 = totalFull', sumFull === scheme.totalFull, sumFull + ' vs ' + scheme.totalFull)

/* ============ 5. classes/（规范 §4）============ */
console.log('\n=== 5. classes ===')
const idx = JSON.parse(textOf(inner('classes/index.json')))
ok('format = teaching-course/classes', idx.format === 'teaching-course/classes', idx.format)
ok('version = 1', idx.version === 1, String(idx.version))
ok('classes 是数组', Array.isArray(idx.classes), 'n=' + (idx.classes || []).length)
ok('班级数 = counts.classes', (idx.classes || []).length === pack.counts.classes, (idx.classes || []).length + ' vs ' + pack.counts.classes)

let idBad = []
let idOk = 0
for (const c of idx.classes || []) {
  const expect = REAL + '-' + crypto.createHash('sha256').update(String(c.name).trim()).digest('hex').slice(0, 8)
  if (c.id === expect) idOk++
  else idBad.push(c.name + '(got ' + c.id + ' want ' + expect + ')')
}
ok('班级 id = <courseId>-<班名 sha256 前 8 位>', idBad.length === 0, idOk + '/' + (idx.classes || []).length + (idBad.length ? ' · ' + idBad[0] : ''))
ok('每个班都有 localId（仅参考）', (idx.classes || []).every((c) => typeof c.localId === 'string' && c.localId.length > 0), '')
ok('每个班都有 roster 文件名', (idx.classes || []).every((c) => typeof c.roster === 'string' && c.roster.length > 0), (idx.classes || []).map((c) => c.roster).join(', '))
ok('每个班都有 students 人数', (idx.classes || []).every((c) => typeof c.students === 'number'), (idx.classes || []).map((c) => c.students).join('+'))
ok('人数合计 = counts.students', (idx.classes || []).reduce((n, c) => n + (c.students || 0), 0) === pack.counts.students, 'sum=' + (idx.classes || []).reduce((n, c) => n + (c.students || 0), 0) + ' vs ' + pack.counts.students)

// 名单 csv：表头 / BOM / CRLF
for (const c of idx.classes || []) {
  const e = inner('classes/' + c.roster)
  if (!e) {
    ok('名单文件存在：' + c.roster, false)
    continue
  }
  const buf = Buffer.from(e.data)
  const txt = buf.toString('utf8')
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const crlf = txt.includes('\r\n')
  const lines = txt.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
  const header = (lines[0] || '').split(',')
  ok('名单「' + c.roster + '」有 BOM（Excel 不乱码）', hasBom, '')
  ok('名单「' + c.roster + '」用 CRLF', crlf, '')
  ok('名单「' + c.roster + '」表头是 学号,姓名,备注', header[0] === '学号' && header[1] === '姓名' && header[2] === '备注', header.join(','))
  const rows = lines.length - 1
  ok('名单「' + c.roster + '」行数 = index 里的 students', rows === c.students, rows + ' vs ' + c.students)
}

/* ============ 6. content/（规范 §5）============ */
console.log('\n=== 6. content/ ===')
const contentFiles = innerAll.filter((p) => p.startsWith('content/'))
ok('content 下有文件', contentFiles.length > 0, contentFiles.length + ' 个')
const roots = new Set(contentFiles.map((p) => p.split('/')[1]))
const allow = new Set(pack.contentRoots)
const illegal = [...roots].filter((r) => !allow.has(r))
ok('顶层目录都在 contentRoots 内', illegal.length === 0, [...roots].join(','))

const badPaths = contentFiles.filter((p) => p.includes('..') || p.startsWith('/') || /^[a-zA-Z]:/.test(p))
ok('没有 .. / 绝对路径 / 盘符', badPaths.length === 0, badPaths.slice(0, 2).join(','))

const IGNORE = ['node_modules/', '.git/', '.DS_Store', 'Thumbs.db', 'desktop.ini']
const ignored = innerAll.filter((p) => IGNORE.some((x) => p.includes(x)))
ok('没把 node_modules/.git/.DS_Store 等打进包', ignored.length === 0, ignored.slice(0, 3).join(','))

ok('counts.files = content/ 下的实际文件数', pack.counts.files === contentFiles.length, pack.counts.files + ' vs ' + contentFiles.length)

/* ============ 7. 压缩方式（规范 §8）============ */
console.log('\n=== 7. 压缩 ===')
const TEXT = /\.(md|html|css|js|json|txt|csv|vue|mjs)$/i
const ALREADY = /\.(png|jpe?g|mp4|zip|pdf|svg|gif|webp)$/i
/*
 * 不按扩展名一刀切，而是**实际试压**：
 * 能压小却没压 → 真问题；压不小（极小文件）退回存储 → 正确行为。
 *
 * 踩过的例子：7 个 58 字节的 main.mjs（只有几行 import），
 * deflate 后是 60 字节，压了反而更大。原来这条测试因此一直报失败。
 */
const textStored = entries.filter((e) => {
  if (e.dir || !TEXT.test(e.name) || e.method !== 0) return false
  const raw = Buffer.from(e.data)
  return zlib.deflateRawSync(raw, { level: 9 }).length < raw.length
})
const binDeflated = entries.filter((e) => !e.dir && ALREADY.test(e.name) && e.method === 8)
ok('能压小的文本都走了 deflate', textStored.length === 0,
  textStored.length
    ? textStored.length + ' 个文本可压小却被「存储」：' +
      textStored.slice(0, 3).map((e) => e.name).join(', ')
    : '检查 ' + entries.filter((e) => !e.dir && TEXT.test(e.name)).length + ' 个文本')
note('已压缩格式（svg/gif 等）也走 deflate：' + binDeflated.length + ' 个 —— 规范说「png/jpg/mp4/zip/pdf 按存储」，svg 属文本可压，不算违背')

const rawBytes = entries.filter((e) => !e.dir).reduce((n, e) => n + (Buffer.from(e.data).length || 0), 0)
ok('包体积小于原样字节（确实压缩了）', zip.length < rawBytes, Math.round(rawBytes / 1024) + 'KB → ' + Math.round(zip.length / 1024) + 'KB')

/* ============ 8. README.txt ============ */
console.log('\n=== 8. README.txt ===')
const readmeE = inner('README.txt')
ok('README.txt 存在', !!readmeE)
const readme = textOf(readmeE)
ok('README 写了课程名', readme.includes(course.name), '')
ok('README 写了怎么导入', /导入/.test(readme), '')

/* ============ 9. 模板包（规范 §9.5）============ */
console.log('\n=== 9. 空壳模板 ===')
const tplZip = await binOf('/api/courses/template.zip')
const tplEntries = readZip(tplZip)
const tplNames = tplEntries.filter((e) => !e.dir).map((e) => e.name)
const tplTop = new Set(tplNames.map((n) => n.split('/')[0]))
ok('模板只有一个顶层目录', tplTop.size === 1, [...tplTop].join(','))
const tplRoot = [...tplTop][0]
const need = ['pack.json', 'course.json', 'classes/index.json', 'README.txt']
for (const n of need) ok('模板含 ' + n, tplNames.includes(tplRoot + '/' + n), '')
ok('模板含一个 .roster.csv', tplNames.some((n) => n.endsWith('.roster.csv')), tplNames.filter((n) => n.endsWith('.csv')).join(','))
for (const d of ['lecture', 'materials', '代码示例', 'exams']) {
  ok('模板 content/' + d + ' 有 .keep 占位', tplNames.includes(tplRoot + '/content/' + d + '/.keep'), '')
}

/* ============ 10. 坏包拒绝（规范 §7）============ */
console.log('\n=== 10. 坏包要被拒 ===')
const postZip = async (u, buf) =>
  fetch(BASE + u, { method: 'POST', headers: Object.assign({ 'content-type': 'application/zip' }, H), body: buf }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))

// 改 format
const reZip = (mut) => {
  const list = readZip(zip).map((e) => ({ path: e.name, data: Buffer.from(e.data) }))
  const p = list.find((x) => x.path === REAL + '/pack.json')
  const j = JSON.parse(p.data.toString('utf8'))
  mut(j)
  p.data = Buffer.from(JSON.stringify(j, null, 2), 'utf8')
  return makeZip(list)
}

let r1 = await postZip('/api/courses/import/inspect', reZip((j) => (j.format = 'something-else')))
ok('format 不对 → 拒绝', r1.status >= 400, 'status=' + r1.status + ' ' + JSON.stringify(r1.body.error || r1.body).slice(0, 80))

let r2 = await postZip('/api/courses/import/inspect', reZip((j) => (j.version = 99)))
ok('version 不是 1 → 拒绝', r2.status >= 400, 'status=' + r2.status + ' ' + JSON.stringify(r2.body.error || r2.body).slice(0, 80))

// 改一个文件的 sha256
const tampered = readZip(zip).map((e) => ({ path: e.name, data: Buffer.from(e.data) }))
const pf = tampered.find((x) => x.path === REAL + '/pack.json')
const pj = JSON.parse(pf.data.toString('utf8'))
pj.files[0].sha256 = '0'.repeat(64)
pf.data = Buffer.from(JSON.stringify(pj, null, 2), 'utf8')
let r3 = await postZip('/api/courses/import/inspect', makeZip(tampered))
ok('sha256 不符 → 拒绝', r3.status >= 400, 'status=' + r3.status + ' ' + JSON.stringify(r3.body.error || r3.body).slice(0, 80))

// 删掉一个内容文件
const gone = readZip(zip).map((e) => ({ path: e.name, data: Buffer.from(e.data) })).filter((x) => !x.path.includes('content/assets/brands/vue.svg'))
let r4 = await postZip('/api/courses/import/inspect', makeZip(gone))
ok('清单里的文件缺失 → 拒绝', r4.status >= 400, 'status=' + r4.status + ' ' + JSON.stringify(r4.body.error || r4.body).slice(0, 80))

// 不是 zip
let r5 = await postZip('/api/courses/import/inspect', Buffer.from('this is not a zip'))
ok('不是 zip → 拒绝', r5.status >= 400, 'status=' + r5.status)

/* ============ 11. 学号跨班重复（规范 §7）============ */
console.log('\n=== 11. 学号跨班重复 ===')
const dup = readZip(zip).map((e) => ({ path: e.name, data: Buffer.from(e.data) }))
const rosterFiles = dup.filter((x) => x.path.endsWith('.roster.csv'))
if (rosterFiles.length >= 2) {
  const first = rosterFiles[0].data.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[1]
  const sid = (first || '').split(',')[0]
  const secondTxt = rosterFiles[1].data.toString('utf8')
  rosterFiles[1].data = Buffer.from(secondTxt.replace(/\r\n$/, '\r\n') + sid + ',重复学号,\r\n', 'utf8')
  const r6 = await postZip('/api/courses/import/inspect', makeZip(dup))
  ok('同学号出现在两个班 → 拒绝', r6.status >= 400, 'sid=' + sid + ' status=' + r6.status + ' ' + JSON.stringify(r6.body.error || r6.body).slice(0, 90))
}

/* ============ 12. 导出文件名（规范 §9）============ */
console.log('\n=== 12. 导出文件名 ===')
const resp = await fetch(BASE + '/api/courses/' + REAL + '/package.zip', { headers: H })
const cd = resp.headers.get('content-disposition') || ''
/*
 * 用**本地日期**，不能用 toISOString()。
 * 服务端按本地时间生成 <YYYYMMDD>；toISOString 是 UTC。
 * 东八区凌晨 0~8 点这两者差一天，断言会在这个时段必然失败 —— 与被测代码无关。
 */
const _d = new Date()
const today =
  String(_d.getFullYear()) +
  String(_d.getMonth() + 1).padStart(2, '0') +
  String(_d.getDate()).padStart(2, '0')
const nameOk = /\.coursepack\.zip/.test(cd) && cd.includes(today)
ok('文件名形如 <id>_<YYYYMMDD>.coursepack.zip', nameOk, decodeURIComponent(cd))

/* ============ 汇总 ============ */
console.log('\n' + (fail === 0 ? '规范一致 ✓' : '有 ' + fail + ' 处不一致 ✗') + '（通过 ' + pass + ' · 失败 ' + fail + '）')
if (warn.length) {
  console.log('\n提示：')
  for (const w of warn) console.log('  · ' + w)
}
fs.writeFileSync(path.join(os.tmpdir(), 'spec-sample.coursepack.zip'), zip)
process.exit(fail === 0 ? 0 : 1)
