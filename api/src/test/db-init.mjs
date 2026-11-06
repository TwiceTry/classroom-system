/*
 * db-init.mjs —— 空库必须能自己建表
 *
 * 起因：Docker 用空数据卷启动时，teach.db 是个空文件，
 * 第一个查询就 `SqliteError: no such table: courses`。
 * 因为 applySchema 以前只有 migrate.js 会调，server.js 启动时不建表。
 * 本地一直没暴露，是 data/teach.db 从 CSV 迁移过来、表早就在。
 *
 * 这个测试就是替「新机器第一次启动」站岗：拿一个不存在的路径开库，
 * 不跑任何迁移命令，直接查表。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, tableCounts, dbPath } from '../db/index.js'

let pass = 0
let fail = 0
function ok(label, cond, detail) {
  if (cond) {
    pass++
    console.log('  ✓ ' + label + (detail ? '  → ' + detail : ''))
  } else {
    fail++
    console.log('  ✗ ' + label + (detail ? '  → ' + detail : ''))
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-dbinit-'))
const tmpDb = path.join(tmpDir, 'fresh.db')

try {
  console.log('=== 1. 全新空库（模拟容器第一次启动）===')
  ok('数据库文件一开始不存在', !fs.existsSync(tmpDb), tmpDb.endsWith('fresh.db'))

  const db = openDb(tmpDb)
  ok('openDb 没有抛异常', true)

  const counts = tableCounts(db)
  const names = Object.keys(counts)
  ok('建出了 ' + names.length + ' 张表', names.length > 0, names.slice(0, 6).join(',') + '…')

  for (const t of ['courses', 'classes', 'students', 'events', 'state']) {
    ok('表 ' + t + ' 存在', names.includes(t))
  }

  console.log('\n=== 2. 关键查询立刻可用（原来就是这里炸的）===')
  const q = (sql) => {
    try {
      return db.prepare(sql).all()
    } catch (e) {
      return e.code + ': ' + e.message
    }
  }
  const r1 = q('SELECT * FROM courses')
  ok('SELECT * FROM courses 不报 no such table', Array.isArray(r1), Array.isArray(r1) ? r1.length + ' 行' : String(r1))
  const r2 = q('SELECT * FROM state')
  ok('SELECT * FROM state 正常', Array.isArray(r2), Array.isArray(r2) ? r2.length + ' 行' : String(r2))

  console.log('\n=== 3. 空库上能直接插入数据 ===')
  const now = new Date().toISOString()
  let wrote = false
  try {
    db.prepare('INSERT INTO courses (id, name, archived, created_at) VALUES (?,?,?,?)').run('c1', '测试课程', 0, now)
    wrote = true
  } catch (e) {
    console.log('      写入失败：' + e.message)
  }
  ok('插入一门课程', wrote)
  const c = wrote ? db.prepare('SELECT name FROM courses WHERE id = ?').get('c1') : null
  ok('读回来内容正确', !!c && c.name === '测试课程', c ? c.name : '(无)')

  console.log('\n=== 4. schema_migrations 有记录 ===')
  // 要在 close 之前查，否则拿到的是「连接已关闭」
  const v = q('SELECT COUNT(*) n FROM schema_migrations')
  ok('schema_migrations 可查询', Array.isArray(v), Array.isArray(v) ? v[0].n + ' 条' : String(v))

  console.log('\n=== 5. 再开一次是幂等的（服务重启不会报错）===')
  db.close()
  let again = null
  let err = ''
  try {
    again = openDb(tmpDb)
  } catch (e) {
    err = e.message
  }
  ok('重复 openDb 不抛异常', !err && !!again, err || 'ok')
  if (again) {
    const row = again.prepare('SELECT name FROM courses WHERE id = ?').get('c1')
    ok('已有数据没被清掉', !!row && row.name === '测试课程', row ? row.name : '(丢了)')
    const c2 = tableCounts(again)
    ok('表还在（没被 DROP 重建）', Object.keys(c2).length > 0)
    again.close()
  }

} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch (e) {
    /* 清理失败不影响结论 */
  }
}

console.log('\n' + (fail === 0 ? '全部通过 ✓' : '有 ' + fail + ' 项失败 ✗') + '（通过 ' + pass + ' · 失败 ' + fail + '）')
process.exit(fail === 0 ? 0 : 1)
