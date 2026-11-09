/*
 * lecture.js —— 讲义切片
 *
 * lecture/*.md 的结构是固定的：每个 ## 小节下面成对出现
 *   ### 📺 屏幕   ← 学生 materials 的镜像（投屏/共看用，不含教学法）
 *   ### 🎤 讲稿   ← 教师向的教学法（比喻、时间提示、追问、板书）
 *
 * 于是同一个文件可以切出三种视图：
 *   screen —— 只留「屏幕」，等价于学生材料，可放心投影
 *   notes  —— 只留「讲稿」，老师课前过一遍
 *   full   —— 原样，逐段对照（默认）
 *
 * 这样做的好处：讲义与材料仍然只有一份真源（维护铁律「改一处必查三处」），
 * 系统只是换了个阅读角度，不另存副本。
 */

const RE_H2 = /^##\s+/
const RE_SCREEN = /^###\s*📺/
const RE_NOTES = /^###\s*🎤/
const RE_H3 = /^###\s+/

/**
 * 讲义切片（屏幕 / 讲稿）。
 * 当前界面不再用：讲义页改成「讲义 ↔ 课程材料」两种视图对照，
 * 因为老师更常干的是「我讲的和学生看的是不是一回事」。
 * 保留这两个函数，是为了将来要单出一份「只含 📺 屏幕、能直接投影」的视图时不用重写。
 */
export const LECTURE_MODES = [
  { key: 'full', label: '全文', tip: '屏幕 + 讲稿逐节对照（备课用）' },
  { key: 'screen', label: '屏幕', tip: '只留📺屏幕：与学生材料一致，可投影' },
  { key: 'notes', label: '讲稿', tip: '只留🎤讲稿：教学法、时间提示、追问' },
]

/** 把 md 按 ## 小节切开，再按 📺/🎤 归类 */
function parseSections(md) {
  const lines = String(md || '').split(/\r?\n/)
  const head = []
  const sections = []
  let cur = null
  let bucket = null // 'screen' | 'notes' | 'plain'

  const push = (line) => {
    if (!cur) {
      head.push(line)
      return
    }
    if (!bucket) {
      cur.plain.push(line)
      return
    }
    cur[bucket].push(line)
  }

  for (const line of lines) {
    if (RE_H2.test(line)) {
      cur = { heading: line, screen: [], notes: [], plain: [] }
      sections.push(cur)
      bucket = 'plain'
      continue
    }
    if (RE_SCREEN.test(line)) {
      // 丢掉「📺 屏幕」这行小标题本身，只留内容
      bucket = 'screen'
      continue
    }
    if (RE_NOTES.test(line)) {
      bucket = 'notes'
      continue
    }
    if (RE_H3.test(line) && bucket !== 'plain') {
      // 📺/🎤 块内部的 ### 小标题，保留以维持层级
      push(line)
      continue
    }
    push(line)
  }

  return { head, sections }
}

export function sliceLecture(md, mode) {
  if (!mode || mode === 'full') return String(md || '')

  const { head, sections } = parseSections(md)
  const out = []

  if (mode === 'screen') {
    // 屏幕视图要能直接投影：开头那段元信息（周次 / 目标 / 重点难点 / 作业）
    // 是教师向内容，必须整块丢掉，只留一级标题。
    const title = head.find((l) => /^#\s+/.test(l))
    if (title) out.push(title)
  } else if (head.join('').trim()) {
    out.push(head.join('\n'))
  }

  for (const s of sections) {
    const body = mode === 'screen' ? s.screen : s.notes
    const hasMarker = s.screen.length > 0 || s.notes.length > 0
    // 屏幕视图：只要拿到「屏幕」内容的小节（时间分配 / 课后记这类教师小节自动消失）
    // 讲稿视图：没有标记的小节也保留（如时间分配总览，老师要对着看）
    if (mode === 'screen' && !s.screen.some((l) => l.trim())) continue
    if (mode === 'notes' && hasMarker && !s.notes.some((l) => l.trim())) continue

    out.push(s.heading)
    if (!hasMarker) {
      out.push(s.plain.join('\n'))
    } else {
      out.push(body.join('\n'))
    }
  }

  return out.join('\n').replace(/^#\s*(.+?)（教师讲稿）\s*$/m, '# $1')
}

/* ------------------------------------------------------------------
 * 小节节点（讲义与课程材料同步的锚点）
 *
 * 讲义与 materials 本来就是一节对一节的（lecture 的 📺 屏幕就是 materials 的镜像），
 * 所以用二级标题文本做锚点最自然：同一句话在两份文件里写的是同一个标题。
 *
 * 归一化只做「不影响语义」的处理：去 Markdown 标记、全角/半角冒号、空白。
 * emoji 保留 —— 两边标题里的 emoji 也是一致的，去掉反而容易撞车。
 * ---------------------------------------------------------------- */

/** 标题末尾的显式锚点：`## 标题 {#08-props}` */
export const RE_ANCHOR = /\{#([A-Za-z0-9_-]{1,40})\}\s*$/

export function normHeading(text) {
  return String(text == null ? '' : text)
    // 先还原实体、再剥标签 —— 顺序不能反。
    // 渲染后的标题里，行内代码 `<script setup>` 变成了 `&lt;script setup&gt;`：
    // 先剥标签（此刻还没还原）就白剥一次，还原之后又把它当标签剥掉，
    // 而材料那边是原文的 `<script setup>`，一个被剥、一个没剥，标题就永远对不上。
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '') // 渲染后的 HTML 里可能带 <code>；正文里写字面尖括号也被当标记忽略
    .replace(/[*`_]/g, '') // 加粗 / 行内代码标记
    .replace(/\{#([A-Za-z0-9_-]{1,40})\}\s*$/, '') // 兼容旧写法：锚点标记不参与比对
    .replace(/[：:]/g, ' ') // 全角半角冒号一视同仁
    .replace(/（/g, '(') // 括号形状不参与比对，但括号里的字算
    .replace(/）/g, ')')
    .replace(/\s+/g, '') // 空白（含中英文空格）全部忽略
    .toLowerCase() // 英文大小写忽略
    .trim()
}

/* ---------- 小节配对：讲义的一节 ↔ 材料的一节 ----------
 * 约定（见 课堂系统/docs/内容规范.md §4）：**两侧标题写一样就是同一节**，不加任何标记。
 * 所以判等用 normHeading（忽略空白/冒号/括号形状/行内标记/英文大小写），
 * 跳转只认「完全相同」。
 *
 * 下面这套相似度只用来做一件事：当某节对不上时，告诉老师「材料里最像的是哪个」，
 * 好让他知道该改哪边。**绝不拿它去跳转** —— 跳到隔壁比不跳更糟。
 */
const EMOJI_ONE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u
const EMOJI_ALL = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu

function stripMarks(text) {
  return String(text == null ? '' : text)
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, ' ')
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
  if (t.length <= 1) {
    if (t) out.add(t)
    return out
  }
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

/** 两个标题有多像：0~1（仅用于「最接近的那节」提示） */
export function sectionScore(lectureTitle, materialsTitle) {
  const le = (String(lectureTitle).match(EMOJI_ONE) || [''])[0]
  const me = (String(materialsTitle).match(EMOJI_ONE) || [''])[0]
  const lc = stripMarks(lectureTitle).replace(EMOJI_ALL, '').trim()
  const mc = stripMarks(materialsTitle).replace(EMOJI_ALL, '').trim()
  if (!lc || !mc) return 0
  let d = lc === mc ? 1 : dice(lc, mc)
  // 两边都有 emoji 却不一样（📺 vs 🎤 之类），说明很可能是两件不同的事
  if (le && me && le !== me) d *= 0.55
  return d
}

/**
 * 在材料小节里找「最接近」的那一个 —— 只用于提示，不用于跳转。
 *
 * 跳转只认「标题完全相同」（见 normHeading）：宁可这一节不跳，
 * 也不能把学生带到隔壁去，那比不跳更糟。
 */
export function closestHeading(title, materialsHeadings) {
  let best = null
  let bestScore = 0
  for (const h of materialsHeadings || []) {
    const s = sectionScore(title, h.title)
    if (s > bestScore) {
      bestScore = s
      best = h
    }
  }
  return bestScore >= 0.45 ? best : null
}

/** 讲义里的「屏幕 / 讲稿」是结构标记，不是内容节点，不参与同步 */
export function isStructuralHeading(title) {
  // 必须带 u：字符类里放 emoji 时，没有 u 会退化成「代理码位集合」，
  // 结果所有 emoji 开头的标题都会被误当成结构标记。
  return /^[📺🎤]/u.test(String(title || '').trim())
}

/**
 * 取文档里的同步节点标题：## / ### / #### / ##### / ######，跳过代码块里的。
 * 返回 { level, id, title, key }：
 *   - 层级只影响排版，**不参与匹配**：讲义 📺 里用 ####、材料里用 ###，标题一样就算同一节
 *   - 写了 `{#xx}` 的（旧写法，已不推荐），id = xx、key = xx
 *   - 没写的，key = 归一化标题
 *   - `📺 / 🎤` 开头的结构标记直接跳过
 */
export function mdHeadings(md) {
  const text = String(md || '').replace(/```[\s\S]*?```/g, '')
  const out = []
  const re = /^(#{2,6})\s+(.+)$/gm
  let m
  while ((m = re.exec(text))) {
    const raw = m[2].trim()
    if (isStructuralHeading(raw)) continue
    const hit = RE_ANCHOR.exec(raw)
    const id = hit ? hit[1] : ''
    const title = hit ? raw.slice(0, hit.index).trim() : raw
    out.push({ level: m[1].length, id, title, key: id || normHeading(title) })
  }
  return out
}

/** 文档首行标题（用于侧栏 / 面包屑） */
export function docTitle(md) {
  const m = /^#\s+(.+)$/m.exec(String(md || ''))
  return m ? m[1].trim() : ''
}

/** 粗略统计（字数 + 预计讲授时长） */
export function docStats(md) {
  const text = String(md || '')
  const chars = text.replace(/\s/g, '').length
  return { chars, minutes: Math.max(1, Math.round(chars / 400)) }
}
