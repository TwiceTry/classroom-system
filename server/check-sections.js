'use strict'
/*
 * check-sections.js —— 检查「讲义 ↔ 课程材料」的同步节点
 *
 * 约定见 ../../小节锚点约定.md。两条：
 *   1) 两侧标题写成同一个（忽略空白 / 冒号 / 括号形状 / 行内标记 / 英文大小写）即同一节点；
 *      层级不参与匹配（讲义 📺 里用 ####、材料里用 ### 也算同一个）。
 *   2) 讲义里带 `### 📺 屏幕` 的节，材料里必须有同名标题；软约束：最小叶子节点最好一屏讲完。
 *
 * 用法：
 *   node server/check-sections.js             # 检查
 *   node server/check-sections.js --report    # 顺带生成「小节待改清单.md」
 *
 * 退出码：有错误 1，其余 0（软约束只提醒，不算错）。
 */
const fs = require('fs')
const path = require('path')
const content = require('./lib/content')

/* 软约束阈值：超过就当「一屏讲不完」提醒（不是错误） */
const MAX_CHARS = 900
const MAX_CODES = 3

/* ---------- 归一化：与前端 utils/lecture.js 的 normHeading 保持一致 ---------- */

function norm(title) {
  return String(title == null ? '' : title)
    // 顺序同前端：先还原实体、再剥标签（正文里的字面 <...> 与渲染后的 &lt;...&gt; 一视同仁）
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .replace(/[*`_]/g, '')
    .replace(/\{#([A-Za-z0-9_-]{1,40})\}\s*$/, '')
    .replace(/[：:]/g, ' ')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/\s+/g, '')
    .toLowerCase()
    .trim()
}

const EMOJI_ONE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u
const EMOJI_ALL = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu

function stripMarks(text) {
  return String(text == null ? '' : text)
    .replace(/<[^>]+>/g, '')
    .replace(/[*`_]/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/「[^」]*」/g, '')
    .replace(/[：:]/g, ' ')
    .replace(/[·、,，。;；!！?？/\\|—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function bigrams(s) {
  const t = String(s).replace(/\s+/g, '')
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

function dice(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let n = 0
  for (const x of A) if (B.has(x)) n++
  return (2 * n) / (A.size + B.size)
}

function similarity(a, b) {
  const ea = (String(a).match(EMOJI_ONE) || [''])[0]
  const eb = (String(b).match(EMOJI_ONE) || [''])[0]
  const ca = stripMarks(a).replace(EMOJI_ALL, '').trim()
  const cb = stripMarks(b).replace(EMOJI_ALL, '').trim()
  if (!ca || !cb) return 0
  let d = ca === cb ? 1 : dice(ca, cb)
  if (ea && eb && ea !== eb) d *= 0.55
  return d
}

/* ---------- 解析 ---------- */

// 注意必须带 u 标志：字符类里放 emoji 时，没有 u 会退化成「代理码位集合」，
// 结果是所有 emoji 开头的标题都被误判成结构标记。
const isStructural = (t) => /^[📺🎤]/u.test(String(t || '').trim())

/**
 * 讲义：`##` 是一级节点（带 📺 的才同步）；`###` / `####` 是它拆出来的细节点，
 * 只有落在 `### 📺 屏幕` 桶里的才算（`🎤 讲稿` 里的是讲法，不同步）。
 *
 * 细节点用 `###` 还是 `####` 都行 —— 层级不参与匹配，两侧标题一样就是同一个节点。
 * 约定推荐用 `####`：`###` 与 `📺 / 🎤` 同层，人看着容易混。
 */
function parseLecture(md) {
  const text = String(md || '').replace(/```[\s\S]*?```/g, '')
  const nodes = []
  let section = null
  let bucket = 'body'
  for (const line of text.split(/\r?\n/)) {
    const h = /^(#{2,4})\s+(.+)$/.exec(line)
    if (!h) continue
    const level = h[1].length
    const raw = h[2].trim()
    if (level === 2) {
      section = { level: 2, title: raw, key: norm(raw), sync: false }
      nodes.push(section)
      bucket = 'body'
      continue
    }
    if (isStructural(raw)) {
      if (/^📺/.test(raw)) {
        bucket = 'screen'
        if (section) section.sync = true
      } else {
        bucket = 'notes'
      }
      continue
    }
    // `###` / `####` 都算细节点：只要在 📺 桶里、且不是结构标记
    nodes.push({ level, title: raw, key: norm(raw), sync: bucket === 'screen' })
  }
  return nodes.filter((n) => n.sync)
}

/** 材料：## / ### / #### 全是同步节点 */
function parseMaterials(md) {
  const text = String(md || '').replace(/```[\s\S]*?```/g, '')
  return text
    .split(/\r?\n/)
    .map((line) => /^(#{2,4})\s+(.+)$/.exec(line))
    .filter(Boolean)
    .filter((h) => !isStructural(h[2]))
    .map((h) => ({ level: h[1].length, title: h[2].trim(), key: norm(h[2]) }))
}

/** 每个节点自己的正文规模（到下一个任意级标题为止），只统计叶子节点 */
function leafSizes(md) {
  const lines = String(md || '').split(/\r?\n/)
  const heads = []
  lines.forEach((line, i) => {
    const h = /^(#{2,4})\s+(.+)$/.exec(line)
    if (h && !isStructural(h[2])) heads.push({ i, level: h[1].length, title: h[2].trim() })
  })
  const out = []
  heads.forEach((h, k) => {
    const next = heads[k + 1]
    const isLeaf = !next || next.level <= h.level ? true : false
    if (!isLeaf) return
    const body = lines.slice(h.i + 1, next ? next.i : lines.length)
    const text = body.join('\n')
    out.push({
      title: h.title,
      level: h.level,
      chars: text.replace(/\s/g, '').length,
      codes: (text.match(/^```/gm) || []).length / 2,
      lines: body.filter((l) => l.trim()).length,
    })
  })
  return out
}

/* ---------- 主流程 ---------- */

function main() {
  const wantReport = process.argv.indexOf('--report') >= 0
  const lessons = content.listLessons()

  let errors = 0
  let warns = 0
  let soft = 0
  let okLessons = 0
  let checked = 0
  let totalSync = 0
  let totalMatched = 0

  const report = []
  const softest = []

  console.log('')
  console.log('同步节点检查（同一标题即同一节点；讲义带 ### 📺 的节必须有同名材料节点）')
  console.log('='.repeat(74))

  for (const l of lessons) {
    if (!l.lecture || !l.materials) continue
    checked++
    const leMd = content.getDoc('lecture', l.id).markdown
    const maMd = content.getDoc('materials', l.id).markdown
    const L = parseLecture(leMd)
    const M = parseMaterials(maMd)
    const mKeys = new Set(M.map((m) => m.key))
    const lKeys = new Set(L.map((x) => x.key))

    const problems = []
    const notes = []

    for (const x of L) {
      if (mKeys.has(x.key)) continue
      let best = null
      let bs = 0
      for (const m of M) {
        const s = similarity(x.title, m.title)
        if (s > bs) {
          bs = s
          best = m
        }
      }
      const hint = best && bs >= 0.45 ? '（材料里最接近：「' + best.title + '」）' : ''
      problems.push((x.level > 2 ? 'H' + x.level + ' ' : '') + '讲义「' + x.title + '」材料里没有同名标题' + hint)
    }
    for (const m of M) {
      if (!lKeys.has(m.key)) notes.push('材料「' + m.title + '」讲义里没有同名标题（材料独有则忽略）')
    }

    const matched = L.filter((x) => mKeys.has(x.key)).length
    totalSync += L.length
    totalMatched += matched

    // 软约束：叶子节点太大 = 一屏讲不完 = 学生端只能整段跳
    for (const leaf of leafSizes(maMd)) {
      if (leaf.chars <= MAX_CHARS && leaf.codes <= MAX_CODES) continue
      soft++
      softest.push({ lesson: l, ...leaf })
    }

    const name = (l.kind === 'lesson' ? '第' + String(l.no).padStart(2, '0') + '课 ' : '') + l.title
    console.log(
      '\n' + name + '\n  讲义同步节点 ' + L.length + ' · 材料节点 ' + M.length + ' · 已对齐 ' + matched
    )
    if (problems.length) {
      errors += problems.length
      for (const p of problems) console.log('  ✗ ' + p)
    }
    if (notes.length) {
      warns += notes.length
      for (const n of notes) console.log('  · ' + n)
    }
    if (!problems.length) okLessons++

    if (problems.length) {
      report.push('## ' + name + '\n')
      for (const p of problems) report.push('- [ ] ' + p)
      report.push('')
    }
  }

  console.log('\n' + '='.repeat(74))
  console.log('课程 ' + checked + ' 门 · 无错误 ' + okLessons + ' · 错误 ' + errors + ' · 提醒 ' + warns)
  console.log(
    '同步节点 ' + totalSync + ' · 已对齐 ' + totalMatched +
      (totalSync ? '（' + Math.round((totalMatched / totalSync) * 100) + '%）' : '')
  )

  if (soft) {
    softest.sort((a, b) => b.chars - a.chars)
    console.log('\n软约束：以下叶子节点超过一屏（> ' + MAX_CHARS + ' 字 或 > ' + MAX_CODES + ' 个代码块），建议拆下一级标题：')
    for (const s of softest.slice(0, 10)) {
      console.log(
        '  · 第' + String(s.lesson.no).padStart(2, '0') + '课「' + s.title + '」' +
          s.chars + ' 字 / ' + Math.round(s.codes) + ' 个代码块'
      )
    }
    if (softest.length > 10) console.log('  …共 ' + softest.length + ' 处，完整清单见 --report')
  }

  if (errors) console.log('\n有 ' + errors + ' 处标题对不上。改法：两侧改成同一个（建议以材料为准，改讲义标题）。')
  else if (!totalSync) console.log('\n没有找到需要同步的节点：请检查讲义是否有 ### 📺 屏幕。')
  else console.log('\n同步节点全部对齐。')

  if (wantReport) {
    const file = path.join(__dirname, '..', '..', '小节待改清单.md')
    const softLines = softest.map(
      (s) =>
        '- [ ] 第' + String(s.lesson.no).padStart(2, '0') + '课「' + s.title + '」' +
        s.chars + ' 字 / ' + Math.round(s.codes) + ' 个代码块（建议拆子标题）'
    )
    const out =
      '# 小节待改清单\n\n' +
      '> 由 `node server/check-sections.js --report` 生成，改完重跑直到「错误 0」。\n' +
      '> 规则见 `小节锚点约定.md`。\n\n' +
      (report.length ? report.join('\n') : '_（没有待改项）_\n') +
      '\n## 软约束：超一屏的叶子节点\n\n' +
      (softLines.length ? softLines.join('\n') + '\n' : '_（没有超长节点）_\n')
    try {
      fs.writeFileSync(file, out, 'utf8')
      console.log('\n已生成待改清单：' + file)
    } catch (e) {
      console.log('\n清单写入失败：' + e.message)
    }
  }

  process.exit(errors ? 1 : 0)
}

main()
