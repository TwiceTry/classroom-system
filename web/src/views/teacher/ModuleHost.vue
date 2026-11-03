<template>
  <div v-if="!scheme.loaded" class="content"><div class="card empty">正在读取考核方案…</div></div>

  <div v-else-if="!mod" class="content">
    <div class="card empty">
      <b>「{{ itemKey }}」这个模块没有启用。</b>
      <p class="dim" style="margin: 8px 0 0">
        考核方案里这一项要么关了模块开关，要么还没有这个考核项。去
        <router-link to="/teacher/scheme">考核方案</router-link> 把它打开，保存后这里立刻就能用。
      </p>
    </div>
  </div>

  <!-- 考勤：一屏点名（只记异常） -->
  <Attendance v-else-if="mod.form === 'attendance'" :key="mod.itemKey + '-attend'" :item-key="mod.itemKey" />
  <!-- 课堂互动：随机点名 + 当场加减分 -->
  <Interact v-else-if="mod.form === 'manual'" :key="mod.itemKey + '-interact'" :item-key="mod.itemKey" />
  <!-- 机试：试卷 / 题库 + 判卷 -->
  <ExamModule v-else-if="mod.form === 'paper'" :key="mod.itemKey + '-exam'" :item-key="mod.itemKey" />
  <!-- 交代码的模块：文件树 + 编辑器 + 跑渲染 -->
  <Assignments v-else-if="mod.submit === 'code'" :key="mod.itemKey + '-code'" :item-key="mod.itemKey" />
  <!-- 交材料的模块：说明 + 链接 + 附件 -->
  <Projects v-else :key="mod.itemKey + '-files'" :item-key="mod.itemKey" />
</template>

<script setup>
/*
 * 教师端模块入口：/teacher/modules/:itemKey
 *
 * 一个模块 = 方案里的一个考核项。这里只做三件事：
 *   1) 找到这一项的模块配置（有没有启用、交代码还是交材料）；
 *   2) 按 submit 选页面（Assignments = 代码工作台，Projects = 材料表单）；
 *   3) 没启用就明说，并给一条去「考核方案」的路 —— 不静默 403。
 * 页面本身按 itemKey 取数据，所以「加一项考核」不用再改路由。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Assignments from './Assignments.vue'
import Projects from './Projects.vue'
import Attendance from './Attendance.vue'
import Interact from './Interact.vue'
import ExamModule from './ExamModule.vue'
import { scheme } from '../../utils/scheme'

const route = useRoute()
const itemKey = computed(() => String(route.params.itemKey || ''))

const mod = computed(() => scheme.modules.find((m) => m.itemKey === itemKey.value) || null)
</script>
