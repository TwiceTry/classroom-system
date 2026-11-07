/**
 * 打分折算口径（单元）
 *
 * 为什么要单独测这组：
 *   同一套折算曾经有三份实现（后端 grading.js、GradeBox、ScoreForm），
 *   而且已经错过两次 ——
 *     · 后端按固定 100 算，作业满分 20 却存成 100；
 *     · 前端预览还留着老的 100，界面说 100、实际存 20。
 *   现在三处都走 web/src/utils/grade.js，这里直接测它，
 *   期望值从**方案参数手算**得出，不写死数字。
 *
 *   「前端算的和后端存的一致」由 homework-flow.mjs 端到端对账。
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as schemeLib from '../lib/scheme.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
// Windows 上动态 import 绝对路径必须转成 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const grade = await import(pathToFileURL(path.join(ROOT, 'web/src/utils/grade.js')).href)

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) {
    pass++
    console.log('  ✓ ' + name + (detail ? '  → ' + detail : ''))
  } else {
    fail++
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''))
  }
}

const items = schemeLib.runInRequest(() => {
  schemeLib.activate('web-front-dev')
  return schemeLib.items()
})
const byKey = (k) => items.find((i) => i.key === k)
const hw = byKey('homework')
const pj = byKey('project')
const ex = byKey('exam')

console.log('')
console.log('方案：homework ' + hw.full + ' 分（' + (hw.grades || []).map((g) => g.key + '=' + g.factor).join(' ') + '）')
console.log('      project  ' + pj.full + ' 分（' + (pj.dims || []).map((d) => d.key + ':' + d.full).join(' ') + '）')
console.log('      exam     ' + ex.full + ' 分（卷面 ' + (ex.rawFull || 100) + ' × ' + (ex.factor || '?') + '）')

/* ---------- 等级 ---------- */
console.log('')
const gA = (hw.grades || []).find((g) => g.key === 'A')
const gB = (hw.grades || []).find((g) => g.key === 'B')

ok(
  '等级 A → 本项满分 ' + hw.full,
  grade.letterScoreOf(hw, 'A', false) === Math.round(hw.full * gA.factor * 10) / 10,
  String(grade.letterScoreOf(hw, 'A', false))
)

{
  const lateF = hw.lateFactor === undefined ? 0.5 : hw.lateFactor
  const want = Math.round(hw.full * gB.factor * lateF * 10) / 10
  ok('等级 B + 迟交 → ' + want, grade.letterScoreOf(hw, 'B', true) === want, String(grade.letterScoreOf(hw, 'B', true)))
}

ok('没选等级 → null', grade.letterScoreOf(hw, '', false) === null, String(grade.letterScoreOf(hw, '', false)))
ok('不存在的等级 → null', grade.letterScoreOf(hw, 'ZZ', false) === null, String(grade.letterScoreOf(hw, 'ZZ', false)))
ok(
  '满分不会超过本项上限',
  grade.letterScoreOf(hw, 'A', false) <= hw.full,
  grade.letterScoreOf(hw, 'A', false) + ' / ' + hw.full
)

/* ---------- 卷面 ---------- */
console.log('')
{
  const rawFull = ex.rawFull || 100
  const factor = ex.factor === undefined ? ex.full / rawFull : ex.factor
  const wantFull = Math.round(rawFull * factor * 10) / 10
  ok(
    '卷面满分 ' + rawFull + ' → ' + wantFull,
    grade.rawScoreOf(ex, rawFull) === wantFull,
    String(grade.rawScoreOf(ex, rawFull))
  )
  const want80 = Math.round(80 * factor * 10) / 10
  ok('卷面 80 → ' + want80, grade.rawScoreOf(ex, 80) === want80, String(grade.rawScoreOf(ex, 80)))
  ok(
    '卷面超上限会被夹住',
    grade.rawScoreOf(ex, rawFull * 3) === wantFull,
    String(grade.rawScoreOf(ex, rawFull * 3))
  )
  ok('负数 → null', grade.rawScoreOf(ex, -1) === null, String(grade.rawScoreOf(ex, -1)))
  ok('空值 → null', grade.rawScoreOf(ex, '') === null, String(grade.rawScoreOf(ex, '')))
}

/* ---------- 量规 ---------- */
console.log('')
{
  const dims = pj.dims || []
  const fullMap = {}
  for (const d of dims) fullMap[d.key] = d.full
  const total = dims.reduce((a, d) => a + d.full, 0)
  ok('量规全满 → ' + total, grade.dimsTotalOf(pj, fullMap) === Math.round(total * 10) / 10, String(grade.dimsTotalOf(pj, fullMap)))

  const over = {}
  for (const d of dims) over[d.key] = d.full + 100
  ok('单维超限会被夹到各自满分', grade.dimsTotalOf(pj, over) === Math.round(total * 10) / 10, String(grade.dimsTotalOf(pj, over)))

  const zero = {}
  for (const d of dims) zero[d.key] = 0
  ok('量规全 0 → 0', grade.dimsTotalOf(pj, zero) === 0, String(grade.dimsTotalOf(pj, zero)))
}

/* ---------- 按规则自动选 ---------- */
console.log('')
ok('scoreOf(homework, {grade:A}) → 等级口径', grade.scoreOf(hw, { grade: 'A' }) === grade.letterScoreOf(hw, 'A', false), String(grade.scoreOf(hw, { grade: 'A' })))
ok('scoreOf(project, {dims}) → 量规口径', grade.scoreOf(pj, { dims: { [pj.dims[0].key]: 1 } }) === grade.dimsTotalOf(pj, { [pj.dims[0].key]: 1 }), String(grade.scoreOf(pj, { dims: { [pj.dims[0].key]: 1 } })))
ok('scoreOf(exam, {raw:50}) → 卷面口径', grade.scoreOf(ex, { raw: 50 }) === grade.rawScoreOf(ex, 50), String(grade.scoreOf(ex, { raw: 50 })))

console.log('')
console.log(fail === 0 ? '打分折算：全部通过 ✓' : '打分折算：有失败 ✗')
console.log('（通过 ' + pass + ' · 失败 ' + fail + '）')
process.exit(fail === 0 ? 0 : 1)
