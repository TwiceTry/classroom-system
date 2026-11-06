/*
 * xlsx.js —— 二维数组 → Excel 工作簿
 *
 * 为什么统一用 xlsx 而不是 CSV：
 *   · 中文姓名、学号（长数字）在 CSV 里被 Excel 自动转成日期/科学计数法，老师天天踩
 *   · 导出的表老师多半要再加工（排序、求和、加列），xlsx 才顺手
 *   · 学号是字符串，xlsx 能强制成文本，不会被吃掉前导 0
 *
 * 注意：**课程包 / 班级包里的 *.roster.csv 不在这里改**。
 * 那些是包格式的一部分（规范里定了「表头必须是 学号,姓名,备注」），
 * 换成 xlsx 会让已经导出的旧包打不开。
 */
import ExcelJS from 'exceljs'

/** 看上去像数字的字符串 → 数字（分数列才能求和），但学号这类要留成文本 */
function looksNumeric(v) {
  if (typeof v === 'number') return true
  const s = String(v === undefined || v === null ? '' : v).trim()
  if (!s) return false
  if (!/^-?\d+(\.\d+)?$/.test(s)) return false
  // 长度 >= 8 的纯数字（学号、手机号）当字符串处理，避免变科学计数法或丢前导 0
  if (/^-?\d+$/.test(s) && s.replace('-', '').length >= 8) return false
  return true
}

/**
 * 生成 xlsx。
 *
 * @param {Array<Array>} rows    第一行是表头
 * @param {object} opts
 *   sheetName  工作表名
 *   textCols   这些列号（0 基）强制按文本写（学号列）
 * @returns {Promise<Buffer>}
 */
export async function rowsToXlsx(rows, opts = {}) {
  const { sheetName = 'Sheet1', textCols = [] } = opts
  const list = Array.isArray(rows) ? rows : []
  const textSet = new Set(textCols)

  const wb = new ExcelJS.Workbook()
  wb.creator = '课堂系统'
  const ws = wb.addWorksheet(String(sheetName).slice(0, 30) || 'Sheet1')

  for (const r of list) {
    const cells = (Array.isArray(r) ? r : [r]).map((v, ci) => {
      if (textSet.has(ci)) {
        // 强制文本：写字符串并设成文本格式，Excel 不会转成数字/日期
        return { text: String(v === undefined || v === null ? '' : v) }
      }
      if (looksNumeric(v)) return { value: Number(v) }
      return { text: String(v === undefined || v === null ? '' : v) }
    })
    const row = ws.addRow(cells.map((c) => (c.text !== undefined ? c.text : c.value)))
    // 文本列再标一次 number format，防 Excel 自作聪明
    cells.forEach((c, ci) => {
      if (c.text !== undefined && textSet.has(ci)) row.getCell(ci + 1).numFmt = '@'
    })
  }

  // 表头：加粗 + 浅底 + 冻结首行
  const head = ws.getRow(1)
  if (head) {
    head.font = { bold: true }
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
    head.alignment = { vertical: 'middle' }
  }
  ws.views = list.length > 1 ? [{ state: 'frozen', ySplit: 1 }] : []

  // 列宽：按内容长度估（中文按 2 个字符宽算），夹在 8~42 之间
  const colCount = list.reduce((n, r) => Math.max(n, Array.isArray(r) ? r.length : 1), 0)
  for (let c = 1; c <= colCount; c++) {
    let w = 8
    for (const r of list) {
      const v = Array.isArray(r) ? r[c - 1] : ''
      const s = String(v === undefined || v === null ? '' : v)
      let len = 0
      for (const ch of s) len += ch.charCodeAt(0) > 255 ? 2 : 1
      if (len > w) w = len
    }
    ws.getColumn(c).width = Math.min(42, Math.max(8, w + 2))
  }

  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** 带时间戳的文件名（中文安全） */
export function stampedName(base, ext) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes())
  return base + '-' + stamp + '.' + ext
}
