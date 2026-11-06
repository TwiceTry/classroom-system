/*
 * lib/submitstore.js —— 学生提交的文件落盘
 *
 * 目录沿用旧后端的结构，**这样老数据不用搬**：
 *   data/students/<classId>/<sid>/作业/<作业id>/      课堂作业（交代码文本）
 *   data/students/<classId>/<sid>/大作业/<作业id>/    大作业（交附件）
 *   data/students/<classId>/<sid>/机试/<作业id>/      机试（答卷）
 *
 * 两条安全约定：
 *   · 文件名一律清洗（去路径分隔符 + 保留末 80 字符），不允许 `../`
 *   · 落盘前校验最终路径仍在学生的作业目录之内
 */
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

/** 作业类型 → 目录名（与旧布局一致） */
const DIR_OF_KIND = { work: '作业', project: '大作业', paper: '机试' }

const dirName = (kind) => DIR_OF_KIND[kind] || '作业'

/** 清洗文件名：不留路径成分，只留末 80 字符 */
export function safeName(name) {
  return String(name || 'file')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '_')
    .slice(-80) || 'file'
}

/** 某个学生某次作业的目录 */
export function dirOf(kind, classId, sid, assignmentId) {
  return path.join(config.dataDir, 'students', String(classId), String(sid), dirName(kind), String(assignmentId))
}

/** 目录内的安全落点 */
function targetInside(dir, name) {
  const full = path.resolve(dir, safeName(name))
  const base = path.resolve(dir)
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('文件名越界：' + name)
  return full
}

/** 写入一批文件：entries = [{ name, text }] 或 [{ name, dataUrl }] */
export function writeFiles(kind, classId, sid, assignmentId, entries) {
  const dir = dirOf(kind, classId, sid, assignmentId)
  fs.mkdirSync(dir, { recursive: true })
  const written = []
  for (const e of entries || []) {
    const name = safeName(e.name)
    const full = targetInside(dir, name)
    let buf
    if (typeof e.text === 'string') {
      buf = Buffer.from(e.text, 'utf8')
    } else if (typeof e.dataUrl === 'string') {
      const m = /^data:[\w/+.-]+;base64,(.+)$/.exec(e.dataUrl)
      if (!m) continue
      buf = Buffer.from(m[1], 'base64')
    } else {
      continue
    }
    fs.writeFileSync(full, buf)
    written.push({ name, size: buf.length })
  }
  return written
}

/** 列目录里的文件 */
export function listFiles(kind, classId, sid, assignmentId) {
  const dir = dirOf(kind, classId, sid, assignmentId)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, size: fs.statSync(path.join(dir, d.name)).size }))
}

/** 读文本（课堂作业批阅时看代码） */
export function readTextFiles(kind, classId, sid, assignmentId, names) {
  const dir = dirOf(kind, classId, sid, assignmentId)
  const list = Array.isArray(names) && names.length ? names.map(safeName) : listFiles(kind, classId, sid, assignmentId).map((f) => f.name)
  const out = []
  for (const name of list) {
    const full = targetInside(dir, name)
    if (!fs.existsSync(full)) continue
    const st = fs.statSync(full)
    if (st.size > 512 * 1024) {
      out.push({ name, size: st.size, text: '', note: '文件较大，请下载查看' })
      continue
    }
    try {
      out.push({ name, size: st.size, text: fs.readFileSync(full, 'utf8') })
    } catch (e) {
      out.push({ name, size: st.size, text: '', note: '不是文本文件' })
    }
  }
  return out
}

/** 读单个文件的绝对路径（下载用；调用方负责再验身份） */
export function filePathOf(kind, classId, sid, assignmentId, name) {
  const dir = dirOf(kind, classId, sid, assignmentId)
  const full = targetInside(dir, name)
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : ''
}

/** 删掉这次作业在所有学生下的目录（删作业时用） */
export function removeAssignmentEverywhere(kind, assignmentId, classes) {
  let removed = 0
  for (const c of classes || []) {
    for (const s of c.students || []) {
      const dir = dirOf(kind, c.id, s.sid, assignmentId)
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true })
          removed++
        }
      } catch (e) {
        /* 被占用就下次再说 */
      }
    }
  }
  return removed
}
