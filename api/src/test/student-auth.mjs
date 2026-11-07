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

  /* ---------- 规则一：必须在班级名单里 ---------- */
  {
    const t0 = Date.now()
    const r = await j('POST', '/api/auth/login/student', { sid: '9999999999', password: 'whatever' })
    const ms = Date.now() - t0
    const msg = (r.j && r.j.error && r.j.error.message) || ''
    ok('不在名册的学号被拒', r.s === 401, 'status=' + r.s)
    ok('提示指向「名单」', msg.indexOf('名单') >= 0, msg.slice(0, 26))
    /*
     * 顺序很重要：先查名册再问青果。
     * 反过来的话，一个不在名单的学号也会去问青果 —— 白消耗一次失败次数。
     */
    ok('先查名册，没打青果（<500ms）', ms < 500, ms + 'ms')
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

    /* 密码错：默认拒绝，且**不自动**去打青果（否则连输几次就把账号打锁） */
    const t1 = Date.now()
    const bad = await j('POST', '/api/auth/login/student', { sid: SID, password: 'wrong-password' })
    const ms1 = Date.now() - t1
    const m1 = (bad.j && bad.j.error && bad.j.error.message) || ''
    ok('本地密码错 → 401', bad.s === 401, 'status=' + bad.s)
    ok('提示引导「用青果再验一次」', m1.indexOf('青果再验') >= 0, m1.slice(0, 30))
    ok('不自动打青果（<500ms）', ms1 < 500, ms1 + 'ms')

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
  const back = await j('PATCH', '/api/settings/student-auth', { mode: 'local' }, T)
  console.log('\n  已切回 local（' + back.s + '）')
}

console.log('')
console.log(fail === 0 ? '学生登录方式：全部通过 ✓' : '学生登录方式：有失败 ✗')
console.log('（通过 ' + pass + ' · 失败 ' + fail + '）')
process.exit(fail === 0 ? 0 : 1)
