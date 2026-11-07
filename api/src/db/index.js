/*
 * db/index.js —— SQLite 连接与 schema 应用
 *
 * 为什么是 better-sqlite3：
 *   · 同步 API —— 一个班几十个人、一学期几万条记录，同步读写简单直接，
 *     不用为每个查询写 await，也不会出现「事务里混进异步」的经典坑；
 *   · 单文件数据库 —— 备份就是拷一个 data/teach.db（外加 -wal / -shm），
 *     老师自己就能备份，比「拷一堆 csv」还省事；
 *   · WAL 模式 —— 读不阻塞写，40 个学生刷页面 + 老师在记分不会互相卡。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_FILE = path.join(HERE, 'schema.sql')

/** 数据目录：TS_DATA_DIR > 仓库的 data/（与旧后端同一个目录，方便迁移与回滚） */
export function dataDir() {
  const dir = process.env.TS_DATA_DIR
    ? path.resolve(process.env.TS_DATA_DIR)
    : path.resolve(HERE, '..', '..', '..', 'data')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function dbPath() {
  return path.join(dataDir(), 'teach.db')
}

/**
 * 打开数据库。
 * PRAGMA 的取舍：
 *   journal_mode = WAL   —— 读写不互相阻塞（学生刷页面时老师记分不会卡）
 *   foreign_keys = ON    —— SQLite 默认不开外键，必须显式打开
 *   busy_timeout = 5000  —— 万一撞上写锁，等 5 秒而不是立刻报错
 *   synchronous = NORMAL —— WAL 下这个档位已经足够安全，又比 FULL 快一个量级
 */
export function openDb(file) {
  const target = file || dbPath()
  const db = new Database(target)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')

  /*
   * 建表放在这里，而不是只留给 migrate.js。
   *
   * 原来 applySchema 只有 CLI（migrate.js）和测试会调，server.js 启动时**不建表**。
   * 本地一直没事，是因为 data/teach.db 是从 CSV 迁移过来的老库、表早就在；
   * 但 Docker 挂一个空卷时，teach.db 是个空文件，
   * 于是第一个查询就炸：SqliteError: no such table: courses。
   *
   * 放在 openDb 里意味着**任何入口都会建表**（服务 / CLI / 测试 / 临时库），
   * 不会再出现「某个路径忘了迁移」。schema.sql 全是 CREATE ... IF NOT EXISTS，
   * 对已有库是空操作，代价只有启动时多读一次文件。
   */
  applySchema(db)
  return db
}

/**
 * 给**已经存在**的表补新列。
 *
 * schema.sql 全是 `CREATE TABLE IF NOT EXISTS` —— 表已经在了，它就不会加新列。
 * 所以新增字段除了写进 schema.sql（新库直接建对），还得在这里 ALTER 一次。
 * SQLite 没有 `ADD COLUMN IF NOT EXISTS`，用 PRAGMA 查过再改。
 */
function ensureColumns(db) {
  const add = (table, col, ddl) => {
    let cols = []
    try {
      cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name)
    } catch (e) {
      return false
    }
    if (!cols.length || cols.includes(col)) return false
    try {
      db.exec(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`)
      return true
    } catch (e) {
      return false
    }
  }
  const added = []
  // 大作业：必交附件 / 收哪些扩展名（前端早就在读这两个字段，后端一直没给）
  if (add('assignments', 'require_file', 'require_file INTEGER NOT NULL DEFAULT 1')) added.push('assignments.require_file')
  if (add('assignments', 'attachments', "attachments TEXT NOT NULL DEFAULT ''")) added.push('assignments.attachments')

  // 登录失败表：学号、外部系统自报次数、老师手动禁用
  if (add('student_login_fails', 'sid', "sid TEXT NOT NULL DEFAULT ''")) added.push('student_login_fails.sid')
  if (add('student_login_fails', 'remote_count', 'remote_count INTEGER NOT NULL DEFAULT 0')) added.push('student_login_fails.remote_count')
  if (add('student_login_fails', 'remote_at', "remote_at TEXT NOT NULL DEFAULT ''")) added.push('student_login_fails.remote_at')
  if (add('student_login_fails', 'manual_blocked', 'manual_blocked INTEGER NOT NULL DEFAULT 0')) added.push('student_login_fails.manual_blocked')
  return added
}

/** 应用 schema.sql（幂等：全是 CREATE ... IF NOT EXISTS） */
export function applySchema(db) {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8')
  db.exec(sql)
  ensureColumns(db)
  const version = crypto.createHash('sha1').update(sql).digest('hex').slice(0, 12)
  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (version, applied_at, note) VALUES (?, ?, ?)`
  ).run(version, new Date().toISOString(), 'schema.sql')
  return version
}

/** 各表行数（迁移校验、自检都用它） */
export function tableCounts(db) {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name)
  const out = {}
  for (const t of tables) {
    out[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n
  }
  return out
}
