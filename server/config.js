'use strict'
/*
 * config.js —— 路径与运行时配置
 *
 * 三条约束：
 *   1) 内容不搬家：materials / lecture / 代码示例 原地被读取，本系统只读不改；
 *   2) 数据落在本目录 data/ 下（首次启动自动创建），备份就是拷这个目录；
 *   3) 所有路径都可被环境变量覆盖，便于把课堂系统装到别的机器上。
 */
const fs = require('fs')
const path = require('path')

const APP_DIR = path.resolve(__dirname, '..') // 系统自己的目录（仓库根）
const DATA_DIR = process.env.TS_DATA_DIR ? path.resolve(process.env.TS_DATA_DIR) : path.join(APP_DIR, 'data')
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
}

ensureDir(DATA_DIR)
ensureDir(UPLOAD_DIR)

const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {}
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (e) {
    return {}
  }
}

const stored = readConfig()

/**
 * 课程内容目录（讲义 / 材料 / 代码示例）**不绑死在系统旁边**：
 *   1) 环境变量 TS_COURSE_DIR
 *   2) data/config.json 里的 courseDir（相对路径按系统目录解析）
 *   3) 系统目录的上一级里找 course-content/（开发时的仓库布局）
 *   4) 系统目录的上一级本身（离线包布局：讲义/材料/代码示例 与系统目录平级）
 *   5) 系统目录下的 content/（把内容搬进系统的做法）
 * 谁先有 lecture/ 或 materials/ 就用谁；都没有就返回第 4 个，启动时会提示怎么配。
 */
function isContentDir(p) {
  if (!p) return false
  try {
    return (
      fs.existsSync(path.join(p, 'lecture')) || fs.existsSync(path.join(p, 'materials')) || fs.existsSync(path.join(p, '代码示例'))
    )
  } catch (e) {
    return false
  }
}

function resolveCourseDir() {
  const cands = []
  if (process.env.TS_COURSE_DIR) cands.push(path.resolve(process.env.TS_COURSE_DIR))
  if (stored.courseDir) cands.push(path.resolve(APP_DIR, stored.courseDir))
  cands.push(path.resolve(APP_DIR, '..', 'course-content'))
  cands.push(path.resolve(APP_DIR, '..'))
  cands.push(path.join(APP_DIR, 'content'))
  // 一个都没命中时也要给一个确定的路径：容器里 APP_DIR=/app、上一级是 /，
  // 以前这里取 cands[3] 会得到 undefined，path.join 立刻抛错、进程起不来
  const hit = cands.find(isContentDir)
  return hit || path.join(APP_DIR, 'content')
}

const COURSE_DIR = resolveCourseDir()

/* 令牌签名密钥：TS_SECRET > config.json 里的 secret > 首次启动生成并落盘。
 * 持久化的意义：服务重启 / 重新部署后，老师和学生的登录态还在（课堂中途重启不用全场重登）。 */
let tokenSecret = process.env.TS_SECRET || stored.secret || ''
if (!tokenSecret) tokenSecret = require('crypto').randomBytes(32).toString('hex')

/* 边缘端（局域网代理）上报密钥：TS_EDGE_KEY > config.json 里的 edgeKey > 首次启动生成并落盘。
 *
 * 为什么需要它：代理会把「本地 N 个学生谁在场、谁在看投屏」打包成一个请求报上来
 * （POST /api/presence/snapshot）。这个请求代表的是**一群人**，
 * 如果不认来源，任何人只要知道某个学生的令牌就能替全班报状态 ——
 * 甚至用空名单把整个班「踢下线」。所以这个接口必须凭密钥调用。
 * 密钥由服务端生成，填到教学机的 proxy.conf（edge.key = …）。 */
let edgeKey = process.env.TS_EDGE_KEY || stored.edgeKey || ''
if (!edgeKey) edgeKey = require('crypto').randomBytes(24).toString('hex')

const config = {
  appDir: APP_DIR,
  secret: tokenSecret,
  edgeKey,
  courseDir: COURSE_DIR,
  dataDir: DATA_DIR,
  uploadDir: UPLOAD_DIR,

  // 内容目录（只读）
  materialsDir: process.env.TS_MATERIALS_DIR || path.join(COURSE_DIR, 'materials'),
  lectureDir: process.env.TS_LECTURE_DIR || path.join(COURSE_DIR, 'lecture'),
  examplesDir: process.env.TS_EXAMPLES_DIR || path.join(COURSE_DIR, '代码示例'),

  // 前端构建产物
  webDist: path.join(APP_DIR, 'web', 'dist'),

  port: Number(process.env.TS_PORT || stored.port || 18730),
  host: process.env.TS_HOST || '0.0.0.0',

  // 教师口令：环境变量 > data/config.json > 首次生成的默认值
  teacherPassword: process.env.TS_PASSWORD || stored.teacherPassword || 'teacher',
  passwordIsDefault: !process.env.TS_PASSWORD && !stored.teacherPassword,

  // 登录令牌有效期（小时）
  tokenHours: Number(stored.tokenHours || 12),

  // 作息时间表（data/config.json 里可选；不写就用内置的示例职业学院那张）
  timetable: stored.timetable || null,
}

// 把配置落盘（缺什么补什么），方便老师日后直接改文件：
// courseDir 写成「相对系统目录的路径」，换机器、挪盘符都不用改。
;(function persist() {
  try {
    const cur = readConfig()
    const next = Object.assign(
      { port: config.port, teacherPassword: config.teacherPassword, tokenHours: config.tokenHours },
      cur
    )
    if (!next.secret && !process.env.TS_SECRET) next.secret = config.secret
    if (!next.edgeKey && !process.env.TS_EDGE_KEY) next.edgeKey = config.edgeKey
    if (!next.courseDir && !process.env.TS_COURSE_DIR) {
      next.courseDir = path.relative(APP_DIR, COURSE_DIR).split(path.sep).join('/') || '.'
    }
    if (JSON.stringify(next) !== JSON.stringify(cur)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
    }
  } catch (e) {
    /* 只读介质：忽略 */
  }
})()

module.exports = config
