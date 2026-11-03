/*
 * xlsx.mjs —— 极简 .xlsx 读取器（零依赖、纯浏览器、离线可用）
 *
 * 为什么是 .mjs 而不是 .js：vue3-sfc-loader 把纯 .js 当「普通脚本」解析
 * （不许出现 import / export），只有 .mjs 和 .ts 才按 ES 模块解析。
 *
 * 为什么能这么写：.xlsx 其实就是一个 ZIP 包，里面是几个 XML：
 *   xl/sharedStrings.xml        所有字符串放在这里（单元格里只存下标）
 *   xl/worksheets/sheet1.xml    第一个工作表的行列数据
 * 所以只要会「解 ZIP + 解析 XML」，就能把表格读成二维数组。
 *
 * 只做「把第一个工作表读成二维数组」这一件事，够用即止。
 * 老版 .xls（BIFF 二进制）不在这里处理，提示用户另存为 .xlsx 或 .csv。
 */

const decoder = new TextDecoder('utf-8')

/* ==================== ZIP ==================== */

/** 从文件尾部往回找 ZIP 的「中央目录结束标记」 */
function findEOCD(dv) {
  const limit = Math.min(dv.byteLength, 66000)
  for (let i = dv.byteLength - 22; i >= dv.byteLength - limit && i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) return i
  }
  throw new Error('不是有效的 .xlsx（没找到 ZIP 目录），可能文件已损坏')
}

/** 解开 ZIP，返回 { 条目名: { method, raw } } */
function unzip(buf) {
  const dv = new DataView(buf)
  const eocd = findEOCD(dv)
  const total = dv.getUint16(eocd + 10, true)
  let off = dv.getUint32(eocd + 16, true)
  const entries = {}

  for (let i = 0; i < total; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break // 中央目录条目签名
    const method = dv.getUint16(off + 10, true) // 0=存储 8=deflate
    const compSize = dv.getUint32(off + 20, true)
    const nameLen = dv.getUint16(off + 28, true)
    const extraLen = dv.getUint16(off + 30, true)
    const cmtLen = dv.getUint16(off + 32, true)
    const localOff = dv.getUint32(off + 42, true)
    const name = decoder.decode(new Uint8Array(buf, off + 46, nameLen))

    // 本地头里的名字/扩展字段长度可能和中央目录不同，必须按本地头算偏移
    const lNameLen = dv.getUint16(localOff + 26, true)
    const lExtraLen = dv.getUint16(localOff + 28, true)
    const start = localOff + 30 + lNameLen + lExtraLen

    entries[name] = { method, raw: new Uint8Array(buf, start, compSize) }
    off += 46 + nameLen + extraLen + cmtLen
  }
  return entries
}

/** 取出某个条目并解压成文本 */
async function readEntry(entry) {
  if (!entry) return ''
  if (entry.method === 0) return decoder.decode(entry.raw)
  if (entry.method !== 8) throw new Error('这个表格用了不支持的压缩方式，请在 Excel 里另存为 .csv 再导入')
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器不支持解压 .xlsx，请在 Excel 里另存为 .csv 再导入')
  }
  const stream = new Blob([entry.raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return await new Response(stream).text()
}

/* ==================== XML ==================== */

function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&') // 必须最后替换
}

/** sharedStrings.xml → ['张三', '男', ...] */
function parseSharedStrings(xml) {
  const out = []
  if (!xml) return out
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g
  let m
  while ((m = siRe.exec(xml))) {
    const body = m[1] || ''
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let n
    let text = ''
    while ((n = tRe.exec(body))) text += n[1]
    out.push(decodeXml(text))
  }
  return out
}

/** 'C7' → 2（列下标，从 0 开始） */
function columnIndex(ref) {
  const m = /^([A-Z]+)/.exec(String(ref || '').toUpperCase())
  if (!m) return -1
  let n = 0
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** 工作表 XML → 二维数组 */
function parseSheet(xml, shared) {
  const rows = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let rm
  while ((rm = rowRe.exec(xml))) {
    const cells = []
    const cRe = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g
    let cm
    let auto = 0 // 单元格没写 r="A1" 时按顺序排
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1] || cm[2] || ''
      const body = cm[3] || ''
      const refMatch = /r="([A-Z]+\d+)"/.exec(attrs)
      const idx = refMatch ? columnIndex(refMatch[1]) : auto
      const col = idx >= 0 ? idx : auto
      auto = col + 1

      const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || ''
      let value = ''
      if (type === 'inlineStr') {
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
        let tm
        while ((tm = tRe.exec(body))) value += tm[1]
        value = decodeXml(value)
      } else {
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)
        const raw = vm ? vm[1] : ''
        value = type === 's' ? shared[Number(raw)] ?? '' : decodeXml(raw)
      }
      cells[col] = value
    }
    rows.push(cells)
  }
  return rows
}

/** 挑第一个工作表（sheet1 / sheet2 … 按数字排序取最小） */
function pickSheet(entries) {
  const names = Object.keys(entries)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n))
    .sort((a, b) => {
      const na = Number((a.match(/(\d+)\.xml$/i) || [])[1] || 0)
      const nb = Number((b.match(/(\d+)\.xml$/i) || [])[1] || 0)
      return na - nb
    })
  return names[0]
}

/* ==================== 对外接口 ==================== */

export function isXlsx(file) {
  return /\.xlsx$/i.test(file && file.name ? file.name : '')
}

/** File → 二维数组 */
export async function xlsxToRows(file) {
  const buf = await file.arrayBuffer()
  const entries = unzip(buf)
  const shared = parseSharedStrings(await readEntry(entries['xl/sharedStrings.xml']))
  const sheetName = pickSheet(entries)
  if (!sheetName) throw new Error('这个 .xlsx 里没找到工作表')
  const xml = await readEntry(entries[sheetName])
  return parseSheet(xml, shared)
}
