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
import { onMounted } from 'vue'
import ErrorBoundary from './components/ErrorBoundary.vue'
import { state, bootstrap } from './store'

onMounted(() => {
  bootstrap()
})
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
