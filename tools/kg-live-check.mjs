/*
 * 用 kg-login/credentials.json 里的账号，真机验证「密码对不对」这条路径。
 *
 * 安全约定（这份脚本绝不外泄凭据）：
 *   · 密码只在内存里从 文件 → fetch body 走一遍，不打印、不落盘、不写日志
 *   · 只输出长度、以及「结论」（成功/密码错/未入班）
 *   · 账号本身也只输出长度和「是否等于某个学号」
 *
 * 判定逻辑（账号不在学生名单，正好能区分两种情况）：
 *   返回「还没有加入本课程班级」 → 说明**密码是对的**（外部放行了），只是没入班
 *   返回「账号或密码不对」       → 密码或账号错
 *   返回「锁定 / 次数」          → 外部已经拦了
 */
import fs from 'node:fs'

const B = 'http://127.0.0.1:18730'
const CRED = 'kg-login/credentials.json'

let pass = 0
let fail = 0
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n + (d ? '  → ' + d : '')) }
  else { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')) }
}

/* ---------- 1. 读配置（不打印内容）---------- */
if (!fs.existsSync(CRED)) {
  console.log('找不到 ' + CRED)
  process.exit(2)
}
const raw = fs.readFileSync(CRED, 'utf8').replace(/^\uFEFF/, '')
const cfg = JSON.parse(raw)
const account = String(cfg.username || '').trim()
const password = String(cfg.password || '')
const base = String(cfg.base || '').trim()

console.log('=== 配置（只看长度，不看内容）===')
console.log('  账号长度 ' + account.length + ' · 密码长度 ' + password.length + ' · base ' + (base || '(未写)'))

if (!account || !password) {
  console.log('\n配置文件里账号或密码是空的 —— 先填上再跑。')
  process.exit(2)
}

/* ---------- 2. 准备 ---------- */
const tcfg = JSON.parse(fs.readFileSync('课堂系统/data/config.json', 'utf8'))
const T = (await (await fetch(B + '/api/auth/login/teacher', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: String(tcfg.teacherPassword || '').trim() }),
})).json()).token

const creds = await import('./课堂系统/api/src/lib/student-creds.js')
const fails = await import('./课堂系统/api/src/lib/login-fails.js')
const { openDb } = await import('./课堂系统/api/src/db/index.js')

const db = openDb()
const sids = db.prepare('SELECT DISTINCT sid FROM students').all().map((r) => String(r.sid))
db.close()

console.log('\n=== 账号与名单的关系 ===')
console.log('  名册学号总数 ' + sids.length)
console.log('  是否正好等于某个学号: ' + (sids.includes(account) ? '是' : '否'))
const contains = sids.filter((s) => s.length >= 6 && account.includes(s))
console.log('  账号里是否包含某个学号: ' + (contains.length ? '是（' + contains.length + ' 个候选）' : '否'))

/* ---------- 3. 真机登录 ---------- */
const login = async () => {
  const t0 = Date.now()
  const r = await fetch(B + '/api/auth/login/student', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sid: account, password }), // 密码只在这一次请求体里
  })
  const j = await r.json().catch(() => ({}))
  return { s: r.status, j, ms: Date.now() - t0 }
}

try {
  await fetch(B + '/api/settings/student-auth', {
    method: 'PATCH',
    headers: { authorization: 'Bearer ' + T, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'kg', verifyEachTime: true }), // 强制每次都问外部，确保测到真链路
  })
  creds.forget(account)
  fails.unblock(account)
  console.log('\n=== 已切到 kg 模式（每次核验），清掉该账号的本地缓存在测 ===')

  const first = await login()
  const msg = (first.j && first.j.error && first.j.error.message) || ''
  console.log('\n  第 1 次（真问外部）: ' + first.s + '  ' + first.ms + 'ms  「' + msg.slice(0, 60) + '」')

  const reachedRosterCheck = /还没有加入本课程班级|未加入本课程班级/.test(msg)
  const wrongPwd = msg.indexOf('账号或密码不对') >= 0
  const blocked = /锁定|次数|短信/.test(msg)

  if (first.s === 200) {
    ok('登录成功（账号在名册里）', true, '已拿到 token')
  } else if (reachedRosterCheck) {
    ok('★ 密码正确 —— 外部放行了（因为提示是「未入班」而不是「密码错」）', true, msg.slice(0, 26))
  } else if (wrongPwd) {
    ok('★ 密码正确 —— 外部放行', false, '外部返回的是「账号或密码不对」，说明账号或密码本身有问题')
  } else if (blocked) {
    ok('★ 密码正确 —— 外部放行', false, '外部拦了：' + msg.slice(0, 40))
  } else {
    ok('★ 密码正确 —— 外部放行', false, '意外结果：' + msg.slice(0, 40))
  }

  /* ---------- 4. 缓存生效后第二次应该更快 ---------- */
  console.log('\n=== 第 2 次（本地核验）===')
  await fetch(B + '/api/settings/student-auth', {
    method: 'PATCH',
    headers: { authorization: 'Bearer ' + T, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'kg', verifyEachTime: false }),
  })
  const second = await login()
  const msg2 = (second.j && second.j.error && second.j.error.message) || ''
  console.log('  ' + second.s + '  ' + second.ms + 'ms  「' + msg2.slice(0, 60) + '」')

  if (reachedRosterCheck || first.s === 200) {
    ok('第二次走本地（明显更快）', second.ms < first.ms, first.ms + 'ms → ' + second.ms + 'ms')
    ok('结论一致（仍是未入班/成功，不是密码错）',
      /还没有加入本课程班级|未加入本课程班级/.test(msg2) || second.s === 200,
      msg2.slice(0, 26))
  }
} finally {
  /* ---------- 5. 清理：别把老师的密码留在学生凭据表里 ---------- */
  await fetch(B + '/api/settings/student-auth', {
    method: 'PATCH',
    headers: { authorization: 'Bearer ' + T, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'local', verifyEachTime: false }),
  })
  const n1 = creds.forgetAll()
  const n2 = fails.unblockAll()
  console.log('\n=== 清理 ===')
  console.log('  清凭据 ' + n1 + ' 条 · 清失败记录 ' + n2 + ' 条 · 已切回 local')
}

console.log('\n（通过 ' + pass + ' · 失败 ' + fail + '）')
