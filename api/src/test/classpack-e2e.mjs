import path from 'node:path'
/**
 * 班级包：导出 → 预检 → 模板
 * **不做 apply**：那会写进真实班级（本次只验只读链路）
 */
import fs from 'node:fs'
const BASE = 'http://127.0.0.1:18730'
const REAL = 'web-front-dev'
let pass = 0
let fail = 0
const ok = (n, c, e) => {
  c ? (pass++, console.log('  ✓ ' + n + (e ? '  → ' + e : ''))) : (fail++, console.log('  ✗ ' + n + (e ? '  → ' + e : '')))
}

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'))
const tk = await fetch(BASE + '/api/auth/login/teacher', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: cfg.teacherPassword || 'teacher' }),
}).then((r) => r.json())
const H = { authorization: 'Bearer ' + tk.token }
const getJson = (u) => fetch(BASE + u, { headers: H }).then((r) => r.json())
const binOf = (u) => fetch(BASE + u, { headers: H }).then((r) => r.arrayBuffer()).then((b) => Buffer.from(b))

console.log('=== 班级包 ===')
const zip = await binOf('/api/courses/' + REAL + '/classes.zip')
ok('导出班级包', zip.length > 500 && zip.slice(0, 2).toString() === 'PK', zip.length + ' 字节')

const clsBefore = (await getJson('/api/classes')).items.length

const insRes = await fetch(BASE + '/api/courses/' + REAL + '/classes/inspect', {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/zip' }, H),
  body: zip,
})
const ins = await insRes.json()
ok('预检 200', insRes.status === 200, 'status=' + insRes.status)
ok('预检列出班级', Array.isArray(ins.classes) && ins.classes.length === 2, JSON.stringify((ins.classes || []).map((c) => c.name)))
ok(
  '预检标出「已存在」而不是新增',
  (ins.classes || []).every((c) => c.action === 'update' || c.action === 'same'),
  JSON.stringify((ins.classes || []).map((c) => c.action))
)
ok('预检没落盘（班级数不变）', (await getJson('/api/classes')).items.length === clsBefore, clsBefore + ' → ' + clsBefore)

const tpl = await binOf('/api/courses/' + REAL + '/classes/template.zip')
ok('班级包模板可下载', tpl.length > 200 && tpl.slice(0, 2).toString() === 'PK', tpl.length + ' 字节')

console.log('\n' + (fail === 0 ? '全部通过 ✓' : '有失败 ✗') + '（通过 ' + pass + ' · 失败 ' + fail + '）')
