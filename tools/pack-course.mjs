#!/usr/bin/env node
/**
 * pack-course.mjs —— 把「课程包源目录」打成 teaching-course v1 的 zip
 *
 * 源目录长这样（就是仓库里的 course-content/）：
 *
 *   course-content/
 *     course.json         课程信息（id / name / note / semester / 指向其余部件）
 *     scheme.json         考核方案（与 data/schemes/<id>.json 同构）
 *     classes/
 *       index.json        班级清单
 *       *.roster.csv      名单（学号,姓名,备注）
 *     lecture/ materials/ 代码示例/ exams/ assets/     ← 内容（会被映射到包内 content/ 下）
 *     README.md           给人看的课程说明（不进包）
 *     其它文档 / 规范教学相关材料/                     ← 教师内部资料（不进包）
 *
 * 打出来的包（规范见 课程包格式规范.md）：
 *
 *   <id>/pack.json  course.json  scheme.json  classes/**  content/**  README.txt
 *
 * 用法：
 *   node tools/pack-course.mjs                     # 默认打 ../course-content
 *   node tools/pack-course.mjs --src 某目录 --out 某目录
 *   node tools/pack-course.mjs --dry               # 只体检、不写文件
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// 路径里有中文时不能用 URL.pathname（会被 percent-encode），必须走 fileURLToPath
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const coursepack = require(path.join(APP, 'server', 'lib', 'coursepack.js'))
const { makeZip } = require(path.join(APP, 'server', 'lib', 'zip.js'))
const config = require(path.join(APP, 'server', 'config.js'))

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const SRC = path.resolve(arg('src', path.join(APP, '..', 'course-content')))
const DRY = argv.includes('--dry')
// --roots lecture,materials,代码示例,exams  只打其中几类（老版本只认四类时用）
const ROOTS_ARG = arg('roots', '')
const SKIP = new Set(['node_modules', '.git', '.DS_Store', 'Thumbs.db', 'desktop.ini', '.trash'])

function die(msg) {
  console.error('✗ ' + msg)
  process.exit(1)
}

/* ---------------- 读配置 ---------------- */
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    die('读不了 ' + p + '：' + e.message)
  }
}

if (!fs.existsSync(SRC)) die('源目录不存在：' + SRC)
const courseFile = path.join(SRC, 'course.json')
if (!fs.existsSync(courseFile)) die('源目录里没有 course.json（课程信息）')
const course = readJson(courseFile)
if (!coursepack.ID_RE.test(String(course.id || ''))) die('course.json 的 id 不合法：' + JSON.stringify(course.id))
if (!course.name) die('course.json 缺 name')

const schemePath = path.join(SRC, course.scheme || 'scheme.json')
const scheme = fs.existsSync(schemePath) ? readJson(schemePath) : null

const classesDir = path.join(SRC, path.basename(path.dirname(course.classes || 'classes/index.json')))
const classIndexPath = path.join(SRC, course.classes || 'classes/index.json')
const classes = fs.existsSync(classIndexPath) ? readJson(classIndexPath) : null

/* ---------------- 收集内容 ---------------- */
const entries = []
const files = []
const skipped = []
let totalBytes = 0

const inner = course.id
const add = (rel, buf) => {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')
  entries.push({ path: inner + '/' + rel, data })
  files.push({ path: rel, sha256: coursepack.sha256(data), size: data.length })
  totalBytes += data.length
}

// 三个配置部件
add('course.json', JSON.stringify(course, null, 2) + '\n')
if (scheme) add('scheme.json', JSON.stringify(scheme, null, 2) + '\n')
if (classes) {
  add('classes/index.json', JSON.stringify(classes, null, 2) + '\n')
  for (const c of classes.classes || []) {
    const f = path.join(classesDir, c.roster)
    if (!fs.existsSync(f)) die('classes/index.json 里列的名单不存在：' + c.roster)
    add('classes/' + c.roster, fs.readFileSync(f))
  }
}

// 内容：源目录顶层的五个内容根 → 包内 content/ 下
let roots = coursepack.CONTENT_ROOTS
if (ROOTS_ARG) {
  const want = ROOTS_ARG.split(',').map((x) => x.trim()).filter(Boolean)
  const bad = want.filter((r) => coursepack.CONTENT_ROOTS.indexOf(r) < 0)
  if (bad.length) die('--roots 里有不认识的内容根：' + bad.join(',') + '（可用：' + coursepack.CONTENT_ROOTS.join(' / ') + '）')
  roots = want
  console.log('注意：只打这几类内容根 → ' + roots.join(' / '))
}
let contentFiles = 0
for (const root of roots) {
  const dir = path.join(SRC, root)
  if (!fs.existsSync(dir)) continue
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue
      const a = path.join(abs, e.name)
      const r = rel + '/' + e.name
      if (e.isDirectory()) walk(a, r)
      else {
        const size = fs.statSync(a).size
        if (size > 100 * 1024 * 1024) {
          skipped.push({ path: 'content' + r, why: '单文件超过 100MB' })
          continue
        }
        add('content' + r, fs.readFileSync(a))
        contentFiles++
      }
    }
  }
  walk(dir, '/' + root)
}

/* ---------------- pack.json + README.txt ---------------- */
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
const counts = {
  classes: classes ? (classes.classes || []).length : 0,
  students: classes ? (classes.classes || []).reduce((n, c) => n + (c.students || 0), 0) : 0,
  files: files.length,
  bytes: totalBytes,
}

const pack = {
  format: 'teaching-course',
  version: 1,
  kind: 'course-package',
  courseId: course.id,
  courseName: course.name,
  exportedAt: now.toISOString(),
  generator: '课堂系统 pack-course.mjs',
  parts: {
    course: 'course.json',
    scheme: scheme ? 'scheme.json' : '',
    classes: classes ? 'classes/index.json' : '',
    content: 'content/',
  },
  contentRoots: roots,
  counts,
  files,
}

const readme = [
  '课程包 · ' + course.name + '（' + course.id + '）',
  '='.repeat(56),
  '',
  '导出时间：' + now.toISOString(),
  '课程说明：' + (course.note || '（未填）'),
  '学期：' + (course.semester || '（未填）'),
  '',
  '内容统计',
  '-' .repeat(56),
  '  班级 ' + counts.classes + ' 个 · 学生 ' + counts.students + ' 人',
  '  文件 ' + counts.files + ' 个 · 共 ' + (counts.bytes / 1024 / 1024).toFixed(2) + ' MB',
  '  内容根：' + roots.join(' / '),
  '',
  '怎么用',
  '-'.repeat(56),
  '  1. 教师端 → 课程管理 → 「导入课程包」，选这个 zip',
  '  2. 先看导入报告（新建 / 覆盖哪些文件、班级与方案怎么处理），确认后才落盘',
  '  3. 只想换一部分时，去对应页签用「导出 / 导入」（讲义 / 代码练习 / 期末机试 / 班级与名单）',
  '',
  '包里有什么',
  '-'.repeat(56),
  '  pack.json     清单（每个文件 sha256 + 大小，导入时用它校验）',
  '  course.json   课程信息（id / 名称 / 学期 / 各部件位置）',
  '  scheme.json   考核方案（与 data/schemes/<id>.json 同构，可整份挪给别的课）',
  '  classes/      班级清单 + 名单 csv（Excel 直接改）',
  '  content/      lecture / materials / 代码示例 / exams / assets',
  '',
  '这张说明由 tools/pack-course.mjs 自动生成。',
  '',
].join('\n')

const packBuf = Buffer.from(JSON.stringify(pack, null, 2) + '\n', 'utf8')
entries.unshift({ path: inner + '/pack.json', data: packBuf })
entries.push({ path: inner + '/README.txt', data: Buffer.from(readme, 'utf8') })

/* ---------------- 写盘 ---------------- */
const outDir = path.resolve(arg('out', SRC))
const suffix = ROOTS_ARG ? '-' + roots.length + 'roots' : ''
const outFile = path.join(outDir, course.id + '_' + stamp + suffix + '.coursepack.zip')
const total = totalBytes + packBuf.length + Buffer.byteLength(readme)

console.log('源目录：' + SRC)
console.log('部件：course' + (scheme ? ' + scheme' : '') + (classes ? ' + classes' : '') + ' + content(' + contentFiles + ' 个文件)')
console.log('班级 ' + counts.classes + ' 个 · 学生 ' + counts.students + ' 人 · 合计 ' + counts.files + ' 个文件 · ' + (total / 1024 / 1024).toFixed(2) + ' MB')
if (skipped.length) {
  console.log('跳过 ' + skipped.length + ' 个：')
  for (const s of skipped) console.log('  · ' + s.path + '（' + s.why + '）')
}
if (total > 500 * 1024 * 1024) die('整包超过 500MB 上限，先瘦身再打')

if (DRY) {
  console.log('\n--dry：只体检，没有写文件。')
  process.exit(0)
}

const buf = makeZip(entries)
fs.writeFileSync(outFile, buf)
console.log('\n✓ ' + outFile + '（' + (buf.length / 1024 / 1024).toFixed(2) + ' MB）')
