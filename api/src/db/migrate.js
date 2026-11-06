#!/usr/bin/env node
/*
 * db/migrate.js —— 建库（应用 schema.sql）
 *
 *   node src/db/migrate.js           建库/升级（幂等）
 *   node src/db/migrate.js --drop    先删掉所有业务表再建（危险，仅开发用）
 */
import fs from 'node:fs'
import { openDb, dbPath, applySchema, tableCounts, dataDir } from './index.js'

const drop = process.argv.includes('--drop')
const db = openDb()

if (drop) {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((r) => r.name)
  db.pragma('foreign_keys = OFF')
  for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t}"`)
  db.pragma('foreign_keys = ON')
  console.log('已删掉 ' + tables.length + ' 张表')
}

const version = applySchema(db)
console.log('数据库：' + dbPath())
console.log('schema 版本：' + version)
console.log('数据目录：' + dataDir())
const counts = tableCounts(db)
console.log('\n各表行数：')
for (const [t, n] of Object.entries(counts)) {
  if (t === 'schema_migrations') continue
  console.log('  ' + t.padEnd(18) + n)
}
if (fs.existsSync(dbPath())) {
  const size = fs.statSync(dbPath()).size
  console.log('\n文件大小：' + (size / 1024).toFixed(1) + ' KB')
}
db.close()
