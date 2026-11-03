/*
 * parse-table.mjs —— 「表格 → 名单（学号 + 姓名）」的清洗与配对
 *
 * 为什么是 .mjs 而不是 .js：本页用 vue3-sfc-loader 在浏览器里现编译现跑，
 * 它把纯 .js 当「普通脚本」解析（不许出现 import / export），
 * 只有 .mjs 和 .ts 才按 ES 模块解析。改名前请先确认这一点。
 *
 * 解析分两级，先准后稳：
 *   1) 有表头 —— 在前 10 行里找到「姓名」列，就按列名取「学号列 + 姓名列」，最准；
 *   2) 没表头 —— 逐行启发式：各自挑「像姓名的格子」和「像学号的格子」。
 *
 * 现实里的名单表往往长这样：
 *   序号 | 学号       | 姓名 | 性别 | 班级
 *     1  | 2025010101 | 张三 |  男  | 软件1班
 * 所以要区分数值型的三列：序号（1~3 位）、学号（通常 6 位以上）、班级（含非数字）。
 */

/* ==================== 判定规则 ==================== */

// 表头关键词：学号列（不含「序号」，序号不是学号）
const SID_HEAD = /^(学号|学籍号|考生号|考号|工号|编号|学生id|student_?id|no\.?|id)$/i
// 表头关键词：姓名列（兼容教务表常见的「考生姓名 / 学生姓名 / 人员姓名」写法）
const NAME_HEAD =
  /^(姓名|名字|考生姓名|学生姓名|人员姓名|成员姓名|考生名字|学生名字|人员名字|名单)$/i

// 表头里常见的其它词 + 性别值：命中就丢掉
const HEADER_WORDS =
  /^(序号|编号|学号|工号|no\.?|id|姓名|名字|考生姓名|学生姓名|人员姓名|成员姓名|学生|人员|成员|名单|班级|专业|性别|备注|电话|手机|邮箱|成绩|组别|小组|岗位|状态|男|女|未知)$/i

// 一眼不像人名的：含数字（学号、班级番号如「软件1班」）、或班级 / 单位类词
const NOT_NAME = /[0-9０-９]|班|学院|大学|专业|宿舍|小组|团队|公司|有限|中心|教研室|实验室/

// 姓名里应该出现的字符：中文、字母
const HAS_WORD = /[\u4e00-\u9fa5A-Za-z]/

/** 去掉首尾空白、全角空格、单元格内换行 */
export function cleanName(value) {
  if (value == null) return ''
  return String(value)
    .replace(/[\r\n\t\u00a0\u3000]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 这一格「像不像一个姓名」 */
export function isNameLike(value) {
  const s = cleanName(value)
  if (!s) return false
  if (s.length > 24) return false
  if (HEADER_WORDS.test(s)) return false
  if (NOT_NAME.test(s)) return false
  return HAS_WORD.test(s)
}

/**
 * 这一格「像不像学号」：5~24 位，只含字母数字和 - _，且至少有 5 位数字。
 * 这样 2025010101、25soft001 会被认作学号，而序号 1~99、班级「软件1班」不会。
 */
export function isSidLike(value) {
  const s = cleanName(value)
  if (s.length < 5 || s.length > 24) return false
  if (!/^[A-Za-z0-9\-_]+$/.test(s)) return false
  return (s.match(/\d/g) || []).length >= 5
}

/* ==================== 逐格取值 ==================== */

function pickNameCell(row, skipCol) {
  for (let c = 0; c < row.length; c++) {
    if (c === skipCol) continue
    if (isNameLike(row[c])) return cleanName(row[c])
  }
  return ''
}

function pickSidCell(row, skipCol) {
  for (let c = 0; c < row.length; c++) {
    if (c === skipCol) continue
    if (isSidLike(row[c])) return cleanName(row[c])
  }
  return ''
}

/** 去重：有学号按学号，没学号按姓名 */
function dedupe(list) {
  const seen = new Set()
  const out = []
  for (const it of list) {
    const key = it.sid || it.name
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

/* ==================== 主流程 ==================== */

/**
 * 二维数组 → { list: [{sid,name}], issues: [{line,msg,raw}] }
 *
 * issues 是给老师看的：表格里哪些行被跳过了、为什么。空行不算问题。
 */
export function rowsToRosterDetailed(rows) {
  const src = rows || []

  // 1) 先找表头行：前 10 行里，哪一行能同时看出「姓名」列
  let headRow = -1
  let sidCol = -1
  let nameCol = -1
  for (let i = 0; i < Math.min(src.length, 10); i++) {
    const row = src[i] || []
    let s2 = -1
    let n = -1
    for (let c = 0; c < row.length; c++) {
      const t = cleanName(row[c])
      if (s2 < 0 && SID_HEAD.test(t)) s2 = c
      if (n < 0 && NAME_HEAD.test(t)) n = c
    }
    if (n >= 0) {
      headRow = i
      sidCol = s2
      nameCol = n
      break
    }
  }

  const list = []
  const issues = []
  const start = headRow >= 0 ? headRow + 1 : 0

  for (let i = start; i < src.length; i++) {
    const row = src[i] || []
    const line = i + 1 // 表格里的行号（从 1 算，含表头）
    const raw = row.map((c) => cleanName(c)).filter(Boolean).join(' | ').slice(0, 60)
    if (!row.some((c) => cleanName(c))) continue // 整行空白：不是问题

    let name = ''
    let sid = ''

    if (headRow >= 0) {
      name = cleanName(row[nameCol])
      sid = sidCol >= 0 ? cleanName(row[sidCol]) : pickSidCell(row, nameCol)
      if (!name) {
        issues.push({ line, msg: '「姓名」列是空的', raw })
        continue
      }
      if (!isNameLike(name)) {
        issues.push({ line, msg: '「姓名」列不像人名：' + name, raw })
        continue
      }
    } else {
      name = pickNameCell(row, -1)
      sid = pickSidCell(row, -1)
      if (!name) {
        issues.push({ line, msg: '这一行找不到姓名', raw })
        continue
      }
    }

    if (!isSidLike(sid)) {
      issues.push({ line, msg: '学号不对（读到「' + (sid || '空') + '」），请检查这一行', raw })
      continue
    }

    list.push({ sid, name, line })
  }

  // 同一份表里学号重复：保留第一条，后面的报出来
  const seen = new Map()
  const out = []
  for (const it of list) {
    if (seen.has(it.sid)) {
      issues.push({ line: it.line, msg: '学号 ' + it.sid + ' 与第 ' + seen.get(it.sid) + ' 行重复', raw: it.name })
      continue
    }
    seen.set(it.sid, it.line)
    out.push({ sid: it.sid, name: it.name })
  }

  return { list: out, issues }
}

/** 二维数组 → [{ sid, name }]（不关心问题清单时的简单版） */
export function rowsToRoster(rows) {
  return rowsToRosterDetailed(rows).list
}

/**
 * 纯文本 → 二维数组
 * 依据「这一行有没有列分隔符」分三种情况：
 *   A. 有制表符 / 逗号 / 分号 / 顿号 —— 从表格复制的，一行 = 一条记录的多个列（如 "1,2025010101,张三"）；
 *   B. 只有空格，但里面出现了「像学号」的词 —— 视作「学号 姓名」，整行作为一条记录保留配对关系；
 *   C. 只有空格、没有学号 —— 手打的多个名字，按空白拆开，每个词各算一个人
 *      （这样 "张三 李四 王五" 能出 3 个人，而不是只出第一个）。
 */
export function textToRows(text) {
  const out = []
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')

  for (const line of lines) {
    if (!line.trim()) continue
    if (line.indexOf('\t') >= 0) {
      out.push(line.split('\t'))
      continue
    }
    if (/[,，;；、]/.test(line)) {
      out.push(line.split(/[,，;；、]/))
      continue
    }
    const tokens = line.trim().split(/\s+/)
    if (tokens.length > 1 && tokens.some((t) => isSidLike(t))) out.push(tokens)
    else for (const t of tokens) out.push([t])
  }
  return out
}

/** 纯文本 → [{ sid, name }]（一步到位） */
export function textToRoster(text) {
  return rowsToRoster(textToRows(text))
}
