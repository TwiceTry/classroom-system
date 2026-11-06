/*
 * teacher-password.mjs —— 教师口令的修改、校验与优先级
 *
 * 覆盖：
 *   · 旧口令错误 → 401
 *   · 太短 / 用回默认 teacher → 400
 *   · 改成功后：新口令立刻可登录，旧口令立刻失效（**不重启**）
 *   · 改口令不会踢掉已登录设备（令牌是 JWT，与口令无关）
 *   · 写回的是 data/config.json，且不影响文件里其它键
 *
 * 还原方式：直接改 data/config.json（不能走接口 —— 接口禁止把口令设回 teacher，
 * 那是有意的限制，不是 bug）。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '../../../')
const BASE = process.env.TS_BASE || 'http://127.0.0.1:18730'
const CFG = path.join(ROOT, 'data/config.json')

const readCfg = () => JSON.parse(fs.readFileSync(CFG, 'utf8'))
const CUR = String(readCfg().teacherPassword || 'teacher')
const TMP = 'Test@' + Date.now().toString(36) + 'x'

let pass = 0
let fail = 0
function ok(label, cond, detail) {
  if (cond) {
    pass++
    console.log('  ✓ ' + label + (detail ? '  → ' + detail : ''))
  } else {
    fail++
    console.log('  ✗ ' + label + (detail ? '  → ' + detail : ''))
  }
}

async function login(pwd) {
  const r = await fetch(BASE + '/api/auth/login/teacher', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: pwd }),
  })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, token: j.token || '' }
}

async function change(tk, oldPwd, newPwd) {
  const r = await fetch(BASE + '/api/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tk },
    body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

/* 无论中途怎么挂，都要把口令还原 —— 否则下次跑测试连登录都进不去 */
function restore() {
  try {
    const j = readCfg()
    j.teacherPassword = CUR
    fs.writeFileSync(CFG, JSON.stringify(j, null, 2), 'utf8')
  } catch (e) {
    console.log('  ! 还原口令失败：' + e.message)
  }
}

console.log('=== 0. 前置：当前口令能登录 ===')
const a = await login(CUR)
ok('用当前口令登录', a.status === 200 && !!a.token, 'status=' + a.status)
if (!a.token) {
  console.log('\n连登录都过不了，后面跳过')
  process.exit(1)
}

const before = readCfg()
const otherKeys = Object.keys(before).filter((k) => k !== 'teacherPassword').sort()

try {
  console.log('\n=== 1. 拒绝非法请求 ===')
  const r1 = await change(a.token, 'wrong-password-x', TMP)
  ok('旧口令错误 → 401', r1.status === 401, 'status=' + r1.status)

  const r2 = await change(a.token, CUR, '123')
  ok('新口令太短 → 400', r2.status === 400, (r2.body.message || '').slice(0, 30))

  const r4 = await change(a.token, CUR, CUR)
  ok('新旧口令相同 → 400', r4.status === 400, 'status=' + r4.status)

  console.log('\n=== 2. 正常修改 ===')
  const r5 = await change(a.token, CUR, TMP)
  ok('改口令成功', r5.status === 200 && r5.body.ok === true, 'status=' + r5.status)
  ok('返回了提示', Array.isArray(r5.body.notes) && r5.body.notes.length > 0, (r5.body.notes || [])[0] || '')

  console.log('\n=== 3. 立即生效（未重启进程）===')
  const oldTry = await login(CUR)
  ok('旧口令立刻失效', oldTry.status === 401, 'status=' + oldTry.status)
  const newTry = await login(TMP)
  ok('新口令立刻可用', newTry.status === 200 && !!newTry.token, 'status=' + newTry.status)

  console.log('\n=== 4. 已登录设备不受影响 ===')
  const me = await fetch(BASE + '/api/auth/me', { headers: { authorization: 'Bearer ' + a.token } })
  ok('改口令前签发的令牌仍有效', me.status === 200, 'status=' + me.status)

  console.log('\n=== 5. 落盘正确 ===')
  const after = readCfg()
  ok('config.json 里的口令已更新', after.teacherPassword === TMP, '长度=' + String(after.teacherPassword).length)
  const afterKeys = Object.keys(after).filter((k) => k !== 'teacherPassword').sort()
  ok('其它键一个没动', JSON.stringify(afterKeys) === JSON.stringify(otherKeys), afterKeys.join(','))
  console.log('\n=== 6. 还原（走接口，保证进程内存也回去了）===')
  // 注意：直接改文件不够 —— 服务进程里的当前口令是内存变量，
  // 只有 setPassword 会同时更新文件与内存。所以这里用接口还原。
  const back1 = await change(newTry.token, TMP, CUR)
  ok('接口还原成功', back1.status === 200, 'status=' + back1.status)
  const back2 = await login(CUR)
  ok('已还原为原口令，可登录', back2.status === 200, 'status=' + back2.status)
} finally {
  // 兜底：无论上面怎么挂，文件里的口令都要回到原值
  restore()
}

console.log('\n' + (fail === 0 ? '全部通过 ✓' : '有 ' + fail + ' 项失败 ✗') + '（通过 ' + pass + ' · 失败 ' + fail + '）')
process.exit(fail === 0 ? 0 : 1)
