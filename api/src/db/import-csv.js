#!/usr/bin/env node
/*
 * db/import-csv.js —— 把旧的 CSV 数据搬进 SQLite
 *
 *   node src/db/import-csv.js           导入（库里已有数据会拒绝，除非 --force）
 *   node src/db/import-csv.js --force   先清空业务表再导入
 *   node src/db/import-csv.js --check   只校验（不写库）：CSV 有多少行、库里有多少行
 *
 * 为什么复用旧后端的 CsvTable：CSV 里的结构化字段不是 JSON，
 *   · dims    → "code=9;func=12"
 *   · files   → 用 paths 类型的分隔规则
 *   · bool    → "1"/"0"
 * 自己再写一遍解析，只会跟旧代码走偏；直接用它的 decode 最稳。
 * 旧 CSV **一个字节都不改**（只读），随时可以回滚到旧后端。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, applySchema, dataDir, dbPath, tableCounts } from './index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url)) // api/src/db
const ROOT = path.resolve(HERE, '..', '..', '..') // 课堂系统/

import { CsvTable } from './csv.js'
import { SCHEMA } from './schema.js'

const args = process.argv.slice(2)
const CHECK = args.includes('--check')
const FORCE = args.includes('--force')

/** camelCase → snake_case（DB 列名约定） */
const snake = (s) => s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())

/** 这些字段在 SQLite 里存 JSON 文本（旧的 map / files 类型） */
const JSON_COLUMNS = new Set(['dims', 'evidence', 'files', 'changed'])
/** 这些字段在 SQLite 里是 0/1 */
const BOOL_COLUMNS = new Set(['archived', 'late', 'voided', 'allowLate'])

const TABLES = ['courses', 'classes', 'students', 'events', 'rollcall', 'state', 'assignments', 'submissions']

function readCsvTable(name) {
  const file = path.join(dataDir(), name + '.csv')
  if (!fs.existsSync(file)) return { rows: [], file }
  const t = new CsvTable(file, SCHEMA[name])
  return { rows: t.all(), file }
}

/** 把解码后的对象转成 SQLite 能写的行（列名转 snake_case） */
function toRow(obj, cols) {
  const row = {}
  for (const col of cols) {
    let v = obj[col]
    if (JSON_COLUMNS.has(col)) {
      row[snake(col)] = v === undefined || v === null || v === '' ? null : JSON.stringify(v)
      continue
    }
    if (BOOL_COLUMNS.has(col)) {
      row[snake(col)] = v === true ? 1 : 0
      continue
    }
    if (v === undefined) row[snake(col)] = null
    else if (typeof v === 'number') row[snake(col)] = v
    else row[snake(col)] = String(v)
  }
  return row
}

function insertRows(db, table, rows) {
  if (!rows.length) return 0
  const columns = Object.keys(rows[0])
  const sql =
    `INSERT OR REPLACE INTO "${table}" (` +
    columns.map((c) => '"' + c + '"').join(', ') +
    ') VALUES (' +
    columns.map((c) => '@' + c).join(', ') +
    ')'
  const stmt = db.prepare(sql)
  db.transaction((list) => {
    for (const r of list) stmt.run(r)
  })(rows)
  return rows.length
}

const columnsOf = (name) => SCHEMA[name].map((c) => (typeof c === 'string' ? c : c.key))

/* ------------------------------- 主流程 ------------------------------- */

const db = openDb()
applySchema(db)

if (CHECK) {
  console.log('校验模式（不写库）\n')
  const live = tableCounts(db)
  let bad = 0
  console.log('  ' + '表'.padEnd(14) + 'CSV'.padStart(8) + 'SQLite'.padStart(9) + '   状态')
  for (const name of TABLES) {
    const { rows } = readCsvTable(name)
    const n = live[name] ?? 0
    const ok = rows.length === n
    if (!ok) bad++
    console.log(
      '  ' + name.padEnd(14) + String(rows.length).padStart(8) + String(n).padStart(9) + '   ' + (ok ? '一致 ✓' : '不一致 ✗')
    )
  }
  console.log(bad ? '\n有 ' + bad + ' 张表不一致' : '\n全部一致 ✓')
  db.close()
  process.exit(bad ? 1 : 0)
}

const live = tableCounts(db)
const nonEmpty = TABLES.filter((t) => (live[t] ?? 0) > 0)
if (nonEmpty.length && !FORCE) {
  console.error('库里已经有数据（' + nonEmpty.join(', ') + '）。')
  console.error('要重新导入就加 --force（会先清空这些表）')
  db.close()
  process.exit(1)
}
if (nonEmpty.length && FORCE) {
  db.pragma('foreign_keys = OFF')
  for (const t of TABLES) db.exec(`DELETE FROM "${t}"`)
  db.pragma('foreign_keys = ON')
  console.log('已清空业务表（' + nonEmpty.join(', ') + '）')
}

console.log('数据目录：' + dataDir())
console.log('目标库：' + dbPath() + '\n')

let total = 0
for (const name of TABLES) {
  const { rows, file } = readCsvTable(name)
  if (!fs.existsSync(file)) {
    console.log('  ' + name.padEnd(14) + '（没有 csv，跳过）')
    continue
  }
  const cols = columnsOf(name)
  const mapped = rows.map((r) => toRow(r, cols))
  let n = 0
  try {
    n = insertRows(db, name, mapped)
  } catch (e) {
    console.error('  ' + name.padEnd(14) + '写入失败：' + e.message)
    if (mapped[0]) console.error('    首行：' + JSON.stringify(mapped[0]).slice(0, 240))
    db.close()
    process.exit(1)
  }
  total += n
  console.log('  ' + name.padEnd(14) + n + ' 行')
}

const after = tableCounts(db)
let bad = 0
console.log('\n导入后核对：')
for (const name of TABLES) {
  const { rows } = readCsvTable(name)
  const n = after[name] ?? 0
  if (rows.length !== n) {
    bad++
    console.log('  ✗ ' + name + '：CSV ' + rows.length + ' 行 vs 库 ' + n + ' 行')
  }
}
console.log('共导入 ' + total + ' 行' + (bad ? '，但有 ' + bad + ' 张表不一致' : '，全部一致 ✓'))
db.close()
process.exit(bad ? 1 : 0)
