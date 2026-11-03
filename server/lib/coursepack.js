'use strict'
/*
 * coursepack.js —— 课程包（teaching-course v1）
 *
 * 形态：**一个 zip**，解开是一个干净目录，配置与内容分开：
 *
 *   example-course/
 *     pack.json                     清单：版本 / 部件 / 每个文件 sha256 + size
 *     course.json                   ① 课程信息
 *     scheme.json                   ② 考核方案（独立，可单独复用）
 *     classes/
 *       index.json                  ③ 班级元信息
 *       示例1班.roster.csv   ④ 名单（Excel 能直接编辑的模板表格）
 *     content/                      ⑤ 内容：讲义 / 材料 / 代码示例 / 试卷，只放文件
 *       lecture/ materials/ 代码示例/ exams/
 *     README.txt                    自动生成的说明
 *
 * 和旧版（一份大 JSON 里塞 base64）的区别：
 *   · JSON 只放配置，几十行，能读能 diff；内容永远不进 JSON
 *   · 文件靠「相对路径 + 清单哈希」对上，导入能校验完整性、能只写变化的部分
 *   · 方案、名单各自一个文件，可以单独导出/替换
 *
 * 规范全文见 课程包格式规范.md；导入（解析 zip）见 coursepack-import.js。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('../config')
const { makeZip } = require('./zip')
const { HttpError } = require('./http')

const FORMAT = 'teaching-course'
const VERSION = 1

const LIMITS = {
  packBytes: 500 * 1024 * 1024, // 单包上限 500MB
  fileBytes: 100 * 1024 * 1024, // 单文件上限 100MB
  files: 20000,
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/

/** 内容根目录：包里的 content/ 下只允许这几类 */
// assets = 讲义/材料里 ../assets/... 引用的图片（品牌 logo、示意图），必须跟着包走，
// 否则换个机器打开讲义，图全断。
const CONTENT_ROOTS = ['lecture', 'materials', '代码示例', 'exams', 'assets']

/** 打包时跳过的垃圾文件 */
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__'])

/**
 * 课程的内容根目录。
 *   - 绝对路径：照用
 *   - 以 data/ 开头：相对**系统目录**（老写法）
 *   - 其余相对路径：相对**数据目录**（TS_DATA_DIR 挪走了也跟着走）
 */
function contentRootOf(course) {
  const raw = (course && course.contentDir) || ''
  if (!raw) return path.join(config.dataDir, 'courses', course.id, 'content')
  if (path.isAbsolute(raw)) return raw
  const norm = raw.replace(/\\/g, '/')
  if (norm === 'data' || norm.startsWith('data/')) return path.resolve(config.appDir, raw)
  return path.resolve(config.dataDir, raw)
}

/** 新建课程时的默认内容目录（写成相对数据目录的形式，换机器也不用改） */
function defaultContentDir(id) {
  return 'courses/' + id + '/content'
}

/** 路径归一 + 安全检查：只允许 content 下的相对路径 */
function safeRelPath(raw) {
  const s = String(raw == null ? '' : raw).replace(/\\/g, '/').trim()
  if (!s) return ''
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return ''
  const parts = s.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return ''
  if (!CONTENT_ROOTS.includes(parts[0])) return ''
  return parts.join('/')
}

/* ---------------- 打包用的小工具 ---------------- */

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 班级的稳定 id：课程 id + 班名哈希（同一份名单导到哪台机器都还是同一个班） */
function stableClassId(courseId, className) {
  const h = sha256(Buffer.from(String(className || ''), 'utf8')).slice(0, 8)
  return String(courseId) + '-' + h
}

/** 文件名里不能出现的字符换成下划线（Win/macOS/Linux 都安全） */
function safeFileName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim() || 'class'
}

/** 递归列出目录下的文件（跳过垃圾文件），返回相对 root 的路径（/ 分隔） */
function walkFiles(root) {
  const out = []
  const seen = new Set()

  const walk = (dir, rel) => {
    let items
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      return
    }
    // 同一层里大小写只差一个字母的两份（Windows 上会互相覆盖）——只记第一次出现的
    for (const it of items) {
      const lower = (rel ? rel + '/' : '') + it.name.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)

      const full = path.join(dir, it.name)
      const relPath = rel ? rel + '/' + it.name : it.name
      if (it.isDirectory()) {
        if (SKIP_DIRS.has(it.name)) continue
        walk(full, relPath)
      } else if (it.isFile()) {
        if (SKIP_NAMES.has(it.name)) continue
        out.push({ rel: relPath, full })
      }
    }
  }

  walk(root, '')
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

function readScheme(schemeId) {
  const id = String(schemeId || '').trim()
  if (!id) return null
  const file = path.join(config.dataDir, 'schemes', id + '.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return null
  }
}

/** 名单 CSV：Excel 双击不乱码（BOM）、学号按文本给 */
function rosterCsv(students) {
  const rows = [['学号', '姓名', '备注']]
  for (const s of students) rows.push([String(s.sid || ''), String(s.name || ''), ''])
  const body = rows
    .map((r) => r.map((v) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join(','))
    .join('\r\n')
  return '\ufeff' + body + '\r\n'
}

function readmeText(course, parts) {
  const want = parts.want || new Set(['course', 'scheme', 'classes', 'content'])
  const lines = [
    '课程包：' + course.name + '（' + course.id + '）',
    '导出时间：' + parts.exportedAt,
    '',
    '这个包里有什么',
    '----------------',
    'pack.json              清单：版本、包含哪些部件、每个文件的 sha256 与大小',
    'course.json            课程信息（名称、备注、学期、各部分位置）',
  ]
  if (want.has('scheme')) lines.push('scheme.json            考核方案（可以单独拷给别的课程用）')
  if (want.has('classes')) {
    lines.push('classes/index.json     班级列表')
    lines.push('classes/*.roster.csv   名单（学号,姓名,备注 —— Excel 直接编辑）')
  }
  if (want.has('content')) {
    lines.push('content/               讲义 / 材料 / 代码示例 / 试卷，原样目录，不进 JSON')
  }
  const only = ['course', 'scheme', 'classes', 'content'].filter((k) => want.has(k))
  if (only.length < 4) {
    lines.push(
      '',
      '注意：这是「部分部件」的包（只包含 ' + only.join(' / ') + '），导入时只会更新这几块，其余不受影响。'
    )
  }
  lines.push(
    '',
    '怎么用',
    '------',
    '1) 教师端 →「课程管理」→「导入课程包」，选这个 zip',
    '2) 导入前会先给一份报告：新增什么、更新什么、有没有冲突，确认后才落盘'
  )
  if (want.has('classes')) {
    lines.push('3) 只想改名单：直接用 Excel 打开 classes/*.roster.csv，改完另存 CSV（UTF-8）')
  }
  if (want.has('content')) {
    lines.push('', '内容目录说明', '------------', parts.roots.map((r) => 'content/' + r).join('\n'))
  }
  lines.push(
    '',
    '统计：' + parts.counts.classes + ' 个班 / ' + parts.counts.students + ' 名学生 / ' + parts.counts.files + ' 个内容文件',
    skippedText(parts.skipped || []),
    '规范见 课程包格式规范.md'
  )
  return lines.filter(Boolean).join('\n')
}

/** 有文件因为太大没进包时，写进 README（老师解包时第一眼就能看到） */
function skippedText(skipped) {
  if (!skipped || !skipped.length) return ''
  const lines = [
    '',
    '注意：以下文件超过单文件上限（' + Math.round(LIMITS.fileBytes / 1024 / 1024) + 'MB），没有进包',
    '------------------------------------------------------------',
  ]
  for (const f of skipped.slice(0, 10)) {
    lines.push('  ' + f.path + '（' + Math.round(f.size / 1024 / 1024) + 'MB）')
  }
  if (skipped.length > 10) lines.push('  …还有 ' + (skipped.length - 10) + ' 个')
  return lines.join('\n')
}

/**
 * 导出课程包。
 * @param {object} db
 * @param {string} courseId
 * @returns {{ filename: string, buffer: Buffer, stats: object }}
 */
function exportCourse(db, courseId, opts) {
  const course = db.getCourse(courseId)
  if (!course) throw new HttpError(404, '课程不存在')

  const now = new Date()
  const exportedAt = now.toISOString()
  // 文件名里的日期用**本机日期**（exportedAt 是 UTC，晚上导出会差一天）
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
  const inner = course.id // zip 里那层目录名

  // 要打哪几个部件：course.json 永远有（它是包的身份证），其余三块按需
  const wantRaw = String((opts && opts.parts) || 'scheme,classes,content')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const want = new Set(wantRaw.length ? wantRaw : ['scheme', 'classes', 'content'])
  want.add('course')

  const entries = [] // { path, data }  path 相对内层目录
  const manifest = [] // { path, sha256, size }

  const add = (relPath, data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
    entries.push({ path: inner + '/' + relPath, data: buf })
    manifest.push({ path: relPath, sha256: sha256(buf), size: buf.length })
    return buf.length
  }

  /* ① 内容文件：原样目录，只登记哈希（不想带内容就整块跳过） */
  const root = contentRootOf(course)
  let contentFiles = 0
  let contentBytes = 0
  const skipped = [] // 超过单文件上限、没进包的（要报告给老师，不能静默）
  for (const f of want.has('content') ? walkFiles(root) : []) {
    const abs = f.full
    let buf
    try {
      buf = fs.readFileSync(abs)
    } catch (e) {
      continue
    }
    if (buf.length > LIMITS.fileBytes) {
      skipped.push({ path: f.rel, size: buf.length })
      continue
    }
    contentBytes += add('content/' + f.rel, buf)
    contentFiles++
  }

  /* ② 班级与名单 */
  const classes = want.has('classes') ? db.listClassesOf(course.id) : []
  const classIndex = []
  let studentCount = 0
  for (const c of classes) {
    const students = db.rosterOf(c.id)
    studentCount += students.length
    const roster = safeFileName(c.name) + '.roster.csv'
    add('classes/' + roster, rosterCsv(students))
    classIndex.push({
      id: stableClassId(course.id, c.name),
      localId: c.id,
      name: c.name,
      note: c.note || '',
      roster: roster,
      students: students.length,
    })
  }
  if (want.has('classes')) {
    add(
      'classes/index.json',
      JSON.stringify(
        {
          format: 'teaching-course/classes',
          version: VERSION,
          classes: classIndex,
        },
        null,
        2
      ) + '\n'
    )
  }

  /* ③ 考核方案：原样搬（独立文件，可复用到别的课） */
  const scheme = want.has('scheme') ? readScheme(course.schemeId || course.id) : null
  if (scheme) add('scheme.json', JSON.stringify(scheme, null, 2) + '\n')

  /* ④ 课程信息 */
  const courseJson = {
    format: 'teaching-course/course',
    version: VERSION,
    id: course.id,
    name: course.name,
    note: course.note || '',
    semester: course.semester || '',
    scheme: scheme ? 'scheme.json' : '',
    classes: want.has('classes') ? 'classes/index.json' : '',
    content: want.has('content') ? 'content/' : '',
    contentRoots: CONTENT_ROOTS,
  }
  add('course.json', JSON.stringify(courseJson, null, 2) + '\n')

  /* ⑤ README + 清单（清单放最后，它要统计上面所有文件） */
  const counts = {
    classes: classes.length,
    students: studentCount,
    files: contentFiles,
    bytes: contentBytes,
    skipped: skipped.length,
  }
  add(
    'README.txt',
    readmeText(course, { exportedAt, roots: CONTENT_ROOTS, counts, skipped, want }) + '\n'
  )

  const pack = {
    format: FORMAT,
    version: VERSION,
    kind: 'course-package',
    courseId: course.id,
    courseName: course.name,
    exportedAt,
    generator: '课堂系统 ' + (require('../../package.json').version || ''),
    parts: {
      course: 'course.json',
      scheme: scheme ? 'scheme.json' : '',
      classes: want.has('classes') ? 'classes/index.json' : '',
      content: want.has('content') ? 'content/' : '',
    },
    contentRoots: CONTENT_ROOTS,
    counts,
    files: manifest,
  }
  // 清单自己不进 manifest（否则自指）
  entries.unshift({ path: inner + '/pack.json', data: Buffer.from(JSON.stringify(pack, null, 2) + '\n', 'utf8') })

  const rawBytes = entries.reduce((n, e) => n + (e.data ? e.data.length : 0), 0)
  if (rawBytes > LIMITS.packBytes) {
    const biggest = entries
      .slice()
      .sort((a, b) => (b.data ? b.data.length : 0) - (a.data ? a.data.length : 0))
      .slice(0, 5)
      .map((e) => e.path.slice(inner.length + 1) + '（' + Math.round(e.data.length / 1024 / 1024) + 'MB）')
    const err = new HttpError(
      413,
      '这门课的内容一共 ' + Math.round(rawBytes / 1024 / 1024) + 'MB，超过单包上限 ' + Math.round(LIMITS.packBytes / 1024 / 1024) + 'MB，导不出来'
    )
    err.errors = ['最大的几个文件：'].concat(biggest)
    throw err
  }

  const buffer = makeZip(entries, now)
  return {
    filename: course.id + '_' + stamp + '.coursepack.zip',
    buffer,
    stats: Object.assign({}, counts, {
      rawBytes,
      zipBytes: buffer.length,
      skipped,
      parts: ['course'].concat(['scheme', 'classes', 'content'].filter((k) => want.has(k) && (k !== 'scheme' || !!scheme))),
    }),
  }
}

/**
 * 导出前体检：只看大小（不读内容、不打包），回答「有多大、有几个超限文件」。
 * 前端拿它决定要不要先提示老师，避免打了个 3 分钟的包再失败。
 */
function summary(db, courseId) {
  const course = db.getCourse(courseId)
  if (!course) throw new HttpError(404, '课程不存在')
  const root = contentRootOf(course)
  let files = 0
  let bytes = 0
  const skipped = []
  for (const f of walkFiles(root)) {
    let st
    try {
      st = fs.statSync(f.full)
    } catch (e) {
      continue
    }
    files++
    bytes += st.size
    if (st.size > LIMITS.fileBytes) skipped.push({ path: f.rel, size: st.size })
  }
  const classes = db.listClassesOf(course.id)
  const students = classes.reduce((n, c) => n + db.rosterOf(c.id).length, 0)
  return {
    courseId: course.id,
    courseName: course.name,
    files,
    bytes,
    mb: Math.round((bytes / 1024 / 1024) * 10) / 10,
    classes: classes.length,
    students,
    skipped,
    limits: { file: LIMITS.fileBytes, pack: LIMITS.packBytes },
    overLimit: bytes > LIMITS.packBytes,
  }
}

/**
 * 空壳课程包：只有骨架，用来当模板。
 * 老师解开 → 改 course.json 里的 id / name → 往 content/ 里放讲义和示例 →
 * 名单填 classes/名单.roster.csv → 再用「导入课程包」导回来。
 */
function templatePack() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
  const inner = 'my-course'
  const entries = []
  const manifest = []
  const add = (relPath, text, noManifest) => {
    const buf = Buffer.from(text, 'utf8')
    entries.push({ path: inner + '/' + relPath, data: buf })
    if (!noManifest) manifest.push({ path: relPath, sha256: sha256(buf), size: buf.length })
  }

  const courseJson = {
    format: 'teaching-course/course',
    version: VERSION,
    id: 'my-course',
    name: '新课程（把这里改成课程名）',
    note: '学期 · 学时 · 任课（可留空）',
    semester: '',
    scheme: 'scheme.json',
    classes: 'classes/index.json',
    content: 'content/',
    contentRoots: CONTENT_ROOTS,
  }
  add('course.json', JSON.stringify(courseJson, null, 2) + '\n')
  add(
    'classes/index.json',
    JSON.stringify(
      {
        format: 'teaching-course/classes',
        version: VERSION,
        classes: [{ id: 'my-course-1', name: '把这里改成班级名', roster: '名单.roster.csv', students: 0 }],
      },
      null,
      2
    ) + '\n'
  )
  add('classes/名单.roster.csv', '\ufeff学号,姓名,备注\r\n2025000001,张三,\r\n2025000002,李四,班长\r\n')
  add(
    'README.txt',
    [
      '课程包模板（teaching-course v1）',
      '生成时间：' + now.toISOString(),
      '',
      '怎么用',
      '------',
      '1) 改 course.json：id（只能小写字母/数字/短横线）、name、note',
      '2) 改 classes/index.json 里的班级名，名单填 classes/名单.roster.csv（学号,姓名,备注）',
      '3) 讲义/材料/示例/试卷放进 content/ 下对应目录（lecture / materials / 代码示例 / exams）',
      '4) 想要考核方案，把 scheme.json 放进来（不想要就删掉这一行、把 course.json 的 scheme 改成空串）',
      '5) 打包成 zip 后，教师端「课程管理 → 导入课程包」，先看差异报告再导入',
      '',
      '详细规范见 课程包格式规范.md',
    ].join('\n') + '\n'
  )
  // 四个内容目录各放一个占位说明（zip 里空目录不好表达，放个 .keep 最省事）
  for (const root of CONTENT_ROOTS) {
    // 只占位、不进清单：导入时空目录会自动创建
    add('content/' + root + '/.keep', '把这一类文件放这里；这个 .keep 可以删\n', true)
  }

  const pack = {
    format: FORMAT,
    version: VERSION,
    kind: 'course-package',
    courseId: courseJson.id,
    courseName: courseJson.name,
    exportedAt: now.toISOString(),
    generator: '课堂系统 ' + (require('../../package.json').version || '') + '（模板）',
    parts: { course: 'course.json', scheme: 'scheme.json', classes: 'classes/index.json', content: 'content/' },
    contentRoots: CONTENT_ROOTS,
    counts: { classes: 1, students: 2, files: 0, bytes: 0 },
    files: manifest,
  }
  entries.unshift({ path: inner + '/pack.json', data: Buffer.from(JSON.stringify(pack, null, 2) + '\n', 'utf8') })

  return { filename: 'coursepack-template_' + stamp + '.zip', buffer: makeZip(entries, now) }
}

module.exports = {
  FORMAT,
  VERSION,
  LIMITS,
  CONTENT_ROOTS,
  ID_RE,
  contentRootOf,
  defaultContentDir,
  safeRelPath,
  stableClassId,
  safeFileName,
  walkFiles,
  sha256,
  exportCourse,
  summary,
  templatePack,
}
