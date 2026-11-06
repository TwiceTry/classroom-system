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

export const config = {
  port: Number(process.env.TS_PORT || stored.port || 18730),
  host: process.env.TS_HOST || '0.0.0.0',

  secret: tokenSecret,
  edgeKey,
  tokenHours: Number(stored.tokenHours || 12),

  teacherPassword: process.env.TS_PASSWORD || stored.teacherPassword || 'teacher',
  passwordIsDefault: !process.env.TS_PASSWORD && !stored.teacherPassword,

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
