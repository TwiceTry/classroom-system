/**
 * 班级登录管理（e2e，需要服务在 18730 跑着）
 *
 * 覆盖「老师在班级页管学生登录」这条线：
 *   看状态（本系统失败次数 / 平台自报次数 / 是否禁登）
 *   单独禁用、解除
 *   ★ 手动禁用对**两种登录方式都生效**（这里曾经只对 kg 生效，是个真漏洞）
 *   越权与不存在资源的边界
 *
 * 注意：全程**不联网**。
 *   · 失败次数直接用 login-fails.bump() 写表，不通过登录去制造
 *   · 被禁用后的登录一定在打外部之前就被拦下（这也是断言的一部分）
 * 否则每跑一次就给真实学号在外部记几笔失败，跑几次就把人锁了。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const B = process.env.TS_BASE || 'http://127.0.0.1:18730'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/config.json'), 'utf8'))

let pass = 0
let fail = 0
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n + (d ? '  → ' + d : '')) }
  else { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')) }
}

const j = async (m, u, b, tk) => {
  const o = { method: m, headers: { 'content-type': 'application/json' } }
  if (tk) o.headers.authorization = 'Bearer ' + tk
  if (b !== undefined) o.body = JSON.stringify(b)
  const t0 = Date.now()
  const r = await fetch(B + u, o)
  const txt = await r.text()
  let x = null
  try { x = JSON.parse(txt) } catch (e) { /* */ }
  return { s: r.status, j: x, ms: Date.now() - t0 }
}

const T = (await j('POST', '/api/auth/login/teacher', { password: String(cfg.teacherPassword || '').trim() })).j.token
const fails = await import(pathToFileURL(path.join(ROOT, 'api/src/lib/login-fails.js')).href)

try {
  /* ---------- 准备：拿一个班和一个在册学生 ---------- */
  const clsList = (await j('GET', '/api/classes', undefined, T)).j
  const cls = (clsList.items || [])[0]
  if (!cls) throw new Error('没有班级，先建一个再跑这个测试')

  const roster = (await j('GET', '/api/classes/' + cls.id + '/students', undefined, T)).j
  const stu = (roster.items || roster.students || [])[0]
  if (!stu) throw new Error('班级里没有学生')

  const SID = String(stu.sid)
  const NAME = String(stu.name)
  const base = '/api/classes/' + cls.id

  // 起点干净
  fails.unblockAll()

  console.log('=== 1. 面板数据 ===')
  {
    const r = await j('GET', base + '/login-admin', undefined, T)
    ok('200', r.s === 200, 'status=' + r.s)
    ok('带登录方式与开关', typeof r.j.mode === 'string' && typeof r.j.verifyEachTime === 'boolean', r.j.mode + ' / ' + r.j.verifyEachTime)
    ok('学生数 = 名册人数', Array.isArray(r.j.students) && r.j.students.length === (roster.items || roster.students || []).length, String(r.j.students && r.j.students.length))

    const one = (r.j.students || []).find((x) => String(x.sid) === SID)
    ok(
      '每个学生带齐 失败/平台次数/状态 字段',
      !!one && ['failCount', 'remoteCount', 'blocked', 'manual', 'auto'].every((k) => k in one),
      one ? JSON.stringify({ fail: one.failCount, remote: one.remoteCount, blocked: one.blocked }) : '没找到'
    )
    ok('刚清过，应该是正常状态', one && one.blocked === false, String(one && one.blocked))
  }

  console.log('\n=== 2. 失败次数与平台自报次数 ===')
  {
    fails.bump(SID, 1, SID)
    fails.bump(SID, 4, SID) // 平台自报 4 次 > 本地 2 次 → 取较大值
    const r = await j('GET', base + '/login-admin', undefined, T)
    const one = r.j.students.find((x) => String(x.sid) === SID)
    ok('本系统次数取较大值（平台 4）', one.failCount === 4, String(one.failCount))
    ok('平台自报次数单独保留', one.remoteCount === 4, String(one.remoteCount))
    ok('数到 3 已自动熔断', one.blocked === true && one.auto === true, 'auto=' + one.auto)
    ok('未标记为老师禁用', one.manual === false, String(one.manual))
  }

  console.log('\n=== 3. 自动熔断后登录被拒，且不发外部请求 ===')
  {
    /*
     * 自动熔断保护的是**外部账号**（错满 5 次会被锁），所以只在 kg 模式下检查。
     * 切回「学号+姓名」后不再依赖外部系统，熔断也就不需要生效 —— 这是刻意的：
     * 老师临时切模式救急，被熔断的学生应该能进来。
     * （但「老师手动禁用」是另一回事，两种模式都拦，见第 5 步。）
     */
    await j('PATCH', '/api/settings/student-auth', { mode: 'kg' }, T)

    const t0 = Date.now()
    const r = await j('POST', '/api/auth/login/student', { sid: SID, password: 'whatever' }, null)
    const ms = Date.now() - t0
    const msg = (r.j && r.j.error && r.j.error.message) || ''
    ok('401', r.s === 401, 'status=' + r.s)
    ok('没有发起外部请求（<300ms）', ms < 300, ms + 'ms')
    ok('提示说到「暂时禁止登录」', /暂时禁止|禁止登录/.test(msg), msg.slice(0, 26))
  }

  console.log('\n=== 3b. local 模式下自动熔断不拦（切模式即救急）===')
  {
    await j('PATCH', '/api/settings/student-auth', { mode: 'local', verifyEachTime: false }, T)
    const r = await j('POST', '/api/auth/login/student', { sid: SID, name: NAME }, null)
    ok('local 模式下能正常登录', r.s === 200 && !!r.j.token, 'status=' + r.s)
    // 但记录还在，切回 kg 依旧被拦
    const back = await j('PATCH', '/api/settings/student-auth', { mode: 'kg' }, T)
    ok('切回 kg 后记录仍在', back.s === 200 && fails.check(SID).blocked === true, 'blocked=' + fails.check(SID).blocked)
  }

  console.log('\n=== 4. 老师手动禁用 ===')
  {
    fails.unblockAll()
    const r = await j('POST', base + '/students/' + encodeURIComponent(SID) + '/login-block', {}, T)
    ok('禁用 200', r.s === 200, JSON.stringify(r.j))

    const v = await j('GET', base + '/login-admin', undefined, T)
    const one = v.j.students.find((x) => String(x.sid) === SID)
    ok('状态 = 老师禁用', one.manual === true && one.blocked === true, JSON.stringify({ manual: one.manual, auto: one.auto }))
    ok('面板 blockedCount 计入', v.j.blockedCount >= 1, String(v.j.blockedCount))

    /* 手动禁用不能因为「密码碰巧对了」就放行 */
    const creds = await import(pathToFileURL(path.join(ROOT, 'api/src/lib/student-creds.js')).href)
    creds.remember(SID, 'right-password')
    const r2 = await j('POST', '/api/auth/login/student', { sid: SID, password: 'right-password' }, null)
    ok('即使密码正确也登不进', r2.s === 401, 'status=' + r2.s)
    creds.forget(SID)
  }

  console.log('\n=== 5. ★ 手动禁用对「学号+姓名」也生效（曾经漏掉的那种）===')
  {
    await j('PATCH', '/api/settings/student-auth', { mode: 'local', verifyEachTime: false }, T)

    const r = await j('POST', '/api/auth/login/student', { sid: SID, name: NAME }, null)
    const msg = (r.j && r.j.error && r.j.error.message) || ''
    ok('local 模式也被拦', r.s === 401, 'status=' + r.s)
    ok('提示是「老师禁止」', /老师禁止/.test(msg), msg.slice(0, 26))
    ok('没有误报成「姓名对不上」', msg.indexOf('姓名') < 0, msg.slice(0, 26))

    // 换一个没被禁的学生，同一个模式应该能进 —— 证明拦的是人不是全局
    const other = (roster.items || roster.students || []).find((x) => String(x.sid) !== SID)
    if (other) {
      const r2 = await j('POST', '/api/auth/login/student', { sid: String(other.sid), name: String(other.name) }, null)
      ok('同班其他学生不受影响', r2.s === 200 && !!r2.j.token, 'status=' + r2.s)
    }
  }

  console.log('\n=== 6. 解除 ===')
  {
    const r = await j('DELETE', base + '/students/' + encodeURIComponent(SID) + '/login-block', undefined, T)
    ok('解除 200', r.s === 200, JSON.stringify(r.j))

    const v = await j('GET', base + '/login-admin', undefined, T)
    const one = v.j.students.find((x) => String(x.sid) === SID)
    ok('状态恢复', one.blocked === false && one.manual === false, JSON.stringify({ blocked: one.blocked, manual: one.manual }))
    ok('失败次数也清零', one.failCount === 0, String(one.failCount))

    const login = await j('POST', '/api/auth/login/student', { sid: SID, name: NAME }, null)
    ok('解除后能正常登录', login.s === 200 && !!login.j.token, 'status=' + login.s)
  }

  console.log('\n=== 7. 边界 ===')
  {
    const noAuth = await (await fetch(B + base + '/login-admin')).status
    ok('未登录 → 401', noAuth === 401, 'status=' + noAuth)

    const badCls = await j('GET', '/api/classes/not-exist/login-admin', undefined, T)
    ok('班级不存在 → 404', badCls.s === 404, 'status=' + badCls.s)

    const notIn = await j('POST', base + '/students/9999999999/login-block', {}, T)
    ok('禁一个不在册的学号 → 404', notIn.s === 404, 'status=' + notIn.s)

    /* 学生令牌不能碰这个接口 */
    const stok = (await j('POST', '/api/auth/login/student', { sid: SID, name: NAME }, null)).j.token
    const asStudent = await j('GET', base + '/login-admin', undefined, stok)
    ok('学生令牌访问 → 403', asStudent.s === 403, 'status=' + asStudent.s)
  }
} finally {
  /* 无论测到哪一步，都把登录方式复位、脏数据清掉 */
  await j('PATCH', '/api/settings/student-auth', { mode: 'local', verifyEachTime: false }, T)
  fails.unblockAll()
  const creds = await import(pathToFileURL(path.join(ROOT, 'api/src/lib/student-creds.js')).href)
  creds.forgetAll()
  console.log('\n  已复位 local，清空失败记录与凭据')
}

console.log('')
console.log(fail === 0 ? '班级登录管理：全部通过 ✓' : '班级登录管理：有失败 ✗')
console.log('（通过 ' + pass + ' · 失败 ' + fail + '）')
process.exit(fail === 0 ? 0 : 1)
