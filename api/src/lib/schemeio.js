/*
 * schemeio.js —— 考核方案的「单独导入 / 导出」
 *
 * 为什么单独做：方案是「数据」不是「代码」，同事之间传一份、下学期复用一份、
 * 一门课试两套方案，都不该被逼着打一整个课程包（包里还有几十 MB 的讲义和示例）。
 *
 * 三种导入模式（对应界面上的三个单选）：
 *   use  用上传的覆盖本机当前方案（版本 +1，变更日志记「导入方案」）
 *   keep 什么都不做（点错了/看完觉得不合适，能原样退出）
 *   copy 另存为新 id（如 example-course-import2），两套并存，不动当前方案
 *
 * 设计约定：只做「算差异 + 落盘」，不碰课程包逻辑；课程包导入时也复用这里的 diff()。
 */

/** 键排好序的 JSON：同样的内容一定得到同样的字符串 */

import * as schemeLib from './scheme.js'
import { HttpError } from './legacy-http.js'

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  if (v && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v)
        .filter((k) => ['version', 'changes', 'updatedAt', 'at'].indexOf(k) < 0)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canon(v[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(v === undefined ? null : v)
}

/** 本机当前方案的原始 JSON */
function currentRaw() {
  const cur = schemeLib.current()
  const id = cur.id || schemeLib.DEFAULT_ID
  const raw = schemeLib.readRawById(id)
  if (!raw) throw new HttpError(500, '读不到当前方案文件：' + schemeLib.fileOf(id))
  return { id, version: cur.version, raw }
}

/** 两套方案的差异（只比「实质内容」） */
function diff(a, b) {
  const A = a || {}
  const B = b || {}
  const top = []
  for (const k of ['name', 'totalFull', 'passLine', 'cap']) {
    if (canon(A[k]) !== canon(B[k])) top.push({ field: k, from: A[k], to: B[k] })
  }

  const mapOf = (s) => {
    const m = new Map()
    for (const it of (s && s.items) || []) if (it && it.key) m.set(String(it.key), it)
    return m
  }
  const ma = mapOf(A)
  const mb = mapOf(B)

  const added = []
  const removed = []
  const changed = []
  for (const [key, it] of mb) {
    if (!ma.has(key)) {
      added.push({ key, name: it.name || key, full: it.full })
      continue
    }
    const old = ma.get(key)
    const fields = []
    for (const f of ['name', 'full', 'form', 'rule', 'module']) {
      if (canon(old[f]) !== canon(it[f])) fields.push({ field: f, from: old[f], to: it[f] })
    }
    // 顺序变了也算一条（评分表列顺序跟着方案走）
    const ia = (A.items || []).findIndex((x) => x && x.key === key)
    const ib = (B.items || []).findIndex((x) => x && x.key === key)
    if (ia !== ib) fields.push({ field: 'order', from: ia + 1, to: ib + 1 })
    if (fields.length) changed.push({ key, name: it.name || old.name || key, fields })
  }
  for (const [key, it] of ma) {
    if (!mb.has(key)) removed.push({ key, name: it.name || key, full: it.full })
  }

  return {
    same: !top.length && !added.length && !removed.length && !changed.length,
    top,
    added,
    removed,
    changed,
  }
}

/** 干跑：上传的方案与本机当前方案差在哪（不写盘） */
function inspect(incoming) {
  let check
  try {
    check = schemeLib.validate(incoming)
  } catch (e) {
    check = { errors: [e.message], warnings: [] }
  }
  const cur = currentRaw()
  const d = diff(cur.raw, incoming)

  const warnings = (check.warnings || []).slice()
  const totalChanged = d.top.find((x) => x.field === 'totalFull')
  if (totalChanged) warnings.push('总满分 ' + totalChanged.from + ' → ' + totalChanged.to + '：已有记分会按新规则重新折算')
  for (const it of d.changed) {
    if (it.fields.some((f) => f.field === 'full')) {
      warnings.push('「' + it.name + '」满分变了：已有记录会按新规则重新算分（分数不会丢，但会变）')
    }
    if (it.fields.some((f) => f.field === 'rule')) {
      warnings.push('「' + it.name + '」的计分规则变了：已有记录按新规则重算')
    }
  }
  for (const it of d.removed) {
    warnings.push('「' + it.name + '」这一项被删了：已有记分记录仍留在流水里，但总评不再计算它')
  }

  return {
    ok: (check.errors || []).length === 0,
    errors: check.errors || [],
    warnings,
    current: { id: cur.id, version: cur.version, name: cur.raw.name, totalFull: cur.raw.totalFull, items: (cur.raw.items || []).length },
    incoming: {
      id: incoming && incoming.id,
      version: incoming && incoming.version,
      name: incoming && incoming.name,
      totalFull: incoming && incoming.totalFull,
      items: ((incoming && incoming.items) || []).length,
    },
    diff: d,
  }
}

/** 真正落盘 */
function apply(incoming, opts) {
  const o = opts || {}
  const mode = ['use', 'keep', 'copy'].indexOf(o.mode) >= 0 ? o.mode : 'use'
  const by = o.by || '教师'

  const check = schemeLib.validate(incoming)
  if ((check.errors || []).length) {
    const err = new HttpError(400, '方案校验不过：' + check.errors.slice(0, 6).join('；'))
    err.errors = check.errors
    throw err
  }

  const cur = currentRaw()
  const d = diff(cur.raw, incoming)

  if (mode === 'keep') {
    return { ok: true, mode, changed: false, current: { id: cur.id, version: cur.version } }
  }

  if (mode === 'copy') {
    // 新 id：`<原 id>-import`，重名就 -2、-3…
    const base = String(incoming.id || cur.id || 'scheme').replace(/-import\d*$/, '')
    let id = base + '-import'
    let n = 1
    while (schemeLib.readRawById(id)) {
      n++
      id = base + '-import' + n
    }
    const saved = schemeLib.saveAs(incoming, id, by, '导入的方案（另存为新方案）')
    return {
      ok: true,
      mode,
      changed: true,
      savedId: saved.raw.id,
      version: saved.raw.version,
      warnings: saved.warnings || [],
      diff: d,
    }
  }

  // use：覆盖本机当前方案
  const saved = schemeLib.save(incoming, by, '导入方案（来自文件）')
  return {
    ok: true,
    mode: 'use',
    changed: true,
    savedId: saved.raw.id || cur.id,
    version: saved.raw.version,
    warnings: saved.warnings || [],
    diff: d,
  }
}

export { canon, diff, currentRaw, inspect, apply }
