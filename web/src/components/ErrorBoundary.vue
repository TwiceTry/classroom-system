<template>
  <!-- 兜底：任何子组件渲染出错都不让整页变白，至少把错误摆出来 -->
  <div v-if="err" class="eb card">
    <h3>这个页面出错了</h3>
    <p class="dim">
      页面渲染时抛了异常，已经把位置和原因记下来了。先刷新一次；如果反复出现，把这行错误发给我。
    </p>
    <pre class="msg">{{ err }}</pre>
    <div class="acts">
      <button class="btn primary" @click="reload">刷新页面</button>
      <button class="btn" @click="reset">回到首页</button>
    </div>
  </div>
  <slot v-else />
</template>

<script setup>
/*
 * ErrorBoundary —— 全局错误边界
 *
 * 为什么需要：Vue 里子组件渲染抛异常时，整棵子树会被卸载，用户看到的是一整片白屏，
 * 而且不知道发生了什么。这里接住异常（onErrorCaptured 返回 false 阻止向上冒泡），
 * 换成一张能读的错误卡 + 两个出口（刷新 / 回首页）。
 *
 * 覆盖两类：渲染期异常（onErrorCaptured）+ 事件/异步里没接住的（main.js 的 app.config.errorHandler）。
 */
import { onErrorCaptured, ref } from 'vue'
import { pushError } from '../utils/errorBus'

const err = ref('')

onErrorCaptured((e, instance, info) => {
  err.value = [e && e.message ? e.message : String(e), info].filter(Boolean).join('　·　')
  // 顺手打全栈，便于排查
  console.error('[界面异常]', e, info)
  pushError(err.value)
  return false // 不再往上抛，父组件不会被一起卸掉
})

function reload() {
  window.location.reload()
}

function reset() {
  err.value = ''
  window.location.hash = '#/'
  window.location.reload()
}
</script>

<style scoped>
.eb {
  margin: 24px auto;
  max-width: 760px;
  padding: var(--sp-4) var(--sp-5);
}

.eb h3 {
  margin: 0 0 8px;
  font-size: var(--fs-lg);
}

.eb .dim {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-md);
  line-height: 1.8;
  color: #4b5563;
}

.msg {
  margin: 0 0 var(--sp-3);
  padding: var(--sp-2) 12px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: var(--r-md);
  color: #b91c1c;
  font: 12px/1.6 Consolas, monospace;
  white-space: pre-wrap;
  max-height: 220px;
  overflow: auto;
}

.acts {
  display: flex;
  gap: 8px;
}
</style>
