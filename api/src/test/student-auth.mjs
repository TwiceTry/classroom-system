/**
 * 学生登录的两种校验方式（e2e，需要服务在 18730 跑着）
 *
 *   local —— 学号 + 姓名（默认，不联网）
 *   kg    —— 学号 + 青果密码（能登上智慧校园才放行）
 *
 * 两条底线，这个文件主要就是守住它们：
 *   1. 切到 kg 之后，local 的姓名比对必须失效（不能两种都放行）
 *   2. 青果校验失败时**一次就返回**，绝不自动重试（会锁学生账号）
 *
 * 注意：kg 那步会真的去问青果（用不存在的学号，不碰真实学生）。
 * 没有外网时用 TS_SKIP_KG=1 跳过——但那样就只验证了「接口形状」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const B = process.env.TS_BASE || 'http://127.0.0.1:18730'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/config.json'), 'utf8'))
/*
 * 联网那步**默认跳过**，要显式 TS_KG_LIVE=1 才真去问青果。
 *
 * 原因：青果按 24 小时记失败次数，同一个测试账号多跑几次就会被锁，
 * 之后这组测试会永远红 —— 那不是代码坏了，是测试把账号打废了。
 * 需要在发版前人工验一次真链路时，再手动开这个开关。
 */
const SKIP_KG = String(process.env.TS_KG_LIVE || '') !== '1'

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
  const r = await fetch(B + u, o)
  const t = await r.text()
  let x = null
  try { x = JSON.parse(t) } catch (e) { /* */ }
  return { s: r.status, j: x }
}

const T = (await j('POST', '/api/auth/login/teacher', { password: String(cfg.teacherPassword || '').trim() })).j.token
const SID = '2515230114'
const NAME = '马婷婷'

try {
  /* ---------- 先把状态复位成 local，别假设上一次跑完是干净的 ---------- */
  await j('PATCH', '/api/settings/student-auth', { mode: 'local' }, T)

  const m0 = await j('GET', '/api/auth/student-mode')
  ok('登录页能拿到当前方式', m0.s === 200 && !!m0.j.mode, String(m0.j && m0.j.mode))
  ok('复位后是 local', m0.j.mode === 'local', String(m0.j.mode))

  const pub = await j('GET', '/api/settings/student-auth')
  ok('完整配置不对外公开', pub.s === 401, 'status=' + pub.s)

  /* ---------- local 行为 ---------- */
  {
    const good = await j('POST', '/api/auth/login/student', { sid: SID, name: NAME })
    ok('local：学号+姓名 能登录', good.s === 200 && !!good.j.token, 'status=' + good.s)

    const bad = await j('POST', '/api/auth/login/student', { sid: SID, name: '不是这个名字' })
    ok('local：姓名不对被拒', bad.s === 401, 'status=' + bad.s)

    const noName = await j('POST', '/api/auth/login/student', { sid: SID })
    ok('local：不填姓名被拒', noName.s === 400, 'status=' + noName.s)
  }

  /* ---------- 切到 kg ---------- */
  {
    const r = await j('PATCH', '/api/settings/student-auth', { mode: 'kg' }, T)
    ok('能切到 kg', r.s === 200 && r.j.mode === 'kg', String(r.j && r.j.mode))
    const m = await j('GET', '/api/auth/student-mode')
    ok('登录页立刻看到 kg', m.j.mode === 'kg', String(m.j.mode))

    /* 关键：kg 模式下姓名不再是通行证 */
    const byName = await j('POST', '/api/auth/login/student', { sid: SID, name: NAME })
    ok('kg 模式下「学号+姓名」不再放行', byName.s >= 400, 'status=' + byName.s)

    const noPwd = await j('POST', '/api/auth/login/student', { sid: SID })
    ok('kg 模式下不填密码 → 400', noPwd.s === 400, 'status=' + noPwd.s)
  }

  /* ---------- 真的去问一次青果（不存在的学号，不碰真实学生）---------- */
  if (SKIP_KG) {
    console.log('  · 跳过真实青果校验（TS_SKIP_KG=1）')
  } else {
    const t0 = Date.now()
    const r = await j('POST', '/api/auth/login/student', { sid: '9999999999', password: 'definitely-not-real' })
    const ms = Date.now() - t0
    const msg = (r.j && r.j.error && r.j.error.message) || ''
    ok('kg：不存在的账号被拒', r.s === 401, 'status=' + r.s + '  ' + ms + 'ms')
    ok('kg：失败原因能看懂', !!msg, msg.slice(0, 44))
    ok('kg：确实去问了青果（不是本地糊弄）', ms > 300, ms + 'ms')
  }

  /* ---------- 规则一：账号要能对上某个学号，否则是「未入班」而不是「密码错」---------- */
  {
    const creds0 = await import(pathToFileURL(path.join(ROOT, 'api/src/lib/student-creds.js')).href)

    /*
     * 能登录（这里用本地已记住的凭据模拟「青果通过了」），但账号里不含任何学号。
     * 这时必须提示「未加入班级」—— 和「密码不对」分开说。
     * 混着说会让没入班的学生反复试密码，把自己账号试到锁定。
     */
    const account = 'ZZNOTASTUDENT'
    creds0.remember(account, 'pw-x')
    const r = await j('POST', '/api/auth/login/student', { sid: account, password: 'pw-x' })
    const msg = (r.j && r.j.error && r.j.error.message) || ''
    ok('账号对不上任何学号 → 401', r.s === 401, 'status=' + r.s)
    ok('提示是「未加入班级」', /还没有加入本课程班级|未加入本课程班级/.test(msg), msg.slice(0, 34))
    ok('没有误报成「账号或密码不对」', msg.indexOf('账号或密码不对') < 0, msg.slice(0, 30))
    creds0.forget(account)
  }

  /* ---------- 规则二：记住密码后走本地，不再打青果 ---------- */
  {
    const creds = await import(pathToFileURL(path.join(ROOT, 'api/src/lib/student-creds.js')).href)
    ok('remember 返回 true', creds.remember(SID, 'Test-Pass-123') === true)
    ok('verify 对得上', creds.verify(SID, 'Test-Pass-123') === true)
    ok('verify 对不上', creds.verify(SID, 'other') === false)
    ok('没记过的返回 null', creds.verify('0000000000', 'x') === null)

    const t0 = Date.now()
    const r = await j('POST', '/api/auth/login/student', { sid: SID, password: 'Test-Pass-123' })
    const ms = Date.now() - t0
    ok('本地比对通过即可登录', r.s === 200 && !!r.j.token, 'status=' + r.s)
    ok('走本地，没打青果（<500ms）', ms < 500, ms + 'ms')

    /*
     * 账号不一定正好等于学号：学校可能用工号风格前缀、或邮箱后缀。
     * 规则是「等于，或者包含某个学号」都认。
     */
    for (const [label, account] of [
      ['带前缀（WP+学号）', 'WP' + SID],
      ['带后缀（学号@域）', SID + '@school.edu'],
    ]) {
      creds.remember(account, 'pw-alias')
      const ra = await j('POST', '/api/auth/login/student', { sid: account, password: 'pw-alias' })
      ok(
        label + ' → 认成 ' + SID,
        ra.s === 200 && ra.j.student && ra.j.student.sid === SID,
        ra.s + ' / ' + (ra.j.student && ra.j.student.sid)
      )
      creds.forget(account)
    }

    /*
     * 密码错的路径**只在允许联网时才测**。
     *
     * 原因很实际：新逻辑下「本地对不上 → 去问青果」，而这里用的是名册里的**真实学号**。
     * 每跑一次测试就给这个学号在青果那边记一次失败，
     * 跑几次就把人锁了 —— 那不是测试，那是搞破坏。
     * 默认（TS_KG_LIVE 未开）就跳过这一支，只验证本地成功路径。
     */
    if (!SKIP_KG) {
      const t1 = Date.now()
      const bad = await j('POST', '/api/auth/login/student', { sid: SID, password: 'wrong-password' })
      const ms1 = Date.now() - t1
      const m1 = (bad.j && bad.j.error && bad.j.error.message) || ''
      ok('本地密码错 → 401', bad.s === 401, 'status=' + bad.s)
      ok('提示里没有「再验」这类内部说法', m1.indexOf('再验') < 0, m1.slice(0, 34))
      ok('提示是「学号或密码不对」（或次数/锁定）', /学号或密码不对|次数|锁定/.test(m1), m1.slice(0, 34))
      ok('这时会去问青果（>300ms）', ms1 > 300, ms1 + 'ms')
    } else {
      console.log('  · 跳过「密码错 → 问青果」（会消耗真实学号的失败次数）')
    }

    /* 表里只有派生值，没有明文列 */
    const { openDb } = await import(pathToFileURL(path.join(ROOT, 'api/src/db/index.js')).href)
    const db = openDb()
    const cols = db.prepare('PRAGMA table_info(student_credentials)').all().map((c) => c.name)
    db.close()
    ok('凭据表只有 algo/salt/hash', cols.includes('hash') && !cols.includes('password'), cols.join(','))

    const g = await j('GET', '/api/settings/student-auth', undefined, T)
    ok('教师能看到已记住的数量', Number(g.j.rememberedCount) >= 1, 'count=' + g.j.rememberedCount)

    const one = await j('DELETE', '/api/settings/student-auth/creds/' + SID, undefined, T)
    ok('能清掉某个学生', one.j && one.j.removed === true, JSON.stringify(one.j))
    ok('清掉后本地不再认', creds.verify(SID, 'Test-Pass-123') === null)

    const all = await j('DELETE', '/api/settings/student-auth/creds', undefined, T)
    ok('能清空全部', all.s === 200, 'removed=' + (all.j && all.j.removed))
  }

  /* ---------- 教师端开关：是否每次都向青果核验 ---------- */
  {
    const creds = await import(pathToFileURL(path.join(ROOT, 'api/src/lib/student-creds.js')).href)
    creds.remember(SID, 'Test-Pass-123')

    const on = await j('PATCH', '/api/settings/student-auth', { verifyEachTime: true }, T)
    ok('能打开「每次登录都核验」', on.j && on.j.verifyEachTime === true, JSON.stringify(on.j && on.j.verifyEachTime))

    /* 开了之后：哪怕本地记得、密码也对，仍然以青果为准（同样只在允许联网时才跑） */
    if (!SKIP_KG) {
      const t0 = Date.now()
      const r = await j('POST', '/api/auth/login/student', { sid: SID, password: 'Test-Pass-123' })
      const ms = Date.now() - t0
      ok('开着时即使本地有记录也去问青果（>300ms）', ms > 300, r.s + ' / ' + ms + 'ms')
    } else {
      console.log('  · 跳过「开着时去问青果」（会消耗真实学号的失败次数）')
    }

    const off = await j('PATCH', '/api/settings/student-auth', { verifyEachTime: false }, T)
    ok('能关掉', off.j && off.j.verifyEachTime === false, JSON.stringify(off.j && off.j.verifyEachTime))

    const t1 = Date.now()
    const r2 = await j('POST', '/api/auth/login/student', { sid: SID, password: 'Test-Pass-123' })
    const ms1 = Date.now() - t1
    ok('关掉后回到本地比对（登录成功且 <500ms）', r2.s === 200 && ms1 < 500, r2.s + ' / ' + ms1 + 'ms')

    creds.forgetAll()
  }

  /* ---------- 规则三：连错 3 次本地熔断，不再发起外部请求 ---------- */
  {
    const fails = await import(pathToFileURL(path.join(ROOT, 'api/src/lib/login-fails.js')).href)
    const ACC = 'ZZPROBE001'

    fails.unblock(ACC)
    const r1 = fails.bump(ACC)
    const r2 = fails.bump(ACC)
    const r3 = fails.bump(ACC)
    ok('阈值是 3 次', fails.BLOCK_AFTER === 3, String(fails.BLOCK_AFTER))
    ok('第 1、2 次不熔断', r1.blocked === false && r2.blocked === false, r1.count + '/' + r2.count)
    ok('第 3 次熔断（justBlocked）', r3.blocked === true && r3.justBlocked === true, 'count=' + r3.count)

    /*
     * 熔断之后必须**连请求都不发** —— 否则熔断就没意义，
     * 外部系统的失败次数还是会被推上去。
     * 用耗时判断：不发请求就是毫秒级。
     */
    const t0 = Date.now()
    const r = await j('POST', '/api/auth/login/student', { sid: ACC, password: 'anything' })
    const ms = Date.now() - t0
    const msg = (r.j && r.j.error && r.j.error.message) || ''
    ok('被熔断的账号登录 → 401', r.s === 401, 'status=' + r.s)
    ok('提示「暂时禁止登录」', /暂时禁止|禁止登录/.test(msg), msg.slice(0, 26))
    ok('没有发起外部请求（<300ms）', ms < 300, ms + 'ms')

    const g = await j('GET', '/api/settings/student-auth', undefined, T)
    ok('教师端能看到被禁数量', Number(g.j.blockedCount) >= 1, 'blocked=' + g.j.blockedCount)

    const un = await j('DELETE', '/api/settings/student-auth/blocks/' + ACC, undefined, T)
    ok('教师能解锁', un.j && un.j.removed === true, JSON.stringify(un.j))
    ok('解锁后不再禁止', fails.check(ACC).blocked === false, String(fails.check(ACC).blocked))

    fails.unblockAll()
    ok('全解后为 0', fails.blockedCount() === 0, String(fails.blockedCount()))
  }

  /* ---------- 规则四：登录成功要把失败计数清零 ---------- */
  {
    const fails = await import(pathToFileURL(path.join(ROOT, 'api/src/lib/login-fails.js')).href)
    const creds = await import(pathToFileURL(path.join(ROOT, 'api/src/lib/student-creds.js')).href)
    creds.remember(SID, 'pw-clear')
    fails.bump(SID)
    fails.bump(SID)
    ok('先制造 2 次失败', fails.check(SID).count === 2, 'count=' + fails.check(SID).count)

    const r = await j('POST', '/api/auth/login/student', { sid: SID, password: 'pw-clear' })
    ok('登录成功', r.s === 200, 'status=' + r.s)
    ok('成功后失败计数清零', fails.check(SID).count === 0, 'count=' + fails.check(SID).count)
    creds.forget(SID)
  }

  /* ---------- 入口配置 ---------- */
  {
    const r = await j('PATCH', '/api/settings/student-auth', {
      mode: 'kg',
      kgBases: ['http://117.159.97.151:9999', 'http://117.159.97.151:8888'],
    }, T)
    ok('能改入口顺序', r.s === 200 && r.j.kgBases[0].endsWith(':9999'), JSON.stringify(r.j && r.j.kgBases))

    const bad = await j('PATCH', '/api/settings/student-auth', { kgBases: ['不是网址'] }, T)
    ok('非法地址被过滤，回落到默认', bad.s === 200 && bad.j.kgBases.length === 2, JSON.stringify(bad.j && bad.j.kgBases))

    const restored = await j('PATCH', '/api/settings/student-auth', {
      mode: 'kg',
      kgBases: ['http://117.159.97.151:8888', 'http://117.159.97.151:9999'],
    }, T)
    ok('默认入口能恢复', restored.j.kgBases[0].endsWith(':8888'), JSON.stringify(restored.j && restored.j.kgBases))
  }
} finally {
  /* 无论测到哪一步，都要切回默认，别把课上到一半的登录方式改掉 */
  // 复位要彻底：只改 mode 不改 verifyEachTime，下次跑就会留下「每次都核验」的坑
  const back = await j('PATCH', '/api/settings/student-auth', { mode: 'local', verifyEachTime: false }, T)
  console.log('\n  已切回 local（' + back.s + '）')
}

console.log('')
console.log(fail === 0 ? '学生登录方式：全部通过 ✓' : '学生登录方式：有失败 ✗')
console.log('（通过 ' + pass + ' · 失败 ' + fail + '）')
process.exit(fail === 0 ? 0 : 1)
