<template>
  <div v-if="!scheme.loaded" class="content"><div class="card empty">正在读取考核方案…</div></div>

  <div v-else-if="!mod || mod.studentVisible === false" class="content">
    <div class="card empty">
      <b v-if="!mod">「{{ itemKey }}」这个模块没有启用。</b>
      <b v-else>这一项老师暂时没在学生端开放。</b>
      <p class="dim" style="margin: 8px 0 0">联系老师确认一下考核方案，或者先看看别的模块。</p>
    </div>
  </div>

  <!-- 机试：先看有哪些场次 -->
  <ExamList v-else-if="mod.form === 'paper'" :key="mod.itemKey + '-exam'" :item-key="mod.itemKey" />
  <!-- 交代码的模块 -->
  <Assignments v-else-if="mod.submit === 'code'" :key="mod.itemKey + '-code'" :item-key="mod.itemKey" />
  <!-- 交材料的模块 -->
  <Projects v-else :key="mod.itemKey + '-files'" :item-key="mod.itemKey" />
</template>

<script setup>
/*
 * 学生端模块入口：/student/modules/:itemKey
 * 跟教师端同一套判断：方案里启用了哪个模块，这里就渲染哪种页面。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Assignments from './Assignments.vue'
import Projects from './Projects.vue'
import ExamList from './ExamList.vue'
import { scheme } from '../../utils/scheme'

const route = useRoute()
const itemKey = computed(() => String(route.params.itemKey || ''))

const mod = computed(() => scheme.modules.find((m) => m.itemKey === itemKey.value) || null)
</script>
