<template>
  <PgWorkbench
    title="代码练习"
    sub="改左边的代码，右边立刻出页面；不用联网，改动存在本机"
    content-dir="代码示例"
  />
</template>

<script setup>
/*
 * 代码练习页 = 工作台组件的默认用法（目录可选、改动存本机）。
 * 编辑 / 预览 / 存档逻辑全在 components/PgWorkbench.vue，课堂作业页也用同一份。
 */
import PgWorkbench from '../components/PgWorkbench.vue'
</script>
