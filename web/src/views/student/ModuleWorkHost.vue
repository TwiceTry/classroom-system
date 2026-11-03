<template>
  <div v-if="!scheme.loaded" class="content"><div class="card empty">正在读取考核方案…</div></div>

  <div v-else-if="!mod" class="content">
    <div class="card empty">
      <b>「{{ itemKey }}」这个模块没有启用。</b>
    </div>
  </div>

  <!-- 机试：开考 / 作答 / 交卷 -->
  <ExamWork v-else-if="mod.form === 'paper'" :key="mod.itemKey + '-exam'" />
  <!-- 交代码的模块：做题页（Playground 那套 + 提交） -->
  <AssignmentWork v-else-if="mod.submit === 'code'" :key="mod.itemKey + '-work'" />
  <!-- 交材料的模块：说明 / 链接 / 附件 -->
  <ProjectDetail v-else :key="mod.itemKey + '-detail'" />
</template>

<script setup>
/*
 * 学生端「某个模块的某一份作业」：/student/modules/:itemKey/:id
 * 交代码的进做题页，交材料的进提交页 —— 由方案的 submit 决定，不看 URL。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AssignmentWork from './AssignmentWork.vue'
import ProjectDetail from './ProjectDetail.vue'
import ExamWork from './ExamWork.vue'
import { scheme } from '../../utils/scheme'

const route = useRoute()
const itemKey = computed(() => String(route.params.itemKey || ''))

const mod = computed(() => scheme.modules.find((m) => m.itemKey === itemKey.value) || null)
</script>
