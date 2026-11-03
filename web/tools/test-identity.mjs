/**
 * 不用浏览器，直接在 Node 里验「身份三态」的状态机：
 *   游客（从没登录过） / 已登录 / 登录已失效
 * 用法：cd web && node tools/test-identity.mjs
 *
 * 说明：src/store.js 里 import './api' 没有扩展名（Vite 能解析，Node ESM 不行），
 * 所以这里把两个模块复制到 .tmp-test/ 并补上 .js 后缀再 import。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')
const TMP = path.join(WEB, '.tmp-test')

fs.mkdirSync(TMP, { recursive: true })
for (const f of ['store.js', 'api.js']) {
  let s = fs.readFileSync(path.join(WEB, 'src', f), 'utf8')
  s = s.split("from './api'").join("from './api.js'").split("from '../api'").join("from './api.js'")
  fs.writeFileSync(path.join(TMP, f), s, 'utf8')
}

// ---- 造一个假浏览器环境 ----
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}
globalThis.window = { location: { pathname: '/student/materials', search: '', href: 'http://x/student/materials' } }
globalThis.location = globalThis.window.location

let fetchMode = 'guest' // 'guest' | 'expired' | 'ok'
globalThis.fetch = async (url, opts) => {
  const u = String(url)
  const hasToken = !!(opts && opts.headers && opts.headers.Authorization)
  if (u.indexOf('/api/me') >= 0) {
    if (!hasToken) return jsonRes(401, { error: '登录已失效，请重新登录' })
    if (fetchMode === 'expired') return jsonRes(401, { error: '登录已失效，请重新登录' })
    return jsonRes(200, { role: 'student', student: { sid: '1', name: 'x', className: '1班' } })
  }
  return jsonRes(200, {})
}
function jsonRes(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  }
}

const { state, bootstrap, applyLogin, logout } = await import(pathToFileURL(path.join(TMP, 'store.js')).href)
const { unauthorized } = await import(pathToFileURL(path.join(TMP, 'api.js')).href)

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  PASS  ' + name)
  } else {
    fail++
    console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''))
  }
}

console.log('=== ① 从没登录过（游客）===')
store.clear()
fetchMode = 'guest'
await bootstrap()
check('没有令牌 → 走游客分支（不算失效）', state.tokenExpired === false, 'tokenExpired=' + state.tokenExpired)

console.log('\n=== ② 令牌过期（启动时 /api/me 就 401）===')
store.clear()
store.set('teach-system-token', 'old-token')
store.set('teach-system-role', 'student')
fetchMode = 'expired'
await bootstrap()
check('识别为「登录已失效」', state.tokenExpired === true, 'tokenExpired=' + state.tokenExpired)
check('身份被清掉（role 空）', state.role === '' && state.student === null)
check('令牌被清掉', !store.get('teach-system-token'))

console.log('\n=== ③ 页面上令牌中途失效（任意请求 401）===')
store.clear()
store.set('teach-system-token', 'old-token')
store.set('teach-system-role', 'student')
fetchMode = 'ok'
await bootstrap()
check('登录成功 → 不是失效', state.tokenExpired === false)
check('身份在（role=student）', state.role === 'student')
unauthorized.handler() // 模拟收到 401
check('401 之后标记为失效', state.tokenExpired === true, 'tokenExpired=' + state.tokenExpired)
check('身份被清掉', state.role === '' && state.student === null)

console.log('\n=== ④ 重新登录 → 失效标记清掉 ===')
applyLogin({ token: 'new-token', role: 'student', student: { sid: '1', name: 'x' } })
check('登录后不再提示失效', state.tokenExpired === false, 'tokenExpired=' + state.tokenExpired)
check('身份回来了', state.role === 'student')

console.log('\n=== ⑤ 主动退出 ≠ 失效 ===')
await logout()
check('主动退出后 tokenExpired 仍为 false', state.tokenExpired === false, 'tokenExpired=' + state.tokenExpired)

console.log('\n=== ⑥ 游客误调需要登录的接口（本来就没令牌）→ 不算失效 ===')
store.clear()
fetchMode = 'guest'
await bootstrap()
unauthorized.handler()
check('没令牌收到 401 不算「失效」', state.tokenExpired === false, 'tokenExpired=' + state.tokenExpired)

console.log('\n' + (fail ? 'FAILED' : 'ALL PASS') + '  pass=' + pass + ' fail=' + fail)
process.exit(fail ? 1 : 0)
