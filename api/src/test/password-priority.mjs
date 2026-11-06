/*
 * password-priority.mjs —— 口令的优先级规则
 *
 * 规则（data/config.json 是唯一真源）：
 *   1) config 里没有口令 → 用 TS_PASSWORD 初始化（没有就兜底），并立刻落盘
 *   2) config 里已有口令 → 一律以它为准，环境变量不再参与
 *   3) 界面上改口令 → 覆写 config，立即生效，重启后还是新的
 *
 * 这几种情况**必须在真实进程里测**：config.js 在模块加载时读一次环境变量，
 * 同一个进程里改 process.env 是没用的。所以每个场景都 spawn 一个独立服务。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '../../../')
const PORT = 19870
const BASE = 'http://127.0.0.1:' + PORT

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-pwd-'))
const cfgFile = path.join(tmpDir, 'config.json')
const readCfg = () => {
  try {
    return JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  } catch (e) {
    return null
  }
}

let child = null

async function startServer(password) {
  const env = { ...process.env, TS_DATA_DIR: tmpDir, TS_PORT: String(PORT) }
  if (password === null) delete env.TS_PASSWORD
  else env.TS_PASSWORD = password

  child = spawn(process.execPath, ['api/src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  child.stderr.on('data', (d) => (err += String(d)))
  child.stdout.on('data', () => {})

  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    try {
      const r = await fetch(BASE + '/api/health')
      if (r.ok) return true
    } catch (e) {
      /* 还没起来 */
    }
    if (child.exitCode !== null) {
      console.log('      进程提前退出：' + err.slice(0, 300))
      return false
    }
    await sleep(200)
  }
  console.log('      启动超时：' + err.slice(0, 300))
  return false
}

async function stopServer() {
  if (!child) return
  const c = child
  child = null
  c.kill()
  const t0 = Date.now()
  while (c.exitCode === null && Date.now() - t0 < 5000) await sleep(100)
  // 端口可能还没释放，等一小会儿
  await sleep(300)
}

async function login(pwd) {
  try {
    const r = await fetch(BASE + '/api/auth/login/teacher', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    })
    const j = await r.json().catch(() => ({}))
    return { status: r.status, token: j.token || '' }
  } catch (e) {
    return { status: 0, token: '', error: e.message }
  }
}

async function changePwd(tk, oldP, newP) {
  const r = await fetch(BASE + '/api/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tk },
    body: JSON.stringify({ oldPassword: oldP, newPassword: newP }),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

const P1 = 'Init@2026aaa'
const P2 = 'EnvIgnored@bbb'
const P3 = 'Changed@ccc'

try {
  console.log('=== 1. 首次部署：没有 config，用 TS_PASSWORD 初始化 ===')
  ok('一开始没有 config.json', !fs.existsSync(cfgFile))
  ok('服务起来了（TS_PASSWORD=' + P1 + '）', await startServer(P1))
  const a = await login(P1)
  ok('用环境变量的口令能登录', a.status === 200 && !!a.token, 'status=' + a.status)
  const c1 = readCfg()
  ok('口令已落盘到 config.json', !!c1 && c1.teacherPassword === P1, c1 ? c1.teacherPassword : '(没有)')
  ok('config.json 里有其它键（secret 等）', !!c1 && !!c1.secret)
  await stopServer()

  console.log('\n=== 2. 已有 config：环境变量不再参与（关键规则）===')
  ok('服务起来了（TS_PASSWORD=' + P2 + '，与 config 不同）', await startServer(P2))
  const b1 = await login(P1)
  ok('config 里的口令仍然有效', b1.status === 200, 'status=' + b1.status)
  const b2 = await login(P2)
  ok('环境变量的口令**登不进去**', b2.status === 401, 'status=' + b2.status)
  const c2 = readCfg()
  ok('config.json 没被环境变量改写', !!c2 && c2.teacherPassword === P1, c2 ? c2.teacherPassword : '(没有)')

  console.log('\n=== 3. 界面上改口令：直接覆写 config 并立即生效 ===')
  const ch = await changePwd(b1.token, P1, P3)
  ok('改口令成功（不再被环境变量拦住）', ch.status === 200, 'status=' + ch.status)
  const c3 = readCfg()
  ok('config.json 已变成新口令', !!c3 && c3.teacherPassword === P3, c3 ? c3.teacherPassword : '(没有)')
  const oldTry = await login(P1)
  ok('旧口令立刻失效', oldTry.status === 401, 'status=' + oldTry.status)
  const newTry = await login(P3)
  ok('新口令立刻可用', newTry.status === 200, 'status=' + newTry.status)
  await stopServer()

  console.log('\n=== 4. 重启后仍然是界面上改的那个（不被环境变量抢回）===')
  ok('服务起来了（仍带着 TS_PASSWORD=' + P2 + '）', await startServer(P2))
  const d1 = await login(P3)
  ok('界面上改的口令重启后仍有效', d1.status === 200, 'status=' + d1.status)
  const d2 = await login(P2)
  ok('环境变量还是进不去', d2.status === 401, 'status=' + d2.status)
  await stopServer()

  console.log('\n=== 5. 不设环境变量时也能正常走 config ===')
  ok('服务起来了（无 TS_PASSWORD）', await startServer(null))
  const e1 = await login(P3)
  ok('config 里的口令可用', e1.status === 200, 'status=' + e1.status)
  await stopServer()
} finally {
  await stopServer()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch (e) {
    /* 清理失败不影响结论 */
  }
}

console.log('\n' + (fail === 0 ? '全部通过 ✓' : '有 ' + fail + ' 项失败 ✗') + '（通过 ' + pass + ' · 失败 ' + fail + '）')
process.exit(fail === 0 ? 0 : 1)
