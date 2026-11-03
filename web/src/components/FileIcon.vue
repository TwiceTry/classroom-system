<template>
  <svg
    class="ficon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    role="img"
    :aria-label="hint"
  >
    <title>{{ hint }}</title>

    <!-- Vue：官方那枚「双层 V」标志 -->
    <template v-if="kind === 'vue'">
      <path d="M2 4h4.4L12 13.4 17.6 4H22L12 20.6z" fill="#41b883" />
      <path d="M7.4 4h2.7L12 7.3 13.9 4h2.7L12 11.2z" fill="#35495e" />
    </template>

    <!-- HTML：橙色 </>（和编辑器里"标签"的样子一致） -->
    <template v-else-if="kind === 'html'">
      <path
        d="M8.6 8.4 4.8 12l3.8 3.6M15.4 8.4 19.2 12l-3.8 3.6M13.4 6.9l-2.8 10.2"
        fill="none"
        stroke="#e0490f"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>

    <!-- CSS：蓝色 #（样式表最直观的记号） -->
    <template v-else-if="kind === 'css'">
      <path
        d="M10 6.5 8.8 17.5M16 6.5l-1.2 11M6.6 10h11M6 14h11"
        fill="none"
        stroke="#1572b6"
        stroke-width="2"
        stroke-linecap="round"
      />
    </template>

    <!-- JS / MJS：编辑器里那块黄底 JS（VS Code 也是一块黄） -->
    <template v-else-if="kind === 'js'">
      <rect x="2.5" y="2.5" width="19" height="19" rx="3.2" fill="#f2d024" />
      <text
        x="12"
        y="17.2"
        text-anchor="middle"
        font-family="Consolas, 'Cascadia Mono', monospace"
        font-size="9.5"
        font-weight="700"
        fill="#2b2b23"
      >JS</text>
    </template>

    <!-- JSON：琥珀色花括号 -->
    <template v-else-if="kind === 'json'">
      <path
        d="M9.8 4.2c-2.5 0-3.4 1.2-3.4 3.1v1.9c0 1.6-.8 2.3-2.5 2.3 1.7 0 2.5.7 2.5 2.3v1.9c0 1.9.9 3.1 3.4 3.1M14.2 4.2c2.5 0 3.4 1.2 3.4 3.1v1.9c0 1.6.8 2.3 2.5 2.3-1.7 0-2.5.7-2.5 2.3v1.9c0 1.9-.9 3.1-3.4 3.1"
        fill="none"
        stroke="#c08a12"
        stroke-width="2.1"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>

    <!-- Markdown：M↓（和 Markdown 官方标一致） -->
    <template v-else-if="kind === 'md'">
      <path
        d="M4.4 17.2V7.4l3.6 4.4 3.6-4.4v9.8M16.6 7.4v7.1M13.9 12.4l2.7 2.8 2.7-2.8"
        fill="none"
        stroke="#4a7ba6"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>

    <!-- 图片：相框 + 山 + 太阳 -->
    <template v-else-if="kind === 'img'">
      <rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.4" fill="none" stroke="#a259c4" stroke-width="1.8" />
      <circle cx="8.4" cy="9.6" r="1.7" fill="#a259c4" />
      <path
        d="M4.6 17.4l4.7-4.9 3.3 3.3 2.5-2.3 4.3 3.9"
        fill="none"
        stroke="#a259c4"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>

    <!-- 兜底：一张纸 -->
    <template v-else>
      <path
        d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"
        fill="none"
        stroke="#8492a6"
        stroke-width="1.8"
        stroke-linejoin="round"
      />
      <path d="M14 3v5h5" fill="none" stroke="#8492a6" stroke-width="1.8" stroke-linejoin="round" />
    </template>
  </svg>
</template>

<script setup>
/*
 * FileIcon —— 文件类型图标
 *
 * 跟着主流编辑器的习惯走（VS Code / JetBrains 那套），不用「字母小牌子」：
 *   .vue  → 官方绿色双层 V 标志
 *   .html → 橙色 </>
 *   .css  → 蓝色 #
 *   .js   → 黄底 JS（.mjs 显示 M）
 *   .json → 琥珀色花括号
 *   .md   → M↓（Markdown 官方标）
 *   图片  → 相框 + 山 + 太阳（紫色）
 * 全部是矢量图形（不是文字），16px 下也锐利；颜色压暗一档，浅底上不刺眼。
 */
import { computed } from 'vue'

const props = defineProps({
  path: { type: String, default: '' },
  size: { type: [Number, String], default: 16 },
})

const NAMES = {
  vue: 'Vue 组件',
  html: 'HTML 页面',
  css: '样式表',
  js: 'JavaScript',
  json: 'JSON 数据',
  md: 'Markdown 文档',
  img: '图片',
  other: '文件',
}

const ext = computed(() => {
  const p = String(props.path || '')
  const i = p.lastIndexOf('.')
  return i < 0 ? '' : p.slice(i + 1).toLowerCase()
})

const kind = computed(() => {
  const e = ext.value
  if (e === 'vue') return 'vue'
  if (e === 'html' || e === 'htm') return 'html'
  if (e === 'css' || e === 'scss' || e === 'less') return 'css'
  if (e === 'js' || e === 'mjs' || e === 'cjs' || e === 'ts') return 'js'
  if (e === 'json') return 'json'
  if (e === 'md' || e === 'markdown') return 'md'
  if (['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico'].indexOf(e) >= 0) return 'img'
  return 'other'
})

const hint = computed(() => NAMES[kind.value] + (ext.value ? '（.' + ext.value + '）' : ''))
</script>

<style scoped>
.ficon {
  display: block;
  flex: 0 0 auto;
  overflow: visible;
}
</style>
