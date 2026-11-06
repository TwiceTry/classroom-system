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
   * 规则只有一条：**data/config.json 是唯一真源，环境变量只在「还没有配置」时用一次。**
   *
   *   1) config 里已经有 teacherPassword
   *        → 一律以它为准。环境变量不再参与，只在两者不一致时提示一句。
   *   2) config 里没有（首次部署，或老配置里没这个字段）
   *        → 用 TS_PASSWORD，没有就用默认 teacher，**并立刻落盘**，从此它就是配置。
   *   3) 界面上改口令
   *        → 直接覆写 config.json，立即生效。
   *
   * 我前两版都没写对，两种错法正好相反：
   *   · 先写成「文件优先但环境变量仍被当成权威」→ 设了 -e TS_PASSWORD 却登不进去；
   *   · 再改成「环境变量永远优先」→ 只要 compose 里写了 TS_PASSWORD，
   *     界面就永远改不了口令（接口还得返回 400 拦住你），等于设置项被环境变量钉死。
   * 现在按「初始化时用环境变量，之后配置文件说了算」，
   * 环境变量既能在第一次部署时把口令设进去，也不会挡住以后的修改。
   */
  if (filePwd) {
    currentPassword = filePwd
    passwordSource = 'file'
    if (envPwd && envPwd !== filePwd) {
      console.warn('  [config] 检测到环境变量 TS_PASSWORD，但 config.json 里已经有口令 —— 以 config.json 为准。')
      console.warn('  [config] 要改口令：教师端「投屏设置 → 账号安全」，或直接改 data/config.json。')
      console.warn('  [config] （TS_PASSWORD 只在「还没有 config」的第一次启动时生效，之后不再参与。）')
    }
    return
  }

  // 没有配置：用环境变量初始化，然后落盘，让它成为配置
  currentPassword = envPwd || 'teacher'
  passwordSource = envPwd ? 'env-init' : 'default'
  try {
    flushPassword(currentPassword)
  } catch (e) {
    console.warn('  [config] 口令写不进 data/config.json（' + e.message + '）。')
    console.warn('  [config] 本次运行用 ' + (envPwd ? 'TS_PASSWORD' : '默认口令 teacher') +
      '；数据目录不可写时，下次启动仍会走这一步。')
  }
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
    // 判的是「当前口令是不是默认值」，不是「它从哪来」。
    // 首次启动落盘 teacher 之后，来源会变成 file，但口令依然是默认的 —— 得继续提醒。
    return currentPassword === 'teacher'
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
