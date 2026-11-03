<template>
  <div ref="root" class="md" v-html="html"></div>
</template>

<script setup>
/*
 * MdView —— Markdown 渲染（mdReader 的基础能力，搬到系统里）
 *
 * 三件必须离线可做的事：
 *   1) marked 本地渲染（index.html 里已用 /vendor/marked.min.js 引入）；
 *   2) ```mermaid 代码块 → 图，mermaid 只在真出现图时才懒加载（3.2MB，不常驻）；
 *   3) 外链一律新窗口打开，避免把 SPA 顶掉。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { normHeading } from '../utils/lecture'

const props = defineProps({
  source: { type: String, default: '' },
})

const root = ref(null)

const html = computed(() => render(props.source))

watch(
  () => props.source,
  () => nextTick(drawMermaid)
)
onMounted(() => nextTick(drawMermaid))

function render(src) {
  const text = String(src || '')
  if (!text.trim()) return ''
  const marked = window.marked
  if (!marked || typeof marked.parse !== 'function') {
    return '<pre>' + escapeHtml(text) + '</pre>'
  }
  const out = marked.parse(text, { gfm: true, breaks: false })
  return (
    String(out)
      // 二~四级标题都可能是同步节点：讲义 📺 里用 ####、材料里用 ###，标题一样即可对上。
      // `📺 / 🎤` 是结构标记，不打点。
      .replace(/<h([2-4])>([\s\S]*?)<\/h\1>/g, (m, lv, inner) => {
        const text = inner.replace(/<[^>]+>/g, '')
        if (/^[📺🎤]/u.test(text.trim())) return m
        const hit = /\{#([A-Za-z0-9_-]{1,40})\}\s*$/.exec(text)
        if (hit) {
          const clean = inner.replace(/\s*\{#[A-Za-z0-9_-]{1,40}\}\s*$/, '')
          return '<h' + lv + ' data-sec="' + attr(hit[1]) + '">' + clean + '</h' + lv + '>'
        }
        // 必须转义：标题里出现英文双引号（如「穿三件"衣服"」）会把属性提前截断，
        // 后面的文字变成一堆假属性，data-sec 只剩前半截，于是永远对不上材料。
        return '<h' + lv + ' data-sec="' + attr(normHeading(text)) + '">' + inner + '</h' + lv + '>'
      })
      .replace(
        /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
        (m, code) => '<div class="mermaid">' + code + '</div>'
      )
      .replace(/<a\s+href="(https?:[^"]+)"/g, '<a target="_blank" rel="noopener" href="$1"')
  )
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 写进 HTML 属性里：& 先转，再转引号与尖括号（dataset 读出来会自动还原） */
function attr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

let mermaidPromise = null

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid)
  if (!mermaidPromise) {
    mermaidPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = '/vendor/mermaid.min.js'
      s.onload = () => {
        try {
          window.mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' })
        } catch (e) {
          /* 老版本没有 initialize 也能跑 */
        }
        resolve(window.mermaid)
      }
      s.onerror = () => reject(new Error('mermaid 加载失败'))
      document.head.appendChild(s)
    })
  }
  return mermaidPromise
}

async function drawMermaid() {
  const el = root.value
  if (!el) return
  const nodes = Array.prototype.slice.call(el.querySelectorAll('.mermaid'))
  if (!nodes.length) return
  // 已经画过的（有 svg）跳过，避免重复渲染
  const todo = nodes.filter((n) => !n.querySelector('svg') && !n.dataset.rendered)
  if (!todo.length) return

  try {
    const mermaid = await loadMermaid()
    todo.forEach((n) => (n.dataset.rendered = '1'))
    await mermaid.run({ nodes: todo })
  } catch (e) {
    todo.forEach((n) => {
      n.classList.add('mermaid-error')
      if (!n.querySelector('svg')) n.textContent = 'Mermaid 渲染失败：' + (e && e.message ? e.message : e)
    })
  }
}
</script>
