/*
 * classio.js —— 一门课的「班级 + 名单」整体导入 / 导出（zip）
 *
 * 为什么要它：名单模板是「一个班一份」，新部署或换机器时要一个班一个班点进去导，
 * 十来个班就是十来次。这里把整门课的班与名单打成一个 zip，导回来一次搞定。
 *
 * zip 结构刻意做得像人话 —— 一个班 = 一个 csv 文件，文件名就是班名：
 *
 *   classes/示例1班.roster.csv
 *   classes/示例2班.roster.csv
 *   README.txt
 *
 * 没有 index.json 之类的中间层：老师用 Excel 改完丢回来就行。
 * csv 三列「学号,姓名,备注」（同课程包里的名单格式），UTF-8 带不带 BOM 都认。
 */

import fs from 'fs'
import path from 'path'
import { makeZip, readZip } from './zip.js'
import { HttpError } from './legacy-http.js'
import { rowsFromText, rowsToRoster } from './sheet.js'
import * as studentsLib from './students.js'

const MAX_BYTES = 20 * 1024 * 1024 // 名单 zip 上限：二十来个班也才几十 KB

/** 班名 → 文件名（去掉 Windows 不允许的字符） */
function fileNameOf(name) {
  return (
    String(name || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim() || '未命名班级'
  )
}

/** 文件名 → 班名 */
function classNameOf(entryName) {
  const base = String(entryName || '')
    .split('/')
    .pop()
    .replace(/\.roster\.csv$/i, '')
    .replace(/\.csv$/i, '')
  return base.trim()
}

function rosterCsv(students) {
  const rows = [['学号', '姓名', '备注']]
  for (const s of students || []) rows.push([s.sid, s.name, s.note || ''])
  const esc = (v) => {
    const t = String(v == null ? '' : v)
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t
  }
  return '\ufeff' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n'
}

const README = `班级与名单（导入导出）

这个包里一个 csv 文件 = 一个班，文件名就是班名：
  classes/示例1班.roster.csv
  classes/示例2班.roster.csv

每个 csv 三列：学号,姓名,备注（和课程包里的名单格式一样，UTF-8，Excel 直接打开）
· 学号必填、不能重复；姓名必填，最多 20 字；备注可以空
· 改完直接另存为 CSV（UTF-8），再压缩成 zip 导回来

导入时会先给一份报告：哪些班是新建、每个班新增/改名/移出几个人，确认后才写。
· 「合并」= 名单只增不减（推荐）
· 「整体替换」= 名单同步成包里的，多出来的人移出名单（他们的记分记录仍然保留）

包里没有的班不会被删除 —— 想删某个班请在班级管理里单独删。
`

/** 导出：整门课的班 + 名单 */
function exportClasses(db, course) {
  const classes = db.listClassesOf(course.id)
  if (!classes.length) throw new HttpError(400, '这门课还没有班级，没什么可导出的')
  const entries = []
  const seen = new Set()
  for (const c of classes) {
    let name = fileNameOf(c.name) + '.roster.csv'
    if (seen.has(name.toLowerCase())) name = fileNameOf(c.name) + '-' + c.id + '.roster.csv'
    seen.add(name.toLowerCase())
    entries.push({ path: 'classes/' + name, data: Buffer.from(rosterCsv(db.rosterOf(c.id)), 'utf8') })
  }
  entries.push({ path: 'README.txt', data: Buffer.from(README, 'utf8') })
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
  return {
    filename: course.id + '_classes_' + stamp + '.zip',
    buffer: makeZip(entries),
    classes: classes.length,
  }
}

/** 空壳模板：一个示例班 + 说明 */
function templateZip() {
  const sample = [
    ['2025010101', '张三', ''],
    ['2025010102', '李四', '班长'],
    ['2025010103', '王五', ''],
  ]
  const entries = [
    { path: 'classes/示例班级.roster.csv', data: Buffer.from(rosterCsv(sample.map((r) => ({ sid: r[0], name: r[1], note: r[2] }))), 'utf8') },
    { path: 'README.txt', data: Buffer.from(README, 'utf8') },
  ]
  return { filename: 'classes-template.zip', buffer: makeZip(entries) }
}

/** 解析一个 zip：班名 → 学生列表（含逐行问题） */
function parseZip(buf) {
  if (buf.length > MAX_BYTES) throw new HttpError(413, '包太大（上限 ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB）')
  let zipped = []
  try {
    zipped = readZip(buf)
  } catch (e) {
    throw new HttpError(400, '这不是一个可用的 zip：' + e.message)
  }
  const out = []
  const issues = []
  for (const f of zipped) {
    const name = String(f.name || '')
    if (/\.roster\.csv$/i.test(name) === false) continue // 只认 *.roster.csv
    const cls = classNameOf(name)
    if (!cls) continue
    const parsed = rowsToRoster(rowsFromText(f.data.toString('utf8')))
    for (const it of parsed.issues || []) {
      issues.push({ cls, line: it.line, msg: it.msg })
    }
    const students = parsed.students || []
    if (!students.length) {
      issues.push({ cls, line: 0, msg: '这个班一个学生都没解析出来（检查表头是不是「学号,姓名」）' })
      continue
    }
    if (out.some((x) => x.name === cls)) {
      issues.push({ cls, line: 0, msg: '同一个班出现了两个文件，只用了第一个' })
      continue
    }
    out.push({ name: cls, students })
  }
  if (!out.length) throw new HttpError(400, '包里没有 *.roster.csv（一个班一个 csv，文件名就是班名）')
  return { classes: out, issues }
}

/** 干跑：这个 zip 会让每个班变成什么样 */
function plan(db, course, buf) {
  const { classes, issues } = parseZip(buf)
  const local = db.listClassesOf(course.id)
  const byName = new Map(local.map((c) => [c.name, c]))
  const rows = []
  for (const pack of classes) {
    const hit = byName.get(pack.name)
    if (!hit) {
      rows.push({
        name: pack.name,
        action: 'create',
        added: pack.students.length,
        updated: 0,
        removed: 0,
        before: 0,
        after: pack.students.length,
        renamed: [],
        removedSids: [],
      })
      continue
    }
    const mine = new Map(db.rosterOf(hit.id).map((s) => [s.sid, s.name]))
    const theirs = new Set(pack.students.map((s) => s.sid))
    const added = pack.students.filter((s) => !mine.has(s.sid))
    const renamed = pack.students
      .filter((s) => mine.has(s.sid) && mine.get(s.sid) !== s.name)
      .map((s) => ({ sid: s.sid, from: mine.get(s.sid), to: s.name }))
    const removed = [...mine.keys()].filter((sid) => !theirs.has(sid))
    rows.push({
      name: pack.name,
      action: 'update',
      added: added.length,
      updated: renamed.length,
      removed: removed.length,
      before: mine.size,
      after: pack.students.length,
      renamed: renamed.slice(0, 20),
      removedSids: removed.slice(0, 20),
    })
  }
  const notInPack = local.filter((c) => !classes.some((x) => x.name === c.name)).map((c) => c.name)
  return {
    classes: rows,
    issues,
    notInPack,
    totals: {
      create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length,
      added: rows.reduce((n, r) => n + r.added, 0),
      renamed: rows.reduce((n, r) => n + r.updated, 0),
      removed: rows.reduce((n, r) => n + r.removed, 0),
      students: rows.reduce((n, r) => n + r.after, 0),
    },
  }
}

/** 真写 */
function apply(db, course, buf, mode) {
  const p = plan(db, course, buf)
  const { classes } = parseZip(buf)
  const done = []
  for (const pack of classes) {
    let target = db.listClassesOf(course.id).find((c) => c.name === pack.name) || null
    let action = 'update'
    if (!target) {
      target = db.createClass('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), pack.name, course.id)
      action = 'create'
    }
    const mine = new Map(target.students.map((s) => [s.sid, s.name]))
    let added = 0
    let updated = 0
    for (const s of pack.students) {
      if (!mine.has(s.sid)) {
        target.students.push({ sid: s.sid, name: s.name })
        added++
      } else if (mine.get(s.sid) !== s.name) {
        target.students.find((x) => x.sid === s.sid).name = s.name
        updated++
      }
    }
    let removed = 0
    if (mode === 'replace') {
      const keep = new Set(pack.students.map((s) => s.sid))
      const kept = target.students.filter((s) => keep.has(s.sid))
      removed = target.students.length - kept.length
      target.students = kept
    }
    // 以前这里要 db.save() 手动落盘（CSV 时代）；SQLite 是即时写入，不需要
    studentsLib.ensureMany(target.id, target.students)
    done.push({ name: target.name, action, added, updated, removed, total: target.students.length })
  }
  return {
    mode,
    classes: done,
    totals: {
      classes: done.length,
      created: done.filter((x) => x.action === 'create').length,
      added: done.reduce((n, x) => n + x.added, 0),
      renamed: done.reduce((n, x) => n + x.updated, 0),
      removed: done.reduce((n, x) => n + x.removed, 0),
    },
    notInPack: p.notInPack,
  }
}

export { exportClasses, templateZip, plan, apply, README, rosterCsv }
