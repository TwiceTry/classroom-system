/*
 * lib/auth-overrides.js —— 学生登录方式的单独设置
 *
 * 全局设置（data/config.json 的 studentAuth.mode）决定「默认怎么验」，
 * 这里存「谁不按默认来」。没有记录 = 跟随全局。
 *
 * 两种方式：
 *   local  学号 + 姓名，不进青果、不输密码
 *   kg     账号 + 密码，走青果核验
 *
 * 为什么需要按人覆盖（真实场景）：
 *   · 大部分学生用青果账号密码，但个别学生青果密码老对不上、或者账号被锁，
 *     老师想让他先用「学号 + 姓名」进来上课
 *   · 反过来也有：默认学号+姓名，个别要交作业的学生要求必须走青果
 *   · 一节课上两种方式并存是常态，不是例外
 */
import { db } from './repo.js'
import { getProvider } from './auth-providers/index.js'

/*
 * 这里原来写死白名单 `new Set(['local','kg'])` —— 插件化之后它就是错的：
 * 任何新插件的 key 都会被这个集合默默拒掉（setMany 抛错、modeFor 回落全局），
 * 表现是「老师给某个学生设了第三种登录方式，保存成功但下次登录还是老样子」。
 *
 * 现在只判「空不空」：空 = 清除覆盖，非空 = 一个插件 key。
 * 合不合法由 setMany 那边查插件清单确认（这样插件被删掉之后，
 * 已有的覆盖记录不会让读取路径抛错，只是 providerFor 会回落到全局）。
 */

/**
 * 这个学生实际用哪种方式。
 *
 * @param {string} sid
 * @param {string} fallback 全局设置（'local' | 'kg'）
 */
export function modeFor(sid, fallback) {
  const s = String(sid || '').trim()
  if (!s) return fallback
  try {
    const row = db().prepare('SELECT mode FROM auth_overrides WHERE sid = ?').get(s)
    const m = row && String(row.mode || '')
    /* 不在这里校验合法性：插件可能被临时停用，那条覆盖记录仍然该留着 */
    return m || fallback
  } catch (e) {
    /* 表还没建（第一次启动前）/ 库坏了：一律按全局走，别把登录搞挂 */
    return fallback
  }
}

/**
 * 批量取：sid → mode（只返回**有覆盖**的）。
 *
 * 登录管理表格一次要显示几十行，一行一次查询太碎；
 * 而且大多数学生没有覆盖，返回一个只含例外的 Map 更省。
 */
export function listOf(sids) {
  const out = new Map()
  const list = (sids || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 2000)
  if (!list.length) return out
  try {
    const ph = list.map(() => '?').join(',')
    const rows = db()
      .prepare('SELECT sid, mode FROM auth_overrides WHERE sid IN (' + ph + ')')
      .all(...list)
    for (const r of rows) out.set(String(r.sid), String(r.mode || ''))
  } catch (e) {
    /* 同上，读不到当没有覆盖 */
  }
  return out
}

/**
 * 批量设置（或清除）。
 *
 * @param {string[]} sids
 * @param {string} mode 'local' | 'kg' | ''（空 = 清除覆盖，回到跟随全局）
 * @returns {{changed:number, cleared:number}}
 */
export function setMany(sids, mode) {
  const list = (sids || []).map((x) => String(x || '').trim()).filter(Boolean)
  if (!list.length) return { changed: 0, cleared: 0 }
  const want = String(mode || '').trim()
  const now = new Date().toISOString()
  const d = db()

  if (!want) {
    const del = d.prepare('DELETE FROM auth_overrides WHERE sid = ?')
    let cleared = 0
    const tx = d.transaction((arr) => {
      for (const s of arr) cleared += del.run(s).changes
    })
    tx(list)
    return { changed: 0, cleared }
  }

  /* 合法性在这里查：必须是已加载的插件（名单由加载器扫目录维护，不在这里重复一份） */
  if (!getProvider(want)) throw new Error('没有这个登录方式：' + want)

  const up = d.prepare(
    'INSERT INTO auth_overrides (sid, mode, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(sid) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at'
  )
  let changed = 0
  const tx = d.transaction((arr) => {
    for (const s of arr) changed += up.run(s, want, now).changes
  })
  tx(list)
  return { changed, cleared: 0 }
}

/** 有多少人单独设过（给设置页显示个数字，提示「全局改了不影响他们」） */
export function count() {
  try {
    const r = db().prepare('SELECT COUNT(*) AS n FROM auth_overrides').get()
    return Number((r && r.n) || 0)
  } catch (e) {
    return 0
  }
}
