<template>
  <!--
    所有页面的统一头部：标题 + 说明 + 工具区

    右半边的排列（**顺序改动过，原因见下**）：

        ┌─ 页面专属（各页 #right）─┐ ┌─ 通用工具（全站固定）─┐
        │ [作业目录] [＋新建作业]   │ │ A− 15 A+  ↻  ⛶  ↑   │
        └──────────────────────────┘ └──────────────────────┘

    为什么把通用工具放到**最右**：
      原来它在左边、专属区在右边。而专属按钮各页数量不同（讲义 6 个、
      我的分数 0 个），于是通用工具的位置跟着页面左右横跳 ——
      切页时那几个图标总在动，眼睛得重新找。
      现在通用区贴着右边界、宽度恒定（4 个图标 + 字号组，尺寸都写死），
      它的位置**只由窗口宽度决定**，跟哪一页无关。
      专属区在它左边，数量变化时向**左**长，不推它。

    图标的另外两条规矩（也是这次改的）：
      · 一律用内联 SVG，不用 ↻ ⛶ ↑ 这种字符 —— 字符的字形和宽度取决于系统字体，
        Windows / macOS / 安卓各不相同，一排图标对不齐
      · **不能用时也存在，只是 disabled** —— 刷新按钮原来用 v-if，
        没注册 @reload 的页根本不渲染它，于是那一排又短一截、又跳一次

    用法：
      <PageHead @reload="loadAll">
        <template #title>考核方案</template>
        <template #sub>有哪些考核项、各占多少分……</template>
        <template #right><button class="btn mini">保存</button></template>
      </PageHead>

    刷新：各页可以注册自己的重载函数，避免 location.reload() 把没保存的表单冲掉。
    实现见下面 doReload()：不声明 emits，直接读 $attrs.onReload 来判断有没有人接。
  -->
  <header class="pagehead" :class="{ 'is-full': isFull }">
    <div class="head-txt">
      <h2><slot name="title" /></h2>
      <p v-if="sub || $slots.sub" class="sub"><slot name="sub">{{ sub }}</slot></p>
    </div>

    <div class="right">
      <!-- ① 页面专属区：各页自己的操作，没有就是空的（这一格仍然占位） -->
      <span class="head-page"><slot name="right" /></span>

      <!-- ② 通用工具区：四个槽位固定，不看页面 -->
      <span class="head-tools">
        <span class="tool-fs" title="全站字号：讲义、材料、代码一起变">
          <button class="btn mini" title="缩小字号" @click="adjustDoc(-1)">A−</button>
          <span class="fs-val">{{ docPx }}</span>
          <button class="btn mini" title="放大字号" @click="adjustDoc(1)">A+</button>
        </span>

        <!--
          刷新：**始终存在**，页面没接 @reload 时是 disabled（灰掉、点不动）。
          用 disabled 而不是 v-if —— 不渲染会让整排少一个格子、宽度变化，
          切页时右边的图标全跟着平移。
        -->
        <button
          class="btn mini tool-ico"
          :disabled="!$attrs.onReload"
          :title="$attrs.onReload ? '刷新这一页（只重拉数据，不动你正在填的内容）' : '这一页没有可刷新的数据'"
          @click="doReload"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path
              d="M13 8a5 5 0 1 1-1.5-3.6M13 2.6V5.2h-2.6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>

        <button
          class="btn mini tool-ico"
          :title="isFull ? '退出全屏' : '全屏（讲课 / 投屏时用）'"
          @click="toggleFull"
        >
          <svg v-if="!isFull" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path
              d="M6 2.6H2.6V6M10 2.6h3.4V6M6 13.4H2.6V10M10 13.4h3.4V10"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <svg v-else viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path
              d="M2.6 6h3.4V2.6M13.4 6H10V2.6M2.6 10h3.4v3.4M13.4 10H10v3.4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>

        <button class="btn mini tool-ico" title="回到页面顶部" @click="backToTop">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path
              d="M8 13V3.4M3.8 7.6 8 3.4l4.2 4.2"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </span>
    </div>
  </header>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, useAttrs } from 'vue'
import { useFontSize } from '../composables/useFontSize'

defineProps({
  /* 说明文字：写 slot 更灵活（可带标签/多段），只想给一句话时也可以直接传 sub */
  sub: { type: String, default: '' },
})

/*
 * 不声明 defineEmits('reload')：那样 onReload 会被 Vue 从 $attrs 里摘走，
 * 就没法判断「这一页到底接没接」。直接读 $attrs 最简单。
 */
const attrs = useAttrs()

/** 字号：全站一个值，控件只在这一处 */
const { docPx, adjustDoc } = useFontSize()

/**
 * 刷新。
 *
 * 各页如果接了 @reload，就只重拉数据（不动表单、不重建编辑器）；
 * 没接就退回整页重载 —— 简单粗暴，但至少能用。
 * 让页面自己决定是必须的：考核方案那种有未保存改动的页，
 * 整页重载一下改动就没了，用户会骂人。
 */
function doReload() {
  const fn = attrs.onReload
  if (typeof fn !== 'function') return
  fn()
}

/* ---------------- 全屏 ---------------- */
const isFull = ref(false)

function syncFull() {
  isFull.value = !!document.fullscreenElement
}

function toggleFull() {
  try {
    if (document.fullscreenElement) document.exitFullscreen()
    else document.documentElement.requestFullscreen()
  } catch (e) {
    /* 某些环境（iframe 没授权、浏览器策略）会拒绝，静默即可 */
  }
}

onMounted(() => {
  syncFull()
  document.addEventListener('fullscreenchange', syncFull)
})
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', syncFull)
})

/**
 * 回到顶部。
 *
 * 页面滚动位置不一：有的整页滚（window），有的是某个 .card 自己 overflow:auto
 * （讲义、材料就是这种）。全找出来滚一遍最省事 —— 本来就没滚动的元素不受影响。
 */
function backToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' })
  document.querySelectorAll('.card, .md, .page, .main, main, .scroll, [class*="-scroll"]').forEach((el) => {
    if (el.scrollTop > 0) el.scrollTo({ top: 0, behavior: 'smooth' })
  })
}
</script>
