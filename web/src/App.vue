<template>
  <ErrorBoundary v-if="state.ready">
    <router-view />
  </ErrorBoundary>
  <div v-else class="boot">
    <div class="boot-dot"></div>
    <p>{{ state.bootError || '正在读取课程数据…' }}</p>
    <p v-if="state.bootError" class="dim">请确认教师机上的课堂系统服务（node server/index.js）正在运行。</p>
  </div>
</template>

<script setup>
import { onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ErrorBoundary from './components/ErrorBoundary.vue'
import { state, bootstrap } from './store'

const router = useRouter()
const route = useRoute()

/**
 * 登录状态失效（令牌过期 / 服务端不认了）→ 立刻去登录页。
 * 课程材料页对游客开放，所以光靠路由守卫不够：已经在页面上时守卫不会再跑，
 * 这里补一刀；登录完会回到刚才那一页（?next=）。
 */
watch(
  () => state.tokenExpired,
  (v) => {
    if (!v) return
    // next 只在「有意义的页面」时带：'/' 会把登录后的人又弹回登录页
    const cur = route.fullPath || ''
    const next = cur && cur !== '/' && cur.indexOf('/login') !== 0 ? cur : ''
    router.replace({ path: '/login', query: next ? { next } : {} })
  }
)

onMounted(() => {
  bootstrap()
})

/*
 * 标签页标题跟随真实课程名。
 * 静态标题在 index.html 里（「课堂系统」），这里补上课程名，
 * 两个窗口并排开教师端/学生端时，标签上能分清是哪个班哪门课。
 */
watch(
  () => state.courseName,
  (name) => {
    document.title = name ? '课堂系统 · ' + name : '课堂系统'
  },
  { immediate: true }
)
</script>

<style scoped>
.boot {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #475569;
}
.boot-dot {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 3px solid #c7d2fe;
  border-top-color: #2c5f84;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
