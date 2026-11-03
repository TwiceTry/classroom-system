<template>
  <!-- 筛选条：一行放不下自动换行；内容全部走默认插槽，组件只管间距与对齐 -->
  <div class="fbar" :class="{ tight }">
    <slot />
  </div>
</template>

<script setup>
defineProps({
  /* 更紧凑一点（卡片里的次级筛选条） */
  tight: { type: Boolean, default: false },
})
</script>
