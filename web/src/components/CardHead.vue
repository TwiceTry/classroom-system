<template>
  <!--
    卡片头：h3 + 说明 / 统计（meta） + 右侧操作（right） + 其它零碎（默认插槽）
    用法：
      <CardHead>
        <template #title>全班流水</template>
        <template #meta><span class="dim">有效 12 条</span></template>
        <template #right><button class="btn mini">导出流水</button></template>
      </CardHead>
    约定：meta / right 里的元素自带 class（dim / mini / pill…），组件只负责布局，不改它们的样式。
  -->
  <div class="card-head" :class="{ small }">
    <h3 v-if="$slots.title"><slot name="title" /></h3>
    <slot name="meta" />
    <div v-if="$slots.right" class="right"><slot name="right" /></div>
    <slot />
  </div>
</template>

<script setup>
defineProps({
  /* 小一号标题（次要卡片用） */
  small: { type: Boolean, default: false },
})
</script>
