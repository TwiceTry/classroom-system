/* 按《课程包格式规范》检查一个课程目录 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = process.argv[2] || 'web前端框架开发'
const ABS = path.resolve(ROOT)

let pass = 0, warn = 0, fail = 0
const ok = (n, d) => { pass++; console.log('  ✓ ' + n + (d ? '  → ' + d : '')) }
const wa = (n, d) => { warn++; console.log('  ! ' + n + (d ? '  → ' + d : '')) }
const no = (n, d) => { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')) }

/* 规范里的白名单（pack.json 的 contentRoots） */
const CONTENT_ROOTS = ['lecture', 'materials', '代码示例', 'exams', 'assets']

const exists = (p) => fs.existsSync(path.join(ABS, p))
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ABS, p), 'utf8').replace(/^\uFEFF/, ''))

const walk = (dir, rel = '') => {
  const out = []
  let items = []
  try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return out }
  for (const e of items) {
    const p = path.join(dir, e.name)
    const r = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) out.push(...walk(p, r))
    else if (e.isFile()) out.push({ rel: r, size: fs.statSync(p).size })
  }
  return out
}

console.log('=== 检查目录：' + ROOT + ' ===')
console.log('')

/* ---------- 1. 清单与配置文件 ---------- */
console.log('【1】清单与配置文件')
if (exists('pack.json')) {
  try {
    const pk = readJson('pack.json')
    ok('有 pack.json')
    ok('format', pk.format)
    ok('version = 1', String(pk.version) === '1' ? '1' : '⚠ ' + pk.version)
    ok('files[] 登记 ' + (pk.files || []).length + ' 条', '')
  } catch (e) {
    no('pack.json 不是合法 JSON', e.message)
  }
} else {
  no('没有 pack.json', '这是课程包里必须有的清单（记录每个文件的 sha256）')
}

let course = null
if (exists('course.json')) {
  try {
    course = readJson('course.json')
    ok('有 course.json')
    const idOk = /^[a-z0-9-]{2,40}$/.test(String(course.id || ''))
    idOk ? ok('course.id 合法', course.id) : no('course.id 不合法', String(course.id) + '（要求 2–40 位小写字母/数字/短横线）')
    course.name ? ok('有 course.name', course.name) : no('缺 course.name')
  } catch (e) {
    no('course.json 不是合法 JSON', e.message)
  }
} else {
  no('没有 course.json', '必填：课程 id 与名称')
}

if (exists('scheme.json')) {
  try {
    const sc = readJson('scheme.json')
    const sum = (sc.items || []).reduce((s, it) => s + (Number(it.full) || 0), 0)
    ok('有 scheme.json（可选）', (sc.items || []).length + ' 项 · 合计 ' + sum + ' / totalFull ' + sc.totalFull)
    if (Number(sc.totalFull) && Math.abs(sum - Number(sc.totalFull)) > 0.01) {
      wa('各段合计与 totalFull 不一致', sum + ' vs ' + sc.totalFull + '（规范里算「提示」，能导入）')
    }
  } catch (e) {
    no('scheme.json 不是合法 JSON', e.message)
  }
} else {
  wa('没有 scheme.json（可选）', '导入后课程不绑方案，之后可以在「考核方案」页建')
}

/* ---------- 2. 内容目录层 ---------- */
console.log('')
console.log('【2】内容目录（规范要求内容放在 content/ 下）')
const declared = course && course.content ? String(course.content).replace(/\/+$/, '') : ''
if (exists('content')) {
  ok('有 content/ 目录')
  const top = fs.readdirSync(path.join(ABS, 'content'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  const bad = top.filter((n) => !CONTENT_ROOTS.includes(n))
  bad.length ? no('content/ 下有白名单外的目录', bad.join(', ') + '（允许：' + CONTENT_ROOTS.join(' / ') + '）') : ok('content/ 下的顶层目录都在白名单里', top.join(', '))
} else {
  no('没有 content/ 目录', declared ? '而 course.json 里写的是 "' + declared + '/"' : '')
  const loose = fs.readdirSync(ABS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  const inRoot = loose.filter((n) => CONTENT_ROOTS.includes(n))
  if (inRoot.length) {
    console.log('     实际上内容裸露在根目录：' + inRoot.join(', '))
    console.log('     → 需要把它们移进 content/ 才符合规范')
  }
}

/* ---------- 3. 白名单外的目录 ---------- */
console.log('')
console.log('【3】顶层目录盘点')
const dirs = fs.readdirSync(ABS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
for (const d of dirs) {
  const n = walk(path.join(ABS, d)).length
  if (CONTENT_ROOTS.includes(d)) console.log('     · ' + d.padEnd(16) + n + ' 个文件（白名单内）')
  else if (d === 'classes' || d === 'content') console.log('     · ' + d.padEnd(16) + n + ' 个文件（结构目录）')
  else {
    wa('顶层有白名单外的目录：' + d, n + ' 个文件')
  }
}

/* ---------- 4. 班级与名单 ---------- */
console.log('')
console.log('【4】班级与名单')
if (exists('classes/index.json')) {
  try {
    const idx = readJson('classes/index.json')
    const list = idx.classes || idx.items || []
    ok('有 classes/index.json', list.length + ' 个班')
    let total = 0
    const seen = new Map()
    for (const c of list) {
      const f = String(c.roster || c.file || '').replace(/^classes\//, '')
      const p = path.join(ABS, 'classes', f)
      if (!fs.existsSync(p)) { no('班级「' + (c.name || c.id) + '」的名单文件不存在', f); continue }
      const lines = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((x) => x.trim())
      const rows = Math.max(0, lines.length - 1) // 去表头
      total += rows
      console.log('     · ' + String(c.name || c.id).padEnd(22) + rows + ' 人  (' + f + ')')
      // 学号跨班重复
      for (const ln of lines.slice(1)) {
        const sid = ln.split(',')[0].replace(/^"|"$/g, '').trim()
        if (!sid) continue
        if (seen.has(sid)) no('学号 ' + sid + ' 同时出现在「' + seen.get(sid) + '」和「' + (c.name || c.id) + '」', '规范里这是硬报错')
        else seen.set(sid, c.name || c.id)
      }
    }
    ok('名单总人数', String(total))
  } catch (e) {
    no('classes/index.json 有问题', e.message)
  }
} else {
  wa('没有 classes/（可选）', '课程包里可以不带班级；导入后自己建班、导名单')
}

/* ---------- 5. 体积与安全 ---------- */
console.log('')
console.log('【5】体积与安全')
const all = walk(ABS)
const totalBytes = all.reduce((s, f) => s + f.size, 0)
const big = all.filter((f) => f.size > 100 * 1024 * 1024)
console.log('     文件总数 ' + all.length + '（上限 20000）')
console.log('     总体积 ' + (totalBytes / 1024 / 1024).toFixed(1) + ' MB（上限 500MB）')
all.length > 20000 ? no('文件数超限') : ok('文件数在限内', String(all.length))
totalBytes > 500 * 1024 * 1024 ? no('整包超 500MB') : ok('整包体积在限内', (totalBytes / 1024 / 1024).toFixed(1) + ' MB')
big.length ? no('有单文件超 100MB', big.map((f) => f.rel + ' ' + (f.size / 1024 / 1024).toFixed(0) + 'MB').join(', ')) : ok('没有单文件超 100MB')

const badPath = all.filter((f) => f.rel.includes('..') || path.isAbsolute(f.rel))
badPath.length ? no('有不安全路径', badPath.map((f) => f.rel).join(', ')) : ok('没有 .. / 绝对路径')

/* ---------- 6. 根级散文档 ---------- */
console.log('')
console.log('【6】根目录散落的文件')
const rootFiles = fs.readdirSync(ABS, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ name: e.name, size: fs.statSync(path.join(ABS, e.name)).size }))
const keep = ['course.json', 'scheme.json', 'pack.json', 'README.txt']
const stray = rootFiles.filter((f) => !keep.includes(f.name))
for (const f of rootFiles) console.log('     · ' + f.name.padEnd(34) + (f.size / 1024).toFixed(1) + ' KB' + (keep.includes(f.name) ? '' : '  ← 不在规范里'))
if (stray.length) wa('有 ' + stray.length + ' 个文件不在规范规定的位置', '课程包里根目录只应有 course.json / scheme.json / pack.json / classes/ / content/ / README.txt')

/* ---------- 汇总 ---------- */
console.log('')
console.log('=== 汇总：通过 ' + pass + ' · 提示 ' + warn + ' · 报错 ' + fail + ' ===')
if (fail > 0) console.log('按规范，这份目录**现在不能作为课程包导入**。')
