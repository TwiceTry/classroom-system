'use strict'
/*
 * submissions.js —— 课堂作业的「学生代码」落地
 *
 * 位置：data/students/<班级 id>/<学号>/作业/<作业 id>/<提交 id>/<原相对路径>
 *   —— 跟学生的记分、大作业、机试试卷放在同一个专属目录里（见 lib/students.js），
 *      期末把一个学生的材料整包拷走就是完整一套。
 *
 * 为什么正文不进 CSV：
 *   一份提交动辄几百上千行，塞进 submissions.csv 之后这文件就没法 git diff 了，
 *   而且同学交两次就得在一格里塞两个版本。所以拆分职责：
 *     · submissions.csv 只存索引（谁 / 何时 / 交了哪些文件 / 改了哪些 / 多少分）；
 *     · 正文落在上面那条路径里，目录结构和「代码示例」里的一模一样，
 *       老师直接用编辑器打开也能跑。
 *
 * 目录名一律走 safeSeg()：班级 id / 学号 / 作业 id / 提交 id 都过一遍，
 * 万一有脏数据也不会把文件写到 data/ 外面去。
 */
const fs = require('fs')
const path = require('path')
const students = require('./students')
const { isInside, HttpError } = require('./http')

// 单份提交的上限：够交一整课的多文件作业，又不至于把教师机磁盘写爆
const LIMITS = {
  files: 120,
  fileBytes: 512 * 1024,
  totalBytes: 6 * 1024 * 1024,
}

/**
 * 把浏览器传来的相对路径洗成安全路径：
 *   "src\\App.vue" → "src/App.vue"；"../x" / "C:/x" / "" → ''
 * 返回 '' 表示这条路径不可用，调用方应当拒收。
 */
function normalizePath(raw) {
  const s = String(raw == null ? '' : raw).replace(/\\/g, '/').trim()
  if (!s || s.length > 200) return ''
  if (/^[a-zA-Z]:/.test(s)) return ''
  const parts = []
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return ''
    if (/[<>:"|?*\u0000-\u001f]/.test(seg)) return '' // Windows 文件名非法字符
    if (seg.length > 80) return ''
    parts.push(seg)
  }
  return parts.join('/')
}

/** 一份提交的目录：students/<班级>/<学号>/作业/<作业 id>/<提交 id> */
function subDir(classId, sid, assignmentId, submissionId) {
  return path.join(students.workDir(classId, sid, assignmentId), students.safeSeg(submissionId))
}

function rmrf(target, mustInside) {
  const base = mustInside || students.ROOT
  if (!isInside(base, target)) return false
  if (!fs.existsSync(target)) return false
  try {
    // Node 12.10+ 支持 recursive；Win7 上跑的是 13.6，稳定可用
    fs.rmdirSync(target, { recursive: true })
    return true
  } catch (e) {
    try {
      fs.unlinkSync(target)
      return true
    } catch (e2) {
      return false
    }
  }
}

/**
 * 写入一份提交的全部文件。
 * files: [{ path, text }] → { paths: [...], bytes }
 * 任一条不合规就抛错（带 status，交给上层转成 400/413）。
 */
function writeFiles(classId, sid, assignmentId, submissionId, files) {
  if (!Array.isArray(files) || !files.length) throw new HttpError(400, '没有提交任何文件')
  if (files.length > LIMITS.files) throw new HttpError(400, '一次最多提交 ' + LIMITS.files + ' 个文件')

  const dir = subDir(classId, sid, assignmentId, submissionId)
  const clean = []
  const seen = new Set()
  let total = 0

  for (const f of files) {
    const rel = normalizePath(f && f.path)
    if (!rel) throw new HttpError(400, '文件名不合法：' + String((f && f.path) || ''))
    if (seen.has(rel)) continue
    seen.add(rel)
    const text = typeof f.text === 'string' ? f.text : String(f.text == null ? '' : f.text)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > LIMITS.fileBytes) throw new HttpError(413, '文件太大：' + rel + '（单个文件上限 512KB）')
    total += bytes
    if (total > LIMITS.totalBytes) throw new HttpError(413, '提交内容过大（合计上限 6MB）')
    clean.push({ rel, text })
  }

  students.ensure(classId, sid) // 目录骨架可能没建（老名单）：这里兜一下
  rmrf(dir, students.ROOT) // 重交覆盖：同一提交 id 不会重复，但保险起见先清
  for (const item of clean) {
    const full = path.join(dir, item.rel)
    if (!isInside(dir, full)) continue
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, item.text, 'utf8')
  }

  return { paths: clean.map((c) => c.rel).sort(), bytes: total }
}

/** 读回一份提交里指定的文件（paths 为空则把目录里所有文件都读出来） */
function readFiles(classId, sid, assignmentId, submissionId, paths) {
  const dir = subDir(classId, sid, assignmentId, submissionId)
  let list = Array.isArray(paths) ? paths.map(normalizePath).filter(Boolean) : []
  if (!list.length) list = walk(dir).map((full) => path.relative(dir, full).replace(/\\/g, '/'))
  const out = []
  for (const rel of list) {
    const full = path.join(dir, rel)
    if (!isInside(dir, full)) continue
    try {
      out.push({ path: rel, text: fs.readFileSync(full, 'utf8') })
    } catch (e) {
      out.push({ path: rel, text: '', missing: true })
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

function walk(dir) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

function removeSubmission(classId, sid, assignmentId, submissionId) {
  return rmrf(subDir(classId, sid, assignmentId, submissionId), students.ROOT)
}

/** 删作业：把每个学生 作业/<作业 id>/ 下那一棵都清掉 */
function removeAssignment(assignmentId) {
  const aid = students.safeSeg(assignmentId)
  let removed = 0
  for (const classId of listDirs(students.ROOT)) {
    for (const sid of listDirs(path.join(students.ROOT, classId))) {
      const target = path.join(students.ROOT, classId, sid, students.SUB.work, aid)
      if (rmrf(target, students.ROOT)) removed++
    }
  }
  return removed
}

/** 删班：整个班级目录（含所有学生的作业 / 大作业 / 记分）一起清 */
function removeClass(classId) {
  return rmrf(students.classDir(classId), students.ROOT)
}

/* ---------------- 大作业（附件 + 说明 + 链接） ----------------
 * 位置：students/<班级>/<学号>/大作业/<作业 id>/<提交 id>/<原文件名>
 * 跟课堂作业的区别：大作业交的是「任意文件」（源码包、截图、PDF…），
 * 不是可编辑的文本，所以走二进制写盘，前端用 dataURL 上传。
 */

const PROJECT_LIMITS = {
  files: 6,
  fileBytes: 6 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
}

function projectDir(classId, sid, assignmentId, submissionId) {
  return path.join(
    students.subOf(classId, sid, 'project'),
    students.safeSeg(assignmentId),
    students.safeSeg(submissionId)
  )
}

/** 文件名洗干净：只留最后一段，去掉 Windows 非法字符，保留扩展名 */
function safeFileName(raw) {
  const s = String(raw == null ? '' : raw).replace(/\\/g, '/').split('/').pop()
  const clean = s.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim()
  if (!clean || clean === '.' || clean === '..') return ''
  return clean.length > 120 ? clean.slice(-120) : clean
}

/** 写一份大作业提交的附件，返回实际写下的文件名（重名会自动加序号） */
function writeAttachments(classId, sid, assignmentId, submissionId, files) {
  const list = Array.isArray(files) ? files : []
  if (!list.length) throw new HttpError(400, '没有上传任何文件')
  if (list.length > PROJECT_LIMITS.files) throw new HttpError(400, '一次最多上传 ' + PROJECT_LIMITS.files + ' 个文件')

  const parsed = []
  let total = 0
  const used = new Set()
  for (const f of list) {
    const name = safeFileName(f && f.name)
    if (!name) throw new HttpError(400, '文件名不合法：' + String((f && f.name) || ''))
    const m = /^data:([\w/+.-]+)?;base64,(.+)$/.exec(String((f && f.dataUrl) || ''))
    if (!m) throw new HttpError(400, '文件格式不正确：' + name)
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length > PROJECT_LIMITS.fileBytes) throw new HttpError(413, '文件太大：' + name + '（单个上限 6MB）')
    total += buf.length
    if (total > PROJECT_LIMITS.totalBytes) throw new HttpError(413, '附件合计过大（上限 20MB）')
    // 同名文件不覆盖：a.zip / a-2.zip
    let final = name
    let n = 1
    while (used.has(final)) {
      n++
      const dot = name.lastIndexOf('.')
      final = dot > 0 ? name.slice(0, dot) + '-' + n + name.slice(dot) : name + '-' + n
    }
    used.add(final)
    parsed.push({ name: final, buf })
  }

  const dir = projectDir(classId, sid, assignmentId, submissionId)
  students.ensure(classId, sid)
  rmrf(dir, students.ROOT)
  for (const item of parsed) {
    const full = path.join(dir, item.name)
    if (!isInside(dir, full)) continue
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(full, item.buf)
  }
  return { names: parsed.map((p) => p.name).sort(), bytes: total }
}

/** 某个附件的绝对路径（不合法 / 不存在返回 ''） */
function attachmentPath(classId, sid, assignmentId, submissionId, name) {
  const dir = projectDir(classId, sid, assignmentId, submissionId)
  const safe = safeFileName(name)
  if (!safe) return ''
  const full = path.join(dir, safe)
  if (!isInside(dir, full)) return ''
  return fs.existsSync(full) ? full : ''
}

function removeProjectSubmission(classId, sid, assignmentId, submissionId) {
  return rmrf(projectDir(classId, sid, assignmentId, submissionId), students.ROOT)
}

/** 删某个学生在某一类目录（大作业 / 机试 / 作业）下的某一次作业 */
function removeStudentAssignment(kind, classId, sid, assignmentId) {
  const sub = students.SUB[kind] || students.SUB.project
  return rmrf(path.join(students.ROOT, students.safeSeg(classId), students.safeSeg(sid), sub, students.safeSeg(assignmentId)), students.ROOT)
}

/** 删大作业：把每个学生 大作业/<作业 id>/ 下那一棵都清掉 */
function removeProjectAssignment(assignmentId) {
  const aid = students.safeSeg(assignmentId)
  let removed = 0
  for (const classId of listDirs(students.ROOT)) {
    for (const sid of listDirs(path.join(students.ROOT, classId))) {
      const target = path.join(students.ROOT, classId, sid, students.SUB.project, aid)
      if (rmrf(target, students.ROOT)) removed++
    }
  }
  return removed
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch (e) {
    return []
  }
}

module.exports = {
  LIMITS,
  PROJECT_LIMITS,
  subDir,
  normalizePath,
  writeFiles,
  readFiles,
  removeSubmission,
  removeAssignment,
  removeClass,
  projectDir,
  safeFileName,
  writeAttachments,
  attachmentPath,
  removeProjectSubmission,
  removeProjectAssignment,
  removeStudentAssignment,
}
