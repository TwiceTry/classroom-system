/*
 * 打分折算 —— 前端唯一的口径
 *
 * 为什么单独抽出来：
 *   同一套折算原本有三份实现：
 *     api/src/lib/grading.js   （真正落库的）
 *     components/GradeBox.vue  （批阅弹层里「= 20 分」的预览）
 *     components/ScoreForm.vue （分数表里的录入）
 *   三份各自写，已经错过两次：
 *     · 后端按固定 100 算 → 作业满分 20 却存成 100
 *     · 前端预览还留着老的 100 → 界面说 100、实际存 20
 *   抽成纯函数后，前端两处都调这里，测试也能直接 import 它，
 *   拿同一组输入和后端比对，错一处就红。
 *
 * 约定：与 api/src/lib/grading.js 完全同口径
 *   avg   : full × 等级系数 × 迟交系数，夹到 [0, full]
 *   raw   : 卷面分 × 系数（没写系数就按 full/rawFull），夹到 [0, full]
 *   rubric: 各维度分别夹到 [0, d.full] 再求和
 * 一律保留一位小数。
 */

const round1 = (v) => Math.round(Number(v) * 10) / 10

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v)))

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

const fullOf = (item) => num(item && item.full, 100) || 100

/** 等级扣分：A/B/C/D/F → 本项得分 */
export function letterScoreOf(item, gradeKey, late) {
  const g = ((item && item.grades) || []).find((x) => x.key === gradeKey)
  if (!g) return null
  const full = fullOf(item)
  const lateFactor = item.lateFactor === undefined ? 0.5 : num(item.lateFactor, 0.5)
  const raw = full * num(g.factor, 0) * (late ? lateFactor : 1)
  return round1(clamp(raw, 0, full))
}

/** 卷面分折算：机试/笔试 */
export function rawScoreOf(item, raw) {
  /*
   * 空值必须返回 null，不能当 0 分。
   * `Number('')` 是 0，如果不先拦掉，老师只是**没填**卷面分，
   * 界面会显示「折算 0 分」，一保存就真给学生记 0 分。
   * 后端 grading.js 对空值的处理是「清分」，这里保持一致。
   */
  if (raw === '' || raw === null || raw === undefined) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  const full = fullOf(item)
  const rawFull = num(item.rawFull, 100) || 100
  const factor = item.factor === undefined ? full / rawFull : num(item.factor, full / rawFull)
  return round1(clamp(n * factor, 0, full))
}

/** 量规求和：各维度先夹到自己的满分 */
export function dimsTotalOf(item, dims) {
  let sum = 0
  for (const d of (item && item.dims) || []) {
    sum += clamp(num((dims || {})[d.key], 0), 0, num(d.full, 0))
  }
  return round1(sum)
}

/**
 * 按规则的 type 自动选算法。
 * 返回 null 表示「这次没有有效输入」（例如没选等级），界面该显示「—」。
 */
export function scoreOf(item, input) {
  const mode = item && item.rule ? item.rule.type : 'avg'
  if (mode === 'rubric') {
    const has = Object.keys((input && input.dims) || {}).length > 0
    return has ? dimsTotalOf(item, input.dims) : null
  }
  if (mode === 'raw') return rawScoreOf(item, input && input.raw)
  return letterScoreOf(item, input && input.grade, !!(input && input.late))
}
