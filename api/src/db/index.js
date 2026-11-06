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
  return db
}

/** 应用 schema.sql（幂等：全是 CREATE ... IF NOT EXISTS） */
export function applySchema(db) {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8')
  db.exec(sql)
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
