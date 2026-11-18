/*
 * lib/errlog.js —— 系统异常行为记录
 *
 * 记的是「**为什么会这样**」的现场，不是「谁改了什么」（那是审计，另一回事）。
 * 典型场景：
 *   · 学生用账号密码登录青果，目标主机返回 402 / 505 / 验证码错
 *   · 调青果超时、DNS 解析不了、TLS 握手失败
 *   · 教学机代理上报被拒（edge.key 对不上）
 *   · 未捕获的异常（带堆栈和当时的请求）
 *   · 慢请求（超过阈值，学生那边已经转圈了）
 *
 * 为什么单独做这一套，而不是打开 Fastify 的 logger：
 *   1) Fastify 打的是 stdout。这台服务是 Start-Process -WindowStyle Hidden 起的，
 *      stdout 直接进空处 —— 打开它等于白开。
 *   2) 缺的不是「请求行」，是「**业务语义**」：`POST /api/auth/student 401`
 *      说明不了什么，而「青果返回 402、失败计数=3、账号被锁定」才说得清。
 *      那种信息只有调用点知道。
 *
 * 存法：data/logs/YYYY-MM-DD.jsonl，一天一个文件，一行一条 JSON。
 *   为什么不是 SQLite：日志是「坏了就坏了」的数据，不该和业务表共用一个库
 *   （日志写满磁盘不该让记分失败）。JSONL 还支持 grep、能直接拖进 Excel。
 *
 * 保留：默认 30 天，启动时清一次。日志无限增长最后一定会把磁盘写满，
 * 而那种事往往在学期中间发生。
 */
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

const KEEP_DAYS = Number(process.env.TS_LOG_KEEP_DAYS || 30)
/** 单条里长文本的截断长度 —— 目标主机有时会回一整页 HTML */
const MAX_TEXT = 500

const DIR = () => path.join(config.dataDir || path.resolve(process.cwd(), 'data'), 'logs')

/** 当天文件路径 */
function fileOf(d) {
  const day = (d || new Date()).toISOString().slice(0, 10)
  return path.join(DIR(), day + '.jsonl')
}

/**
 * 脱敏。
 *
 * 这是这套日志的红线：**凭据永远不进日志**。
 * 调用方可能顺手把整个请求体塞进来，所以这里按字段名兜一道，
 * 而不是指望每个调用点都记得。
 */
const SECRET_KEYS = /^(password|pwd|passwd|token|captcha|code|secret|authorization|edgeKey|edge_key)$/i
function redact(v, depth = 0) {
  if (v === null || v === undefined) return v
  if (depth > 4) return '[deep]'
  if (typeof v === 'string') return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + '…' : v
  if (typeof v !== 'object') return v
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1))
  const out = {}
  for (const [k, val] of Object.entries(v)) {
    out[k] = SECRET_KEYS.test(k) ? '[已隐去]' : redact(val, depth + 1)
  }
  return out
}

/**
 * 写一条。
 *
 * @param {object} e
 *   kind    'kg-login' | 'net' | 'uncaught' | 'slow' | 'edge' | 'app'
 *   level   'warn' | 'error'（默认 warn）
 *   msg     一句话说清发生了什么（会显示在列表里）
 *   其余字段随意（sid / name / target / status / ms …）
 *
 * 写失败不抛 —— 记日志把业务搞挂是最不能接受的。但会打一行 stderr，
 * 免得「日志没了」这件事本身也静默。
 */
export function write(e) {
  try {
    const dir = DIR()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const row = Object.assign(
      { t: new Date().toISOString(), level: 'warn' },
      redact(e || {})
    )
    fs.appendFileSync(fileOf(), JSON.stringify(row) + '\n', 'utf8')
    return true
  } catch (err) {
    try {
      process.stderr.write('[errlog] 写日志失败：' + err.message + '\n')
    } catch (e) {
      /* 连 stderr 都没了就算了 */
    }
    return false
  }
}

/** 读某一天（不给就是今天），返回倒序（最新在前） */
export function readDay(day, limit = 500) {
  const f = fileOf(day ? new Date(day + 'T00:00:00Z') : null)
  if (!fs.existsSync(f)) return []
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const out = []
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]))
    } catch (e) {
      /* 坏行跳过 —— 半行 JSON 通常是被强杀时写断的 */
    }
  }
  return out
}

/** 有哪些天的日志（倒序） */
export function days() {
  try {
    return fs
      .readdirSync(DIR())
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .map((n) => n.slice(0, 10))
      .sort()
      .reverse()
  } catch (e) {
    return []
  }
}

/**
 * 按条件查。
 *
 * 只扫最近 maxDays 天：日志是用来查「刚才发生了什么」的，
 * 谁也不会去翻三个月前的慢请求，全扫一遍反而慢。
 */
export function query({ kind, sid, q, day, limit = 300, maxDays = 7 } = {}) {
  const list = day ? [day] : days().slice(0, maxDays)
  const kw = (q || '').trim().toLowerCase()
  const out = []
  for (const d of list) {
    for (const row of readDay(d, 2000)) {
      if (kind && row.kind !== kind) continue
      if (sid && String(row.sid || '') !== String(sid)) continue
      if (kw) {
        const hay = JSON.stringify(row).toLowerCase()
        if (hay.indexOf(kw) < 0) continue
      }
      out.push(row)
      if (out.length >= limit) return out
    }
  }
  return out
}

/** 清掉超过 KEEP_DAYS 的（启动时调一次就够） */
export function prune() {
  const keep = KEEP_DAYS
  let removed = 0
  try {
    const cut = Date.now() - keep * 86400000
    for (const d of days()) {
      if (new Date(d + 'T00:00:00Z').getTime() < cut) {
        try {
          fs.unlinkSync(path.join(DIR(), d + '.jsonl'))
          removed++
        } catch (e) {
          /* 删不掉就留着，下次再说 */
        }
      }
    }
  } catch (e) {
    /* 目录还不存在 */
  }
  return { removed, keepDays: keep }
}

/** 磁盘占用（总览用） */
export function size() {
  let bytes = 0
  let n = 0
  try {
    for (const f of fs.readdirSync(DIR())) {
      if (!/\.jsonl$/.test(f)) continue
      try {
        bytes += fs.statSync(path.join(DIR(), f)).size
        n++
      } catch (e) {
        /* 并发删了 */
      }
    }
  } catch (e) {
    /* 目录不存在 */
  }
  return { files: n, bytes, keepDays: KEEP_DAYS }
}
