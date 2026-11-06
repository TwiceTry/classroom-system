/*
 * pgTree.js —— Playground 文件树的分组逻辑（纯函数，无 DOM，方便单测）
 *
 * 独立版 playground 的核心体验之一：文件树不是一堆平铺文件，而是**按页面分组**——
 * 一组 = 一个 HTML 页面 + 它的入口 + 入口 import 链上的源码。
 * 这样学生点 `Watch.vue` 时知道自己在改哪个页面，切换页面时也知道哪些文件跟着走。
 *
 * 归属靠四条线索（与独立版一致）：
 *   1) 页面上 `<script src="..sfc-boot.js" data-entry="lab.mjs">` 声明的入口；
 *   2) 入口里的 import / export ... from / import() 递归下去；
 *   3) 同名文件（`q3.html` ↔ `q3.js`、`lab.html` ↔ `lab.mjs`）；
 *   4) 页面自己 <script src> / <link href> 引到的文件。
 *
 * 落单的处理：被多个页面共用 → 单独成组；谁都没引用 → 最后一组。
 */

const PAGE_RE = /\.html?$/i

export function isPage(p) {
  return PAGE_RE.test(p)
}

export function dirOf(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i + 1)
}

export function baseOf(p) {
  return p.slice(p.lastIndexOf('/') + 1)
}

export function extOf(p) {
  const b = baseOf(p)
  const i = b.lastIndexOf('.')
  return i < 0 ? '' : b.slice(i).toLowerCase()
}

export function stemOf(p) {
  const b = baseOf(p)
  const i = b.lastIndexOf('.')
  return i < 0 ? b : b.slice(0, i)
}

function joinPath(fromDir, rel) {
  const parts = (fromDir + rel).split('/')
  const out = []
  for (const seg of parts) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}

/**
 * 把 spec 解析成 bundle 内的相对路径；外链、data:、裸模块（'vue'）返回 ''
 * @param {string} fromDir    引用方所在目录（以 / 结尾，根目录传 ''）
 * @param {string} spec       源码里写的说明符
 * @param {string} [aliasBase] '@/' 别名指向的目录（Vite 工程里就是 src/）
 */
export function resolveSpec(fromDir, spec, aliasBase) {
  const raw = String(spec || '').trim()
  if (!raw) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('#')) return ''
  const clean = raw.split('?')[0].split('#')[0].replace(/\\/g, '/')
  // Vite 工程常用 '@/x' 指 src 下的文件，不然 views/ stores/ 会全部落单
  if (clean.startsWith('@/')) return joinPath(aliasBase === undefined ? fromDir : aliasBase, clean.slice(2))
  // '/src/main.js' 是 Vite 的项目根绝对路径；预览时项目根就是本课根，
  // 于是按「相对页面所在目录」处理，第 17 课那种子项目目录才能归到同一组
  if (clean.startsWith('/')) return joinPath(fromDir.replace(/\/$/, '') + '/', clean.slice(1))
  // 裸模块名（'vue'、'pinia'、'vue-router'）不是本课的文件。
  // 注意别把 'judge.css' 这种「没写 ./ 的同目录文件」也当成包名：带点的当文件。
  if (!clean.startsWith('.') && clean.indexOf('/') < 0 && clean.indexOf('.') < 0) return ''
  return joinPath(fromDir, clean)
}

/** 从 JS / MJS 源码里抽模块说明符 */
export function importsOf(text) {
  const out = []
  const push = (s) => {
    if (s && out.indexOf(s) < 0) out.push(s)
  }
  let m
  const reFrom = /\bfrom\s*['"]([^'"]+)['"]/g
  while ((m = reFrom.exec(text))) push(m[1])
  const reSide = /\bimport\s*['"]([^'"]+)['"]/g
  while ((m = reSide.exec(text))) push(m[1])
  const reDyn = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = reDyn.exec(text))) push(m[1])
  const reUrl = /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]/g
  while ((m = reUrl.exec(text))) push(m[1])
  return out
}

/** 页面里 <script src> / <link href> 引到的相对资源 */
export function refsOfPage(text) {
  const out = []
  const re = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi
  let m
  while ((m = re.exec(text))) if (out.indexOf(m[1]) < 0) out.push(m[1])
  return out
}

/** 页面里第一个 <script type="module" src="...">：原生 ESM / Vite 工程的入口 */
export function moduleEntryOfPage(text) {
  const re = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>/gi
  let m
  while ((m = re.exec(text))) {
    const s = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[0])
    if (s) return s[1]
  }
  return ''
}

/** 页面上 sfc-boot.js 的 data-entry */
export function entryOfPage(text) {
  const tag = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*sfc-boot\.js["'][^>]*>/i.exec(text)
  if (!tag) return ''
  const e = /\bdata-entry\s*=\s*["']([^"']+)["']/i.exec(tag[0])
  return e ? e[1] : ''
}

/**
 * @param {Array<{path:string,text:string}>} files
 * @returns {{groups:Array, byPath:Object<string,string[]>}}
 *   groups: [{ page, dir, entry, items: [{path, role}] }]
 *   byPath: 文件 -> 用它做预览的页面列表（点源码时用它决定预览切到哪）
 */
export function buildTree(files) {
  const list = Array.isArray(files) ? files : []
  const texts = {}
  for (const f of list) texts[f.path] = f.text

  const pages = list.map((f) => f.path).filter(isPage)

  const byPath = {}
  const claim = (p, page) => {
    if (!p || !texts[p]) return
    if (!byPath[p]) byPath[p] = []
    if (byPath[p].indexOf(page) < 0) byPath[p].push(page)
  }

  // 说明符常常省扩展名（'@/stores/portfolio'、import './router'）：
  // 依次试 原样 / 补扩展名 / 目录下的 index.*
  const pick = (p) => {
    if (!p) return ''
    if (texts[p] !== undefined) return p
    for (const tail of ['.js', '.mjs', '.vue', '.css', '.json']) {
      if (texts[p + tail] !== undefined) return p + tail
    }
    for (const tail of ['/index.js', '/index.mjs', '/index.vue']) {
      if (texts[p + tail] !== undefined) return p + tail
    }
    return ''
  }

  const groups = []
  for (const page of pages) {
    const pageDir = dirOf(page)
    const src = texts[page] || ''

    // 入口，四条线索按可靠性排：
    // 1) 页面上 data-entry（我们自己运行时的约定）
    // 2) 页面里第一个 <script type="module" src>（Vite 工程、原生 ESM 页面）
    // 3) 同目录同名 .mjs / .js
    // 4) main.mjs / main.js
    let entry = pick(resolveSpec(pageDir, entryOfPage(src)))
    if (!entry) entry = pick(resolveSpec(pageDir, moduleEntryOfPage(src)))
    if (!entry) {
      for (const c of [stemOf(page) + '.mjs', stemOf(page) + '.js', 'main.mjs', 'main.js']) {
        if (texts[pageDir + c] !== undefined) {
          entry = pageDir + c
          break
        }
      }
    }

    // '@/x' 指向哪：入口在 src/ 下就指 src/，否则退回页面目录
    const aliasBase = entry ? dirOf(entry) : pageDir

    const items = []
    // 页面自己引到的资源（style.css、单独的 script 之类）
    for (const r of refsOfPage(src)) {
      const p = pick(resolveSpec(pageDir, r))
      if (p && p !== page && items.indexOf(p) < 0) items.push(p)
    }
    if (entry && items.indexOf(entry) < 0) items.push(entry)

    // 从入口沿 import 链往下
    const queue = entry ? [entry] : []
    const seen = {}
    while (queue.length) {
      const cur = queue.shift()
      if (seen[cur]) continue
      seen[cur] = 1
      for (const spec of importsOf(texts[cur] || '')) {
        const p = pick(resolveSpec(dirOf(cur), spec, aliasBase))
        if (p && p !== page) {
          if (items.indexOf(p) < 0) items.push(p)
          queue.push(p)
        }
      }
    }

    // 同名文件：q3.html ↔ q3.js
    const twin = pageDir + stemOf(page) + '.js'
    if (texts[twin] !== undefined && items.indexOf(twin) < 0) items.push(twin)

    // npm 工程的项目级文件（页面不会 import 它们，但学生会想找）
    for (const extra of ['package.json', 'vite.config.js', 'vite.config.mjs']) {
      if (texts[pageDir + extra] !== undefined && items.indexOf(pageDir + extra) < 0) items.push(pageDir + extra)
    }

    for (const it of items) claim(it, page)
    groups.push({ page, dir: pageDir, entry, items })
  }

  // 把跨页面共用的文件从各组里摘出来单独成组
  const shared = []
  for (const p in byPath) {
    if (isPage(p)) continue
    if (byPath[p].length > 1) shared.push(p)
  }
  if (shared.length) {
    for (const g of groups) g.items = g.items.filter((p) => shared.indexOf(p) < 0)
  }

  const orphans = list
    .map((f) => f.path)
    .filter((p) => !isPage(p) && !byPath[p])

  const roleOf = (p) => {
    const e = extOf(p)
    if (e === '.vue') return 'vue'
    if (e === '.css') return 'css'
    if (e === '.json') return 'json'
    if (e === '.html' || e === '.htm') return 'page'
    return 'js'
  }

  const out = groups.map((g) => ({
    kind: 'page',
    page: g.page,
    dir: g.dir,
    entry: g.entry,
    items: g.items.map((p) => ({ path: p, role: roleOf(p) })),
  }))

  if (shared.length) {
    out.push({ kind: 'shared', page: '', dir: '', entry: '', items: shared.map((p) => ({ path: p, role: roleOf(p) })) })
  }
  if (orphans.length) {
    out.push({ kind: 'orphan', page: '', dir: '', entry: '', items: orphans.map((p) => ({ path: p, role: roleOf(p) })) })
  }
  return { groups: out, byPath }
}

/**
 * 一组里「默认显示」哪些文件。
 *
 * 默认把「页面」和「这一组的入口文件」藏起来 —— 它们已经显示在组标题上了；
 * 但一组里如果只有入口（补充课的 q1.js 那种），不能把整组压成空。
 *
 * 这条规则文件树和 openGroup 都要用，所以放这里，别在组件里各写一份。
 */
export function visibleItemsOf(g, showAll) {
  if (showAll) return g.items
  const vis = g.items.filter((it) => it.role !== 'page' && it.path !== g.entry)
  return vis.length ? vis : g.items.filter((it) => it.role !== 'page')
}
