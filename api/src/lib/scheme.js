/*
 * lib/scheme.js —— 考核方案（计分规则）的桥接层
 *
 * 这里**暂时复用旧后端的实现**（server/lib/scheme.js + rules/）：
 *   · 计分规则（base / acc / avg / last / raw / rubric …）是这套系统里最容易
 *     「看着一样、算出来差几分」的地方，重写一遍风险远大于收益；
 *   · 旧模块本身已经改成「每个请求一份上下文」（AsyncLocalStorage），
 *     不存在全局串味问题。
 *
 * S5 再把它内联进 api/src/lib（那时可以顺手清掉旧的 CSV 时代残留）。
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url)) // api/src/lib
const ROOT = path.resolve(HERE, '..', '..', '..') // 课堂系统/
const LEGACY = path.join(ROOT, 'server', 'lib')

export const scheme = require(path.join(LEGACY, 'scheme.js'))
export const scoring = require(path.join(LEGACY, 'scoring.js'))

/**
 * 在「这门课的方案」上下文里执行 fn。
 * 旧 scheme 的 activate 接受的是 **schemeId**（不是课程 id）——
 * 课程的 schemeId 为空时它自己会退回默认方案。
 */
export function withCourseScheme(course, fn) {
  return scheme.runInRequest(() => {
    scheme.activate(course && course.schemeId ? course.schemeId : '')
    return fn()
  })
}

/** 当前方案里的考勤项（form === 'attendance'），可以用 ?itemKey= 指定 */
export function attendanceItem(itemKey) {
  if (itemKey) {
    const hit = scheme.itemByKey(itemKey)
    if (hit) return hit
  }
  const list = scheme.items().filter((i) => i.form === 'attendance')
  return list[0] || scheme.itemByKey('attend') || null
}

/**
 * 某类考勤该扣几分 —— 与 base 规则同一口径：
 *   缺勤 → -perAbsent（默认 2）
 *   迟到 / 早退 → -perLate（默认 1）
 *   出勤 / 请假 → 0
 */
export function attendanceDelta(item, kind) {
  const p = (item && item.rule && item.rule.params) || {}
  const absentKind = (p.zeroRule && p.zeroRule.kind) || '缺勤'
  const perAbsent = p.perAbsent === undefined ? 2 : Number(p.perAbsent) || 0
  const perLate = p.perLate === undefined ? 1 : Number(p.perLate) || 0
  if (kind === absentKind) return -perAbsent
  if (kind === '迟到' || kind === '早退') return -perLate
  return 0
}

/** 一节课的槽位（后端只按字符串分组，不做死校验，给前端五个选项） */
export const SLOTS = ['1-2节', '3-4节', '5-6节', '7-8节', '9-10节']

export const dayOf = (iso) => String(iso || '').slice(0, 10)

/** 这条考勤账属于哪个节次：优先用事件上的 slot，老数据从 reason 里认 */
export function slotOf(e) {
  if (e && e.slot) return String(e.slot)
  const m = /(\d+-\d+节)/.exec(String((e && e.reason) || ''))
  return m ? m[1] : ''
}

/** 考勤是「留痕」还是「真扣分」：所有 kind 的扣分表 */
export function attendanceKinds(item) {
  return ['出勤', '迟到', '缺勤', '请假', '早退'].map((kind) => ({ kind, delta: attendanceDelta(item, kind) }))
}
