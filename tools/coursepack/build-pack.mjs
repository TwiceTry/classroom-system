/*
 * 按《课程包格式规范》(teaching-course v1) 把一个「课程包源目录」打成 zip
 *
 * 用法： node build-pack.mjs <源目录> [输出目录]
 *
 * 做四件事：
 *   1. 只取规范允许放进 content/ 的顶层目录（白名单）
 *   2. 复制 course.json / scheme.json / classes/
 *   3. 生成 pack.json（每个文件的 sha256 + size）
 *   4. 用系统自己的 makeZip 打包（同一个实现，压缩方式/中文文件名一定对）
 *
 * 源目录本身**不会被改动**（只读）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const SRC = path.resolve(process.argv[2] || 'web前端框架开发')
const OUT = path.resolve(process.argv[3] || '.')

/* 规范里的 contentRoots 白名单 */
const CONTENT_ROOTS = ['lecture', 'materials', '代码示例', 'exams', 'assets']

// 相对脚本自身定位，从哪个目录执行都行（原来写死 '课堂系统/api/...'，
// 只在「仓库根」这个 cwd 下才成立）
const zipPath = path.resolve(import.meta.dirname, '../../api/src/lib/zip.js')
const zipMod = await import(pathToFileURL(zipPath).href)
const makeZip = zipMod.makeZip || zipMod.default

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))

const walk = (dir, rel = '') => {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    const r = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) out.push(...walk(p, r))
    else if (e.isFile()) out.push({ rel: r, abs: p, size: fs.statSync(p).size })
  }
  return out
}

/* ---------- 1. 读课程信息 ---------- */
const course = readJson(path.join(SRC, 'course.json'))
const inner = course.id // zip 里的那层目录名
console.log('课程：' + course.name + '  (' + inner + ')')

const entries = []   // { path, data }
const files = []     // pack.json 的 files[]
let contentFiles = 0, contentBytes = 0

const add = (relInPack, abs, isContent) => {
  const data = fs.readFileSync(abs)
  entries.push({ path: inner + '/' + relInPack, data })
  files.push({ path: relInPack, sha256: sha256(data), size: data.length })
  if (isContent) { contentFiles++; contentBytes += data.length }
}

/* ---------- 2. 配置三件 ---------- */
add('course.json', path.join(SRC, 'course.json'), false)
if (fs.existsSync(path.join(SRC, 'scheme.json'))) add('scheme.json', path.join(SRC, 'scheme.json'), false)

let classCount = 0, studentCount = 0
if (fs.existsSync(path.join(SRC, 'classes', 'index.json'))) {
  const idx = readJson(path.join(SRC, 'classes', 'index.json'))
  const list = idx.classes || idx.items || []
  classCount = list.length
  studentCount = list.reduce((s, c) => s + (Number(c.students) || 0), 0)
  add('classes/index.json', path.join(SRC, 'classes', 'index.json'), false)
  for (const f of fs.readdirSync(path.join(SRC, 'classes'))) {
    if (f === 'index.json') continue
    const abs = path.join(SRC, 'classes', f)
    if (fs.statSync(abs).isFile()) add('classes/' + f, abs, false)
  }
}

/* ---------- 3. content/：只放白名单目录 ---------- */
const topDirs = fs.readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
const taken = topDirs.filter((d) => CONTENT_ROOTS.includes(d))
// classes 是结构目录（已单独进包），不算「没进包」
const skipped = topDirs.filter((d) => !CONTENT_ROOTS.includes(d) && d !== 'classes' && d !== 'content')

for (const d of taken) {
  for (const f of walk(path.join(SRC, d))) {
    add('content/' + d + '/' + f.rel, f.abs, true)
  }
}

/* ---------- 4. pack.json ---------- */
const now = new Date()
const pack = {
  format: 'teaching-course',
  version: 1,
  kind: 'course-package',
  courseId: course.id,
  courseName: course.name,
  exportedAt: now.toISOString(),
  generator: '课堂系统 2.2.0（源目录打包）',
  parts: {
    course: 'course.json',
    scheme: fs.existsSync(path.join(SRC, 'scheme.json')) ? 'scheme.json' : '',
    classes: fs.existsSync(path.join(SRC, 'classes', 'index.json')) ? 'classes/index.json' : '',
    content: 'content/',
  },
  contentRoots: taken,
  // counts 只算 content/ 下的（规范口径）
  counts: { classes: classCount, students: studentCount, files: contentFiles, bytes: contentBytes },
  files,
}

/* ---------- 5. README.txt ---------- */
const readme = [
  '课程包：' + course.name,
  '',
  '格式：teaching-course v1（见 课堂系统/docs/课程包格式规范.md）',
  '打包时间：' + now.toLocaleString('zh-CN'),
  '',
  '怎么用：',
  '  1) 打开教师端 →「课程管理」→「导入课程包」，选这个 zip',
  '  2) 先看差异报告（新增多少、覆盖多少），确认后再导入',
  '',
  '里面有什么：',
  '  · course.json   课程信息（id / 名称 / 学期）',
  '  · scheme.json   考核方案（可以单独挪给别的课）',
  '  · classes/      班级与名单（*.roster.csv 可以直接用 Excel 改）',
  '  · content/      内容：' + taken.join(' / '),
  '',
  '统计：',
  '  班级 ' + classCount + ' 个 · 学生 ' + studentCount + ' 人',
  '  内容文件 ' + contentFiles + ' 个 · ' + (contentBytes / 1024 / 1024).toFixed(1) + ' MB',
  '  包内文件合计 ' + (files.length + 1) + ' 个',
  '',
].join('\r\n')

entries.push({ path: inner + '/pack.json', data: Buffer.from(JSON.stringify(pack, null, 2), 'utf8') })
entries.push({ path: inner + '/README.txt', data: Buffer.from(readme, 'utf8') })

/* ---------- 6. 写 zip ---------- */
const stamp = now.toISOString().slice(0, 10).replace(/-/g, '')
const filename = course.id + '_' + stamp + '.coursepack.zip'
const buf = makeZip(entries, now)
const outFile = path.join(OUT, filename)
// 输出目录可能还不存在（比如传了 ./dist 或临时目录）—— 自己建，
// 否则 writeFileSync 抛 ENOENT，而报错信息里只有一长串路径，看不出是这个原因
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, buf)

console.log('')
console.log('=== 已打包 ===')
console.log('  文件：' + outFile)
console.log('  体积：' + (buf.length / 1024 / 1024).toFixed(2) + ' MB（压缩前 ' + (entries.reduce((s, e) => s + e.data.length, 0) / 1024 / 1024).toFixed(2) + ' MB）')
console.log('  条目：' + entries.length + '（含 pack.json 与 README.txt）')
console.log('  内容：' + taken.join(' / '))
console.log('  班级：' + classCount + ' 个 · 学生 ' + studentCount + ' 人')

if (skipped.length) {
  console.log('')
  console.log('=== 没进包（不在 content 白名单里）===')
  for (const d of skipped) {
    const n = walk(path.join(SRC, d)).length
    console.log('  · ' + d + '  （' + n + ' 个文件）')
  }
  const loose = fs.readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => !['course.json', 'scheme.json', 'pack.json', 'README.txt'].includes(n))
  if (loose.length) {
    console.log('  · 根目录散文件 ' + loose.length + ' 个：' + loose.join(', '))
  }
}
