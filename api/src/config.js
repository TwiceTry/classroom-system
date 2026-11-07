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

/*
 * 热加载：老师**手改** data/config.json 之后，不用重启也能生效。
 *
 * 之前 config 只在进程启动时读一次（模块加载时），于是：
 * 改了文件 → 登录还是旧口令 → 以为改错了 → 再去查代码。
 * 实际上只是没重启。
 *
 * 这里按 mtime 判断文件有没有被动过：动过就重读 teacherPassword。
 * 一次 statSync，微秒级，而且只在有人尝试登录/校验口令时才发生。
 * 界面上改口令本来就会同时更新内存，所以这条主要服务于「手工编辑文件」。
 */
let _pwdMtime = 0
try {
  _pwdMtime = fs.statSync(CONFIG_FILE).mtimeMs
} catch (e) {
  /* 文件还不存在（首次启动）：下次读口令时再取 */
}

function reloadPasswordIfChanged() {
  let st
  try {
    st = fs.statSync(CONFIG_FILE)
  } catch (e) {
    return // 文件被删了/读不到：保持内存里的口令，不把服务搞挂
  }
  if (st.mtimeMs === _pwdMtime) return
  _pwdMtime = st.mtimeMs

  const again = readConfigFile()
  const filePwd = String(again.teacherPassword || '').trim()
  if (!filePwd || filePwd === currentPassword) return // 口令没变（改的是别的字段）

  currentPassword = filePwd
  passwordSource = 'file'
  console.log('[config] data/config.json 已变更，教师口令重新加载（无需重启）')
}

/** 当前教师口令：每次读都会先看文件有没有被手改过 */
export function getPassword() {
  reloadPasswordIfChanged()
  return currentPassword
}

/** 口令来源：file / env-init / default */
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
  // 刚写过的文件，记下 mtime，免得下一次 getPassword 又白读一遍
  try {
    _pwdMtime = fs.statSync(CONFIG_FILE).mtimeMs
  } catch (e) {
    /* ignore */
  }
  return true
}

export const config = {
  port: Number(process.env.TS_PORT || stored.port || 18730),
  host: process.env.TS_HOST || '0.0.0.0',

  secret: tokenSecret,
  edgeKey,
  tokenHours: Number(stored.tokenHours || 12),

  // getter：读的时候顺带检查 config.json 有没有被手改（见 reloadPasswordIfChanged）
  get teacherPassword() {
    return getPassword()
  },
  get passwordIsDefault() {
    // 判的是「当前口令是不是默认值」，不是「它从哪来」。
    // 首次启动落盘 teacher 之后，来源会变成 file，但口令依然是默认的 —— 得继续提醒。
    return getPassword() === 'teacher'
  },

  dataDir: DATA_DIR,
  uploadDir: UPLOAD_DIR,
  webDist: path.join(ROOT, 'web', 'dist'),
  configFile: CONFIG_FILE,

  /** 内容目录（只读）：新模型下内容跟着课程走（data/courses/<id>/content/），这里是老布局兜底 */
  courseDir: process.env.TS_COURSE_DIR ? path.resolve(process.env.TS_COURSE_DIR) : stored.courseDir ? path.resolve(ROOT, stored.courseDir) : '',
}

/*
 * 学生登录校验方式
 *
 *   local —— 学号 + 姓名，和课程名单比对（默认，不联网）
 *   kg    —— 学号 + 青果密码，能登上青果就放行（见 lib/kg-auth.js）
 *
 * 存 data/config.json 的 studentAuth 字段，老师随时可以改，改完立即可用
 * （每次登录都现读，不做进程内缓存 —— 这跟口令热加载是同一个思路）。
 */

/** 青果两个入口（内容一样，轮询分流） */
export const DEFAULT_KG_BASES = ['http://117.159.97.151:8888', 'http://117.159.97.151:9999']

export function getStudentAuth() {
  let c = {}
  try {
    c = readConfigFile()
  } catch (e) {
    c = {}
  }
  const sa = (c && c.studentAuth) || {}
  const mode = sa.mode === 'kg' ? 'kg' : 'local'
  const bases = Array.isArray(sa.kgBases)
    ? sa.kgBases.map((x) => String(x || '').trim()).filter((x) => /^https?:\/\//i.test(x)).slice(0, 5)
    : []
  /*
   * verifyEachTime：每次登录都去问青果，不用本地记住的密码。
   *
   *   false（默认）—— 记住密码后本地比对，省一次 1.3 秒的远端往返
   *   true         —— 每次都以青果为准（最准，但慢，且每次都在消耗青果的失败计数）
   *
   * 这是**老师**的决定，学生端不该看见这个区别：
   * 学生永远只输「学号 + 密码」，错了就是「学号或密码不对」。
   */
  const verifyEachTime = sa.verifyEachTime === true
  return { mode, kgBases: bases.length ? bases : DEFAULT_KG_BASES.slice(), verifyEachTime }
}

/** 改学生登录方式；只动 studentAuth 这一个键，别的配置原样保留 */
export function setStudentAuth(patch = {}) {
  const cur = readConfigFile()
  const prev = (cur && cur.studentAuth) || {}
  const mode = patch.mode === 'kg' ? 'kg' : patch.mode === 'local' ? 'local' : prev.mode === 'kg' ? 'kg' : 'local'

  let bases
  if (Array.isArray(patch.kgBases)) {
    bases = patch.kgBases.map((x) => String(x || '').trim()).filter((x) => /^https?:\/\//i.test(x)).slice(0, 5)
  } else if (Array.isArray(prev.kgBases) && prev.kgBases.length) {
    bases = prev.kgBases
  } else {
    bases = DEFAULT_KG_BASES.slice()
  }
  if (!bases.length) bases = DEFAULT_KG_BASES.slice()

  const verifyEachTime =
    patch.verifyEachTime === undefined ? prev.verifyEachTime === true : patch.verifyEachTime === true

  const next = Object.assign({}, cur, { studentAuth: { mode, kgBases: bases, verifyEachTime } })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  return getStudentAuth()
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
