'use strict'
/*
 * scheme.js —— 考核方案（数据）加载 / 校验 / 物化
 *
 * 方案存在 data/schemes/<id>.json，**进 git、老师可直接改**：
 *   改分值、改规则参数、开关模块 → 保存即生效（按文件 mtime 热加载，不用重启服务）。
 *
 * 这一层干三件事：
 *   1) 读文件 + 校验（项 key 唯一、满分合计、规则参数齐不齐）；
 *   2) 把「方案」物化成界面认识的老结构（key/name/short/full/mode/grades/dims…），
 *      这样评分表、抽屉、记分表单一行都不用改；
 *   3) 提供 itemByKey / mainItems / version 给算分与业务接口。
 *
 * 为什么不做版本锁：老师可能学期中按学情调分值。方案只存「怎么折算」，
 * 事实（等级、缺勤、卷面分）都在 events.csv 里不动 —— 所以改分值 = 重新折算，不需要数据迁移。
 * 想让改动可追溯，方案里带 changes[] 与 version（由编辑接口维护，本层只读）。
 */
const fs = require('fs')
const path = require('path')
const config = require('../config')
const { RULES } = require('./rules')

const DIR = path.join(config.dataDir, 'schemes')
const DEFAULT_ID = 'example-course'

/** 极端情况（文件被删/损坏）的兜底：只保结构与算法，文案降级用 */
const FALLBACK = {
  id: DEFAULT_ID,
  name: '示例课程',
  version: 1,
  totalFull: 100,
  passLine: 60,
  cap: 100,
  items: [
    { key: 'attend', name: '考勤', short: '考勤', full: 10, form: 'attendance', module: { enabled: true, title: '考勤点名', submit: 'files' }, hint: '默认全勤 {start} 分；缺勤每次扣 {perAbsent} 分、迟到/早退每次扣 {perLate} 分；缺勤满 {zeroRule.count} 次（迟到 {zeroRule.lateMerge} 次折 1 次）本项计 0 分。', rule: { type: 'base', params: { start: 10, perAbsent: 2, perLate: 1, zeroRule: { kind: '缺勤', count: 3, lateMerge: 2 } } } },
    { key: 'interact', name: '课堂互动', short: '互动', full: 10, form: 'manual', module: { enabled: true, title: '课堂互动', submit: 'files' }, hint: '主动发言 / 上台演示 / 有效提问 / 小组协作，每次加分{hitText}，加到 {full} 分封顶。', rule: { type: 'acc', params: { start: 0 } } },
    { key: 'homework', name: '课堂作业', short: '作业', full: 20, form: 'graded', module: { enabled: true, title: '课堂作业', submit: 'code' }, hint: '逐次判 {gradesText}，取均分折算到 {full} 分；迟交按 {latePercent}%{skipText}。', rule: { type: 'avg', params: { grades: [{ key: 'A', label: 'A（优秀 100）', factor: 1 }, { key: 'B', label: 'B（良好 85）', factor: 0.85 }, { key: 'C', label: 'C（中等 70）', factor: 0.7 }, { key: 'D', label: 'D（及格 60）', factor: 0.6 }, { key: 'F', label: 'F（不及格 0）', factor: 0 }], lateFactor: 0.5 } } },
    { key: 'exam', name: '期末机试', short: '机试', full: 30, form: 'paper', module: { enabled: true, title: '期末机试', submit: 'files' }, hint: '卷面满分 {rawFull} 分，按 {factorPercent}% 折算为本项 {full} 分（以最后一次录入为准）。', rule: { type: 'raw', params: { rawFull: 100, factor: 0.3 } } },
    { key: 'project', name: '期末大作业', short: '大作业', full: 30, form: 'rubric', module: { enabled: true, title: '大作业', submit: 'files' }, hint: '量规：{dimsText}（合计 {dimsSum} 分），折合本项 {full} 分（以最后一次录入为准）。', rule: { type: 'rubric', params: { dims: [{ key: 'func', name: '功能完整', full: 12 }, { key: 'code', name: '代码结构', full: 9 }, { key: 'ui', name: '界面体验', full: 6 }, { key: 'doc', name: '部署与文档', full: 3 }] } } },
    { key: 'bonus', name: '加分', short: '加分', full: 5, extra: true, form: 'manual', module: { enabled: false }, hint: '奖励性加分，计入总评但不突破封顶；总评封顶 {cap} 分。', rule: { type: 'acc', params: { start: 0 } } },
  ],
}

let cache = { file: '', mtimeMs: 0, data: null }

/**
 * 当前生效的方案 id（跟着课程走）。
 * 每个请求进来时由 api.js 按「学生班级所属课程 / 教师选中的课程」设一次，
 * 之后 scoring / 方案页 / 模块开关 全部读这一份。
 */
let activeId = ''

function activate(id) {
  const next = String(id || '')
  if (next !== activeId) {
    activeId = next
    cache = { file: '', mtimeMs: 0, data: null }
  }
  return activeId
}

function activeSchemeId() {
  return activeId
}

function fileOf(id) {
  return path.join(DIR, (id || DEFAULT_ID) + '.json')
}

/** 当前方案文件：目录里按 id 找，找不到用默认 id */
function activeFile() {
  if (activeId) {
    const f = fileOf(activeId)
    if (fs.existsSync(f)) return f
  }
  const f = fileOf(DEFAULT_ID)
  return fs.existsSync(f) ? f : ''
}

function readRaw(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return null
  }
}

/** 校验：返回 { errors, warnings }；errors 非空说明这份方案不能直接用 */
function validate(raw) {
  const errors = []
  const warnings = []
  if (!raw || typeof raw !== 'object') return { errors: ['方案不是合法 JSON 对象'], warnings }
  if (!raw.id) errors.push('缺少 id')
  if (!Array.isArray(raw.items) || !raw.items.length) errors.push('items 不能为空')

  const seen = new Set()
  let mainSum = 0
  for (const it of raw.items || []) {
    const tag = '项「' + (it.key || it.name || '?') + '」'
    if (!it.key) errors.push(tag + ' 缺少 key')
    else if (seen.has(it.key)) errors.push(tag + ' 的 key 重复')
    seen.add(it.key)
    if (!it.name) errors.push(tag + ' 缺少名称')
    if (!(Number(it.full) > 0)) errors.push(tag + ' 的满分必须大于 0')
    const type = it.rule && it.rule.type
    if (!type || !RULES[type]) errors.push(tag + ' 的规则类型不认识：' + String(type))
    if (type === 'avg' && !(it.rule.params && Array.isArray(it.rule.params.grades) && it.rule.params.grades.length)) {
      errors.push(tag + ' 用「多次取均」但没有等级表')
    }
    if (type === 'rubric') {
      const dims = (it.rule.params && it.rule.params.dims) || []
      if (!dims.length) errors.push(tag + ' 用「量规」但没有维度')
      else {
        const sum = dims.reduce((s, d) => s + Number(d.full || 0), 0)
        if (Math.abs(sum - Number(it.full)) > 0.01) {
          warnings.push(tag + ' 维度合计 ' + sum + ' ≠ 本项满分 ' + it.full + '（以维度为准并封顶）')
        }
      }
    }
    if (type === 'raw' && !(Number(it.rule.params && it.rule.params.rawFull) > 0)) {
      errors.push(tag + ' 用「卷面分」但没写卷面满分')
    }
    if (!it.extra) mainSum += Number(it.full) || 0
  }

  const total = Number(raw.totalFull || 100)
  if (Math.abs(mainSum - total) > 0.01) warnings.push('各项满分合计 ' + mainSum + ' ≠ 总满分 ' + total)
  return { errors, warnings }
}

/** 取 a.b.c 这种路径上的值 */
function pathOf(obj, p) {
  let cur = obj
  for (const seg of String(p).split('.')) {
    if (cur === undefined || cur === null) return undefined
    cur = cur[seg]
  }
  return cur
}

/**
 * 说明文字的模板渲染：{full} / {perAbsent} / {zeroRule.count} …
 * 认识的变量替换成当前值；不认识的**原样保留**（老师一眼能看出写错了）。
 */
function fillTemplate(text, ctx) {
  if (!text) return ''
  return String(text).replace(/\{([A-Za-z0-9_.]+)\}/g, (m, key) => {
    const v = pathOf(ctx, key)
    return v === undefined || v === null ? m : String(v)
  })
}

/**
 * 说明模板能用哪些变量：把「考核项 + 规则参数」摊平成一个上下文，
 * 顺带算几个好用的派生值（等级表文本、量规合计、折算百分比…）。
 */
function hintContext(item, params, extra) {
  const p = params || {}
  const n = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v) || 0)
  const dims = Array.isArray(p.dims) ? p.dims : []
  const grades = Array.isArray(p.grades) ? p.grades : []
  const rawFull = n(p.rawFull, 100) || 100
  const factor = p.factor === undefined ? (Number(item.full) || 0) / rawFull : Number(p.factor) || 0
  const lateFactor = p.lateFactor === undefined ? 1 : Number(p.lateFactor)
  return Object.assign(
    {},
    p,
    {
      key: item.key,
      name: item.name,
      short: item.short || item.name,
      full: item.full,
      start: p.start === undefined ? item.full : n(p.start, 0),
      perAbsent: n(p.perAbsent, 2),
      perLate: n(p.perLate, 1),
      gradesText: grades.map((g) => g.label || g.name || g.key).join(' / ') || 'A / B / C',
      latePercent: Math.round(lateFactor * 100),
      skipText: n(p.skipWorst, 0) > 0 ? '，去掉最差 ' + n(p.skipWorst, 0) + ' 次' : '',
      dimsText: dims.map((d) => (d.name || d.key) + ' ' + (d.full === undefined ? '' : d.full)).join(' + '),
      dimsSum: dims.reduce((s, d) => s + (Number(d.full) || 0), 0),
      rawFull,
      factorPercent: Math.round(factor * 1000) / 10,
      hitText: p.perHitMax ? '（单次最多 ' + n(p.perHitMax, 0) + ' 分）' : '',
    },
    extra || {}
  )
}

/** 方案项 → 界面认识的老结构（评分表 / 抽屉 / 记分表单直接用这些字段） */
function materialize(raw) {
  const totalFull = Number(raw.totalFull || 100)
  const items = (raw.items || []).map((it, i) => {
    const rule = it.rule || { type: 'acc', params: {} }
    const p = rule.params || {}
    const out = {
      key: it.key,
      name: it.name,
      short: it.short || it.name,
      full: Number(it.full) || 0,
      extra: !!it.extra,
      order: it.order === undefined ? i + 1 : Number(it.order),
      mode: rule.type, // 兼容老代码：mode 就是规则类型
      rule: { type: rule.type, params: p },
      // hint 是**模板**：{full} {perAbsent} {zeroRule.count} 之类在读取时按当前参数渲染，
      // 所以老师改分值/改扣分，说明文字自动跟着变，不用手动同步。
      hint: fillTemplate(it.hint || '', hintContext(it, p, { cap: totalFull })),
      hintTemplate: it.hint || '',
      presets: Array.isArray(it.presets) ? it.presets : [],
      reasonRequired: it.reasonRequired !== false,
      reasonLabel: it.reasonLabel || '原因 / 说明',
      form: it.form || 'manual',
      module: it.module || { enabled: false },
    }

    if (rule.type === 'base') {
      out.base = p.start === undefined ? out.full : Number(p.start)
      out.start = 0
    }
    if (rule.type === 'acc') {
      out.start = p.start === undefined ? 0 : Number(p.start)
      out.base = 0
    }
    if (rule.type === 'avg' || rule.type === 'last') {
      out.grades = (p.grades || []).map((g) => ({
        key: g.key,
        name: g.label || g.name || g.key,
        factor: g.factor === undefined ? 0 : Number(g.factor),
      }))
      out.lateFactor = p.lateFactor === undefined ? 1 : Number(p.lateFactor)
    }
    if (rule.type === 'raw') {
      out.rawFull = Number(p.rawFull || 100)
      out.factor = p.factor === undefined ? out.full / out.rawFull : Number(p.factor)
    }
    if (rule.type === 'rubric') {
      out.dims = (p.dims || []).map((d) => {
        const byWeight = d.full === undefined && d.weight !== undefined
        return {
          key: d.key,
          name: d.name || d.key,
          full: byWeight ? Math.round(((Number(d.weight) || 0) / 100) * out.full * 10) / 10 : Number(d.full) || 0,
        }
      })
    }
    return out
  })

  items.sort((a, b) => a.order - b.order)
  return {
    id: raw.id || DEFAULT_ID,
    name: raw.name || '考核方案',
    version: Number(raw.version) || 1,
    totalFull,
    passLine: Number(raw.passLine || 60),
    cap: Number(raw.cap || 100),
    items,
    file: '',
  }
}

/**
 * 取当前方案（按 mtime 热加载：老师改完文件不用重启服务）
 * 文件坏了不会把系统带下来：沿用上一次成功的方案，实在没有就用内置兜底。
 */
function current() {
  const file = activeFile()
  if (!file) {
    if (!cache.data) {
      const target = fileOf(DEFAULT_ID)
      let wrote = false
      try {
        if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
        fs.writeFileSync(target, JSON.stringify(FALLBACK, null, 2), 'utf8')
        wrote = true
        console.log('[scheme] 没找到考核方案，已按内置默认生成：' + target)
      } catch (e) {
        /* 只读介质：忽略，下面用内存兜底 */
      }
      if (wrote) return current()
      console.error('[scheme] 没找到考核方案文件（' + target + '），暂用内置兜底')
      cache = { file: '', mtimeMs: 0, data: materialize(FALLBACK) }
    }
    return cache.data
  }

  let st
  try {
    st = fs.statSync(file)
  } catch (e) {
    return cache.data || materialize(FALLBACK)
  }
  if (cache.data && cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.data

  const raw = readRaw(file)
  const check = validate(raw)
  if (check.errors.length) {
    console.error('[scheme] 方案文件有问题，暂用上一版：' + check.errors.join('；'))
    if (cache.data) return cache.data
    cache = { file, mtimeMs: 0, data: materialize(FALLBACK) }
    return cache.data
  }
  if (check.warnings.length) console.log('[scheme] 提示：' + check.warnings.join('；'))

  const data = materialize(raw)
  data.file = file
  cache = { file, mtimeMs: st.mtimeMs, data }
  return data
}

/** 变更摘要：只记"人看得出来"的差别（改分值 / 增删项 / 模块开关） */
function diffSummary(prev, next) {
  const out = []
  const before = ((prev && prev.items) || []).reduce((m, i) => ((m[i.key] = i), m), {})
  const after = (next.items || []).reduce((m, i) => ((m[i.key] = i), m), {})
  for (const k of Object.keys(after)) {
    const a = before[k]
    const b = after[k]
    if (!a) {
      out.push('新增：' + b.name + ' ' + b.full + ' 分')
      continue
    }
    if (Number(a.full) !== Number(b.full)) out.push(b.name + ' 满分 ' + a.full + ' → ' + b.full)
    if (a.name !== b.name) out.push('改名：' + a.name + ' → ' + b.name)
    const wasOn = !!(a.module && a.module.enabled)
    const isOn = !!(b.module && b.module.enabled)
    if (wasOn !== isOn) out.push(b.name + (isOn ? ' 模块启用' : ' 模块关闭'))
    const ta = (a.rule && a.rule.type) || ''
    const tb = (b.rule && b.rule.type) || ''
    if (ta !== tb) out.push(b.name + ' 规则 ' + ta + ' → ' + tb)
  }
  for (const k of Object.keys(before)) if (!after[k]) out.push('删除：' + before[k].name)
  if (prev && Number(prev.totalFull) !== Number(next.totalFull)) out.push('总满分 ' + prev.totalFull + ' → ' + next.totalFull)
  return out.slice(0, 20)
}

/**
 * 保存方案（老师端的「保存」按钮走这里）：
 *   校验 → 版本号 +1 → 追加一条变更日志 → 写盘 → 下次读取按 mtime 重新加载。
 * 校验不过不写盘，把 errors 抛给上层转成 400。
 */
function save(raw, by, note) {
  const check = validate(raw)
  if (check.errors.length) {
    const err = new Error(check.errors.join('；'))
    err.status = 400
    err.errors = check.errors
    throw err
  }
  const file = activeFile() || fileOf(DEFAULT_ID)
  const prev = readRaw(file)
  const now = new Date().toISOString()
  const next = Object.assign({}, raw)
  next.version = (Number(prev && prev.version) || 0) + 1
  next.updatedAt = now
  next.changes = ((prev && prev.changes) || []).slice()
  next.changes.push({
    at: now,
    by: by || '教师',
    note: String(note || '').slice(0, 200),
    summary: diffSummary(prev, next),
  })
  if (next.changes.length > 50) next.changes = next.changes.slice(-50)
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  cache = { file: '', mtimeMs: 0, data: null } // 强制下一次 current() 重新读
  return { raw: next, warnings: check.warnings }
}

/** 读某个方案 id 的原始 JSON（不存在返回 null） */
function readRawById(id) {
  return readRaw(fileOf(id))
}

/**
 * 存成指定 id 的方案（导入课程包用）：跟 save() 一样会升版本、写变更日志，
 * 但目标文件由 id 决定，不会覆盖「当前方案」。
 */
function saveAs(raw, id, by, note) {
  const check = validate(raw)
  if (check.errors.length) {
    const err = new Error(check.errors.join('；'))
    err.status = 400
    err.errors = check.errors
    throw err
  }
  const file = fileOf(id)
  const prev = readRaw(file)
  const now = new Date().toISOString()
  const next = Object.assign({}, raw)
  next.id = id
  next.version = (Number(prev && prev.version) || 0) + 1
  next.updatedAt = now
  next.changes = ((prev && prev.changes) || []).slice()
  next.changes.push({ at: now, by: by || '教师', note: String(note || '').slice(0, 200), summary: diffSummary(prev, next) })
  if (next.changes.length > 50) next.changes = next.changes.slice(-50)
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  cache = { file: '', mtimeMs: 0, data: null }
  return { raw: next, warnings: check.warnings }
}

const items = () => current().items
const mainItems = () => items().filter((i) => !i.extra)
const itemByKey = (key) => items().find((i) => i.key === key) || null
const version = () => current().version
const publicInfo = () => {
  const s = current()
  return { id: s.id, name: s.name, version: s.version, totalFull: s.totalFull, passLine: s.passLine, cap: s.cap, file: s.file }
}

module.exports = {
  DIR,
  DEFAULT_ID,
  fileOf,
  validate,
  materialize,
  fillTemplate,
  hintContext,
  current,
  items,
  mainItems,
  itemByKey,
  version,
  publicInfo,
  diffSummary,
  readRawById,
  saveAs,
  activate,
  activeSchemeId,
  save,
  FALLBACK,
}
