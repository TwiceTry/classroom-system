<template>
  <PageShell body-class="split">
    <template #head>
      <PageHead>
        <template #title>课程材料</template>
        <template #sub>每课一份，随时回看</template>
        <!-- 页头只留标题和全局字号；搜索和「跟随中」下放到左侧列表顶上 -->
      </PageHead>
    </template>
    <aside class="lesson-list">
      <div class="list-tools">
        <span v-if="following" class="tag ok" :title="'老师正在讲：' + following">
          跟随中 · {{ shortFollowing }}
        </span>
        <input v-model.trim="q" class="input" placeholder="搜课名" />
      </div>
      <button v-for="l in filtered" :key="l.id" :class="{ on: l.id === activeId }" @click="open(l.id)">
        <span class="no">{{ l.kind === 'lesson' ? '第' + String(l.no).padStart(2, '0') + '课' : '' }}</span>
        {{ l.title }}
      </button>
      <p v-if="!filtered.length" class="empty">没有匹配的课程</p>
    </aside>

    <section class="card">
      <CardHead>
        <template #title>{{ doc.title || '—' }}</template>
        <template #right>
          <button class="btn mini" :disabled="!prevId" @click="open(prevId)">上一课</button>
          <button class="btn mini" :disabled="!nextId" @click="open(nextId)">下一课</button>
        </template>
      </CardHead>

      <p v-if="error" class="hint err">{{ error }}</p>
      <div v-if="loading" class="empty">读取中…</div>
      <MdView v-else-if="doc.markdown" :source="doc.markdown" :style="{ fontSize: docPx + 'px' }" />
      <div v-else class="empty">这一课没有材料文件</div>
    </section>


    <!-- 跟着老师跳转时提示一下，免得学生以为页面自己乱跑 -->
    <transition name="fade">
      <div v-if="tip" class="follow-toast">{{ tip }}</div>
    </transition>
  </PageShell>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import MdView from '../../components/MdView.vue'
import { api, getToken } from '../../api'
import { state, loadPublicLessons } from '../../store'
import { onPresenceMessage } from '../../utils/presence'
import PageHead from '../../components/PageHead.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'
import { useFontSize } from '../../composables/useFontSize'

const q = ref('')
const activeId = ref(localStorage.getItem('materials-id') || '')
/* 字号控件已经收进 PageHead（全站一处），这里只要值来渲染正文 */
const { docPx } = useFontSize()
const doc = ref({})
const loading = ref(false)
const error = ref('')

/* ---------------- 跟随老师（讲义推到哪一节，这里就跳到哪一节） ---------------- */

const following = ref('') // 正在跟的小节标题（老师推的，推不到就从页面标题兜底）
const shortFollowing = computed(() =>
  following.value.length > 14 ? following.value.slice(0, 14) + '…' : following.value
)
const tip = ref('')
let tipTimer = null
let offFollow = null

function say(text) {
  tip.value = text
  if (tipTimer) clearTimeout(tipTimer)
  tipTimer = setTimeout(() => (tip.value = ''), 2400)
}

/** 找到渲染出来的那个节点标题；用 data-sec 比对，避免选择器里的 emoji/引号把 CSS 弄坏 */
function findSection(anchor) {
  const hs = document.querySelectorAll('.md h2[data-sec], .md h3[data-sec], .md h4[data-sec]')
  for (const h of hs) if (h.dataset.sec === anchor) return h
  return null
}

async function applyFollow(f, animate) {
  /*
   * 老师切到了别的动作（点名 / 推代码），服务端会把跟随停掉并广播 stopped。
   * 原来这里只认带 lessonId 的消息，收到空消息直接 return —— 于是顶部那条
   * 「跟随中 · 某节」一直挂着，学生以为还在跟。
   */
  if (f && f.stopped) {
    following.value = ''
    return
  }
  if (!f || !f.lessonId || !f.anchor) return
  if (f.lessonId !== activeId.value) {
    const target = lessons.value.find((l) => l.id === f.lessonId)
    if (!target) return
    await open(f.lessonId, { keepScroll: true })
    await nextTick()
  }
  const el = findSection(f.anchor)
  if (!el) return
  // 标题以老师推的为准；万一是空的（推送时还没渲染出标题），拿页面上的标题兜底，
  // 绝不能出现「跟随中 · 」后面什么都没有。
  const title = (f.sectionTitle || el.textContent || '').trim()
  following.value = title
  el.scrollIntoView({ behavior: animate ? 'smooth' : 'auto', block: 'start' })
  el.classList.remove('flash')
  void el.offsetWidth
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 1900)
  say('跟着老师跳到「' + (title || '本节') + '」')
}

const lessons = computed(() => state.lessons.filter((l) => l.hasMaterials))
const filtered = computed(() => {
  const kw = q.value.trim()
  if (!kw) return lessons.value
  return lessons.value.filter((l) => l.title.indexOf(kw) >= 0 || String(l.no).indexOf(kw) >= 0)
})

const idx = computed(() => filtered.value.findIndex((l) => l.id === activeId.value))
const prevId = computed(() => (idx.value > 0 ? filtered.value[idx.value - 1].id : ''))
const nextId = computed(() =>
  idx.value >= 0 && idx.value < filtered.value.length - 1 ? filtered.value[idx.value + 1].id : ''
)

onMounted(async () => {
  offFollow = onPresenceMessage((msg) => {
    if (msg.t === 'follow') applyFollow(msg, true)
  })

  // 课次清单：登录用户 bootstrap 已带回来；游客态这里才按需拉
  //（登录页不再无条件拉它 —— 那会让任何人打开登录页就拿到整份课程目录）
  await loadPublicLessons()

  if (!activeId.value && lessons.value.length) activeId.value = lessons.value[0].id
  if (activeId.value) await open(activeId.value, { keepScroll: true })

  // 进页面时先对齐老师当前所在的小节（老师可能已经讲到一半）
  // 游客没有令牌，这个接口会 401 —— 直接跳过，别在控制台刷红
  if (getToken()) {
  try {
    const f = await api.get('/api/follow')
    if (f && f.lessonId) await applyFollow(f, false)
  } catch (e) {
    /* 还没开始讲，忽略 */
  }
  }
})

onUnmounted(() => {
  if (offFollow) offFollow()
  if (tipTimer) clearTimeout(tipTimer)
})

async function open(id, opts) {
  activeId.value = id
  localStorage.setItem('materials-id', id)
  loading.value = true
  error.value = ''
  try {
    doc.value = await api.get('/api/content/doc?type=materials&id=' + encodeURIComponent(id))
    await nextTick()
    if (!opts || !opts.keepScroll) window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch (e) {
    doc.value = {}
    error.value = e.message
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
/* 左侧列表顶上的搜索条（从页头下放来的）：
   搜索的是"哪一课"，属于列表自己的工具，放在列表头上最顺手。 */
.list-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 6px 8px;
}
.list-tools .input {
  flex: 1;
  min-width: 0;
}

.follow-toast {
  position: fixed;
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%);
  z-index: 80;
  padding: 9px 18px;
  border-radius: 4px;
  background: rgba(17, 24, 39, 0.9);
  color: #fff;
  font-size: 13.5px;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.22);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
