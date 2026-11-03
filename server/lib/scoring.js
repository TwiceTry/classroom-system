'use strict'
/*
 * scoring.js —— 算分（服务端权威，前端只展示）
 *
 * 改造后这里只剩「解释器」的职责：
 *   · 方案（有哪些考核项、每项满分、用哪条规则、规则参数）→ 全在 data/schemes/*.json（lib/scheme.js 读）
 *   · 具体怎么算 → 全在 lib/rules/*（base / acc / avg / last / raw / rubric …）
 * 这个文件只负责「取方案 → 逐项跑规则 → 汇总总评」，以及把一条记分记录翻译成人话。
 *
 * 为什么保留 ITEMS / MAIN_ITEMS 这些名字：评分表、抽屉、记分表单都在用，
 * 改成 getter 之后调用方一行都不用动，但内容已经随方案热更新了。
 *
 * 考核方案（对齐附件1）默认是：总评 100 = 考勤 10 + 互动 10 + 作业 20 + 机试 30 + 大作业 30，
 * 另有加分项，计入总分但总分不超过 100。换课程只要换一份方案文件。
 */
const scheme = require('./scheme')
const { ruleOf, round1, clamp } = require('./rules')

/** 一个计分项在给定事件下的得分（规则来自方案，不是写死的 if/else） */
function itemScore(item, events) {
  if (!item) return 0
  const rule = ruleOf(item.rule ? item.rule.type : item.mode)
  if (!rule) return 0
  return rule.score(item, events)
}

function gradeFactor(item, gradeKey) {
  const g = (item.grades || []).find((x) => x.key === gradeKey)
  return g ? g.factor : 0
}

/** 用一个指定的考核项清单算分（方案编辑器试算时用，不依赖全局方案） */
function computeStudentWith(items, cap, events, sid) {
  const mine = (events || []).filter((e) => e.sid === sid)
  const rows = (items || []).map((item) => {
    const list = mine.filter((e) => e.item === item.key)
    return { item, events: list, score: itemScore(item, list) }
  })
  const sum = (rs) => rs.reduce((s, r) => s + r.score, 0)
  const base = sum(rows.filter((r) => !r.item.extra))
  const extra = sum(rows.filter((r) => r.item.extra))
  return {
    rows,
    base: round1(base),
    extra: round1(extra),
    total: round1(Math.min(cap || 100, base + extra)),
    capped: base + extra > (cap || 100),
  }
}

/** 用一个指定的考核项清单算全班（方案编辑器「改前/改后」对比用） */
function computeClassWith(items, cap, passLine, students, events) {
  const scoreOf = (sid) => computeStudentWith(items, cap, events, sid)
  const list = (students || []).map((s) => Object.assign({ student: s }, scoreOf(s.sid)))
  const n = list.length || 1
  const avg = (pick) => round1(list.reduce((s, r) => s + pick(r), 0) / n)
  return {
    list,
    count: list.length,
    totalAvg: avg((r) => r.total),
    passRate: Math.round((list.filter((r) => r.total >= (passLine || 60)).length / n) * 100),
  }
}

/** 一个学生的完整得分 */
function computeStudent(events, sid) {
  const mine = (events || []).filter((e) => e.sid === sid)
  const rows = scheme.items().map((item) => {
    const list = mine.filter((e) => e.item === item.key)
    return { item, events: list, score: itemScore(item, list) }
  })
  const sum = (rs) => rs.reduce((s, r) => s + r.score, 0)
  const base = sum(rows.filter((r) => !r.item.extra))
  const extra = sum(rows.filter((r) => r.item.extra))
  const cap = scheme.current().cap || 100
  return {
    rows,
    base: round1(base),
    extra: round1(extra),
    total: round1(Math.min(cap, base + extra)),
    capped: base + extra > cap,
  }
}

/** 班级整体统计 */
function computeClass(students, events) {
  const list = (students || []).map((s) => Object.assign({ student: s }, computeStudent(events, s.sid)))
  const n = list.length || 1
  const avg = (pick) => round1(list.reduce((s, r) => s + pick(r), 0) / n)
  const items = scheme.items()
  return {
    list,
    count: list.length,
    itemAvg: items.map((item) => ({
      item,
      avg: avg((r) => (r.rows.find((x) => x.item.key === item.key) || {}).score || 0),
    })),
    totalAvg: avg((r) => r.total),
    passRate: Math.round((list.filter((r) => r.total >= (scheme.current().passLine || 60)).length / n) * 100),
    submitted: {
      exam: list.filter((r) => (r.rows.find((x) => x.item.key === 'exam') || {}).score > 0).length,
      project: list.filter((r) => (r.rows.find((x) => x.item.key === 'project') || {}).score > 0).length,
    },
  }
}

/** 记分事件的一句人话摘要（方案里换了项名/规则也说得通） */
function eventSummary(e) {
  const item = scheme.itemByKey(e.item)
  if (!item) return e.reason || ''
  const g = (item.grades || []).find((x) => x.key === e.grade)
  if (e.grade) return '等级 ' + (g ? g.name : e.grade) + (e.late ? '（迟交 ×' + (item.lateFactor === undefined ? 0.5 : item.lateFactor) + '）' : '')
  if (typeof e.raw === 'number') {
    const conv = round1(e.raw * (item.factor === undefined ? item.full / (item.rawFull || 100) : item.factor))
    return item.short + ' ' + e.raw + ' / ' + (item.rawFull || 100) + ' → ' + conv + ' / ' + item.full
  }
  if (e.dims) {
    const parts = (item.dims || []).map((d) => d.name + ' ' + (Number(e.dims[d.key]) || 0) + '/' + d.full)
    return parts.length ? parts.join('，') : '量规合计 ' + Object.values(e.dims).join('+')
  }
  const d = Number(e.delta) || 0
  return (d > 0 ? '+' : '') + d + ' 分' + (e.kind ? '（' + e.kind + '）' : '')
}

module.exports = {
  // 兼容老调用：内容随方案文件热更新
  get ITEMS() {
    return scheme.items()
  },
  get MAIN_ITEMS() {
    return scheme.mainItems()
  },
  itemByKey: (key) => scheme.itemByKey(key),
  itemScore,
  gradeFactor,
  computeStudent,
  computeStudentWith,
  computeClassWith,
  computeClass,
  eventSummary,
  round1,
  clamp,
  scheme,
}
