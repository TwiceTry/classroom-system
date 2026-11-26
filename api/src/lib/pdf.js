/*
 * pdf.js —— HTML 转 PDF
 *
 * 为什么这么做而不是引一个 PDF 库：
 *   ① 打印版 HTML 已经排好了（A4、@page、宋体、密封线），
 *      再用 pdfkit 之类重排一遍等于把版式写两份，迟早不一致。
 *   ② 中文字体嵌入很啰嗦（要子集化、要带 ttf 文件）；
 *      用浏览器自己的打印引擎，系统装了什么字体就用什么，零配置。
 *   ③ 不引新依赖：这个项目现在只有 exceljs 和 yauzl，
 *      为了一个「偶尔用一次」的功能加 80MB 的 puppeteer 不划算。
 *
 * 代价：机器上得有 Chrome / Edge。找不到就明确报错，不静默降级 ——
 * 「点了下载但得到一个空文件」比「提示装浏览器」糟糕得多。
 */

import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

/** 候选浏览器：环境变量优先，然后各平台常见位置 */
const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.EDGE_PATH,
  /* Windows */
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  /* macOS */
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  /* Linux */
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
]

let cached = null
/** 找一个能用的浏览器；找不到返回空串。结果缓存，别每次都去 stat 一堆路径 */
export function findBrowser() {
  if (cached !== null) return cached
  for (const p of CANDIDATES) {
    if (!p) continue
    try {
      if (fs.existsSync(p)) {
        cached = p
        return p
      }
    } catch (e) {
      /* 权限之类的问题，跳过 */
    }
  }
  cached = ''
  return ''
}

const run = (exe, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(exe, args, opts, (err, stdout, stderr) => {
      if (err) {
        const msg = String((stderr || '') + (stdout || '') || err.message).slice(0, 400)
        reject(new Error(msg))
      } else resolve()
    })
  })

/**
 * HTML → PDF（Buffer）。
 *
 * 每次用独立的临时目录：两个学生同时点下载时互不干扰。
 * 目录在 finally 里删 —— 不删的话 /tmp 会慢慢攒一堆 in.html。
 *
 * @param {string} html 完整的 HTML 文档（带 <style>）
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function htmlToPdf(html, opts) {
  const exe = findBrowser()
  if (!exe) {
    throw new Error(
      '这台机器上找不到 Chrome / Edge，无法生成 PDF。' +
        '装一个浏览器，或者把浏览器路径写进环境变量 CHROME_PATH。'
    )
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-pdf-'))
  const htmlFile = path.join(dir, 'in.html')
  const pdfFile = path.join(dir, 'out.pdf')
  try {
    fs.writeFileSync(htmlFile, html, 'utf8')

    /* file:// 在 Windows 上要正斜杠，且路径里的空格要编码 */
    const url = 'file:///' + htmlFile.replace(/\\/g, '/').replace(/ /g, '%20')

    await run(
      exe,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        /* 不要页眉页脚（那上面会打印出文件路径和日期，不该出现在卷子上） */
        '--no-pdf-header-footer',
        /* 背景色要打出来：答题卡的浅灰底、正确项的绿底都靠它 */
        '--print-to-pdf-no-header',
        '--print-to-pdf=' + pdfFile,
        url,
      ],
      { timeout: (opts && opts.timeoutMs) || 60000, windowsHide: true }
    )

    if (!fs.existsSync(pdfFile)) throw new Error('浏览器没有生成 PDF（可能是页面太大或渲染失败）')
    const buf = fs.readFileSync(pdfFile)
    if (!buf.length) throw new Error('生成的 PDF 是空的')
    return buf
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      /* 删不掉就算了，别把正常结果变成报错 */
    }
  }
}

/** 文件名要能直接给人看：`张三-期末机试-答卷.pdf` */
export function pdfName(parts) {
  const raw = parts.filter(Boolean).join('-').replace(/[\\/:*?"<>|]/g, '_')
  return raw + '.pdf'
}
