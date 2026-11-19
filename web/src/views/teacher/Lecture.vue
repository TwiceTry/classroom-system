<template>
  <!--
    并排时不限宽（要放下两栏），单栏时按阅读宽度收窄。
    类名用 side-by-side 而不是 side：`.side` 是侧栏那个类（深灰底 208px），
    撞上之后整个内容区会变成侧栏的颜色。
  -->
  <PageShell :body-class="sideBySide ? 'ws side-by-side' : 'ws read'">
    <template #head>
      <!-- 只读内容页：没有「要重拉的数据」，所以不注册 @reload，页头也就不会有「↻」 -->
      <PageHead>
        <template #title>讲义</template>
        <!--
          副标题改放进度：讲到第几课。

          原来写的是「讲义与课程材料是同一批小节 · 切换视图不打断跟随」——
          那是解释这个页面的机制，老师看第二遍就不需要了。
          而"我们讲到哪了"这件事，原来全页只有左栏目录的高亮能回答。
        -->
        <template #sub>
          <span :title="'讲义与课程材料是同一批小节 · 切换视图不打断「跟随」，学生端仍按小节跳'">
            {{ lecSub }}
          </span>
        </template>
        <template #right>
          <!-- 并排时两边都在，切换就没意义了，收起来 -->
          <div v-if="!sideBySide" class="seg">
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
        <!--
          并排：左右同时显示讲义和学生材料，滚讲义时右边自动跟到同一小节。
          需要够宽（两栏各要 560 以上），窄屏按钮置灰并说明原因，
          而不是让人点开一个挤成两条的结果。
        -->
        <button
          class="btn mini"
          :class="{ on: sideBySide }"
          :disabled="!wideEnough && !sideBySide"
          :title="
            sideBySide
              ? '回到单栏（只显示一份）'
              : wideEnough
                ? '左右同时显示讲义和课程材料，滚动时右边自动跟着对齐'
                : '窗口太窄，放不下两栏（需要 1400 以上）'
          "
          @click="toggleSide"
        >
          {{ sideBySide ? '退出并排' : '并排' }}
        </button>
        <span class="sep"></span>
        <!-- 导出/导入当前视图对应的目录：讲义 → content/lecture，课程材料 → content/materials -->
        <DirIO
          :dir="view === 'materials' ? 'materials' : 'lecture'"
          :label="view === 'materials' ? '课程材料' : '讲义'"
        />
        <span class="sep"></span>
        <button
          class="btn mini"
          :class="{ on: syncOn }"
          :title="syncOn ? '学生端课程材料会自动跟着你翻' : '已暂停：学生端不再跟着跳'"
          @click="toggleSync"
        >
          {{ syncOn ? '跟随中' : '已暂停' }}
        </button>
        <span class="dim mini sync-tip">{{ syncTip }}</span>
        </template>
      </PageHead>
    </template>
    <!-- 左栏：目录。自己滚，正文滚多远它都不动 -->
    <template #left>
    <aside class="lesson-list">
    <template v-for="(l, i) in lessons" :key="l.id">
    <div v-if="l.kind !== 'lesson' && (i === 0 || lessons[i - 1].kind === 'lesson')" class="sep">补充资料</div>
    <!--
      目录项三态：正在看（on）、已经翻过去（past）、还没到（常态）。

      原来是两态（只有 on）。一节课讲到第 12 课，左栏 25 条长得一模一样 ——
      老师想确认"我们讲到哪了"只能靠回忆，或者翻正文找。
      现在翻过的压暗，当前位置高亮，**进度本身就是目录的形状**。

      「讲过」是拿序号比的（比当前小就是翻过了）：讲义本来就是一课一课往后推的，
      没有单独的"已完成"数据 —— 硬造一个字段出来，老师还得额外点一下标记，不划算。
    -->
    <button :class="{ on: l.id === activeId, past: isPast(l) }" @click="open(l.id)">
    <span class="no">{{ l.kind === 'lesson' ? String(l.no).padStart(2, '0') : '' }}</span>
    <span class="tt">{{ l.title }}</span>
    <span v-if="!l.hasLecture" class="tag mute" style="float: right">无讲义</span>
    </button>
    </template>
    <p v-if="!lessons.length" class="empty">没有读到内容，请检查 materials/ 与 lecture/ 目录</p>
    </aside>
    </template>

    <!--
      中栏：正文。
      单栏 = 一份（讲义或材料，靠上面的 seg 切）；
      并排 = 两份各占一半，各自滚，滚讲义时右边自动对齐到同一小节。
    -->
    <template v-if="sideBySide">
      <section ref="articleRef" class="card side-card">
        <CardHead>
          <template #title>{{ doc.title || '讲义' }}</template>
          <template #meta><span v-if="doc.file" class="tag mute">{{ doc.file }}</span></template>
          <template #right>
            <span class="dim">{{ docStatsOf(doc).chars }} 字 · 约 {{ docStatsOf(doc).minutes }} 分钟</span>
          </template>
        </CardHead>
        <p v-if="error" class="hint err">{{ error }}</p>
        <div v-if="loading" class="empty">读取中…</div>
        <MdView v-else-if="doc.markdown" :source="doc.markdown" :style="{ fontSize: docPx + 'px' }" />
        <div v-else class="empty">这一课没有讲义文件。</div>
      </section>

      <section ref="matArticleRef" class="card side-card">
        <CardHead>
          <template #title>{{ matDoc.title || '课程材料' }}</template>
          <template #meta><span v-if="matDoc.file" class="tag mute">{{ matDoc.file }}</span></template>
          <template #right><span class="dim">{{ docStatsOf(matDoc).chars }} 字</span></template>
        </CardHead>
        <MdView v-if="matDoc.markdown" :source="matDoc.markdown" :style="{ fontSize: docPx + 'px' }" />
        <div v-else class="empty">这一课没有课程材料。</div>
      </section>
    </template>

    <section v-else ref="articleRef" class="card">
      <CardHead>
        <template #title>{{ headTitle }}</template>
        <template #meta><span v-if="headFile" class="tag mute">{{ headFile }}</span></template>
        <template #right>
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

/** 当前在看第几课（用来判断哪些已经翻过去了） */
const activeNo = computed(() => {
  const a = lessons.value.find((l) => l.id === activeId.value)
  return a && a.kind === 'lesson' ? Number(a.no) || 0 : 0
})

/** 目录项：比当前课序号小的，就是已经讲过的 */
function isPast(l) {
  return l.kind === 'lesson' && activeNo.value > 0 && Number(l.no) < activeNo.value
}

/**
 * 页头副标题：讲到第几课。
 *
 * 例：`第 12 课 / 共 25 课 · 组件通信下`
 * 一节课上老师最常需要确认的就是这个数 —— 原来它只在左栏高亮里藏着，
 * 而页头那行写的是"讲义和课程材料是同一批小节"。
 */
const lecSub = computed(() => {
  const total = lessons.value.filter((l) => l.kind === 'lesson').length
  if (!total) return '没有读到讲义'
  const cur = lessons.value.find((l) => l.id === activeId.value)
  if (!cur || cur.kind !== 'lesson') return '共 ' + total + ' 课'
  return '第 ' + cur.no + ' 课 / 共 ' + total + ' 课 · ' + cur.title
})
// 'lecture' = 讲义原文（含讲稿批注）；'materials' = 学生手上那一份
const view = ref(localStorage.getItem('lecture-view') === 'materials' ? 'materials' : 'lecture')

/*
 * 并排：讲义和课程材料同时显示，一边讲一边对照。
 *
 * 需要够宽 —— 两栏各要 560 才排得下正文（再窄就一行挤成八九个字）。
 * 窄屏时按钮置灰，并在 resize 时把并排自动关掉，
 * 免得把窗口缩小之后两边都变成一条。
 */
const SIDE_MIN_W = 1400
const sideBySide = ref(localStorage.getItem('lecture-side') === '1' && window.innerWidth >= SIDE_MIN_W)
const wideEnough = ref(window.innerWidth >= SIDE_MIN_W)
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
/** 并排时两边各算各的字数（单栏沿用上面的 stats） */
const docStatsOf = (d) => docStats((d && d.markdown) || '')

const viewHint = computed(() => {
  if (!viewMarkdown.value) return ''
  if (view.value === 'materials') {
    return '课程材料视图：就是学生手上那一份（materials/*.md），不用另开页面就能对照着讲。'
  }
  return '讲义视图：每节先 📺 屏幕（学生看到的），再 🎤 讲稿（怎么讲）。'
})

/* ---------------- 跟随讲义（学生材料跟着跳） ---------------- */

const articleRef = ref(null)
/* 并排时右边那一栏（材料）的容器，用来在讲义滚动时把它对齐过去 */
const matArticleRef = ref(null)
/*
 * 跟随默认**关**（原来默认开）。
 *
 * 原来一打开讲义页就直接把全班跳到材料页那一节 —— 老师只是想先翻一翻、
 * 或者准备下节课的内容，学生端就被拽过去了。现在必须老师自己点「跟随中」才开始推，
 * 点过一次会记住（localStorage 存 '1'），下次进讲义页仍是开的。
 */
/*
 * 跟随：**每次进讲义页都从「已暂停」开始**，不记上次的选择。
 *
 * 上一版是 `localStorage.getItem('lecture-sync') === '1'` —— 意思是「记住你上次开没开」。
 * 结果老师某一节点过一次「跟随中」，此后每次打开讲义页都是开着的，
 * 一进来就把全班拽到材料页，而老师只是想先翻一翻、或者备课。
 * 「记住偏好」在这里是错的：打开讲义 ≠ 开始上课，跟随要老师当场决定。
 */
const syncOn = ref(false)
const matKeys = ref(new Set()) // 材料里的同步节点 key（标题归一化后）
const matList = ref([]) // 材料节点明细，用来算「最接近的那节」
const currentSec = ref({ key: '', title: '', anchor: '', closest: '', level: 0 })
const delivered = ref(-1)
let lastPushed = ''
let scrollTimer = null
/* 最近一个「材料里也有」的节点 key（并排时右边据此对齐，见 alignMaterial） */
const lastAnchor = ref('')

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
  /*
   * 不再在 JS 里截断到 18 字 —— CSS 已经固定宽度 + 省略号，
   * 两边都截会变成「18 字 + …」塞在 280px 里，反而看不出还能不能更全。
   * 这里给完整标题，让它自然溢出到省略号。
   */
  const lv = currentSec.value.level > 2 ? 'H' + currentSec.value.level + ' ' : ''
  return '学生材料已跳到「' + lv + currentSec.value.title + '」' + (delivered.value >= 0 ? ' · ' + delivered.value + ' 台' : '')
})

onMounted(() => {
  if (!activeId.value && lessons.value.length) {
    const first = lessons.value.find((l) => l.hasLecture) || lessons.value[0]
    activeId.value = first.id
  }
  window.addEventListener('resize', onResize)
  /* 滚动宿主是 .ws-main（单栏）或卡片本身（并排），要等 DOM 出来才绑得上 */
  nextTick(bindScroll)
  if (activeId.value) open(activeId.value)
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  if (scrollHost) scrollHost.removeEventListener('scroll', onScroll)
  if (scrollTimer) clearTimeout(scrollTimer)
  if (alignTimer) clearTimeout(alignTimer)
  /*
   * 离开讲义页 = 这一节不讲了。
   * 跟随要一起停 —— 否则人已经去了班级管理，学生端还挂着「跟随讲义中」，
   * 而且这个占用（优先级 40）会挡住老师后面想推的东西。
   */
  if (syncOn.value) stopServerFollow()
})

function setView(v) {
  if (view.value === v) return
  view.value = v
  localStorage.setItem('lecture-view', v)
  // 换视图后 DOM 重排：把当前小节重新判定一次，并照原样推给学生（锚点不变）
  nextTick(() => detectSection(true))
}

/*
 * 滚动事件的宿主。
 *
 * 原来绑在 window 上 —— 但骨架锁高之后这一页真正滚的是 .ws-main，
 * window 根本不滚，事件收不到。结果 syncTip 只在切课 / 切视图时更新一次，
 * 滚动过程中一直停在旧节点。这次一并修掉：单栏绑 .ws-main，并排绑讲义那张卡。
 */
let scrollHost = null
function bindScroll() {
  const root = articleRef.value
  const el = sideBySide.value ? root : root && root.parentElement
  if (scrollHost === el) return
  if (scrollHost) scrollHost.removeEventListener('scroll', onScroll)
  scrollHost = el
  if (el) el.addEventListener('scroll', onScroll, { passive: true })
}

/**
 * 把右边那栏对齐到当前小节。
 *
 * 只做「讲义 → 材料」单向跟随：老师在哪讲，材料就翻到哪。
 * 反过来不做，否则两边互相推会让画面自己抖。
 */
let alignTimer = null
function alignMaterial(instant, depth) {
  const root = matArticleRef.value
  /*
   * 优先用当前节点的 anchor；没有就回退到「最近一次能对上」的那个。
   *
   * 讲义里有 📺 屏幕 / 🎤 讲稿 这类分段标题，材料里没有同名节点 ——
   * 它们本该不推给云端（宁可不跳也不跳错），但如果右边因此完全不动，
   * 老师会看到「我滚了半天右边没反应」。回退到上一节能对上的，
   * 至少让右边停在那个小节开头，视觉上还是跟着走的。
   */
  const key = currentSec.value.align || currentSec.value.anchor || lastAnchor.value
  const leftRoot = articleRef.value
  if (!root || !leftRoot || !key) return
  const sel = '[data-sec="' + String(key).replace(/["\\]/g, '\\$&') + '"]'
  const el = root.querySelector(sel)
  const lEl = leftRoot.querySelector(sel)
  if (!el) return

  /*
   * 目标不是「右边这个标题贴到卡片顶部」，而是「和左边那个标题**在同一高度**」。
   *
   * 贴顶的做法在两种情况下会明显错位：
   *   · 左边那个标题已经滚出视口（老师正在读它下面的正文）——右边却把它顶到最上面
   *   · 两边该标题上方的内容长度不同（讲义有 📺屏幕 分段），差值不可预测
   * 按「同样高度」算，两边就始终是同一行文字对齐。
   */
  const rt = root.getBoundingClientRect().top
  const lt = leftRoot.getBoundingClientRect().top
  const wantY = lEl ? lEl.getBoundingClientRect().top - lt : 12
  const curY = el.getBoundingClientRect().top - rt
  const top = Math.max(0, root.scrollTop + curY - wantY)
  if (instant !== true && Math.abs(root.scrollTop - top) < 12) return
  root.scrollTo({ top, behavior: instant === true ? 'auto' : 'smooth' })

  /*
   * 平滑滚动途中，左边可能又往下滚了一节 —— 那一次 align 会把这次的动画打断，
   * 停在中间某个位置（实测能差 200px，两边标题对不上）。
   * 所以等动画该结束的时候，按「当前节点」再硬对一次，只校正不产生新动画。
   */
  if (instant !== true) {
    if (alignTimer) clearTimeout(alignTimer)
    alignTimer = setTimeout(() => alignMaterial(true, 0), 450)
  } else if ((depth || 0) < 2) {
    /*
     * 硬对齐之后仍可能差几十像素：滚过去之后图片才撑开、字体才落位，
     * 目标位置跟着变了。再算一次基本就收敛（实测 508 → 68 → 4 以内）。
     * 只重试两轮，避免在极端情况下反复滚动。
     */
    requestAnimationFrame(() => alignMaterial(true, (depth || 0) + 1))
  }
}

function toggleSide() {
  if (!sideBySide.value && !wideEnough.value) return
  sideBySide.value = !sideBySide.value
  localStorage.setItem('lecture-side', sideBySide.value ? '1' : '0')
  /* 从「一张卡」换成「两张卡」，滚动容器也换了，要重新绑 */
  nextTick(() => {
    bindScroll()
    detectSection(true)
    if (sideBySide.value) alignMaterial(true)
  })
}

function onResize() {
  wideEnough.value = window.innerWidth >= SIDE_MIN_W
  if (!wideEnough.value && sideBySide.value) {
    /* 窗口拖窄了：自动回到单栏，而不是留两栏挤成一条 */
    sideBySide.value = false
    localStorage.setItem('lecture-side', '0')
    nextTick(() => {
      bindScroll()
      detectSection(true)
    })
  }
}

function toggleSync() {
  syncOn.value = !syncOn.value
  if (syncOn.value) {
    lastPushed = ''
    nextTick(() => detectSection(true))
    return
  }
  /*
   * 停下来要**告诉服务端**。
   *
   * 原来只翻本地这个 ref —— 服务端那条 follow 还立着，学生端就一直是
   * 「跟随讲义中」，而且它是 40 的占用，会挡住老师后面想推的东西
   * （表现是「我明明点了暂停，推代码学生还是不动」）。
   */
  stopServerFollow()
}

/** 把服务端的跟随清掉（学生端收到 stopped 就把提示条收了） */
function stopServerFollow() {
  api.del('/api/teacher/follow?classId=' + encodeURIComponent(currentClassId.value || '')).catch(() => {
    /* 网络抖动不管：下一次推 / 停会重来 */
  })
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
  lastAnchor.value = ''
  try {
    doc.value = await api.get('/api/content/doc?type=lecture&id=' + encodeURIComponent(activeId.value))
    await buildSyncMap()
  } catch (e) {
    doc.value = {}
    error.value = e.message
  } finally {
    loading.value = false
    /*
     * 换课要回到开头：否则滚动位置还停在上节课的高度，判定出来的「当前小节」是乱的。
     * 注意这里滚的不是 window —— 单栏滚 .ws-main、并排滚两张卡自己，
     * 原来那行 window.scrollTo 其实什么也没做。
     */
    if (scrollHost) scrollHost.scrollTo({ top: 0 })
    else window.scrollTo({ top: 0 })
    if (matArticleRef.value) matArticleRef.value.scrollTo({ top: 0 })
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
  /*
   * 基准线按「谁在滚」来定：
   *   单栏   滚动发生在 .ws-main，标题的视口坐标可以直接和 ANCHOR_LINE 比；
   *   并排   滚动发生在卡片内部，得用卡片自己顶部往下 48px 作基准 ——
   *          否则卡片贴着页头时，所有标题的视口 top 都小于 120，会被一起判成「已滚过」。
   */
  const base = sideBySide.value ? root.getBoundingClientRect().top + 48 : ANCHOR_LINE
  let idx = 0
  for (let i = 0; i < hs.length; i++) {
    if (hs[i].getBoundingClientRect().top <= base) idx = i
    else break
  }
  const cur = hs[idx]
  const key = cur.dataset.sec || ''
  const title = (cur.textContent || '').trim()

  /*
   * 并排对齐用的节点：从当前节点开始**往下**找第一个材料里也有的标题。
   *
   * 为什么往下找而不是往上：讲义是「📺 屏幕 / 🎤 讲稿」分段结构，材料是一节一节。
   * 停在「📺 屏幕」这一行时，屏幕段下面紧跟着的就是该小节的正文标题（材料里叫同一名字），
   * 用它对齐，两边标题就在同一高度上。
   * 往上找（用上一节）会让右边停在上一节开头，视觉上永远差半屏。
   *
   * 但如果那个标题离基准线太远（比如本小节末尾、下一节在一屏之外），
   * 就不要跳 —— 跳过去反而突兀，沿用上一次的位置。
   */
  let alignKey = ''
  for (let i = idx; i < hs.length; i++) {
    const k = hs[i].dataset.sec || ''
    if (!matKeys.value.has(k)) continue
    const y = hs[i].getBoundingClientRect().top
    if (i > idx && y - base > 420) break
    alignKey = k
    break
  }
  // 标题一致即同节点：材料里有同名标题才推，否则不推（宁可不跳，也不跳错）。
  // 层级不参与匹配：讲义 📺 里用 ####、材料里用 ###，只要标题一样就算同一个节点。
  const anchor = matKeys.value.has(key) ? key : ''
  const closest = anchor ? '' : (closestHeading(title, matList.value) || {}).title || ''
  if (!force && key === currentSec.value.key) return
  if (anchor) lastAnchor.value = anchor
  if (alignKey) lastAnchor.value = alignKey
  currentSec.value = { key, title, anchor, closest, align: alignKey, level: Number(cur.tagName.slice(1)) || 2 }
  pushFollow()
  /* 并排时右边跟着翻过去；单栏时 matArticleRef 是 null，函数自己会返回 */
  if (sideBySide.value) alignMaterial(false)
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
  border-radius: var(--r-lg);
}

.sep {
  width: 1px;
  height: 18px;
  background: var(--line);
  margin: 0 4px;
}

/*
 * 跟随状态固定占 280px，超长的不许把页头撑开。
 *
 * 原来只写了 max-width —— 文字短的时候这一格跟着缩，
 * 切课/切视图时页头右侧会左右抽动。固定宽度 + 省略号，
 * 长短变化只发生在格子内部。
 */
.sync-tip {
  width: 280px;
  flex: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 截断时给个提示，鼠标停一下能看全文 */
  cursor: default;
}

/*
 * 窄屏把这条跟随提示收起来。
 *
 * 它占着 280px（页头里最宽的一个），而这一页专属区本来就有 6 个按钮，
 * 1240 以下那排必然折行、页头从 89 涨到 155。
 * 信息本身不丢：「跟随中 / 已暂停」按钮的 title 里有全文，
 * 而且跟着翻的效果学生端直接能看见。
 */
@media (max-width: 1240px) {
  .sync-tip {
    display: none;
  }
}
</style>
