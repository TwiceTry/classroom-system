/*
 * auth-providers/index.js —— 插件加载器
 *
 * 扫本目录下的子目录，每个子目录的 index.js 默认导出一个插件。
 * 加一个新登录方式 = 丢一个目录进来 + 重启，不用改任何既有代码。
 *
 * 为什么用「目录扫描」而不是「在配置里列插件名」：
 *   插件文件本身就是文档 —— 想看怎么写，打开任意一个就知道；
 *   而在配置里列名字，等于要求改配置的人先知道有哪些插件。
 *
 * 加载失败**不影响其它插件**：一个坏了就跳过并记日志，
 * 否则某人写错一个文件，整套登录就全挂了。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePlugin, API_VERSION } from './types.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** key → 插件模块 */
const registry = new Map()
let loaded = false

/** 这些不是插件目录 */
const SKIP = new Set(['node_modules'])

export async function loadProviders(log) {
  const say = typeof log === 'function' ? log : () => {}
  registry.clear()

  let dirs = []
  try {
    dirs = fs
      .readdirSync(HERE, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      /* 下划线开头的是模板 / 备份，不加载 */
      .filter((n) => !SKIP.has(n) && !n.startsWith('_') && !n.startsWith('.'))
  } catch (e) {
    say({ level: 'error', msg: '扫描插件目录失败：' + e.message })
    return { ok: [], failed: [] }
  }

  const ok = []
  const failed = []

  for (const dir of dirs.sort()) {
    const file = path.join(HERE, dir, 'index.js')
    if (!fs.existsSync(file)) continue
    try {
      const mod = await import('file://' + file.replace(/\\/g, '/'))
      const p = mod.default || mod
      const errs = validatePlugin(p, dir)
      if (errs.length) {
        failed.push({ dir, errs })
        say({ level: 'error', msg: '插件不合规，已跳过：' + errs.join('；') })
        continue
      }
      if (registry.has(p.key)) {
        failed.push({ dir, errs: ['key 重复：' + p.key] })
        say({ level: 'error', msg: '插件 key 重复，已跳过：' + p.key + '（' + dir + '）' })
        continue
      }
      registry.set(p.key, p)
      ok.push(p.key)
    } catch (e) {
      failed.push({ dir, errs: [e.message] })
      say({ level: 'error', msg: '插件加载失败 ' + dir + '：' + e.message })
    }
  }

  loaded = true
  return { ok, failed }
}

export function isLoaded() {
  return loaded
}

/** 取一个插件；没有就返回 null */
export function getProvider(key) {
  return registry.get(String(key || '')) || null
}

/**
 * 全部插件（给设置页列出来用）—— 只给元信息，不给 verify 函数。
 *
 * 排序：`local` 永远排第一，其余按名字。
 * 理由：它是「不依赖任何外部系统」的那个，出问题时的兜底；而且老师第一次配时
 * 最可能先看到它。按目录名排会把 kg 放前面，看着像"默认用青果"。
 */
export function listProviders() {
  const all = [...registry.values()]
  all.sort((a, b) => {
    if (a.key === 'local') return -1
    if (b.key === 'local') return 1
    return String(a.name).localeCompare(String(b.name), 'zh')
  })
  return all.map((p) => ({
    key: p.key,
    name: p.name,
    desc: p.desc || '',
    remember: p.remember === true,
    credentials: p.credentials || [],
    settings: p.settings || [],
    captcha: p.captcha || { kind: 'none' },
    apiVersion: API_VERSION,
  }))
}

/**
 * 某个学生该用哪个插件。
 *
 * 优先看单独设置（auth_overrides），没有就用全局。
 * 两个都取不到时退回第一个可用的 —— 总比「登录直接崩」好。
 */
export function providerFor(overrideKey, globalKey) {
  const o = String(overrideKey || '')
  if (o && registry.has(o)) return registry.get(o)
  const g = String(globalKey || '')
  if (g && registry.has(g)) return registry.get(g)
  const first = registry.values().next().value
  return first || null
}

/**
 * 构造传给插件的 ctx。
 *
 * 这里是**唯一**给插件开放系统能力的地方：
 *   · roster  —— 只读名册（插件自己不去碰数据库）
 *   · log     —— 已脱敏的审计日志
 * 插件拿不到 repo / db / config，写数据必须走钩子回来。
 */
export function buildContext({ sid, credentials, settings, captcha, log, signal, repo, request }) {
  return {
    sid: String(sid || '').trim(),
    credentials: credentials || {},
    settings: settings || {},
    captcha: captcha || null,
    signal,
    request: request || {},
    log: (obj) => {
      try {
        log && log(obj)
      } catch (e) {
        /* 日志失败不影响登录 */
      }
    },
    /*
     * 只读名册。故意只给两个方法：
     * 插件需要知道「这个学号在不在册、姓名对不对」，别的都不该知道。
     */
    roster: {
      classOf: (s) => {
        try {
          const c = repo.findClassBySid(String(s || ''))
          return c ? { id: c.id, name: c.name, courseId: c.courseId } : null
        } catch (e) {
          return null
        }
      },
      studentOf: (classId, s) => {
        try {
          const st = repo.findStudent(classId, String(s || ''))
          return st ? { sid: st.sid, name: st.name } : null
        } catch (e) {
          return null
        }
      },
    },
  }
}

/**
 * 跑一次验证，带钩子和错误隔离。
 *
 * 三条保命规则：
 *   · verify 抛错 → 退化成 SERVICE_DOWN（不当成"密码错"，别计失败）
 *   · 钩子抛错 → 吞掉，只记日志（插件写坏了不能影响登录结果）
 *   · beforeVerify 返回非空 → 短路，不再调 verify
 */
export async function runVerify(plugin, ctx, log) {
  const say = typeof log === 'function' ? log : () => {}

  if (typeof plugin.beforeVerify === 'function') {
    try {
      const short = await plugin.beforeVerify(ctx)
      if (short && short.outcome) return short
    } catch (e) {
      say({ level: 'error', msg: '插件 ' + plugin.key + ' beforeVerify 抛错：' + e.message })
    }
  }

  let r
  try {
    r = await plugin.verify(ctx)
  } catch (e) {
    say({
      level: 'error',
      msg: '插件 ' + plugin.key + ' verify 抛错：' + e.message,
      stack: String(e && e.stack || '').split('\n').slice(0, 8).join('\n'),
    })
    /* 插件内部炸了 = 这套流程跑不下去，按「服务不可用」处理，绝不当成凭证错 */
    return { outcome: 'fail', reason: 'service-down', message: '登录服务暂时不可用，请稍后再试' }
  }

  if (!r || typeof r !== 'object' || !r.outcome) {
    say({ level: 'error', msg: '插件 ' + plugin.key + ' 返回了不合法的结果：' + JSON.stringify(r).slice(0, 120) })
    return { outcome: 'fail', reason: 'service-down', message: '登录服务暂时不可用，请稍后再试' }
  }

  /* 钩子：都包 try/catch，且不看返回值 */
  for (const [fn, arg] of [
    ['afterVerify', r],
    [r.outcome === 'ok' ? 'onSuccess' : 'onFailure', r],
  ]) {
    if (typeof plugin[fn] !== 'function') continue
    try {
      await plugin[fn](arg, ctx)
    } catch (e) {
      say({ level: 'error', msg: '插件 ' + plugin.key + ' ' + fn + ' 抛错：' + e.message })
    }
  }

  return r
}
