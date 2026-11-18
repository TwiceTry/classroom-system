<template>
  <!--
    全站唯一的一次性提示：**顶部居中弹出，几秒后自己消失**，点一下也能立刻关。

    为什么改成顶部居中（原来在底部）：
      · 底部会和「页脚 / 提交按钮 / 工作台状态条」抢位置，学生做作业时那一条正好压在按钮上
      · 顶部是视线起点，操作完一抬眼就看到，不用低头找
      · 教师端和学生端用同一个位置，两边行为一致

    为什么内置自动消失：
      原来靠各页面自己写 setTimeout 清空，有的写了、有的忘了 ——
      忘了的那些会一直挂在屏幕上。现在把计时器放在组件里，
      调用方只管给 text，其余不用管。

    duration=0 表示不自动消失（真的要用户看完的错误才传 0）。
  -->
  <transition name="toast-drop">
    <div v-if="text" class="toast" role="status" @click="close">{{ text }}</div>
  </transition>
</template>

<script setup>
import { onBeforeUnmount, watch } from 'vue'

const props = defineProps({
  text: { type: String, default: '' },
  /* 毫秒；0 = 不自动关 */
  duration: { type: Number, default: 4000 },
})
const emit = defineEmits(['close'])

let timer = null

function clear() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function close() {
  clear()
  emit('close')
}

/*
 * 文字一变就重新计时。
 * 先清旧定时器很重要：连续两条提示（比如「保存中」→「已保存」）如果不清理，
 * 第一条的定时器会提前把第二条关掉。
 */
watch(
  () => props.text,
  (v) => {
    clear()
    if (v && props.duration > 0) timer = setTimeout(() => emit('close'), props.duration)
  },
  { immediate: true }
)

onBeforeUnmount(clear)
</script>
