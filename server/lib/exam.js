'use strict'
/*
 * exam.js —— 机试（试卷 / 题库）
 *
 * 一套数据格式同时支持两种考试：
 *   kind = "paper" 统一卷 —— 全班同一份卷子（直接出题，pick 可省）
 *   kind = "bank"  题库卷 —— 每段按 pick 条随机抽题，**按「作业 + 学号」定种子**，
 *                   同一个学生重进还是同一份（不会刷出不同的卷子），换人就是另一份
 *
 * 格式（老师把这份 JSON 交上来就行，模板见 data/exams/_template.json）：
 * {
 *   "kind": "paper" | "bank",
 *   "title": "期末机试",
 *   "duration": 90,              // 分钟，0/不填 = 不限时
 *   "fullScore": 100,            // 可省：默认 = Σ(每段 pick × 每题分)
 *   "sections": [
 *     { "id": "s1", "title": "一、选择题", "type": "choice", "score": 3, "pick": 10,
 *       "questions": [
 *         { "id": "c1", "stem": "题干", "options": ["A. …", "B. …"], "answer": "A", "explain": "解析" }
 *       ] }
 *   ]
 * }
 *
 * 题型与判分：
 *   choice  单选/多选 → 与 answer 比对（多选比集合）
 *   judge   判断      → 对/错
 *   fill    填空      → 去空格、不分大小写后比对；accepts 可给多个可接受写法
 *   short   简答      → **不自动判分**，留给老师打分（answer 当参考答案显示）
 *
 * 判分只用「客观题」；总分 = 客观题自动分 + 老师给的主观题分。
 * 老师把总分（卷面分）落进计分表那条 exam 事件，本模块只负责算出来和出报告。
 */
const fs = require('fs')
const path = require('path')
const config = require('../config')
const students = require('./students')

const TYPES = ['choice', 'judge', 'fill', 'short']
const TYPE_NAME = { choice: '选择', judge: '判断', fill: '填空', short: '简答' }

/* ---------------- 解析 / 校验 ---------------- */

function num(v) {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

/** 把老师交上来的 JSON 归一化成内部结构（缺字段补默认、答案统一成数组） */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const kind = src.kind === 'bank' ? 'bank' : 'paper'
  const sections = (Array.isArray(src.sections) ? src.sections : []).map((s, si) => {
    const type = TYPES.indexOf(s.type) >= 0 ? s.type : 'choice'
    const questions = (Array.isArray(s.questions) ? s.questions : []).map((q, qi) => ({
      id: String(q.id || 'q' + (si + 1) + '-' + (qi + 1)),
      type,
      stem: String(q.stem || '').trim(),
      options: Array.isArray(q.options) ? q.options.map((x) => String(x)) : [],
      answer: q.answer === undefined ? '' : q.answer,
      accepts: Array.isArray(q.accepts) ? q.accepts.map((x) => String(x)) : [],
      explain: String(q.explain || ''),
    }))
    return {
      id: String(s.id || 's' + (si + 1)),
      title: String(s.title || '第 ' + (si + 1) + ' 部分'),
      type,
      score: num(s.score) || 0,
      pick: Math.max(0, Math.floor(num(s.pick))),
      questions,
    }
  })

  const computedFull = sections.reduce((sum, s) => {
    const n = kind === 'bank' || s.pick > 0 ? Math.min(s.pick || s.questions.length, s.questions.length) : s.questions.length
    return sum + n * s.score
  }, 0)

  return {
    kind,
    title: String(src.title || '机试').trim(),
    duration: Math.max(0, Math.floor(num(src.duration))),
    fullScore: num(src.fullScore) || computedFull,
    sections,
  }
}

function validate(exam) {
  const errors = []
  const warnings = []
  if (!exam || typeof exam !== 'object') return { errors: ['文件不是合法的 JSON 对象'], warnings }
  if (!exam.sections.length) errors.push('sections 不能为空：至少要有一段题')
  if (exam.kind === 'bank' && exam.duration <= 0) warnings.push('题库随机卷建议设置 duration（分钟），否则学生没有交卷时限')

  const seen = new Set()
  exam.sections.forEach((s, i) => {
    const tag = '第 ' + (i + 1) + ' 段「' + s.title + '」'
    if (!s.questions.length) errors.push(tag + ' 没有题目')
    if (!(s.score > 0)) errors.push(tag + ' 的每题分值必须大于 0')
    if (exam.kind === 'bank') {
      if (!(s.pick > 0)) errors.push(tag + ' 是题库卷，要写 pick（抽几道）')
      if (s.pick > s.questions.length) errors.push(tag + ' 要抽 ' + s.pick + ' 道，但题池只有 ' + s.questions.length + ' 道')
    }
    s.questions.forEach((q) => {
      const qt = tag + ' 题「' + (q.id || '?') + '」'
      if (!q.stem) errors.push(qt + ' 缺题干')
      if (seen.has(q.id)) errors.push(qt + ' 的 id 重复')
      seen.add(q.id)
      if (q.type === 'choice') {
        if (q.options.length < 2) errors.push(qt + ' 选择题至少要 2 个选项')
        const letters = String(q.answer).toUpperCase().replace(/[^A-Z]/g, '')
        if (!letters) errors.push(qt + ' 没给答案（answer 用选项字母，如 "A" 或 "AC"）')
        else {
          const maxCh = String.fromCharCode(64 + q.options.length)
          for (const ch of letters) if (ch < 'A' || ch > maxCh) errors.push(qt + ' 答案「' + ch + '」超出选项范围')
        }
      }
      if (q.type === 'judge') {
        const a = String(q.answer).trim()
        if (!/^(对|错|true|false|T|F|是|否)$/i.test(a)) errors.push(qt + ' 判断题答案只能是 对/错')
      }
      if (q.type === 'fill' && !String(q.answer).trim() && !q.accepts.length) {
        errors.push(qt + ' 填空题没给答案')
      }
    })
  })

  const sum = exam.sections.reduce(
    (a, s) => a + Math.min(exam.kind === 'bank' || s.pick > 0 ? s.pick || s.questions.length : s.questions.length, s.questions.length) * s.score,
    0
  )
  if (Math.abs(sum - exam.fullScore) > 0.01) warnings.push('各段合计 ' + sum + ' ≠ fullScore ' + exam.fullScore + '（以各段为准）')
  return { errors, warnings }
}

/* ---------------- 随机抽题（按学生定种子） ---------------- */

/** 简单稳定的字符串哈希 + mulberry32：同一台机器、同一个学号，永远抽出同一份卷 */
function seedOf(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function rng(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(list, rand) {
  const arr = list.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
  return arr
}

/**
 * 给某个学生出卷：题库卷抽题、统一卷照搬。
 * 返回的 paper **不含答案**（发给学生的就是这个），另外返回 withAnswer 供服务端判分与出报告。
 */
function paperFor(exam, key) {
  const rand = rng(seedOf(String(key)))
  const sections = exam.sections.map((s) => {
    const n = exam.kind === 'bank' || s.pick > 0 ? Math.min(s.pick || s.questions.length, s.questions.length) : s.questions.length
    const pool = exam.kind === 'bank' ? shuffle(s.questions, rand) : s.questions
    const chosen = pool.slice(0, n)
    return {
      id: s.id,
      title: s.title,
      type: s.type,
      score: s.score,
      questions: chosen.map((q) => ({
        id: q.id,
        stem: q.stem,
        options: q.options.slice(),
        score: s.score,
        answer: q.answer,
        accepts: q.accepts.slice(),
        explain: q.explain,
      })),
    }
  })
  const total = sections.reduce((a, s) => a + s.questions.length * s.score, 0)
  const paper = { title: exam.title, duration: exam.duration, fullScore: total, sections }
  return { paper, withAnswer: paper }
}

/**
 * 排一张可打印的卷子（空白卷 / 答案卷共用）：
 *   - 统一卷：全班这份
 *   - 题库卷：按 pick 抽一份「样例卷」，给老师看卷面长什么样（学生拿到的是各自抽的那份，见 his 答卷）
 * 每题补上 score（分段分值下放到题），fullScore 按题量乘出来。
 */
function printPaper(exam, seed) {
  const { paper } = paperFor(Object.assign({}, exam, { kind: 'paper' }), 'print:' + (seed || exam.title || ''))
  return paper
}

/** 发给学生的版本：把答案和解析摘掉 */
function publicPaper(paper) {
  return {
    title: paper.title,
    duration: paper.duration,
    fullScore: paper.fullScore,
    sections: paper.sections.map((s) => ({
      id: s.id,
      title: s.title,
      type: s.type,
      score: s.score,
      questions: s.questions.map((q) => ({ id: q.id, stem: q.stem, options: q.options.slice(), score: q.score })),
    })),
  }
}

/* ---------------- 判分 ---------------- */

const normText = (v) =>
  String(v === undefined || v === null ? '' : v)
    .replace(/\s+/g, '')
    .replace(/[，。；：、（）【】“”‘’]/g, (m) => ({ '，': ',', '。': '.', '；': ';', '：': ':', '、': ',', '（': '(', '）': ')', '【': '[', '】': ']', '“': '"', '”': '"', '‘': "'", '’': "'" }[m] || m))
    .toLowerCase()

function judgeAnswer(q, given) {
  if (q.type === 'choice') {
    const g = String(given || '').toUpperCase().replace(/[^A-Z]/g, '').split('').sort().join('')
    const a = String(q.answer || '').toUpperCase().replace(/[^A-Z]/g, '').split('').sort().join('')
    return !!g && g === a
  }
  if (q.type === 'judge') {
    const truthy = (v) => /^(对|是|true|t|1|正确)$/i.test(String(v).trim())
    const g = truthy(given)
    const a = truthy(q.answer)
    if (!String(given || '').trim()) return false
    return g === a
  }
  if (q.type === 'fill') {
    const g = normText(given)
    if (!g) return false
    const list = [q.answer].concat(q.accepts || []).map(normText).filter(Boolean)
    return list.indexOf(g) >= 0
  }
  return false // short：不自动判
}

/**
 * 自动判客观题。返回每题得分与客观题小计；主观题留给老师（scores 传进来）。
 * scores: { 题id: 分 } —— 老师给主观题（也可以覆盖客观题）打的分
 */
function autoGrade(paper, answers, scores) {
  const ans = answers || {}
  const manual = scores || {}
  const items = []
  let auto = 0
  let manualSum = 0
  let subjectiveCount = 0

  for (const s of paper.sections) {
    for (const q of s.questions) {
      const given = ans[q.id]
      const isShort = s.type === 'short'
      let got = 0
      let ok = null
      let pending = false
      if (isShort) {
        subjectiveCount++
        if (manual[q.id] !== undefined && manual[q.id] !== '') {
          got = Math.max(0, Math.min(q.score, num(manual[q.id])))
          manualSum += got
        } else {
          pending = true // 老师还没判这一题
        }
      } else {
        ok = judgeAnswer(Object.assign({ type: s.type }, q), given)
        got = ok ? q.score : 0
        auto += got
      }
      items.push({
        qid: q.id,
        section: s.id,
        type: s.type,
        score: q.score,
        given: given === undefined ? '' : given,
        answer: q.answer,
        explain: q.explain,
        ok,
        pending,
        got: Math.round(got * 10) / 10,
      })
    }
  }

  const total = Math.round((auto + manualSum) * 10) / 10
  return {
    items,
    autoScore: Math.round(auto * 10) / 10,
    manualScore: Math.round(manualSum * 10) / 10,
    subjectiveCount,
    total: Math.min(total, paper.fullScore),
    fullScore: paper.fullScore,
  }
}

/* ---------------- 出纸：试卷 / 答卷 ----------------
 * 三样东西都是「一张真卷子」的长相：
 *   试卷     —— 空白卷，学生拿到/打印用（可选带答案与解析，老师用）
 *   答卷     —— 学生答过的卷子：卷头 + 每题作答 + 对错 + 得分 + 合计
 * Markdown 给人看、进 git 能 diff；HTML 是打印版（A4、宋体、密封线）。
 */

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
const cnNo = (i) => CN_NUM[i] || String(i + 1)

/** 大题名：去掉模板标题里自带的序号括号，避免「一、选择题（每题 5 分）（每题 5 分，共 20 分）」 */
function sectionName(s) {
  const raw = String(s.title || TYPE_NAME[s.type] || '')
    .replace(/^[一二三四五六七八九十]+\s*[、.．]\s*/, '')
    .replace(/[（(][^）)]*分[^）)]*[）)]\s*$/, '')
    .trim()
  return raw || TYPE_NAME[s.type] || '题目'
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

const score1 = (v) => Math.round((Number(v) || 0) * 10) / 10

/** 答案 → 选项字母：选择题直接取字母，判断题 对=A / 错=B，其余无选项 */
function toLetters(type, value) {
  if (type === 'judge') {
    const v = String(value || '').trim()
    if (!v) return ''
    if (/^(对|是|正确|true|t|1|√|✓)$/i.test(v)) return 'A'
    if (/^(错|否|错误|false|f|0|×|✗)$/i.test(v)) return 'B'
    return ''
  }
  return String(value || '').toUpperCase().replace(/[^A-Z]/g, '')
}

/** 这道题的选项：判断题没有 options，就按「对 / 错」两格排 */
function optionsOf(section, q) {
  if (q.options && q.options.length) return q.options
  return section && section.type === 'judge' ? ['对', '错'] : []
}

/** 选择题：把学生选的选项标出来（asAnswer: 标参考答案） */
function markOptions(options, picked, asAnswer) {
  const set = String(picked || '').toUpperCase().replace(/[^A-Z]/g, '').split('')
  return (options || []).map((text, i) => {
    const ch = String.fromCharCode(65 + i)
    const hit = set.indexOf(ch) >= 0
    const plain = String(text).replace(/^\s*[A-Z][.、．]\s*/, '')
    return { ch, text: plain, hit, mark: hit ? (asAnswer ? ' ← 答案' : ' ← 作答') : '' }
  })
}

/** 一道题的作答块（Markdown）：题干 + 选项 + 学生答 + 对错 + 得分 */
function questionMd(section, q, row, opts) {
  const o = opts || {}
  const L = []
  const no = o.no
  L.push('**' + no + '.** ' + String(q.stem || '').replace(/\s*\n\s*/g, ' '))
  L.push('')
  const optionList = optionsOf(section, q)
  if (optionList.length) {
    const picked = o.answers ? o.answers[q.id] : ''
    const cols = markOptions(optionList, toLetters(section.type, picked), false)
    // 选项排两列，像卷子；学生选中的加粗并标注
    const lines = []
    for (let i = 0; i < cols.length; i += 2) {
      const pair = [cols[i], cols[i + 1]].filter(Boolean).map((c) => {
        const t = c.ch + '. ' + c.text
        return c.hit ? '**' + t + '**' + c.mark : t
      })
      lines.push('　' + pair.join('　　'))
    }
    L.push(lines.join('  \n'))
    L.push('')
  }
  if (o.answers) {
    const given = row && row.given !== undefined && row.given !== '' ? String(row.given) : ''
    if (section.type === 'short') {
      L.push('> 学生作答：' + (given ? given.replace(/\n/g, '\n> ') : '（未作答）'))
    } else {
      L.push('　作答：**' + (given || '（未作答）') + '**' + (row && row.ok === true ? '　✓' : row && row.ok === false ? '　✗' : ''))
    }
    if (row && row.pending) L.push('　得分：待老师判定（满分 ' + q.score + '）')
    else if (row && row.got !== undefined) L.push('　得分：**' + score1(row.got) + ' / ' + q.score + '**')
    if (section.type !== 'short' && row && row.ok === false) L.push('　正确答案：**' + String(q.answer) + '**')
    if (o.withAnswer && section.type === 'short') L.push('　参考答案：' + String(q.answer || ''))
    if (o.withAnswer && row && row.explain) L.push('　解析：' + row.explain)
  } else if (o.withAnswer) {
    L.push('　参考答案：**' + String(q.answer || '') + '**')
    if (q.explain) L.push('　解析：' + q.explain)
  }
  L.push('')
  return L
}

/** 卷头（Markdown 表格，两行四格，像卷子顶上那一栏） */
function headMd(ctx) {
  const { course, assignment, paper, student, graded, gradedAt } = ctx
  const rows = []
  rows.push('| 课程 | ' + (course || '—') + ' | 考试 | ' + (assignment.title || paper.title || '机试') + ' |')
  rows.push('|---|---|---|---|')
  if (student) {
    rows.push('| 班级 | ' + (student.className || '—') + ' | 学号 | ' + (student.sid || '') + ' |')
    rows.push('| 姓名 | ' + (student.name || '') + ' | 交卷 | ' + (fmtTime(gradedAt) || '—') + ' |')
  } else {
    rows.push('| 班级 | 　　　　　 | 学号 | 　　　　　 |')
    rows.push('| 姓名 | 　　　　　 | 日期 | 　　　　　 |')
  }
  const meta = []
  meta.push('满分 **' + paper.fullScore + '** 分')
  if (paper.duration) meta.push('限时 **' + paper.duration + '** 分钟')
  if (graded) meta.push('卷面得分 **' + score1(graded.total) + ' / ' + paper.fullScore + '**')
  return { table: rows.join('\n'), meta: meta.join('　·　') }
}

/** 空白试卷（Markdown）。withAnswer=true 就是「答案卷」，老师自己看 */
function renderPaperMd(ctx) {
  const { course, assignment, paper, withAnswer } = ctx
  const head = headMd({ course, assignment, paper })
  const L = []
  L.push('# ' + (paper.title || '机试') + ' · ' + (withAnswer ? '试卷（含答案）' : '试卷'))
  L.push('')
  L.push(head.table)
  L.push('')
  L.push(head.meta)
  L.push('')
  if (assignment && assignment.note) {
    L.push('> 说明：' + String(assignment.note).replace(/\n/g, ' '))
    L.push('')
  }
  L.push('---')
  L.push('')
  paper.sections.forEach((s, si) => {
    const sum = (s.questions || []).reduce((n, q) => n + (Number(q.score) || 0), 0)
    L.push('## ' + cnNo(si) + '、' + sectionName(s) + '（每题 ' + s.score + ' 分，共 ' + sum + ' 分）')
    L.push('')
    L.push('　本大题得分：＿＿＿＿＿＿')
    L.push('')
    s.questions.forEach((q, qi) => {
      questionMd(s, q, null, { no: qi + 1, withAnswer: !!withAnswer }).forEach((x) => L.push(x))
    })
  })
  L.push('---')
  L.push('')
  L.push('_' + (withAnswer ? '答案卷（老师用，勿下发）' : '试卷') + '　由课堂系统生成：' + fmtTime(new Date().toISOString()) + '_')
  return L.join('\n')
}

/** 学生答卷（Markdown）：卷头 + 逐题作答与得分 + 合计 */
function renderReport(ctx) {
  const { course, assignment, paper, answers, graded, gradedAt, comment, student } = ctx
  const head = headMd({ course, assignment, paper, student, graded, gradedAt })
  const L = []
  L.push('# ' + (paper.title || '机试') + ' · 答卷')
  L.push('')
  L.push(head.table)
  L.push('')
  L.push(head.meta)
  L.push('')
  if (graded) {
    L.push('构成：客观题 **' + score1(graded.autoScore) + '** 分 + 主观题 **' + score1(graded.manualScore) + '** 分')
    L.push('')
  }
  if (comment) {
    L.push('> 老师评语：' + String(comment).replace(/\n/g, ' '))
    L.push('')
  }
  L.push('---')
  L.push('')
  const items = (graded && graded.items) || []
  paper.sections.forEach((s, si) => {
    const rows = s.questions.map((q) => items.find((x) => x.qid === q.id) || { qid: q.id, given: (answers || {})[q.id] || '', got: 0 })
    const sum = (s.questions || []).reduce((n, q) => n + (Number(q.score) || 0), 0)
    const got = rows.reduce((n, r) => n + (Number(r.got) || 0), 0)
    L.push('## ' + cnNo(si) + '、' + sectionName(s) + '（每题 ' + s.score + ' 分，共 ' + sum + ' 分）')
    L.push('')
    L.push('　本大题得分：**' + score1(got) + ' / ' + sum + '**')
    L.push('')
    s.questions.forEach((q, qi) => {
      const row = rows[qi]
      questionMd(s, q, row, { no: qi + 1, answers: answers || {}, withAnswer: true }).forEach((x) => L.push(x))
    })
  })
  L.push('---')
  L.push('')
  L.push('**卷面总分：' + (graded ? score1(graded.total) : '—') + ' / ' + paper.fullScore + '**')
  L.push('')
  L.push('_' + (student ? student.name + '（' + student.sid + '）' : '') + '　由课堂系统生成：' + fmtTime(new Date().toISOString()) + '_')
  return L.join('\n')
}

/** 打印版 HTML（试卷 / 答卷共用一套样式，A4 横向留白、宋体） */
function renderHtml(ctx) {
  const { course, assignment, paper, answers, graded, gradedAt, comment, student, withAnswer } = ctx
  const isAnswerSheet = !!graded
  const esc = (s) =>
    String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  const items = (graded && graded.items) || []
  const optHtml = (section, q, picked, asAnswer) => {
    const list = optionsOf(section, q)
    if (!list.length) return ''
    const cols = markOptions(list, toLetters(section.type, picked), asAnswer)
    return '<div class="opts">' + cols.map((c) => '<span class="opt' + (c.hit ? ' hit' : '') + '">' + esc(c.ch + '. ' + c.text) + (c.hit ? '<i>' + esc(c.mark) + '</i>' : '') + '</span>').join('') + '</div>'
  }
  const secHtml = paper.sections
    .map((s, si) => {
      const rows = s.questions.map((q) => items.find((x) => x.qid === q.id) || null)
      const sum = s.questions.reduce((n, q) => n + (Number(q.score) || 0), 0)
      const got = rows.reduce((n, r) => n + (r ? Number(r.got) || 0 : 0), 0)
      const qs = s.questions
        .map((q, qi) => {
          const row = rows[qi]
          const given = row ? row.given : (answers || {})[q.id] || ''
          let extra = ''
          if (row) {
            if (s.type === 'short') {
              extra =
                '<div class="given short">' + (given ? esc(given).replace(/\n/g, '<br>') : '<span class="none">（未作答）</span>') + '</div>' +
                '<div class="mark">' + (row.pending ? '得分 <span class="pending">待老师判定</span> / ' + q.score : row.got !== undefined ? '得分 <b>' + score1(row.got) + '</b> / ' + q.score : '') + '</div>' +
                '<div class="ref">参考答案：' + esc(q.answer || '') + (row.explain ? '<br>解析：' + esc(row.explain) : '') + '</div>'
            } else {
              extra =
                '<div class="mark">作答 <b>' + esc(given || '—') + '</b>' +
                (row.ok === true ? '<span class="ok">✓</span>' : row.ok === false ? '<span class="no">✗</span>' : '') +
                '　得分 <b>' + score1(row.got) + '</b> / ' + q.score +
                (row.ok === false ? '　正确答案 <b>' + esc(q.answer) + '</b>' : '') +
                '</div>'
            }
          } else if (withAnswer) {
            extra = '<div class="ref">参考答案：' + esc(q.answer || '') + (q.explain ? '<br>解析：' + esc(q.explain) : '') + '</div>'
          }
          return (
            '<div class="q">' +
            '<div class="stem"><b>' + (qi + 1) + '.</b> ' + esc(q.stem) + '</div>' +
            optHtml(s, q, given, false) +
            extra +
            '</div>'
          )
        })
        .join('')
      return (
        '<section>' +
        '<h2>' +
        cnNo(si) + '、' + esc(sectionName(s)) +
        '<span class="meta">（每题 ' + s.score + ' 分，共 ' + sum + ' 分）' +
        (isAnswerSheet ? '　本大题得分 <b>' + score1(got) + '</b> / ' + sum : '　得分 ＿＿＿＿＿＿') +
        '</span></h2>' +
        qs +
        '</section>'
      )
    })
    .join('')

  const title = (paper.title || '机试') + (isAnswerSheet ? ' · 答卷' : withAnswer ? ' · 试卷（含答案）' : ' · 试卷')
  const info = isAnswerSheet
    ? [
        ['课程', course || '—'],
        ['考试', assignment.title || paper.title],
        ['班级', (student && student.className) || '—'],
        ['学号', (student && student.sid) || ''],
        ['姓名', (student && student.name) || ''],
        ['交卷', fmtTime(gradedAt)],
      ]
    : [
        ['课程', course || '—'],
        ['考试', assignment.title || paper.title],
        ['班级', '　　　　　　'],
        ['学号', '　　　　　　'],
        ['姓名', '　　　　　　'],
        ['日期', '　　　　　　'],
      ]
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  body { font: 14px/1.9 "SimSun", "宋体", serif; color: #111; max-width: 820px; margin: 0 auto; padding: 18px; }
  h1 { font-size: 21px; text-align: center; margin: 0 0 4px; letter-spacing: 2px; }
  .sub { text-align: center; color: #444; font-size: 12.5px; margin-bottom: 14px; }
  table.info { width: 100%; border-collapse: collapse; margin-bottom: 6px; font-size: 13px; }
  table.info td { border: 1px solid #333; padding: 5px 8px; }
  table.info td.k { width: 62px; background: #f4f4f2; text-align: center; }
  .score { float: right; border: 1px solid #333; padding: 4px 10px; margin: 6px 0 12px; font-size: 13px; }
  .score b { font-size: 19px; }
  .note { font-size: 12.5px; color: #333; border-left: 3px solid #bbb; padding: 4px 10px; margin: 10px 0; background: #fafaf8; }
  section { margin-top: 16px; }
  h2 { font-size: 15px; margin: 0 0 6px; border-bottom: 1px solid #999; padding-bottom: 4px; }
  h2 .meta { font-weight: normal; font-size: 12.5px; color: #444; }
  .q { margin: 10px 0 14px; border-bottom: 1px dashed #ddd; padding-bottom: 8px; }
  .stem { font-size: 13.5px; }
  .opts { display: flex; flex-wrap: wrap; gap: 4px 22px; margin: 4px 0 2px 14px; font-size: 13px; }
  .opt.hit { font-weight: bold; }
  .opt.hit i { color: #1d4ed8; font-style: normal; font-size: 12px; }
  .mark { font-size: 13px; color: #222; margin-left: 14px; }
  .mark b { font-size: 14px; }
  .ok { color: #15803d; font-weight: bold; margin-left: 6px; }
  .no { color: #b91c1c; font-weight: bold; margin-left: 6px; }
  .given.short { margin: 4px 0 0 14px; padding: 6px 10px; border: 1px dashed #c9c9c4; background: #fcfcfa; font-size: 13px; }
  .none { color: #999; }
  .pending { color: #b45309; font-size: 12.5px; }
  .ref { margin: 4px 0 0 14px; font-size: 12.5px; color: #555; }
  .total { margin-top: 18px; border: 2px solid #333; padding: 8px 12px; font-size: 15px; }
  .total b { font-size: 21px; }
  .comment { margin-top: 10px; font-size: 13px; }
  .comment .txt { border: 1px solid #ccc; padding: 8px 10px; min-height: 46px; background: #fcfcfa; }
  footer { margin-top: 18px; font-size: 11.5px; color: #888; text-align: right; }
  @media print { body { padding: 0; } .q { break-inside: avoid; } }
</style></head>
<body>
<h1>${esc(paper.title || '机试')}</h1>
<div class="sub">${isAnswerSheet ? '答 卷' : '试 卷'}　满分 ${paper.fullScore} 分${paper.duration ? '　限时 ' + paper.duration + ' 分钟' : ''}</div>
<table class="info">${[0, 2, 4].map((i) => '<tr>' + [info[i], info[i + 1]].map(([k, v]) => '<td class="k">' + esc(k) + '</td><td>' + esc(v) + '</td>').join('') + '</tr>').join('')}</table>
${isAnswerSheet ? '<div class="score">卷面得分 <b>' + score1(graded.total) + '</b> / ' + paper.fullScore + '<br><span style="font-size:12px">客观 ' + score1(graded.autoScore) + ' + 主观 ' + score1(graded.manualScore) + '</span></div>' : '<div style="clear:both"></div>'}
${assignment.note ? '<div class="note">说明：' + esc(assignment.note) + '</div>' : ''}
${secHtml}
${isAnswerSheet ? '<div class="total">卷面总分：<b>' + score1(graded.total) + '</b> / ' + paper.fullScore + ' 分</div>' : ''}
${comment ? '<div class="comment">老师评语：<div class="txt">' + esc(comment).replace(/\n/g, '<br>') + '</div></div>' : ''}
<footer>课堂系统生成 ${esc(fmtTime(new Date().toISOString()))}${student ? '　' + esc(student.sid + ' ' + student.name) : ''}</footer>
</body></html>`
}

/* ---------------- 落盘位置 ---------------- */

/** 考试的目录：students/<班级>/<学号>/机试/<作业id>/<提交id>/ */
function examDir(classId, sid, assignmentId, submissionId) {
  return path.join(
    students.subOf(classId, sid, 'exam'),
    students.safeSeg(assignmentId),
    students.safeSeg(submissionId)
  )
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return fallback
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

/** 试卷源文件（老师上传的那份），按作业存 */
function sourceFile(assignmentId) {
  return path.join(config.dataDir, 'exams', students.safeSeg(assignmentId) + '.json')
}

module.exports = {
  TYPES,
  TYPE_NAME,
  normalize,
  validate,
  paperFor,
  publicPaper,
  judgeAnswer,
  autoGrade,
  sectionName,
  printPaper,
  renderPaperMd,
  renderReport,
  renderHtml,
  examDir,
  sourceFile,
  readJson,
  writeJson,
  normText,
}
