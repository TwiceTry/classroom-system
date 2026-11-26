/*
 * pdf-kit.js —— 纯 Node 的 PDF 生成（不依赖浏览器）
 *
 * 和 lib/pdf.js（调 Chrome 打印）的关系：
 *
 *   pdf.js      HTML → PDF，**版式完全复用打印版网页**，效果最好，
 *               但机器上得有 Chrome / Edge。
 *   pdf-kit.js  Node 里直接排版，**只要有中文字体就能跑**，
 *               效果朴素一些（没有密封线、没有精细的行内混排）。
 *
 * 调用方优先用 pdf.js，找不到浏览器时自动落到这里 ——
 * 机房那台没装浏览器的服务器也能导出，只是版式简单点。
 *
 * 中文字体是硬要求：pdfkit 不嵌字体的话，中文全是方框。
 * 用系统里现成的 TTF（simhei / simkai / 思源），只读一次进内存复用。
 */

import fs from 'fs'
import PDFDocument from 'pdfkit'

/* ---------------- 字体 ---------------- */

/** 候选中文字体：TTF / OTF 优先（TTC 集合要指定 index，麻烦，放最后） */
const FONT_CANDIDATES = [
  process.env.CJK_FONT,
  /* Windows */
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simkai.ttf',
  'C:/Windows/Fonts/simfang.ttf',
  'C:/Windows/Fonts/STSONG.TTF',
  'C:/Windows/Fonts/Deng.ttf',
  /* macOS */
  '/System/Library/Fonts/Supplemental/Songti.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  /* Linux（装了中文字体的常见位置） */
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
]

let fontBuf = null
let fontPath = null

/** 找一份能用的中文字体，读进内存（只读一次 —— 一个字体 10MB，别每次请求都读盘） */
export function cjkFont() {
  if (fontBuf) return { buf: fontBuf, path: fontPath }
  for (const p of FONT_CANDIDATES) {
    if (!p) continue
    try {
      if (!fs.existsSync(p)) continue
      fontBuf = fs.readFileSync(p)
      fontPath = p
      return { buf: fontBuf, path: fontPath }
    } catch (e) {
      /* 读不了就试下一个 */
    }
  }
  return null
}

/* ---------------- 版面常量 ---------------- */

const PAGE_W = 595.28 /* A4 宽（pt） */
const PAGE_H = 841.89
const M = 45 /* 页边距 */
const CONTENT_W = PAGE_W - M * 2
const BOTTOM = PAGE_H - M - 24 /* 留出页脚 */

/* ---------------- 小工具 ---------------- */

/** 卷面分显示：整数不带小数，6.7 保留一位 */
const num1 = (n) => {
  const v = Math.round((Number(n) || 0) * 10) / 10
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** 题干剥掉排版标签（和前端 plain() 同一套白名单，别把 <script> 当标签吃掉） */
const FMT_TAG = /<\/?(?:b|i|em|strong|u|s|del|ins|br|p|div|span|sub|sup|small|mark|code|pre|blockquote)\b[^>]*>/gi
function plain(s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(FMT_TAG, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 选项文字：数组里的元素可能是字符串，也可能是 {text} */
function optionText(o) {
  if (typeof o === 'string') return o
  if (o && typeof o === 'object') return String(o.text || o.label || o.key || '')
  return String(o == null ? '' : o)
}

const letterOf = (i) => String.fromCharCode(65 + i)

/** 解析出学生选了哪几个字母 */
function chosenLetters(type, given) {
  const s = String(given == null ? '' : given).toUpperCase()
  if (type === 'choice') return s.replace(/[^A-Z]/g, '').split('').filter((c, i, a) => a.indexOf(c) === i)
  if (type === 'judge') return [String(given || '').trim()]
  return [String(given == null ? '' : given)]
}

/* ---------------- 主渲染 ---------------- */

/**
 * 出一份 PDF（试卷 / 答卷共用）。
 *
 * ctx 和 renderHtml 完全一致：
 *   { course, assignment, paper, student, graded, withAnswer }
 *   graded 有值 = 答卷（带作答、对错、得分）
 *   withAnswer = true = 答案卷（标出正确答案）
 *
 * @returns {Promise<Buffer>}
 */
export function renderPdf(ctx) {
  const font = cjkFont()
  if (!font) {
    return Promise.reject(
      new Error(
        '这台机器上没有可用的中文字体，无法生成 PDF。' +
          '装一个中文字体（如 simhei.ttf / Noto Sans CJK），或者把字体路径写进环境变量 CJK_FONT。'
      )
    )
  }

  const { course, assignment, paper, student, graded, withAnswer } = ctx
  const isAnswerSheet = !!graded
  const items = (graded && graded.items) || []
  const answerMap = {}
  for (const it of items) answerMap[it.qid] = it

  return new Promise((resolve, reject) => {
    const chunks = []
    const doc = new PDFDocument({
      size: 'A4',
      /* 要 bufferPages 才能最后回头给每页盖页码 */
      bufferPages: true,
      margins: { top: M, bottom: M, left: M, right: M },
      /* PDF 元信息：拷到电脑上一堆文件时按标题能认出来 */
      info: {
        Title: String(assignment && assignment.title ? assignment.title : '机试') + (isAnswerSheet ? ' · 答卷' : ' · 试卷'),
        Author: String(course || ''),
        Subject: student ? String(student.name || student.sid || '') : '',
      },
    })
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    try {
      doc.registerFont('cjk', font.buf)
      doc.font('cjk')

      /* ---------- 卷头 ---------- */
      const title = (paper && paper.title) || (assignment && assignment.title) || '机试'
      doc.fontSize(16).fillColor('#000').text(title, M, M, { width: CONTENT_W, align: 'center' })
      doc.moveDown(0.3)
      const kindWord = isAnswerSheet ? '答卷' : '试卷'
      const sub = [
        kindWord,
        paper && paper.fullScore ? '满分 ' + num1(paper.fullScore) + ' 分' : '',
        paper && paper.duration ? '限时 ' + paper.duration + ' 分钟' : '',
      ]
        .filter(Boolean)
        .join('　')
      doc.fontSize(9).fillColor('#444').text(sub, M, doc.y, { width: CONTENT_W, align: 'center' })
      doc.moveDown(0.8)

      /* ---------- 信息表 ---------- */
      infoTable(doc, {
        course: course || '',
        className: (student && student.className) || '',
        name: (student && student.name) || '',
        examTitle: (assignment && assignment.title) || '',
        sid: (student && student.sid) || '',
        date: isAnswerSheet && graded.gradedAt ? String(graded.gradedAt).slice(0, 10) : '',
      })
      doc.moveDown(0.9)

      /* ---------- 逐段逐题 ---------- */
      let objIndex = 0
      ;(paper.sections || []).forEach((s, si) => {
        const rows = (s.questions || []).map((q) => answerMap[q.id] || null)
        const fullOfSection = (s.questions || []).reduce((n, q) => n + (Number(q.score) || 0), 0)
        const gotOfSection = rows.reduce((n, r) => n + (r ? Number(r.got) || 0 : 0), 0)

        ensureRoom(doc, 60)
        doc.fontSize(11).fillColor('#000')

        /* 段头：左边标题，右边本段得分（答卷才显示） */
        const segY = doc.y
        const segTitle = cnNo(si) + '、' + String(s.title || '').replace(/^[一二三四五六七八九十]+、\s*/, '')
        doc.text(segTitle, M, segY, { width: CONTENT_W - 110 })
        if (isAnswerSheet) {
          doc
            .fontSize(9)
            .fillColor('#333')
            .text('本段 ' + num1(gotOfSection) + ' / ' + num1(fullOfSection), PAGE_W - M - 105, segY + 2, {
              width: 105,
              align: 'right',
            })
        }
        doc.moveDown(0.5)
        line(doc)
        doc.moveDown(0.3)

        ;(s.questions || []).forEach((q, qi) => {
          objIndex++
          const row = rows[qi]
          const given = row ? row.given : (ctx.answers || {})[q.id] || ''

          ensureRoom(doc, 70)

          /* 题干：`1. xxx`，自动换行 */
          doc.fontSize(10).fillColor('#000')
          const stemW = CONTENT_W - 4
          doc.text(String(objIndex) + '. ' + plain(q.stem), M, doc.y, { width: stemW, lineGap: 1.5 })
          doc.moveDown(0.25)

          /* 选项 */
          const opts = (q.options || []).map(optionText)
          if (s.type === 'choice' && opts.length) {
            drawOptions(doc, s.type, opts, chosenLetters('choice', given), String(q.answer || ''), {
              markAnswer: withAnswer || isAnswerSheet,
              graded: !!row,
            })
          } else if (s.type === 'judge') {
            const pick = String(given || '').trim()
            doc.fontSize(9.5).fillColor('#333')
            doc.text(
              '（　）对　　（　）错' +
                (pick ? '　　学生答：' + pick : '') +
                (withAnswer || isAnswerSheet ? '　　正确答案：' + String(q.answer || '') : ''),
              M + 12,
              doc.y,
              { width: CONTENT_W - 12 }
            )
          } else if (s.type === 'fill') {
            doc.fontSize(9.5).fillColor('#333')
            doc.text(
              '答：' +
                (String(given || '').trim() || '＿＿＿＿＿＿＿＿＿＿') +
                (withAnswer || isAnswerSheet ? '　　正确答案：' + String(q.answer || '') : ''),
              M + 12,
              doc.y,
              { width: CONTENT_W - 12 }
            )
          } else if (s.type === 'short') {
            doc.fontSize(9.5).fillColor('#333')
            const txt = String(given || '').trim()
            doc.text(txt || '（未作答）', M + 12, doc.y, { width: CONTENT_W - 12, lineGap: 2 })
            if (withAnswer || isAnswerSheet) {
              doc.fontSize(8.5).fillColor('#666').text('参考要点：' + plain(q.answer || ''), M + 12, doc.y + 2, {
                width: CONTENT_W - 12,
              })
            }
          }

          /* 判分结果：一行，跟在题目后面 */
          if (row) {
            doc.moveDown(0.2)
            /*
             * 用 √ / × 而不是 ✓ / ✗：
             *   SimHei / SimSun 里没有 U+2713 / U+2717 的字形，
             *   pdfkit 会画成方框（tofu）。√ (U+221A) 和 × (U+00D7) 中文都有。
             */
            const okMark = row.ok === true ? '√' : row.ok === false ? '×' : ''
            const parts = []
            if (row.pending) parts.push('得分 待老师判定 / ' + num1(q.score))
            else parts.push('得分 ' + num1(row.got) + ' / ' + num1(q.score))
            if (row.why) parts.push(row.why)
            doc
              .fontSize(8.5)
              .fillColor(row.ok === false && !(row.got > 0) ? '#b3261e' : row.got > 0 && row.ok !== true ? '#a15c00' : '#2f6b3a')
              .text((okMark ? okMark + '  ' : '') + parts.join('　'), M + 12, doc.y, { width: CONTENT_W - 12 })
            if (row.explain) {
              doc.fontSize(8).fillColor('#777').text('解析：' + plain(row.explain), M + 12, doc.y + 1, {
                width: CONTENT_W - 12,
              })
            }
          }

          doc.moveDown(0.55)
        })

        doc.moveDown(0.3)
      })

      /* ---------- 卷尾汇总 ---------- */
      if (isAnswerSheet && graded) {
        ensureRoom(doc, 80)
        doc.moveDown(0.5)
        line(doc)
        doc.moveDown(0.4)
        doc.fontSize(10).fillColor('#000')
        doc.text(
          '卷面得分：' + num1(graded.total) + ' / ' + num1(graded.fullScore) +
            '　（客观题 ' + num1(graded.autoScore) + ' · 主观题 ' + num1(graded.manualScore) + '）',
          M,
          doc.y,
          { width: CONTENT_W }
        )
        if (graded.gradedAt) {
          doc.fontSize(8.5).fillColor('#666').text('判分时间：' + String(graded.gradedAt).slice(0, 16).replace('T', ' '), M, doc.y + 2)
        }
      }

      /* ---------- 页脚：页码 ---------- */
      stampPageNumbers(doc)

      doc.end()
    } catch (e) {
      reject(e)
    }
  })
}

/* ---------------- 版面零件 ---------------- */

/** 空间不够就翻页 */
function ensureRoom(doc, need) {
  if (doc.y + need > BOTTOM) {
    doc.addPage()
    doc.font('cjk')
    doc.y = M
  }
}

/** 一条细横线 */
function line(doc) {
  const y = doc.y
  doc.save().strokeColor('#c9d2da').lineWidth(0.6).moveTo(M, y).lineTo(PAGE_W - M, y).stroke().restore()
}

/**
 * 选项。短的排两列，长的整行 —— 和网页版观感一致，也省纸。
 *
 * 选中 / 正确 / 答错的标记：
 *   isChosen  学生选了这个      → 前面 ● 并加粗
 *   isRight   这是正确答案      → 后面 ✓（答案卷或答卷都显示）
 *   isWrong   学生选了但不对    → 后面 ✗
 */
function drawOptions(doc, type, options, chosen, answerLetters, opt) {
  const ANSWER = String(answerLetters || '').toUpperCase().replace(/[^A-Z]/g, '')
  const CHOSEN = chosen.filter((c) => /^[A-Z]$/.test(c))

  const measured = options.map((t) => {
    const label = letterOf(options.indexOf(t))
    const body = '　' + label + '. ' + t
    doc.fontSize(9.5)
    return { label, body, w: doc.widthOfString(body) }
  })

  const twoCol = measured.every((m) => m.w <= (CONTENT_W - 16) / 2)

  if (twoCol) {
    const colW = (CONTENT_W - 16) / 2
    for (let i = 0; i < measured.length; i += 2) {
      const rowY = doc.y
      let rowH = 0
      for (let k = 0; k < 2 && i + k < measured.length; k++) {
        const m = measured[i + k]
        const x = M + 12 + k * colW
        const h = optionLine(doc, m, x, rowY, colW - 6, ANSWER, CHOSEN, opt)
        rowH = Math.max(rowH, h)
      }
      doc.y = rowY + rowH
    }
  } else {
    for (const m of measured) {
      const h = optionLine(doc, m, M + 12, doc.y, CONTENT_W - 12, ANSWER, CHOSEN, opt)
      doc.y += h
    }
  }
}

/** 画一个选项，返回占用的高度 */
function optionLine(doc, m, x, y, w, ANSWER, CHOSEN, opt) {
  const chosen = CHOSEN.indexOf(m.label) >= 0
  const right = ANSWER.indexOf(m.label) >= 0
  const wrong = chosen && !right

  let tail = ''
  if (opt.graded || opt.markAnswer) {
    /* √ / × 而不是 ✓ / ✗ —— 后者在 SimHei 里没有字形，会画成方框 */
    if (right && (opt.markAnswer || chosen)) tail = '  √'
    else if (wrong) tail = '  ×'
  }

  doc.fontSize(9.5)
  if (chosen) doc.fillColor('#1a56a8')
  else doc.fillColor('#222')
  const text = (chosen ? '●' : '') + m.body + tail
  doc.text(text, x, y, { width: w, lineGap: 1 })
  const h = doc.heightOfString(text, { width: w, lineGap: 1 })
  return h
}

/** 卷头那张信息表：课程 / 班级 / 姓名 ｜ 考试 / 学号 / 日期 */
function infoTable(doc, v) {
  const rows = [
    [
      ['课程', v.course],
      ['考试', v.examTitle],
    ],
    [
      ['班级', v.className],
      ['学号', v.sid],
    ],
    [
      ['姓名', v.name],
      ['日期', v.date],
    ],
  ]
  const labelW = 34
  const halfW = CONTENT_W / 2
  const padX = 5
  const rowH = 20

  let y = doc.y
  doc.fontSize(9)

  for (const r of rows) {
    /* 单元格高度可能因为长文字变高，先按固定行高画，长的话后面再撑 */
    for (let i = 0; i < 2; i++) {
      const [lab, val] = r[i]
      const x = M + i * halfW
      doc.save().strokeColor('#c9d2da').lineWidth(0.6).rect(x, y, halfW, rowH).stroke().restore()
      doc.fontSize(8.5).fillColor('#666').text(lab, x + padX, y + 6, { width: labelW, lineBreak: false })
      doc
        .fontSize(9)
        .fillColor('#111')
        .text(String(val || ''), x + labelW + padX, y + 5, { width: halfW - labelW - padX * 2, lineBreak: false, ellipsis: true })
    }
    y += rowH
  }
  doc.y = y
}

/* 中文序号（最多十段，够用了） */
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
const cnNo = (i) => CN[i] || String(i + 1)

/**
 * 页脚页码。
 *
 * pdfkit 的 bufferPages 要一开始就开，这里改成「画完再逐页补」——
 * 需要 doc.bufferedPageRange()，所以创建时得 bufferedPages: true。
 * 简单做法：用 pdfkit 的 switchToPage 遍历。
 */
function stampPageNumbers(doc) {
  const range = doc.bufferedPageRange ? doc.bufferedPageRange() : null
  if (!range || !range.count) return
  const total = range.count
  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i)
    doc
      .fontSize(8)
      .fillColor('#888')
      .text(i + 1 + ' / ' + total, M, PAGE_H - M + 6, { width: CONTENT_W, align: 'center', lineBreak: false })
  }
}
