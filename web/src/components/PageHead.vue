<template>
  <!--
    所有页面的统一头部：标题 + 说明 + 右侧操作区

      · 标题与说明尽量排一行（基线对齐），宽度不够时说明自己折到第二行
      · 右侧操作放不下也会自己折行，不会把标题挤没

    ── 约定（2026-11 起）────────────────────────────────────────────
    这里**只放两类东西**：
      1. 全局工具：字号 A− / A+（已经内置，各页不用自己写）
      2. 极少数「整页只有一个动作」的页面（比如考试页的交卷）

    页面自己的操作（新建/刷新/导入/跟随/点名…）请放到**页面内**
    —— 卡片头 <CardHead #right>，或者页面顶部那条 .bar。
    原因是这些控件跟页面内容是一体的，挂在页头会让人以为它作用于整个系统；
    而且挤在页头时，一行放不下就折行，标题被压得很难看。

    用法：
      <PageHead>
        <template #title>考核方案</template>
        <template #sub>有哪些考核项、各占多少分……</template>
      </PageHead>
  -->
  <header class="pagehead">
    <div class="head-txt">
      <h2><slot name="title" /></h2>
      <p v-if="sub || $slots.sub" class="sub"><slot name="sub">{{ sub }}</slot></p>
    </div>
    <div class="right">
      <span class="head-fs" title="全站字号：讲义、材料、代码一起变">
        <button class="btn mini" @click="adjustDoc(-1)">A−</button>
        <span class="dim">{{ docPx }}</span>
        <button class="btn mini" @click="adjustDoc(1)">A+</button>
      </span>
      <slot name="right" />
    </div>
  </header>
</template>

<script setup>
import { useFontSize } from '../composables/useFontSize'

defineProps({
  /* 说明文字：写 slot 更灵活（可带标签/多段），只想给一句话时也可以直接传 sub */
  sub: { type: String, default: '' },
})

/*
 * 字号放在页头统一给 —— 原来讲义、材料、代码页各有一套 A−A+（还只读不写，
 * 刷新就回默认）。现在一个值管全站，控件也只在页头出现一处。
 */
const { docPx, adjustDoc } = useFontSize()
</script>
