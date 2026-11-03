<template>
  <transition name="fade">
    <div v-if="text" class="toast" @click="$emit('close')">{{ text }}</div>
  </transition>
</template>

<script setup>
defineProps({ text: { type: String, default: '' } })
defineEmits(['close'])
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
