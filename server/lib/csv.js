'use strict'
/*
 * csv.js —— CSV 存储基础工具（零依赖）
 *
 * 为什么用 CSV 当数据库：数据要进 git。JSON 一行几万字，改一个分数就是一整行 diff；
 * CSV 一行一条记录，`git diff` 能直接看出「谁的分变了」。顺带的好处是老师能用任何
 * 编辑器打开、用 Excel 另存分析。
 *
 * 这个文件只干三件事：
 *   1) parse / stringify —— 严格按 RFC 4180 处理引号、逗号、换行（包括单元格里的换行）；
 *   2) 列类型编解码 —— 数字、布尔、map（dims）、文件列表（evidence）四个小转换，
 *      让 CSV 里看到的是人话，内存里拿到的是 JS 类型；
 *   3) CsvTable —— 一张表的内存视图 + 增删改查 + 原子落盘（.tmp → rename）。
 *
 * 格式约定（有意为之，改动前先想清楚 git diff）：
 *   - UTF-8 无 BOM、LF 换行：BOM 和 CRLF 会让同一份数据在不同机器上互相「改行」；
 *   - 列名固定写在第一行，顺序由 schema 决定，不随数据漂移；
 *   - 空单元格 = 该字段没有值（不是空字符串）；
 *   - 写入前由调用方排序，保证同样的数据永远序列化成同样的文本 —— 没变化就不产生 diff。
 *
 * 注意：不要让 Excel 直接「保存」这些文件。Excel 会重写整个文件（加 BOM、改列宽、
 * 把数字变成 1.0E+11），一次保存就是全文件 diff。要核对数据请用「导出 CSV」。
 */
const fs = require('fs')
const path = require('path')

/* ==================== 解析 / 序列化 ==================== */

function parse(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text // 容忍别人存进来的 BOM
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < src.length) {
    const ch = src[i]

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\r') {
      i++ // 兼容 CRLF：\r 直接跳过，靠 \n 收行
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }

    field += ch
    i++
  }

  row.push(field)
  rows.push(row)

  // 末尾空行（文件以 \n 结尾时必然产生）不算一条记录
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop()
  return rows
}

function cellText(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

function escapeCell(value) {
  const s = cellText(value)
  // 含逗号 / 引号 / 换行（含单元格内换行）才需要包起来
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function stringifyGrid(rows) {
  return rows.map((r) => r.map(escapeCell).join(',')).join('\n') + '\n'
}

/* ==================== 列类型 ==================== */

const TYPES = {
  string: {
    encode: (v) => cellText(v),
    decode: (raw) => raw,
  },
  text: {
    encode: (v) => cellText(v),
    decode: (raw) => raw,
  },
  number: {
    encode: (v) => (v === null || v === undefined || v === '' ? '' : String(v)),
    decode: (raw) => {
      if (raw === '') return undefined
      const n = Number(raw)
      return isFinite(n) ? n : undefined
    },
  },
  bool: {
    encode: (v) => (v === true ? '1' : v === false ? '0' : ''),
    decode: (raw) => raw === '1' || raw.toLowerCase() === 'true',
  },
  // dims: { func: 12, code: 9 } ↔ "code=9;func=12"（键排序，保证同样的数据写出同样的文本）
  map: {
    encode: (v) => {
      if (!v || typeof v !== 'object') return ''
      return Object.keys(v)
        .filter((k) => v[k] !== '' && v[k] !== null && v[k] !== undefined)
        .sort()
        .map((k) => k + '=' + v[k])
        .join(';')
    },
    decode: (raw) => {
      const out = {}
      if (!raw) return out
      for (const part of raw.split(';')) {
        if (!part) continue
        const at = part.indexOf('=')
        if (at < 0) continue
        const key = part.slice(0, at)
        const val = Number(part.slice(at + 1))
        out[key] = isFinite(val) ? val : part.slice(at + 1)
      }
      return out
    },
  },
  // paths: ['src/App.vue','src/main.js'] ↔ "src/App.vue|src/main.js"（课堂作业提交的文件清单）
  // 用 | 分隔：Windows 文件名里不允许出现 |，不会歧义；同时一格里看得清交了哪些文件。
  paths: {
    encode: (v) => {
      if (!Array.isArray(v) || !v.length) return ''
      return v
        .map((p) => String(p == null ? '' : p).replace(/\|/g, '_'))
        .filter((s) => s !== '')
        .join('|')
    },
    decode: (raw) => (raw ? raw.split('|').filter((s) => s !== '') : []),
  },
  // evidence: [{name,url}] ↔ "作业截图.png|/uploads/xxx-作业截图.png;…"
  files: {
    encode: (v) => {
      if (!Array.isArray(v) || !v.length) return ''
      return v
        .map((f) => String(f.name || '').replace(/[|;]/g, '_') + '|' + String(f.url || ''))
        .join(';')
    },
    decode: (raw) => {
      if (!raw) return []
      const out = []
      for (const part of raw.split(';')) {
        if (!part) continue
        const at = part.indexOf('|')
        if (at < 0) {
          out.push({ name: decodeURIComponent(part.split('/').pop() || ''), url: part })
          continue
        }
        out.push({ name: part.slice(0, at), url: part.slice(at + 1) })
      }
      return out
    },
  },
}

/* ==================== 表 ==================== */

class CsvTable {
  /**
   * @param {string} file 绝对路径
   * @param {Array} columns [{ key, type }]，顺序即列顺序
   */
  constructor(file, columns) {
    this.file = file
    this.columns = columns.map((c) => (typeof c === 'string' ? { key: c, type: 'string' } : Object.assign({ type: 'string' }, c)))
    this.rows = []
    this.loadedText = ''
    this.load()
  }

  /**
   * 表头第一列必须是我这张表的第一列。
   *
   * 用来分辨「文件是空的/截断的」和「文件其实是别的表 / 编码变了」：
   * 最常见的坏法是老师用 Excel 或记事本打开 csv 再保存，
   * 编码从 UTF-8 变成 GBK/UTF-16 —— 解析不报错，但表头全是乱码，
   * 于是每一列都取不到值、整张表「看起来空了」。那种情况绝不能静默吞掉。
   */
  looksLikeMine(headerCells) {
    const keys = new Set(this.columns.map((c) => c.key))
    const cells = (headerCells || [])
      .map((h) => String(h).replace(/^\uFEFF/, '').trim())
      .filter((h) => h !== '')
    if (!cells.length) return false
    // 第一列必须对得上（列顺序是本系统写的，不会变）
    const first = this.columns[0] && this.columns[0].key
    if (first && cells[0] !== first) return false
    // 而且**每个表头都必须是本表的列名**：
    //   编码变了（GBK/UTF-16）→ 全是乱码，一个都对不上
    //   写到一半被截断 → 末尾是半个列名，对不上
    //   被别的表覆盖了 → 列名是别人的，对不上
    for (const h of cells) if (!keys.has(h)) return false
    return true
  }

  /** 读文本；文件不存在返回 null（真出错也返回 null，但要留一行日志） */
  readTextOrNull(file) {
    try {
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    } catch (e) {
      console.error('[csv] 读不出来：' + file + ' · ' + e.message)
      return null
    }
  }

  /** 文本 → 网格；「不像这张表」一律返回 null（调用方据此决定留证 / 恢复） */
  gridOf(text) {
    if (text == null) return null
    if (!text.trim()) return { text, grid: [] } // 空文件 = 空表，正常
    let g = null
    try {
      g = parse(text)
    } catch (e) {
      g = null
    }
    if (!g || !g.length || !this.looksLikeMine(g[0])) return null
    return { text, grid: g }
  }

  load() {
    const tmpFile = this.file + '.tmp'
    const mainText = this.readTextOrNull(this.file)

    // 上一次写入被打断时，.tmp 会留下来（正常流程里它写完就被改名成主文件了）。
    // 那种情况下 .tmp 可能是「完整的新版」，而主文件是「旧版」或「写到一半的」——
    // 两个都解析，挑更完整的那个。
    let main = this.gridOf(mainText)
    const tmp = this.gridOf(this.readTextOrNull(tmpFile))
    if (tmp && (!main || tmp.grid.length > main.grid.length)) {
      console.error('[csv] 上次写入没走完，改用 .tmp 恢复：' + tmpFile)
      main = tmp
      try {
        fs.renameSync(tmpFile, this.file)
      } catch (e) {
        /* 改不动也无所谓：内容已经在内存里了 */
      }
    } else if (fs.existsSync(tmpFile)) {
      // .tmp 没比主文件好（说明主文件是完整的）→ 清掉这个垃圾，别留着让人误会
      try {
        fs.unlinkSync(tmpFile)
      } catch (e) {
        /* ignore */
      }
    }

    if (!main) {
      // 主文件在、但内容不是这张表（编码变成了 GBK/UTF-16、写到一半被截断、
      // 或者被别的文件覆盖了）。**不能静默当空表** —— 那等于数据无声消失。
      if (mainText && mainText.trim()) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const bad = this.file + '.broken-' + stamp
        try {
          fs.renameSync(this.file, bad)
          console.error('[csv] 内容不像这张表，已改名留证：' + bad)
        } catch (e) {
          console.error('[csv] 内容不像这张表，改名失败：' + this.file + ' · ' + e.message)
        }
      }
      this.rows = []
      this.loadedText = ''
      return
    }

    this.loadedText = main.text
    const grid = main.grid
    if (!grid.length) {
      this.rows = []
      return
    }

    const header = grid[0].map((h) => h.trim())
    const rows = []
    for (let i = 1; i < grid.length; i++) {
      const cells = grid[i]
      if (!cells.length) continue
      const obj = {}
      let allEmpty = true
      for (const col of this.columns) {
        const idx = header.indexOf(col.key)
        const raw = idx >= 0 && idx < cells.length ? cells[idx].trim() : ''
        if (raw !== '') allEmpty = false
        const type = TYPES[col.type] || TYPES.string
        obj[col.key] = type.decode(raw)
      }
      if (!allEmpty) rows.push(obj)
    }
    this.rows = rows
  }

  serialize() {
    const header = this.columns.map((c) => c.key)
    const lines = [header]
    for (const row of this.rows) {
      lines.push(
        this.columns.map((col) => {
          const type = TYPES[col.type] || TYPES.string
          return type.encode(row[col.key])
        })
      )
    }
    return stringifyGrid(lines)
  }

  /**
   * 写入磁盘：内容没变就不碰文件（避免无意义的 mtime 变化和 diff）。
   *
   * 原子替换的完整动作是三步，缺一步都不算安全：
   *   1) 写临时文件
   *   2) **fsync** —— 让内容真的落到盘上（只 write 的话，
   *      断电时可能「rename 成功了、内容还在系统缓存里」→ 得到一个空文件）
   *   3) rename 覆盖主文件 —— 同一磁盘上的改名是原子的，
   *      所以任何时刻读到的都是「完整的旧版」或「完整的新版」，不会是半截
   */
  save() {
    const text = this.serialize()
    if (text === this.loadedText) return false
    const dir = path.dirname(this.file)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const tmp = this.file + '.tmp'
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, text, 'utf8')
      try {
        fs.fsyncSync(fd)
      } catch (e) {
        /* 某些文件系统（网络盘/虚拟盘）不支持 fsync，忽略 */
      }
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, this.file)
    this.loadedText = text
    return true
  }

  /* ---------- 增删改查 ---------- */

  all() {
    return this.rows
  }

  find(pred) {
    return this.rows.find(pred) || null
  }

  filter(pred) {
    return this.rows.filter(pred)
  }

  insert(obj) {
    this.rows.push(obj)
    return obj
  }

  /** 返回被改动的行数 */
  update(pred, patch) {
    let n = 0
    for (const row of this.rows) {
      if (!pred(row)) continue
      Object.assign(row, typeof patch === 'function' ? patch(row) : patch)
      n++
    }
    return n
  }

  /** 返回删掉的行数 */
  remove(pred) {
    const before = this.rows.length
    this.rows = this.rows.filter((row) => !pred(row))
    return before - this.rows.length
  }

  clear() {
    this.rows = []
  }

  /** 排序后再写：保证同样的数据序列化成同样的文本 */
  sortBy(fn) {
    this.rows.sort(fn)
    return this.rows
  }
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

module.exports = { parse, stringifyGrid, escapeCell, CsvTable, TYPES, byText }
