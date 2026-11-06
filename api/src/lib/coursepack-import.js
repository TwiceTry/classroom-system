/*
 * coursepack-import.js —— 课程包导入（teaching-course v1，zip）
 *
 * 两步走，绝不「点一下就开始覆盖」：
 *   1) readPackage(buf)  只读解析 + 校验，得到一个结构化对象（不碰磁盘）
 *   2) inspect(db, pkg)  干跑：算出「新建 / 更新 / 未变 / 冲突」，给老师看
 *   3) apply(db, pkg, {strategy})  按选定策略真正落盘
 *
 * 三种策略：
 *   merge   默认。课程信息 / 方案 / 内容覆盖同名文件；班级名单**只增不减**
 *   replace 内容整体替换（包里没有的删掉）；名单同步成包里的（会移出多余的人）
 *   fork    用新 id 另建一份课程，与现有课程完全隔离
 *
 * 绝不进包 / 绝不因导入而改动：events / submissions / assignments / state —— 那是上课产生的运行时数据。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../config.js'
import * as zipfile from './zipfile.js'
import { HttpError } from './legacy-http.js'
import * as schemeLib from './scheme.js'
import * as studentsLib from './students.js'
import {
  FORMAT,
  VERSION,
  LIMITS,
  CONTENT_ROOTS,
  ID_RE,
  contentRootOf,
  defaultContentDir,
  stableClassId,
  sha256,
} from './coursepack.js'

const STRATEGIES = ['merge', 'replace', 'fork']

/** 回收站只保留最近 KEEP 次（每次导入一个时间戳目录），更早的删掉，避免长期堆积 */
const TRASH_KEEP = 10

function pruneTrash() {
  const base = path.join(config.dataDir, '.trash')
  let dirs = []
  try {
    dirs = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch (e) {
    return
  }
  for (const name of dirs.slice(0, Math.max(0, dirs.length - TRASH_KEEP))) {
    try {
      fs.rmSync(path.join(base, name), { recursive: true, force: true })
    } catch (e) {
      /* 删不掉就算了，不影响本次导入 */
    }
  }
}

/** 20261102-153012，给回收站目录用（本机时间，老师好找） */
function trashStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  )
}

/* ---------------- 小工具 ---------------- */

/** 键排好序的 JSON（同样的内容一定得到同样的字符串，用于比较方案是否真的变了） */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  if (v && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v)
        .filter((k) => ['version', 'changes', 'updatedAt', 'at'].indexOf(k) < 0) // 这些是「修订痕迹」，不算内容
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canon(v[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(v === undefined ? null : v)
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function uid(prefix) {
  return prefix + Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4)
}

/** 极简 CSV 解析（够用于名单：逗号分隔、双引号转义、CRLF/LF） */
function parseCsv(text) {
  const src = String(text).replace(/^\ufeff/, '')
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      if (row.some((c) => String(c).trim() !== '')) rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => String(c).trim() !== '')) rows.push(row)
  return rows
}

/** 名单 CSV → [{sid, name}]，带行号报错 */
function readRoster(text, where, errors) {
  const rows = parseCsv(text)
  if (!rows.length) {
    errors.push(where + '：名单是空的（至少要有一行表头「学号,姓名」）')
    return []
  }
  const head = rows[0].map((c) => String(c).trim())
  const iSid = head.indexOf('学号')
  const iName = head.indexOf('姓名')
  if (iSid < 0 || iName < 0) {
    errors.push(where + '：表头必须是「学号,姓名,备注」，现在读到的是「' + head.join(',') + '」')
    return []
  }
  const out = []
  const seen = new Set()
  for (let r = 1; r < rows.length; r++) {
    const sid = String(rows[r][iSid] == null ? '' : rows[r][iSid]).trim()
    const name = String(rows[r][iName] == null ? '' : rows[r][iName]).trim()
    const line = r + 1
    if (!sid) {
      errors.push(where + ' 第 ' + line + ' 行：学号为空')
      continue
    }
    if (!name) {
      errors.push(where + ' 第 ' + line + ' 行：姓名为空（学号 ' + sid + '）')
      continue
    }
    if (name.length > 20) {
      errors.push(where + ' 第 ' + line + ' 行：姓名太长（' + name.length + ' 字，上限 20）')
      continue
    }
    if (seen.has(sid)) {
      errors.push(where + ' 第 ' + line + ' 行：学号 ' + sid + ' 在本班重复')
      continue
    }
    seen.add(sid)
    out.push({ sid, name })
  }
  return out
}

/* ---------------- 1) 解析 + 校验（只读） ---------------- */

/**
 * 解析一个已经落到磁盘上的课程包 zip（不把整包读进内存）。
 * @param {string} zipPath
 */
async function readPackage(zipPath) {
  const errors = []
  const warnings = []

  // 先看一眼魔数：不是 zip 的话直接给人话，别把 yauzl 的英文报错甩给老师
  try {
    const head = Buffer.alloc(2)
    const fd = fs.openSync(zipPath, 'r')
    fs.readSync(fd, head, 0, 2, 0)
    fs.closeSync(fd)
    if (head.toString('latin1') !== 'PK') {
      throw new HttpError(400, '这不是课程包 zip（文件开头不是 PK）。请用「导出课程包」得到的 .coursepack.zip')
    }
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(400, '上传的文件读不出来：' + e.message)
  }

  let scanned
  try {
    scanned = await zipfile.scan(zipPath, { entries: LIMITS.files, maxBytes: LIMITS.packBytes * 3 })
  } catch (e) {
    throw new HttpError(400, '这个 zip 读不出来（可能上传中断、文件损坏，或不是标准 zip）：' + e.message)
  }
  const entries = scanned.entries // Map(name → {name,size,sha256,data})

  // 包里通常有一层同名目录；找到 pack.json 的位置，把它作为包根
  let packEntry = null
  for (const e of entries.values()) {
    if (/(^|\/)pack\.json$/.test(e.name)) {
      packEntry = e
      break
    }
  }
  if (!packEntry) throw new HttpError(400, '包里没有 pack.json —— 这可能不是课程包（用「导出课程包」重新导一份）')
  if (!packEntry.data) throw new HttpError(400, 'pack.json 太大或读不出来')
  const root = packEntry.name.slice(0, packEntry.name.length - 'pack.json'.length) // 含结尾 /

  const get = (rel) => {
    const hit = entries.get(root + rel)
    return hit && hit.data ? hit.data : null
  }

  let pack
  try {
    pack = JSON.parse(packEntry.data.toString('utf8'))
  } catch (e) {
    throw new HttpError(400, 'pack.json 不是合法 JSON：' + e.message)
  }
  if (pack.format !== FORMAT) errors.push('pack.json：format 必须是 "' + FORMAT + '"（当前：' + pack.format + '）')
  if (Number(pack.version) !== VERSION) errors.push('pack.json：version 必须是 ' + VERSION + '（当前：' + pack.version + '）')

  // 课程信息
  const courseBuf = get('course.json')
  let course = null
  if (!courseBuf) errors.push('缺 course.json（课程信息）')
  else {
    try {
      course = JSON.parse(courseBuf.toString('utf8'))
    } catch (e) {
      errors.push('course.json 不是合法 JSON：' + e.message)
    }
  }
  if (course) {
    const id = String(course.id || '').trim()
    if (!ID_RE.test(id)) errors.push('course.id 不合法（2–40 位小写字母 / 数字 / 短横线）：' + id)
    if (!String(course.name || '').trim()) errors.push('缺 course.name')
    if (String(course.name || '').length > 60) errors.push('course.name 太长（上限 60 字）')
  }

  // 考核方案
  let scheme = null
  const schemeBuf = get('scheme.json')
  if (schemeBuf) {
    try {
      scheme = JSON.parse(schemeBuf.toString('utf8'))
      if (!Array.isArray(scheme.items) || !scheme.items.length) warnings.push('scheme.json 里没有 items，导入后会用空方案')
    } catch (e) {
      errors.push('scheme.json 不是合法 JSON：' + e.message)
    }
  }

  // 班级 + 名单
  const classes = []
  const classBuf = get('classes/index.json')
  if (classBuf) {
    let idx = null
    try {
      idx = JSON.parse(classBuf.toString('utf8'))
    } catch (e) {
      errors.push('classes/index.json 不是合法 JSON：' + e.message)
    }
    const list = (idx && idx.classes) || []
    const names = new Set()
    const allSid = new Map() // sid → 班名（同一门课里学号不能跨班）
    for (const c of list) {
      const name = String(c.name || '').trim()
      if (!name) {
        errors.push('classes/index.json：有班级缺少 name')
        continue
      }
      if (names.has(name)) errors.push('班级重名：' + name)
      names.add(name)

      let students = []
      if (c.roster) {
        const rosterBuf = get('classes/' + c.roster)
        if (!rosterBuf) errors.push('班级「' + name + '」的名单文件缺失：classes/' + c.roster)
        else students = readRoster(rosterBuf.toString('utf8'), '班级「' + name + '」', errors)
      } else {
        warnings.push('班级「' + name + '」没有名单文件')
      }
      for (const s of students) {
        const owner = allSid.get(s.sid)
        if (owner && owner !== name) {
          errors.push('学号 ' + s.sid + ' 同时出现在「' + owner + '」和「' + name + '」——同一门课里一个学号只能在一个班')
        } else allSid.set(s.sid, name)
      }
      classes.push({
        id: String(c.id || ''),
        name,
        note: String(c.note || ''),
        students,
      })
    }
  } else warnings.push('没有 classes/index.json：这次只导课程与内容，班级名单之后再说')

  // 内容文件：以 pack.files 清单为准，逐个校验哈希
  const files = []
  const manifest = Array.isArray(pack.files) ? pack.files : []
  let bytes = 0
  for (const f of manifest) {
    const rel = String((f && f.path) || '').replace(/\\/g, '/').trim()
    // 清单里除内容外还登记了 course.json / scheme.json / classes/… / README.txt，
    // 那些由「部件」管，这里只看内容文件
    if (!rel.startsWith('content/')) continue
    const inside = rel.slice('content/'.length)
    const parts = inside.split('/')
    if (parts.some((p) => p === '' || p === '.' || p === '..')) {
      errors.push('清单里的路径不合法：' + rel)
      continue
    }
    if (CONTENT_ROOTS.indexOf(parts[0]) < 0) {
      errors.push('清单里的路径不在内容目录里（只允许 ' + CONTENT_ROOTS.join(' / ') + '）：' + rel)
      continue
    }
    const hit = entries.get(root + rel)
    if (!hit) {
      errors.push('包里缺文件：' + rel)
      continue
    }
    if (f.size && hit.size !== f.size) {
      errors.push('文件大小与清单不符：' + rel + '（清单 ' + f.size + '，实际 ' + hit.size + '）')
      continue
    }
    if (f.sha256 && hit.sha256 !== f.sha256) {
      errors.push('文件内容与清单不符（sha256）：' + rel + ' —— 包被改过？')
      continue
    }
    if (hit.size > LIMITS.fileBytes) {
      warnings.push('单文件超过 100MB，已跳过：' + rel)
      continue
    }
    files.push({ path: inside, zipName: hit.name, size: hit.size, sha256: hit.sha256 })
    bytes += hit.size
  }
  if (files.length > LIMITS.files) errors.push('文件数超过上限 ' + LIMITS.files)

  if (errors.length) {
    const err = new HttpError(400, '这份课程包有 ' + errors.length + ' 个问题，无法导入')
    err.errors = errors
    err.warnings = warnings
    throw err
  }

  // 这个包实际带了哪几块：导入时只动这几块，其余原样保留
  const has = {
    scheme: !!scheme,
    classes: !!classBuf,
    content: !!(pack.parts && pack.parts.content) || files.length > 0,
  }

  return {
    pack,
    course,
    scheme,
    classes,
    files,
    has,
    bytes: bytes,
    warnings: warnings,
    root: root,
    zipPath,
    scanned,
  }
}

/* ---------------- 2) 干跑：算差异，不落盘 ---------------- */

/** 磁盘上某个文件的 sha256（流式，别把 100MB 读进内存） */
function sha256File(full) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256')
    const rs = fs.createReadStream(full)
    rs.on('data', (c) => h.update(c))
    rs.on('error', () => resolve(''))
    rs.on('end', () => resolve(h.digest('hex')))
  })
}

/** 把包里的内容文件与磁盘上现有内容比较（大小先看，再比 sha256） */
async function diffContent(db, course, files, hasContent) {
  if (hasContent === false) return { added: [], updated: [], unchanged: [], extra: [], skipped: true }
  const root = contentRootOf(course || { id: 'tmp', contentDir: '' })
  const added = []
  const updated = []
  const unchanged = []
  for (const f of files) {
    const full = path.join(root, f.path)
    let st = null
    try {
      st = fs.statSync(full)
    } catch (e) {
      st = null
    }
    if (!st || !st.isFile()) added.push(f.path)
    else if (st.size === f.size && (await sha256File(full)) === f.sha256) unchanged.push(f.path)
    else updated.push(f.path)
  }
  // 磁盘上有、包里没有的（replace 策略下会被删）
  const extra = []
  const walk = (dir, rel) => {
    let items
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      return
    }
    for (const it of items) {
      const r = rel ? rel + '/' + it.name : it.name
      if (it.isDirectory()) walk(path.join(dir, it.name), r)
      else if (it.isFile() && !added.includes(r) && !updated.includes(r) && !unchanged.includes(r)) extra.push(r)
    }
  }
  walk(root, '')
  return { added, updated, unchanged, extra }
}

async function inspect(db, pkg) {
  const id = String(pkg.course.id).trim()
  const existing = db.getCourse(id)

  // 方案：与本机同名方案比一比
  let schemeAction = 'none'
  let schemeVersion = null
  if (pkg.scheme) {
    const localPath = path.join(config.dataDir, 'schemes', (pkg.scheme.id || id) + '.json')
    let local = null
    try {
      local = JSON.parse(fs.readFileSync(localPath, 'utf8'))
    } catch (e) {
      local = null
    }
    schemeVersion = local ? local.version : null
    if (!local) schemeAction = 'create'
    else schemeAction = canon(local) === canon(pkg.scheme) ? 'same' : 'update'
  }

  // 班级：按班名对齐（同一门课里班名唯一）
  const localClasses = existing ? db.listClassesOf(id) : []
  const classes = pkg.classes.map((c) => {
    const hit = localClasses.find((x) => x.name === c.name) || null
    const localSids = new Set(hit ? hit.students.map((s) => s.sid) : [])
    const pkgSids = new Set(c.students.map((s) => s.sid))
    return {
      name: c.name,
      id: stableClassId(id, c.name),
      action: hit ? 'update' : 'create',
      localId: hit ? hit.id : '',
      students: {
        package: c.students.length,
        local: localSids.size,
        added: c.students.filter((s) => !localSids.has(s.sid)).length,
        removed: hit ? [...localSids].filter((sid) => !pkgSids.has(sid)).length : 0,
      },
    }
  })

  const diff = await diffContent(db, existing || { id, contentDir: '' }, pkg.files, pkg.has.content)

  return {
    ok: true,
    mode: 'inspect',
    course: {
      id,
      name: pkg.course.name,
      note: String(pkg.course.note || ''),
      action: existing ? 'update' : 'create',
      existingName: existing ? existing.name : '',
    },
    scheme: {
      id: (pkg.scheme && pkg.scheme.id) || id,
      action: schemeAction,
      localVersion: schemeVersion,
      included: !!pkg.has.scheme,
    },
    classesIncluded: !!pkg.has.classes,
    classes,
    content: {
      included: !!pkg.has.content,
      total: pkg.files.length,
      added: diff.added.length,
      updated: diff.updated.length,
      unchanged: diff.unchanged.length,
      extra: diff.extra.length,
      // 完整清单（replace 会删掉这些）：老师点「整体替换」之前必须能看见
      extraList: diff.extra.slice(0, 500),
      extraTruncated: diff.extra.length > 500,
      bytes: pkg.bytes,
      samples: diff.updated.concat(diff.added).slice(0, 8),
    },
    warnings: pkg.warnings,
    errors: [],
    // 这个包实际带了哪几块（前端用来说「本次只更新：…」）
    parts: ['course']
      .concat(pkg.has.scheme ? ['scheme'] : [])
      .concat(pkg.has.classes ? ['classes'] : [])
      .concat(pkg.has.content ? ['content'] : []),
  }
}

/* ---------------- 3) 真正导入 ---------------- */

async function apply(db, pkg, opts) {
  const strategy = String((opts && opts.strategy) || 'merge')
  if (STRATEGIES.indexOf(strategy) < 0) {
    throw new HttpError(400, '未知的导入策略：' + strategy + '（可选 ' + STRATEGIES.join(' / ') + '）')
  }

  const before = await inspect(db, pkg)
  let courseId = String(pkg.course.id).trim()

  // fork：换一个没用过的 id
  if (strategy === 'fork') {
    let base = courseId
    let n = 0
    while (db.getCourse(courseId)) {
      n++
      courseId = base + '-' + (n === 1 ? 'copy' : 'copy' + n)
    }
  } else if (db.getCourse(courseId) && !opts.force) {
    // 覆盖式导入必须显式给策略；给了 merge/replace 就继续（下面按策略处理）
  }

  const report = {
    ok: true,
    mode: 'apply',
    strategy,
    courseId,
    courseName: String(pkg.course.name).trim(),
    scheme: '',
    classes: [],
    files: { written: 0, removed: 0, unchanged: 0 },
    warnings: pkg.warnings.slice(),
    before,
  }

  // 1) 考核方案：内容没变就不动；变了按 schemeMode 处理（use 覆盖 / keep 保留本机 / copy 另存）
  let boundSchemeId = ''
  if (pkg.scheme) {
    const schemeId = String(pkg.scheme.id || courseId)
    const schemeMode = ['use', 'keep', 'copy'].indexOf(String(opts && opts.schemeMode)) >= 0 ? opts.schemeMode : 'use'
    boundSchemeId = schemeId

    if (before.scheme.action === 'same') {
      report.scheme = schemeId + ' v' + before.scheme.localVersion + '（未改动）'
    } else if (schemeMode === 'keep') {
      report.scheme = schemeId + ' v' + before.scheme.localVersion + '（保留本机版本，包里那份没用）'
      report.schemeKeptLocal = true
    } else {
      let saved
      try {
        if (schemeMode === 'copy') {
          // 另存：不覆盖本机同名方案，课程改绑到新方案
          let id = schemeId + '-import'
          let n = 1
          while (schemeLib.readRawById(id)) {
            n++
            id = schemeId + '-import' + n
          }
          saved = schemeLib.saveAs(pkg.scheme, id, '导入课程包', '来自课程包 ' + courseId + '（另存为新方案）')
          boundSchemeId = saved.raw.id
        } else {
          saved = schemeLib.saveAs(pkg.scheme, schemeId, '导入课程包', '来自课程包 ' + courseId)
        }
      } catch (e) {
        const err = new HttpError(400, '包里的考核方案校验不过：' + e.message)
        err.errors = ['scheme.json：' + e.message]
        throw err
      }
      report.scheme = saved.raw.id + ' v' + saved.raw.version + (schemeMode === 'copy' ? '（另存为新方案）' : '')
    }
  }

  // 2) 课程记录
  const course = db.upsertCourse({
    id: courseId,
    name: String(pkg.course.name).trim(),
    note: String(pkg.course.note || '').slice(0, 500),
    semester: String(pkg.course.semester || '').trim().slice(0, 20),
    schemeId: pkg.scheme ? boundSchemeId || String(pkg.scheme.id || courseId) : undefined,
    contentDir: defaultContentDir(courseId),
    archived: false,
  })

  // 3) 内容文件
  const root = contentRootOf(course)
  for (const dir of CONTENT_ROOTS) fs.mkdirSync(path.join(root, dir), { recursive: true })

  const diff = await diffContent(db, course, pkg.files, pkg.has.content)
  const same = new Set(diff.unchanged)
  const destOf = new Map() // zip 内路径 → 磁盘绝对路径
  for (const f of pkg.files) {
    if (same.has(f.path)) continue // 内容一致，不用再写
    const full = path.join(root, f.path)
    if (!full.startsWith(root + path.sep)) continue
    destOf.set(f.zipName, full)
  }
  if (destOf.size) {
    // 流式解包：从 zip 里直接读到目标文件，内存里只有一条目的缓冲
    const done = await zipfile.extractTo(pkg.zipPath, (name) => destOf.get(name) || '')
    report.files.written = done.written
  }
  report.files.unchanged = diff.unchanged.length

  // replace：把包里没有的挪走（不真删 —— 老师点错了还能捞回来）
  // 放到 data/.trash/<时间戳>/<课程id>/ 下，保留相对路径；同盘 rename，不复制、不占额外空间
  if (strategy === 'replace' && pkg.has.content && diff.extra.length) {
    const stamp = trashStamp()
    const trashRoot = path.join(config.dataDir, '.trash', stamp, course.id)
    pruneTrash()
    let moved = 0
    for (const rel of diff.extra) {
      const full = path.join(root, rel)
      if (!full.startsWith(root + path.sep)) continue
      const dest = path.join(trashRoot, rel)
      if (!dest.startsWith(trashRoot + path.sep)) continue
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.renameSync(full, dest)
        moved++
      } catch (e) {
        // rename 失败（比如被占用）就退回删除，至少不留下半截
        try {
          fs.unlinkSync(full)
          moved++
        } catch (e2) {
          /* 真的动不了，跳过 */
        }
      }
    }
    report.files.removed = moved
    report.files.trash = {
      count: moved,
      dir: ['.trash', stamp, course.id].join('/'),
      abs: path.join(config.dataDir, '.trash', stamp, course.id),
    }
  }

  // 4) 班级 + 名单
  for (const cls of pkg.classes) {
    let target = db.listClassesOf(courseId).find((c) => c.name === cls.name) || null
    let action = 'update'
    if (!target) {
      target = db.createClass(uid('c'), cls.name, courseId)
      action = 'create'
    }
    const localSids = new Set(target.students.map((s) => s.sid))
    let added = 0
    for (const s of cls.students) {
      if (localSids.has(s.sid)) {
        target.students.find((x) => x.sid === s.sid).name = s.name // 改名跟着包走
        continue
      }
      target.students.push({ sid: s.sid, name: s.name })
      added++
    }
    let removed = 0
    if (strategy === 'replace') {
      // 名单同步成包里的：多余的人移出名单（他们的记分记录仍在 events 里，不会消失）
      const keep = new Set(cls.students.map((s) => s.sid))
      const kept = target.students.filter((s) => keep.has(s.sid))
      removed = target.students.length - kept.length
      target.students = kept
    }
    // 以前这里要 db.save() 手动落盘（CSV 时代）；SQLite 是即时写入，不需要
    studentsLib.ensureMany(target.id, target.students)
    report.classes.push({
      name: cls.name,
      action,
      students: cls.students.length,
      added,
      removed,
      total: target.students.length,
    })
  }

  report.courseId = course.id
  report.parts = ['course']
    .concat(pkg.has.scheme ? ['scheme'] : [])
    .concat(pkg.has.classes ? ['classes'] : [])
    .concat(pkg.has.content ? ['content'] : [])
  return report
}

export { readPackage, inspect, apply, STRATEGIES, parseCsv }
