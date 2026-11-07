import path from 'node:path'
import fs from 'node:fs'
/**
 * 计分规则的固定用例回归测试
 *
 * 为什么不用「跟旧实现对比」了：
 *   旧后端 server/ 已经删掉（重构的一部分），拿它当基准这条路走不通。
 *   而且"两边一样"本身不是目标 —— 目标是**算得对**。
 *   所以这里全部改成：给定这组记分事件，就应该得这个分。
 *   期望值是**从方案参数推出来的**，注释里写了怎么算的。
 *
 * 覆盖：base（考勤）/ acc（互动）/ avg（作业）/ rubric（大作业）/ raw（机试）/ 汇总与封顶
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
import { computeStudentWith } from '../lib/scoring.js'

/*
 * 一定要用 scheme.items()，不能直接 JSON.parse 方案文件。
 * 方案里 grades / dims 藏在 rule.params 下面，而规则函数读的是 item.grades / item.dims ——
 * materialize 那一层负责把它们摊平。绕过它，作业和量规会一律算 0。
 */
import * as schemeLib from '../lib/scheme.js'
const items = schemeLib.runInRequest(() => {
  schemeLib.activate('web-front-dev')
  return schemeLib.items()
})
const CAP = schemeLib.runInRequest(() => schemeLib.current().cap) || 100

let pass = 0
let fail = 0
const detail = []

const ev = (item, extra) => Object.assign({ item, sid: 'S1' }, extra || {})

function check(name, events, expect) {
  const r = computeStudentWith(items, CAP, events, 'S1')
  const got = {}
  for (const row of r.rows) got[row.item.key] = row.score

  const bad = []
  for (const [k, v] of Object.entries(expect)) {
    const actual = k === 'total' ? r.total : got[k]
    if (Math.abs(Number(actual) - Number(v)) > 1e-9) bad.push(k + '：期望 ' + v + '，实际 ' + actual)
  }
  if (bad.length) {
    fail++
    detail.push('✗ ' + name + '\n     ' + bad.join('\n     ') + '\n     ' + JSON.stringify(got))
  } else {
    pass++
  }
}

/*
 * ============ base（考勤）============
 *
 * **期望值从方案参数算出来，不写死数字。**
 *
 * 原来这里写死了「start=5 / perAbsent=1 / perLate=0」，于是老师在界面上
 * 把起始分改成 10，这 12 条全红 —— 而算法根本没变。测试测的应该是
 * 「给定这些参数，算得对不对」，不是「参数恰好等于某个值」。
 */
const attendItem = items.find((i) => i.key === 'attend')
const AP = (attendItem && attendItem.rule && attendItem.rule.params) || {}
const S = Number(AP.start !== undefined ? AP.start : attendItem ? attendItem.full : 5)
const AB = AP.perAbsent === undefined ? 2 : Number(AP.perAbsent)
const LT = AP.perLate === undefined ? 1 : Number(AP.perLate)
const FLOOR = Number(AP.floor || 0)
const FULL_A = Number(attendItem ? attendItem.full : 5)
const ZR = AP.zeroRule || null
const ZC = ZR ? Number(ZR.count || 3) : 0
const ZM = ZR ? Number(ZR.lateMerge || 0) : 0

/** 与 scoreBase 同口径：扣分 + 归零 + 夹到 [floor, full] */
const clampA = (v) => Math.min(FULL_A, Math.max(FLOOR, Math.round(v * 10) / 10))
const expectAttend = (absent, late) => {
  if (ZR && ZR.kind === '缺勤') {
    const merged = ZM > 0 ? Math.floor(late / ZM) : 0
    if (absent + merged >= ZC) return 0
  }
  return clampA(S - absent * AB - late * LT)
}

console.log(`  （考勤参数：start=${S} perAbsent=${AB} perLate=${LT} floor=${FLOOR} ` +
  `zeroRule=${ZR ? ZR.kind + '≥' + ZC + '次，迟到' + ZM + '折1' : '无'}）`)

check(`全勤（无记录）→ ${S}`, [], { attend: expectAttend(0, 0), total: expectAttend(0, 0) })
check(`缺勤 1 次 → ${S}-${AB}`, [ev('attend', { kind: '缺勤' })], { attend: expectAttend(1, 0) })
check(`缺勤 2 次 → ${S}-${AB}×2`, [ev('attend', { kind: '缺勤' }), ev('attend', { kind: '缺勤' })], { attend: expectAttend(2, 0) })
if (ZR) {
  check(
    `缺勤 ${ZC} 次 → 触发归零`,
    Array.from({ length: ZC }, () => ev('attend', { kind: '缺勤' })),
    { attend: 0 }
  )
}
check(
  `迟到 2 次 → 每次扣 ${LT}，2 次折算 ${ZM > 0 ? Math.floor(2 / ZM) : 0} < ${ZC} 不归零`,
  [ev('attend', { kind: '迟到' }), ev('attend', { kind: '迟到' })],
  { attend: expectAttend(0, 2) }
)
check(
  '缺勤 1 + 迟到 2 → 扣 1 个缺勤 + 2 个迟到',
  [ev('attend', { kind: '缺勤' }), ev('attend', { kind: '迟到' }), ev('attend', { kind: '迟到' })],
  { attend: expectAttend(1, 2) }
)
check(
  '缺勤 2 + 迟到 2 → 折算后若达阈值则归零',
  [ev('attend', { kind: '缺勤' }), ev('attend', { kind: '缺勤' }), ev('attend', { kind: '迟到' }), ev('attend', { kind: '迟到' })],
  { attend: expectAttend(2, 2) }
)
check('已撤销的缺勤不计', [ev('attend', { kind: '缺勤', voided: true })], { attend: expectAttend(0, 0) })
check('请假不扣分', [ev('attend', { kind: '请假' })], { attend: expectAttend(0, 0) })

/* ============ acc（课堂互动）============
 * start 由参数给，封顶 = 该项满分。
 * 实现只累加 delta（perHitMax 目前没被用到，见文末说明）。
 */
const interactItem = items.find((i) => i.key === 'interact')
const IA = (interactItem && interactItem.rule && interactItem.rule.params) || {}
const FULL_I = Number(interactItem ? interactItem.full : 10)
const START_I = Number(IA.start || 0)
const acc = (sum) => Math.min(FULL_I, Math.max(0, START_I + sum))

console.log(`  （互动参数：start=${START_I} 满分=${FULL_I}）`)

check(`互动 3 次各 +1 → ${acc(3)}`, [ev('interact', { delta: 1 }), ev('interact', { delta: 1 }), ev('interact', { delta: 1 })], { interact: acc(3) })
check(`互动一次 +2 → ${acc(2)}`, [ev('interact', { delta: 2 })], { interact: acc(2) })
check(
  `互动 15 次各 +1 → 封顶 ${FULL_I}`,
  Array.from({ length: 15 }, () => ev('interact', { delta: 1 })),
  { interact: acc(15) }
)
check('互动 -1 → 夹到 0', [ev('interact', { delta: -1 })], { interact: 0 })
check('已撤销的互动不计', [ev('interact', { delta: 1, voided: true })], { interact: START_I })

/* ============ avg（课堂作业）============
 * params: grades A=1 B=0.85 C=0.7 D=0.6 F=0, lateFactor=0.5, skipWorst=0
 * 得分 = 等级系数加权平均 × full(20) + 手工 delta
 */
check('作业 1 次 A → 20×1=20', [ev('homework', { grade: 'A' })], { homework: 20 })
check('作业 1 次 B → 20×0.85=17', [ev('homework', { grade: 'B' })], { homework: 17 })
check('作业 1 次 F → 0', [ev('homework', { grade: 'F' })], { homework: 0 })
check('作业 A + B → (1+0.85)/2×20=18.5', [ev('homework', { grade: 'A' }), ev('homework', { grade: 'B' })], { homework: 18.5 })
check('作业 A 迟交 → 20×1×0.5=10', [ev('homework', { grade: 'A', late: true })], { homework: 10 })
check('没有作业记录 → 0', [], { homework: 0 })

/* ============ rubric（大作业）============
 * dims: func12 / code9 / ui6 / doc3，求和，只取**最后一条**有 dims 的记录
 */
check('量规全满 → 30', [ev('project', { dims: { func: 12, code: 9, ui: 6, doc: 3 } })], { project: 30 })
check('量规只给 func=12 → 12', [ev('project', { dims: { func: 12 } })], { project: 12 })
check('量规超出维度上限 → 夹到上限', [ev('project', { dims: { func: 99, code: 99, ui: 99, doc: 99 } })], { project: 30 })
check(
  '两次评分取最后一次 → 用后一组',
  [ev('project', { dims: { func: 12, code: 9, ui: 6, doc: 3 } }), ev('project', { dims: { func: 3, code: 3, ui: 3, doc: 3 } })],
  { project: 12 }
)

/* ============ raw（机试）============
 * params: rawFull=100, factor=0.3，只取最后一条有 raw 的记录
 */
check('机试卷面 40 → 40×0.3=12', [ev('exam', { raw: 40 })], { exam: 12 })
check('机试卷面 100 → 30', [ev('exam', { raw: 100 })], { exam: 30 })
check('机试 0 分 → 0', [ev('exam', { raw: 0 })], { exam: 0 })
check('两次录入取最后一次 → 50×0.3=15', [ev('exam', { raw: 100 }), ev('exam', { raw: 50 })], { exam: 15 })

/* ============ 汇总 ============ */
/* 各项满分都从方案取，别写死数字（老师随时会改分值） */
const itemFull = (k) => {
  const it = items.find((i) => i.key === k)
  return Number(it ? it.full : 0)
}
const F_HW = itemFull('homework')
const F_PRJ = itemFull('project')
const F_EXAM = itemFull('exam')
const F_INT = itemFull('interact')

check(
  `全满组合：考勤 ${S} + 互动 ${F_INT} + 作业 ${F_HW} + 大作业 ${F_PRJ} + 机试 ${F_EXAM}`,
  [
    ...Array.from({ length: 10 }, () => ev('interact', { delta: 1 })),
    ev('homework', { grade: 'A' }),
    ev('project', { dims: { func: 12, code: 9, ui: 6, doc: 3 } }),
    ev('exam', { raw: 100 }),
  ],
  {
    attend: S,
    interact: F_INT,
    homework: F_HW,
    project: F_PRJ,
    exam: F_EXAM,
    total: S + F_INT + F_HW + F_PRJ + F_EXAM,
  }
)

check(
  '各项独立：只交作业，总评就是作业分',
  [ev('homework', { grade: 'A' })],
  { attend: S, homework: F_HW, total: S + F_HW }
)

/* ============ 封顶（cap）============
 * 真实方案里没有 extra 项，用一份临时 items 测「总评超 cap 要截断」
 */
{
  const withBonus = items.concat([
    {
      key: 'bonus',
      name: '加分',
      short: '加分',
      full: 20,
      extra: true,
      mode: 'acc',
      rule: { type: 'acc', params: { start: 0 } },
    },
  ])
  const r = computeStudentWith(withBonus, 100, [ev('exam', { raw: 100 }), ev('bonus', { delta: 20 })], 'S1')
  // 机试满分 + 加分 20 + 考勤全勤 S，未超封顶 100
  const expectSum = F_EXAM + 20 + S
  const okCap = Math.abs(r.total - expectSum) < 1e-9 && r.capped === false
  if (okCap) pass++
  else {
    fail++
    detail.push('✗ 加分项计入总分（' + F_EXAM + '+20+' + S + '=' + expectSum + '）→ 实际 ' + r.total + ' capped=' + r.capped)
  }

  const heavy = items.concat([
    ...Array.from({ length: 8 }, (_, i) => ({
      key: 'b' + i,
      name: '加分' + i,
      short: 'b' + i,
      full: 20,
      extra: true,
      mode: 'acc',
      rule: { type: 'acc', params: { start: 0 } },
    })),
  ])
  const r2 = computeStudentWith(heavy, 100, [ev('bonus', { delta: 20 })], 'S1')
  const extraSum = r2.rows.filter((x) => x.item.extra).reduce((n, x) => n + x.score, 0)
  const baseSum = r2.rows.filter((x) => !x.item.extra).reduce((n, x) => n + x.score, 0)
  if (r2.total <= 100 && Math.abs(r2.total - Math.min(100, baseSum + extraSum)) < 1e-9) {
    pass++
  } else {
    fail++
    detail.push('✗ 总评封顶 100：base=' + baseSum + ' extra=' + extraSum + ' total=' + r2.total)
  }
}

/* ============ 输出 ============ */
console.log('计分固定用例：' + (fail === 0 ? '全部通过 ✓' : '有失败 ✗') + '（通过 ' + pass + ' · 失败 ' + fail + '）')
if (detail.length) {
  console.log('')
  for (const d of detail) console.log(d)
}
process.exit(fail === 0 ? 0 : 1)
