<template>
  <!--
    所有页面的统一头部：标题 + 说明 + 工具区

      右半边分**两组**，中间一条竖线隔开：
        ┌─ 通用按钮区（全站固定，各页不用写）────────┐
        │ A− 15 A+ │ ↻ 刷新 │ ⛶ 全屏 │ ↑ 顶部       │
        └──────────────────────────────────────────┘
        ┌─ 页面专属区（各页自己的 #right）───────────┐

    为什么这么分：通用的是「整个系统层面」的操作（字号、刷新、全屏、回到顶部），
    每个页都该有、长得也一样；专属的是「这一页」的操作（新建/导入/点名…），
    各页不一样。混在一起时分不清哪个按钮管什么。

    刷新：各页可以注册自己的重载函数，避免 location.reload() 把没保存的表单冲掉：
        <PageHead @reload="loadAll">      ← 只重拉数据
        <PageHead>                        ← 没接就退回 location.reload()
    实现见下面 doReload()：不声明 emits，直接读 $attrs.onReload 来判断有没有人接。

    用法：
      <PageHead>
        <template #title>考核方案</template>
        <template #sub>有哪些考核项、各占多少分……</template>
        <template #right><button class="btn mini">保存</button></template>
      </PageHead>
  -->
  <header class="pagehead" :class="{ 'is-full': isFull }">
    <div class="head-txt">
      <h2><slot name="title" /></h2>
      <p v-if="sub || $slots.sub" class="sub"><slot name="sub">{{ sub }}</slot></p>
    </div>

    <div class="right">
      <!-- ① 通用按钮区：内容固定，各页不用管 -->
      <span class="head-tools">
        <span class="tool-fs" title="全站字号：讲义、材料、代码一起变">
          <button class="btn mini" @click="adjustDoc(-1)">A−</button>
          <span class="dim">{{ docPx }}</span>
          <button class="btn mini" @click="adjustDoc(1)">A+</button>
        </span>
        <button class="btn mini tool-ico" title="刷新这一页（只重拉数据，不动你正在填的内容）" @click="doReload">
          ↻
        </button>
        <button class="btn mini tool-ico" :title="isFull ? '退出全屏' : '全屏（讲课 / 投屏时用）'" @click="toggleFull">
          ⛶
        </button>
        <button class="btn mini tool-ico" title="回到页面顶部" @click="backToTop">↑</button>
      </span>

      <!-- ② 页面专属区 -->
      <span v-if="$slots.right" class="head-page">
        <slot name="right" />
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
  if (typeof fn === 'function') fn()
  else location.reload()
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
