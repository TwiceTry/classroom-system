<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>课堂投屏</template>
        <template #sub>
          <template v-if="casting">老师正在投屏；画面按教师机原始像素显示，看不清可以「全屏」</template>
          <template v-else>老师还没开始投屏，这一页会自动接上，不用刷新</template>
        </template>
        <template #right>
          <span class="tag" :class="casting ? 'ok' : 'mute'">{{ casting ? '投屏中' : '未开播' }}</span>
          <button class="btn mini" :disabled="!casting" @click="toggleFull">{{ full ? '退出全屏' : '全屏' }}</button>
          <button class="btn mini" title="在浏览器新标签页里打开（方便拖到第二块屏幕）" @click="openNewTab">
            新标签页打开
          </button>
        </template>
      </PageHead>
    </template>

    <!-- 直接复用 /watch 那套观看页：抓屏解码、1:1 像素、缩放/全屏都是现成的 -->
    <div ref="wrap" class="caster">
      <iframe src="/watch" title="课堂投屏画面" allow="fullscreen"></iframe>
    </div>
  </PageShell>
</template>

<script setup>
/*
 * 学生端「课堂投屏」——放在应用里（同标签页），不再弹新窗口。
 *   · 画面本身仍由 /watch 渲染（那份逻辑近 600 行，重写必然走样）
 *   · 全屏：对这个容器请求全屏，侧栏和页头一起让位
 *   · 新标签页：想放到第二块屏幕 / 想边看边操作时用
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import PageShell from '../../components/PageShell.vue'
import PageHead from '../../components/PageHead.vue'
import { castWatch } from '../../utils/castWatch'

const wrap = ref(null)
const full = ref(false)
const casting = computed(() => castWatch.casting)

function onFs() {
  full.value = !!document.fullscreenElement
}

onMounted(() => document.addEventListener('fullscreenchange', onFs))
onUnmounted(() => document.removeEventListener('fullscreenchange', onFs))

function toggleFull() {
  if (document.fullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {})
    return
  }
  const el = wrap.value
  if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {})
}

function openNewTab() {
  window.open('/watch', 'pg-cast')
}
</script>

<style scoped>
.caster {
  height: calc(100vh - 190px);
  min-height: 380px;
  display: flex;
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
  background: #111;
}

.caster iframe {
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}

/* 全屏时把边框也去掉，画面顶到屏幕边 */
.caster:fullscreen {
  height: 100vh;
  border: 0;
  border-radius: 0;
}
</style>
