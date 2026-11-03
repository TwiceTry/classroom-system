<template>
  <!--
    所有页面的统一头部：标题 + 说明 + 右侧操作区
      · 标题与说明尽量排一行（基线对齐），宽度不够时说明自己折到第二行
      · 右侧操作放不下也会自己折行，不会把标题挤没
    用法：
      <PageHead>
        <template #title>考核方案</template>
        <template #sub>有哪些考核项、各占多少分……</template>
        <template #right><button class="btn mini">保存</button></template>
      </PageHead>
  -->
  <header class="pagehead">
    <div class="head-txt">
      <h2><slot name="title" /></h2>
      <p v-if="sub || $slots.sub" class="sub"><slot name="sub">{{ sub }}</slot></p>
    </div>
    <div v-if="$slots.right" class="right"><slot name="right" /></div>
  </header>
</template>

<script setup>
defineProps({
  /* 说明文字：写 slot 更灵活（可带标签/多段），只想给一句话时也可以直接传 sub */
  sub: { type: String, default: '' },
})
</script>
