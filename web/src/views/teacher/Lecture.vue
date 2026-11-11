<template>
  <PageShell body-class="split">
    <template #head>
      <PageHead>
        <template #title>讲义</template>
        <template #sub>讲义与课程材料是同一批小节 · 切换视图不打断「跟随」，学生端仍按小节跳</template>
        <template #right>
          <div class="seg">
            <button
            class="btn mini"
            :class="{ on: view === 'lecture' }"
            title="讲义原文：屏幕内容 + 讲稿批注"
            @click="setView('lecture')"
            >
            讲义
          </button>
          <button
          class="btn mini"
          :class="{ on: view === 'materials' }"
          title="学生手上那一份 materials/*.md"
          @click="setView('materials')"
          >
          课程材料
        </button>
        </div>
        <span class="sep"></span>
        <!-- 导出/导入当前视图对应的目录：讲义 → content/lecture，课程材料 → content/materials -->
        <DirIO
          :dir="view === 'materials' ? 'materials' : 'lecture'"
          :label="view === 'materials' ? '课程材料' : '讲义'"
        />
        <!--
          「跟随中 / 重新读取」下放到右边那张卡片的头里（见下面 CardHead #right）——
          它们只影响正在看的这一篇，不是整页的模式切换。
          页头这里只留「讲义 / 课程材料」和导出导入：那两个是"看哪一份内容"，
          相当于两个标签页，放页头才说得通。
        -->
        </template>
      </PageHead>
    </template>
    <aside class="lesson-list">
    <template v-for="(l, i) in lessons" :key="l.id">
    <div v-if="l.kind !== 'lesson' && (i === 0 || lessons[i - 1].kind === 'lesson')" class="sep">补充资料</div>
    <button :class="{ on: l.id === activeId }" @click="open(l.id)">
    <span class="no">{{ l.kind === 'lesson' ? '第' + String(l.no).padStart(2, '0') + '课' : '' }}</span>
    {{ l.title }}
    <span v-if="!l.hasLecture" class="tag mute" style="float: right">无讲义</span>
    </button>
    </template>
    <p v-if="!lessons.length" class="empty">没有读到内容，请检查 materials/ 与 lecture/ 目录</p>
    </aside>

    <section ref="articleRef" class="card">
    <CardHead>
    <template #title>{{ headTitle }}</template>
    <template #meta><span v-if="headFile" class="tag mute">{{ headFile }}</span></template>
    <template #right>
    <!-- 这一篇自己的操作：跟随开关 / 重新读取（从页头下放来的） -->
    <button
      class="btn mini"
      :class="{ on: syncOn }"
      :title="syncOn ? '学生端课程材料会自动跟着你翻' : '已暂停：学生端不再跟着跳'"
      @click="toggleSync"
    >
      {{ syncOn ? '跟随中' : '已暂停' }}
    </button>
    <span class="dim mini sync-tip">{{ syncTip }}</span>
    <button class="btn mini" :disabled="loading" @click="reload">重新读取</button>
    <span class="dim">{{ stats.chars }} 字 · 约 {{ stats.minutes }} 分钟</span>
    </template>
    </CardHead>

    <p v-if="viewHint" class="hint" style="margin-bottom:12px">{{ viewHint }}</p>
    <p v-if="error" class="hint err">{{ error }}</p>
    <div v-if="loading" class="empty">读取中…</div>
    <MdView v-else-if="viewMarkdown" :source="viewMarkdown" :style="{ fontSize: docPx + 'px' }" />
    <div v-else class="empty">
    这一课没有{{ view === 'lecture' ? '讲义' : '课程材料' }}文件。
    <template v-if="view === 'lecture'">切到「课程材料」看学生版内容。</template>
    </div>
    </section>
  </PageShell>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import MdView from '../../components/MdView.vue'
import { api } from '../../api'
import { state } from '../../store'
import { closestHeading, docStats, mdHeadings } from '../../utils/lecture'
import PageHead from '../../components/PageHead.vue'
import DirIO from '../../components/DirIO.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'
import { useFontSize } from '../../composables/useFontSize'
import { currentClassId } from '../../utils/classSel'

const lessons = computed(() => state.lessons)
const activeId = ref(localStorage.getItem('lecture-id') || '')
// 'lecture' = 讲义原文（含讲稿批注）；'materials' = 学生手上那一份
const view = ref(localStorage.getItem('lecture-view') === 'materials' ? 'materials' : 'lecture')
/*
 * 字号改成全站统一（composables/useFontSize.js）。
 * 原来这里读 localStorage['lecture-size']，但**从来没人写它** ——
 * 点 A+ 只改内存，刷新就回到 15.5，这就是「刷新失效」。
 */
/* 字号控件已经收进 PageHead（全站一处），这里只要值来渲染正文 */
const { docPx } = useFontSize()
const doc = ref({})
const matDoc = ref({})
const loading = ref(false)
const error = ref('')

const viewMarkdown = computed(() =>
  view.value === 'materials' ? matDoc.value.markdown || '' : doc.value.markdown || ''
)
const headTitle = computed(() => {
  const t = view.value === 'materials' ? matDoc.value.title || doc.value.title : doc.value.title
  return t || '—'
})
const headFile = computed(() => (view.value === 'materials' ? matDoc.value.file : doc.value.file) || '')
const stats = computed(() => docStats(viewMarkdown.value))

const viewHint = computed(() => {
  if (!viewMarkdown.value) return ''
  if (view.value === 'materials') {
    return '课程材料视图：就是学生手上那一份（materials/*.md），不用另开页面就能对照着讲。'
  }
  return '讲义视图：每节先 📺 屏幕（学生看到的），再 🎤 讲稿（怎么讲）。'
})

/* ---------------- 跟随讲义（学生材料跟着跳） ---------------- */

const articleRef = ref(null)
const syncOn = ref(localStorage.getItem('lecture-sync') !== '0')
const matKeys = ref(new Set()) // 材料里的同步节点 key（标题归一化后）
const matList = ref([]) // 材料节点明细，用来算「最接近的那节」
const currentSec = ref({ key: '', title: '', anchor: '', closest: '', level: 0 })
const delivered = ref(-1)
let lastPushed = ''
let scrollTimer = null

const ANCHOR_LINE = 120 // 判定「当前在讲哪个节点」的视口基准线（px）
// 多级标题都参与同步：## 是一级节点，###/#### 是它拆出来的子节点
const HEAD_SEL = 'h2[data-sec], h3[data-sec], h4[data-sec]'

const syncTip = computed(() => {
  if (!syncOn.value) return '学生端不再跟着跳'
  if (!currentSec.value.key) return '向下滚动到某节即开始同步'
  if (!currentSec.value.anchor) {
    // 对不上时给出「最像的那一节」，老师才知道该改哪边
    return currentSec.value.closest
      ? '本节点未同步：材料里没有同名标题（最接近「' + currentSec.value.closest + '」）'
      : '本节点未同步：材料里没有同名标题'
  }
  const t = currentSec.value.title
  const short = t.length > 18 ? t.slice(0, 18) + '…' : t
  const lv = currentSec.value.level > 2 ? 'H' + currentSec.value.level + ' ' : ''
  return '学生材料已跳到「' + lv + short + '」' + (delivered.value >= 0 ? ' · ' + delivered.value + ' 台' : '')
})

onMounted(() => {
  if (!activeId.value && lessons.value.length) {
    const first = lessons.value.find((l) => l.hasLecture) || lessons.value[0]
    activeId.value = first.id
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  if (activeId.value) open(activeId.value)
})

onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
  if (scrollTimer) clearTimeout(scrollTimer)
})

function setView(v) {
  if (view.value === v) return
  view.value = v
  localStorage.setItem('lecture-view', v)
  // 换视图后 DOM 重排：把当前小节重新判定一次，并照原样推给学生（锚点不变）
  nextTick(() => detectSection(true))
}

function toggleSync() {
  syncOn.value = !syncOn.value
  localStorage.setItem('lecture-sync', syncOn.value ? '1' : '0')
  if (syncOn.value) {
    lastPushed = ''
    nextTick(() => detectSection(true))
  }
}



function open(id) {
  activeId.value = id
  localStorage.setItem('lecture-id', id)
  reload()
}

async function reload() {
  if (!activeId.value) return
  loading.value = true
  error.value = ''
  lastPushed = ''
  delivered.value = -1
  try {
    doc.value = await api.get('/api/content/doc?type=lecture&id=' + encodeURIComponent(activeId.value))
    await buildSyncMap()
  } catch (e) {
    doc.value = {}
    error.value = e.message
  } finally {
    loading.value = false
    // 换课要回到开头：否则滚动位置还停在上节课的高度，判定出来的「当前小节」是乱的
    window.scrollTo({ top: 0 })
    nextTick(() => detectSection(true))
  }
}

/**
 * 讲义 ↔ 材料 的小节对应表。
 * 两份文件本来就该一节对一节（📺 屏幕 就是 materials 的镜像），
 * 标题会有补充语差异，所以交给 buildSectionMap 做打分配对。
 * 材料文档本身也存一份：切到「课程材料」视图直接渲染，不额外请求。
 */
async function buildSyncMap() {
  matKeys.value = new Set()
  matList.value = []
  matDoc.value = {}
  try {
    const mat = await api.get('/api/content/doc?type=materials&id=' + encodeURIComponent(activeId.value))
    matDoc.value = mat || {}
    matList.value = mdHeadings(mat.markdown || '')
    matKeys.value = new Set(matList.value.map((h) => h.key))
  } catch (e) {
    /* 这一课没有材料：所有小节都不推 */
  }
}

function onScroll() {
  if (scrollTimer) return
  scrollTimer = setTimeout(() => {
    scrollTimer = null
    detectSection(false)
  }, 160)
}

/** 当前在讲哪个节点：最后一个已经滚到基准线上方的标题（任意层级） */
function detectSection(force) {
  const root = articleRef.value
  if (!root) return
  const hs = root.querySelectorAll(HEAD_SEL)
  if (!hs.length) return
  let idx = 0
  for (let i = 0; i < hs.length; i++) {
    if (hs[i].getBoundingClientRect().top <= ANCHOR_LINE) idx = i
    else break
  }
  const cur = hs[idx]
  const key = cur.dataset.sec || ''
  const title = (cur.textContent || '').trim()
  // 标题一致即同节点：材料里有同名标题才推，否则不推（宁可不跳，也不跳错）。
  // 层级不参与匹配：讲义 📺 里用 ####、材料里用 ###，只要标题一样就算同一个节点。
  const anchor = matKeys.value.has(key) ? key : ''
  const closest = anchor ? '' : (closestHeading(title, matList.value) || {}).title || ''
  if (!force && key === currentSec.value.key) return
  currentSec.value = { key, title, anchor, closest, level: Number(cur.tagName.slice(1)) || 2 }
  pushFollow()
}

function pushFollow() {
  if (!syncOn.value) return
  const anchor = currentSec.value.anchor
  if (!anchor) return
  const mark = activeId.value + '#' + anchor
  if (mark === lastPushed) return
  lastPushed = mark
  api
    .post('/api/teacher/follow', {
      lessonId: activeId.value,
      anchor,
      sectionTitle: currentSec.value.title,
      /*
       * 带上班级：服务端要用它把这个班的点名 / 代码同步停掉。
       * 教师可能同时带多个班，从令牌里推不出「现在讲的是哪个班」，
       * 漏了的话「切到跟随」就不会把学生端的点名浮层收掉。
       */
      classId: currentClassId.value || '',
    })
    .then((r) => {
      delivered.value = r.delivered
    })
    .catch(() => {
      lastPushed = '' // 失败就允许下次重推
    })
}
</script>

<style scoped>
.seg {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: #f1f3f9;
  border-radius: 9px;
}

.sep {
  width: 1px;
  height: 18px;
  background: var(--line);
  margin: 0 4px;
}

.sync-tip {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
