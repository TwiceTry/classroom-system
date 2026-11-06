/*
 * sheet.js —— 服务端读表格（.xlsx / .csv / 制表符文本）→ 二维数组 → 名单
 *
 * 为什么搬到服务端：
 *   前端那套（utils/xlsx.js + utils/roster.js）是为了「不联网也能解析」，代价是只读第一个 sheet、
 *   不认日期/合并单元格/公式，而且规则只能在前端维护。服务器有 Node 20 + 外网，可以用 exceljs
 *   读得干干净净；前端那份保留给「粘贴文本」这条不受影响的路径。
 *
 * 只做两件事：
 *   rowsOf(buffer|path)   表格 → 二维字符串数组
 *   rowsToRoster(rows)    二维数组 → { students, issues }（issues 带行号与原因，给老师看）
 */

/* ---------------- 1) 表格 → 二维数组 ---------------- */

/** CSV / 制表符文本 → 二维数组（带引号转义、BOM、CRLF 都认） */

import fs from 'fs'
import path from 'path'
import ExcelJS from 'exceljs'

function rowsFromText(text) {
  const src = String(text == null ? '' : text).replace(/^\ufeff/, '')
  // 有制表符就按制表符切（从 Excel 直接粘贴的常见形态），否则按逗号
  const delim = src.indexOf('\t') >= 0 && src.indexOf(',') < 0 ? '\t' : ','
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === delim) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      if (row.some((c) => String(c).trim() !== '')) rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => String(c).trim() !== '')) rows.push(row)
  return rows
}

/**
 * .xlsx → 二维字符串数组（读第一个工作表；日期转成 yyyy-mm-dd）
 *
 * 既收文件路径也收 Buffer：
 * 上传来的表格是收进内存的 Buffer，`readFile` 只认路径 ——
 * 传 Buffer 进去会报 `The "path" argument must be of type string. Received an instance of Buffer`。
 */
async function rowsFromXlsx(input) {
  const wb = new ExcelJS.Workbook()
  if (Buffer.isBuffer(input)) await wb.xlsx.load(input)
  else await wb.xlsx.readFile(input)
  const ws = wb.worksheets[0]
  if (!ws) return []
  const rows = []
  ws.eachRow({ includeEmpty: true }, (row) => {
    const cells = []
    const n = Math.max(row.cellCount || 0, row.values ? row.values.length - 1 : 0)
    for (let c = 1; c <= n; c++) {
      const v = row.getCell(c).value
      cells.push(cellText(v))
    }
    if (cells.some((x) => String(x).trim() !== '')) rows.push(cells)
  })
  return rows
}

/** 单元格值 → 字符串（文本 / 富文本 / 公式结果 / 日期 / 超链接都摊平） */
function cellText(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0')
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate())
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((x) => x.text).join('').trim()
    if (v.text != null) return String(v.text).trim()
    if (v.result != null) return cellText(v.result)
    if (v.hyperlink && v.text == null) return String(v.hyperlink)
  }
  return String(v).trim()
}

/**
 * 读一个上传的文件：按魔数判断（PK = xlsx(zip)，否则当文本）。
 *
 * 参数可以是文件路径，也可以是内存里的 Buffer（HTTP 上传走的就是 Buffer，
 * 不落临时文件）。原来的实现只认路径，老师上传 .xlsx 一律报
 * 「The "path" argument must be of type string」。
 *
 * @returns {Promise<{rows: Array<Array<string>>, kind: 'xlsx'|'text'}>}
 */
async function readUploaded(input) {
  const isBuf = Buffer.isBuffer(input)
  const data = isBuf ? input : fs.readFileSync(input)
  let kind = 'text'
  // 魔数优先：xlsx 本质是 zip，头两个字节是 "PK"
  if (data.length >= 2 && data.slice(0, 2).toString('latin1') === 'PK') kind = 'xlsx'
  else if (!isBuf && /\.xlsx$/i.test(path.extname(input))) {
    // 文件名说是 xlsx、内容却不是 —— 这种要明确报错，不能当文本读
    throw new Error('这个 .xlsx 文件读不出来（可能不是真正的 Excel 文件，或已损坏）')
  }
  if (kind === 'xlsx') return { rows: await rowsFromXlsx(data), kind }
  return { rows: rowsFromText(data.toString('utf8')), kind }
}

/* ---------------- 2) 二维数组 → 名单 ---------------- */

const SID_HEAD = /^(学号|学籍号|考生号|考号|工号|编号|学生id|student_?id|no\.?|id)$/i
const NAME_HEAD = /^(姓名|名字|考生姓名|学生姓名|人员姓名|成员姓名|名单)$/i
const NOT_NAME = /[0-9０-９]|班|学院|大学|专业|宿舍|小组|团队|公司|有限|中心|实验室/
const HAS_WORD = /[\u4e00-\u9fa5A-Za-z]/

const clean = (v) =>
  String(v == null ? '' : v)
    .replace(/[\r\n\t\u00a0\u3000]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const isSid = (v) => /^[A-Za-z0-9_-]{2,32}$/.test(clean(v))
const isName = (v) => {
  const s = clean(v)
  return !!s && s.length <= 20 && !NOT_NAME.test(s) && HAS_WORD.test(s)
}
/** 宽松的「像学号」：给没有表头的表用（至少 5 位数字） */
const looksSid = (v) => {
  const s = clean(v)
  return s.length >= 5 && s.length <= 24 && /^[A-Za-z0-9_-]+$/.test(s) && (s.match(/\d/g) || []).length >= 5
}

/**
 * 二维数组 → { students: [{sid,name}], issues: [{line,msg,raw}] }
 * 有表头就按列名取（最准）；没有就逐行启发式挑「像学号的」和「像人名的」。
 */
function rowsToRoster(rows) {
  const src = rows || []
  const issues = []

  let headRow = -1
  let sidCol = -1
  let nameCol = -1
  for (let i = 0; i < Math.min(src.length, 10); i++) {
    const row = src[i] || []
    let s = -1
    let n = -1
    for (let c = 0; c < row.length; c++) {
      const t = clean(row[c])
      if (s < 0 && SID_HEAD.test(t)) s = c
      if (n < 0 && NAME_HEAD.test(t)) n = c
    }
    if (n >= 0) {
      headRow = i
      sidCol = s
      nameCol = n
      break
    }
  }

  const students = []
  const seen = new Map()
  const start = headRow >= 0 ? headRow + 1 : 0

  for (let i = start; i < src.length; i++) {
    const row = src[i] || []
    const line = i + 1 // 表格行号（含表头），和老师在 Excel 里看到的一致
    const raw = row.map(clean).filter(Boolean).join(' | ').slice(0, 60)
    if (!row.some((c) => clean(c))) continue // 空行不是问题

    let sid = ''
    let name = ''
    if (headRow >= 0) {
      name = clean(row[nameCol])
      sid = sidCol >= 0 ? clean(row[sidCol]) : ''
      if (!sid) {
        // 没有学号列：在这一行里再找一次像学号的
        const hit = row.find((c, idx) => idx !== nameCol && looksSid(c))
        sid = clean(hit)
      }
      if (!name) {
        issues.push({ line, msg: '「姓名」列是空的', raw })
        continue
      }
      if (!isName(name)) {
        issues.push({ line, msg: '「姓名」列不像人名：' + name, raw })
        continue
      }
    } else {
      name = clean(row.find(isName))
      sid = clean(row.find(looksSid))
      if (!name) {
        issues.push({ line, msg: '这一行找不到姓名', raw })
        continue
      }
    }

    if (!isSid(sid)) {
      issues.push({ line, msg: '学号不对（读到「' + (sid || '空') + '」），请检查这一行', raw })
      continue
    }
    if (seen.has(sid)) {
      issues.push({ line, msg: '学号 ' + sid + ' 与第 ' + seen.get(sid) + ' 行重复', raw: name })
      continue
    }
    seen.set(sid, line)
    students.push({ sid, name, line })
  }

  return { students: students.map((s) => ({ sid: s.sid, name: s.name })), issues }
}

export { rowsFromText, rowsFromXlsx, readUploaded, rowsToRoster, cellText }