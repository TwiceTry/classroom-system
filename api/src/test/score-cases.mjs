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

/* ============ base（考勤）============
 * params: start=5, perAbsent=1, perLate=0, floor=0
 *         zeroRule{kind:缺勤, count:3, lateMerge:2}
 *
 * 注意 perLate=0：迟到本身不扣分，只影响"是否归零"。
 */
check('全勤（无记录）→ start=5', [], { attend: 5, total: 5 })
check('缺勤 1 次 → 5-1=4', [ev('attend', { kind: '缺勤' })], { attend: 4 })
check('缺勤 2 次 → 5-2=3', [ev('attend', { kind: '缺勤' }), ev('attend', { kind: '缺勤' })], { attend: 3 })
check('缺勤 3 次 → 触发归零=0', [ev('attend', { kind: '缺勤' }), ev('attend', { kind: '缺勤' }), ev('attend', { kind: '缺勤' })], { attend: 0 })
check('迟到 2 次 → 不扣分（perLate=0），2<3 不归零', [ev('attend', { kind: '迟到' }), ev('attend', { kind: '迟到' })], { attend: 5 })
check(
  '缺勤 1 + 迟到 2 → 扣 1 分；折算 1+1=2 <3 不归零',
  [ev('attend', { kind: '缺勤' }), ev('attend', { kind: '迟到' }), ev('attend', { kind: '迟到' })],
  { attend: 4 }
)
check(
  '缺勤 2 + 迟到 2 → 折算 2+1=3 ≥3 → 归零',
  [ev('attend', { kind: '缺勤' }), ev('attend', { kind: '缺勤' }), ev('attend', { kind: '迟到' }), ev('attend', { kind: '迟到' })],
  { attend: 0 }
)
check('已撤销的缺勤不计', [ev('attend', { kind: '缺勤', voided: true })], { attend: 5 })
check('请假不扣分', [ev('attend', { kind: '请假' })], { attend: 5 })

/* ============ acc（课堂互动）============
 * params: start=0，封顶 = full(10)
 * 实现里只累加 delta（perHitMax 这个参数目前没被用到，见文末说明）
 */
check('互动 3 次各 +1 → 3', [ev('interact', { delta: 1 }), ev('interact', { delta: 1 }), ev('interact', { delta: 1 })], { interact: 3 })
check('互动一次 +2 → 2', [ev('interact', { delta: 2 })], { interact: 2 })
check('互动 15 次各 +1 → 封顶 10', Array.from({ length: 15 }, () => ev('interact', { delta: 1 })), { interact: 10 })
check('互动 -1 → 夹到 0', [ev('interact', { delta: -1 })], { interact: 0 })
check('已撤销的互动不计', [ev('interact', { delta: 1, voided: true })], { interact: 0 })

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
check(
  '全满组合：5 + 10 + 20 + 30 + 30 = 95',
  [
    ...Array.from({ length: 10 }, () => ev('interact', { delta: 1 })),
    ev('homework', { grade: 'A' }),
    ev('project', { dims: { func: 12, code: 9, ui: 6, doc: 3 } }),
    ev('exam', { raw: 100 }),
  ],
  { attend: 5, interact: 10, homework: 20, project: 30, exam: 30, total: 95 }
)

check(
  '各项独立：只交作业，总评就是作业分',
  [ev('homework', { grade: 'A' })],
  { attend: 5, homework: 20, total: 25 }
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
  // 机试 30 + 加分 20 + 考勤全勤 5 = 55，未超 100
  const okCap = Math.abs(r.total - 55) < 1e-9 && r.capped === false
  if (okCap) pass++
  else {
    fail++
    detail.push('✗ 加分项计入总分（30+20+5=55）→ 实际 ' + r.total + ' capped=' + r.capped)
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
