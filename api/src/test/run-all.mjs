/**
 * 测试总入口
 *
 *   node src/test/run-all.mjs unit    仅单元/纯函数（不联网，秒级）
 *   node src/test/run-all.mjs e2e     需要服务端已在 18730 跑着
 *   node src/test/run-all.mjs          两组都跑
 *
 * 为什么分两组：
 *   unit 组进程内起一个临时 app（自己的临时 data 目录），不碰真实数据；
 *   e2e 组打真实服务端与真实数据，只能在开发机上手动跑。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const HERE = import.meta.dirname

const SETS = {
  unit: [
    ['后端自检', 'selftest.js'],
    ['计分固定用例', 'score-cases.mjs'],
  ],
  e2e: [
    ['课程包格式规范', 'coursepack-spec.mjs'],
    ['班级包（导出/预检/模板）', 'classpack-e2e.mjs'],
    ['导出全量（课程包/内容/模板/班级/方案）', 'e2e-export-all.mjs'],
    ['导入全量（自己导出的再导回去）', 'e2e-import-all.mjs'],
    ['作业库设计包（模板→改→传→导出→清理）', 'e2e-design-pack.mjs'],
    ['xlsx 名单上传（干跑）', 'e2e-xlsx-roster.mjs'],
  ],
}

const want = process.argv.slice(2)
const groups = want.length ? want : ['unit', 'e2e']

let failed = 0
for (const g of groups) {
  if (!SETS[g]) {
    console.log('未知分组：' + g + '（可选 unit / e2e）')
    failed++
    continue
  }
  console.log('\n========== ' + g.toUpperCase() + ' ==========')
  for (const [label, file] of SETS[g]) {
    process.stdout.write('· ' + label + ' ... ')
    const r = spawnSync(process.execPath, [path.join(HERE, file)], { stdio: 'pipe', encoding: 'utf8' })
    const out = (r.stdout || '') + (r.stderr || '')
    if (r.status === 0) {
      console.log('通过')
    } else {
      console.log('失败')
      // 只把失败相关的行打出来，避免刷屏
      const lines = out.split(/\r?\n/).filter((l) => /✗|失败|Error|error|期望/.test(l))
      console.log(lines.slice(0, 12).map((l) => '    ' + l).join('\n') || '    ' + out.split(/\r?\n/).slice(0, 8).join('\n    '))
      failed++
    }
  }
}

console.log('\n' + (failed === 0 ? '全部通过 ✓' : failed + ' 组失败 ✗'))
process.exit(failed === 0 ? 0 : 1)
