/*
 * config.js —— 运行时配置
 *
 * 原则：**和旧后端读同一份 data/config.json**。
 * 好处：令牌签名密钥、教师口令、边缘端密钥（edgeKey）都不变，
 * 于是升级那一刻：老师不用重登、教学机代理不用改配置、学生也不用重登。
 * 迁移一个系统，最怕的就是「升级后所有人被踢下线」。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url)) // api/src
export const ROOT = path.resolve(HERE, '..', '..') // 课堂系统/
export const DATA_DIR = process.env.TS_DATA_DIR ? path.resolve(process.env.TS_DATA_DIR) : path.join(ROOT, 'data')
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

for (const dir of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(dir, { recursive: true })

function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {}
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (e) {
    console.error('[config] data/config.json 读不出来，按空配置处理：' + e.message)
    return {}
  }
}

const stored = readConfigFile()

const tokenSecret = process.env.TS_SECRET || stored.secret || crypto.randomBytes(32).toString('hex')
const edgeKey = process.env.TS_EDGE_KEY || stored.edgeKey || crypto.randomBytes(24).toString('hex')

/* ---------------------------------------------------------------- 教师口令
 *
 * 真源是 data/config.json 的 teacherPassword —— 老师可以在界面上改，
 * 改完立刻生效（不用重启），下次启动也从文件读。
 *
 * 环境变量 TS_PASSWORD 的地位：**只做首次初始化**。
 *   1) 文件里没有口令、环境变量有 → 把环境变量写进文件（迁移一次）
 *   2) 两边都有且不同         → 以文件为准，启动时提示一次
 *   3) 都没有                 → 默认 teacher（并提示尽快改）
 *
 * 为什么不让环境变量一直最高：容器部署常用 `-e TS_PASSWORD=xxx`，
 * 如果它始终优先，老师在界面上改的口令会被**悄悄覆盖**，而且没有任何提示 ——
 * 那种「改完没反应」最难查。现在改成「首次落盘」，
 * 环境变量照样能在第一次启动时把口令设进去，之后由文件说了算。
 */
let currentPassword = ''
let passwordSource = 'default' // file | env-migrated | default

/** 把口令写进 config.json（保留其它键） */
function flushPassword(pwd) {
  const cur = readConfigFile()
  const next = Object.assign({}, cur, { teacherPassword: pwd })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
}

function initPassword() {
  const envPwd = String(process.env.TS_PASSWORD || '').trim()
  const filePwd = String(stored.teacherPassword || '').trim()

  /*
   * **环境变量优先**。
   *
   * 这里我第一版写反了：让文件优先，理由是「老师界面上改的口令不该被下次启动覆盖」。
   * 但那样一来，Docker 里 `-e TS_PASSWORD=xxx` 的人会发现 xxx 登不进去
   * （config.json 里还留着旧口令）—— 显式配置了环境变量却完全不起作用，
   * 这比「改完被覆盖」更让人摸不着头脑。
   *
   * 所以现在的规则：
   *   · 设了 TS_PASSWORD → 它说了算（界面上改口令会被接口明确拒绝，并告诉你改哪里）
   *   · 没设 TS_PASSWORD → config.json 说了算（界面上改口令正常）
   * 两者不会打架，因为「有一条路径会被明确拒绝」，而不是悄悄失效。
   */
  if (envPwd) {
    currentPassword = envPwd
    passwordSource = 'env'
    if (!filePwd) {
      // 顺手落盘一份：以后即使不设环境变量了，口令也不至于回到默认的 teacher
      try {
        flushPassword(envPwd)
      } catch (e) {
        /* 只读介质：内存里用着就行 */
      }
    } else if (envPwd !== filePwd) {
      console.warn('  [config] 口令以环境变量 TS_PASSWORD 为准（config.json 里那份被忽略）。')
      console.warn('  [config] 想在界面上改口令，请先去掉 TS_PASSWORD 环境变量。')
    }
    return
  }

  currentPassword = filePwd || 'teacher'
  passwordSource = filePwd ? 'file' : 'default'
}
initPassword()

/** 当前教师口令（每次读都是最新 —— 界面上改完立刻生效） */
export function getPassword() {
  return currentPassword
}

/** 口令来源：file / env-migrated / default */
export function getPasswordSource() {
  return passwordSource
}

/**
 * 改口令：先落盘再改内存。
 * 落盘失败（只读介质）就**不生效** —— 否则重启后变回去，老师以为自己改成功了。
 */
export function setPassword(pwd) {
  const s = String(pwd === undefined || pwd === null ? '' : pwd)
  if (!s.trim()) throw new Error('口令不能为空')
  flushPassword(s)
  currentPassword = s
  passwordSource = 'file'
  return true
}

export const config = {
  port: Number(process.env.TS_PORT || stored.port || 18730),
  host: process.env.TS_HOST || '0.0.0.0',

  secret: tokenSecret,
  edgeKey,
  tokenHours: Number(stored.tokenHours || 12),

  // 用 getter：界面上改完口令，这里立刻就是新值（不需要重启进程）
  get teacherPassword() {
    return currentPassword
  },
  get passwordIsDefault() {
    return passwordSource === 'default'
  },

  dataDir: DATA_DIR,
  uploadDir: UPLOAD_DIR,
  webDist: path.join(ROOT, 'web', 'dist'),
  configFile: CONFIG_FILE,

  /** 内容目录（只读）：新模型下内容跟着课程走（data/courses/<id>/content/），这里是老布局兜底 */
  courseDir: process.env.TS_COURSE_DIR ? path.resolve(process.env.TS_COURSE_DIR) : stored.courseDir ? path.resolve(ROOT, stored.courseDir) : '',
}

/** 把缺的键补进 config.json（不覆盖老师改过的任何值） */
function persist() {
  try {
    const cur = readConfigFile()
    const next = Object.assign({}, cur)
    if (!next.secret && !process.env.TS_SECRET) next.secret = config.secret
    if (!next.edgeKey && !process.env.TS_EDGE_KEY) next.edgeKey = config.edgeKey
    if (next.tokenHours === undefined) next.tokenHours = config.tokenHours
    if (next.port === undefined) next.port = config.port
    if (JSON.stringify(next) !== JSON.stringify(cur)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
    }
  } catch (e) {
    /* 只读介质（U 盘 / 容器只读层）：忽略 */
  }
}
persist()
