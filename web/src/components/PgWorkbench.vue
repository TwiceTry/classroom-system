<template>
  <div class="pg" :class="{ 'pg-tall': layout === 'col' }">
    <PageHead>
      <template #title>{{ title }}</template>
      <template #sub>{{ sub }}</template>
      <template #right>
        <!-- 老师正在同步时，学生端只在这里挂一个小标签，不占额外一行 -->
        <span v-if="readonly" class="tag mute" title="这是学生提交上来的代码，只读（能选中、能搜索，改不动）">只读</span>
        <span
          v-if="following"
          class="tag ok"
          :title="'老师正在同步这一课：' + (followFile || '') + '（只读，老师结束后恢复你自己的代码）'"
        >同步中</span>
        <select v-if="!fixedDir" v-model="dir" class="select" :disabled="following" :title="following ? '老师正在同步，这一节不能自己换' : ''" @change="loadDir">
          <option v-for="e in examples" :key="e.dir" :value="e.dir">{{ e.title }}</option>
        </select>
        <select v-if="pages.length" v-model="page" class="select" :disabled="following" :title="following ? '老师正在同步，预览页跟着老师' : ''" @change="onPageChange">
          <option v-for="p in pages" :key="p" :value="p">{{ p }}</option>
        </select>
        <button
          v-if="canSync && !readonly"
          class="btn mini"
          :class="{ on: syncOn }"
          :disabled="!bundle || !syncClassId"
          :title="syncTitle"
          @click="toggleSync"
        >
          {{ syncOn ? '停止同步' : '同步代码' }}
        </button>
        <!-- 只有「代码练习」这个页签传了 content-dir：在这里能整目录导出/导入示例 -->
        <DirIO v-if="contentDir" :dir="contentDir" :label="title" />
        <button class="btn mini" :disabled="!bundle" title="Ctrl+S" @click="run">▶ 运行</button>
        <button v-if="!readonly" class="btn mini" :disabled="!dirtyCount" @click="resetAll">↺ 还原{{ dirtyCount ? '（' + dirtyCount + '）' : '' }}</button>
        <label class="check"><input v-model="autoRun" type="checkbox" /> 自动运行</label>
        <span class="fontbox">
          <button class="btn mini" title="字号 -" @click="adjustFont(-1)">A−</button>
          <button class="btn mini" title="字号 +" @click="adjustFont(1)">A+</button>
        </span>
        <button class="btn mini" :title="layout === 'row' ? '改成上下排列' : '改成左右排列'" @click="toggleLayout">
          {{ layout === 'row' ? '上下排' : '左右排' }}
        </button>
        <button class="btn mini" :title="codeHidden ? '把代码块放回来' : '只看渲染结果'" @click="toggleCode">
          {{ codeHidden ? '显示代码' : '隐藏代码' }}
        </button>
        <!-- files = 改过的文件；all-files = 整份（交作业要整份，老师才能跑起来看渲染） -->
        <slot name="actions" :dirty-count="dirtyCount" :files="editedFiles" :all-files="allFiles" :bundle="bundle" />
      </template>
    </PageHead>

    <div class="content">
      <slot name="banner" :dirty-count="dirtyCount" :files="editedFiles" />
      <p v-if="error" class="hint err" style="margin-bottom:10px">{{ error }}</p>

      <div v-if="!bundle" class="card empty">正在读取示例清单…</div>

      <div v-else class="work" :class="['dir-' + layout, { nocode: codeHidden }]">
        <aside class="files">
          <div class="files-head">
            <span class="mono ellip">{{ dirLabel }}</span>
            <label class="eye" title="连页面和入口文件一起显示">
              <input v-model="showAll" type="checkbox" @change="saveShowAll" /> 全部
            </label>
          </div>
          <div class="treescroll">
            <div v-for="(g, gi) in tree.groups" :key="gi" class="grp">
              <button
                v-if="g.kind === 'page'"
                class="ghead"
                :class="{ on: g.page === page }"
                :title="g.page"
                @click="openGroup(g)"
              >
                <span v-if="visibleItems(g).length" class="caret" @click.stop="toggleGroup(gi)">{{ closed[gi] ? '▸' : '▾' }}</span>
                <span v-else class="caret none"></span>
                <FileIcon :path="g.page" :size="15" />
                <span class="ellip">{{ shortPage(g.page) }}</span>
                <span v-if="groupDirty(g)" class="dot"></span>
              </button>
              <div v-else class="ghead static">
                <span class="ellip">{{ g.kind === 'shared' ? '多页共用' : '未被页面引用' }} · {{ g.items.length }}</span>
              </div>

              <template v-if="!closed[gi]">
                <button
                  v-for="it in visibleItems(g)"
                  :key="it.path"
                  class="item"
                  :class="{ on: it.path === activeFile }"
                  :title="it.path"
                  @click="openFile(it.path)"
                >
                  <FileIcon :path="it.path" :size="15" />
                  <span class="ellip">{{ shortName(g, it.path) }}</span>
                  <span v-if="isDirty(it.path)" class="dot"></span>
                </button>
              </template>
            </div>
          </div>
          <div class="files-foot" :title="footTitle">
            <span class="dot" :class="{ off: !dirtyCount, fail: storeFail }"></span>
            <span class="ellip">{{ footText }}</span>
            <button v-if="dirtyCount" class="linkbtn" title="清掉本机记住的改动，回到原始示例" @click="clearSaved">清空</button>
          </div>
        </aside>

        <div class="stack">
        <section v-show="!codeHidden" class="editor" :style="{ flexBasis: codePct + '%' }">
          <div class="ed-head">
            <FileIcon :path="activeFile" :size="14" />
            <span class="mono ellip">{{ activeFile || '—' }}</span>
            <span class="tag">{{ langName }}</span>
            <span class="spacer"></span>
            <span v-if="isDirty(activeFile)" class="tag warn">已修改</span>
            <span class="dim">行 {{ caret.line }}，列 {{ caret.col }}</span>
          </div>
          <div ref="cmHost" class="cm-host"></div>
        </section>

        <div
          v-show="!(layout === 'col' && codeHidden)"
          class="pg-split"
          :class="{ 'edge-right': layout === 'col' && !codeHidden, 'edge-left': codeHidden }"
          :title="codeHidden ? '往右拖，把代码块拉回来' : layout === 'row' ? '拖动调整宽度（拖到最宽→上下排，最窄→收起）' : '往左拖回左右排'"
          @pointerdown="startDrag"
        ></div>

        <section class="preview">
          <div class="ed-head">
            <FileIcon :path="page" :size="14" />
            <span class="mono ellip">{{ page || '（选一个页面）' }}</span>
            <span class="spacer"></span>
            <span v-if="npmPage" class="tag warn">npm 工程</span>
            <span v-else-if="running" class="tag ok">已渲染</span>
            <a
              v-if="page"
              :href="'/examples/' + encodeURI(dir) + '/' + page"
              target="_blank"
              rel="noopener"
              class="btn mini"
            >
              新窗口
            </a>
          </div>

          <div v-if="npmPage" class="npmcard">
            <div class="npmicon">⚙</div>
            <h3>这一课是 npm 工程，浏览器里预览不了</h3>
            <p>
              它的入口是 <code>{{ npmEntry }}</code>，代码靠 Vite 打包、裸模块（<code>vue</code> /
              <code>vue-router</code> / <code>pinia</code>）由 node_modules 解析。
              这里没有打包器，也没有 node_modules，所以给不出画面——不是坏了。
            </p>
            <ol>
              <li>在<code>代码示例/{{ bundle.dir }}</code> 里打开终端</li>
              <li><code>npm install</code>（第一次，要联网）</li>
              <li><code>npm run dev</code>，照着终端给的地址打开</li>
            </ol>
            <p class="dim">左边的源码仍然可以看、可以改，改完在真实工程里对照。</p>
          </div>

          <template v-else>
            <iframe ref="frame" class="frame" title="preview" @load="onFrameLoad"></iframe>
            <div v-if="pageErrors.length" class="perr">
              <div class="perr-head">
                <span class="perr-badge" :class="{ soft: !codeErrors.length }">{{ pageErrors.length }}</span>
                <b>页面报错</b>
                <span class="dim">改完会自动重跑；有行号的能点「跳到第 N 行」</span>
                <span class="spacer"></span>
                <button class="perr-mini" title="把全部报错复制到剪贴板" @click="copyErrors">{{ copied ? '已复制' : '复制' }}</button>
                <button class="perr-mini" @click="clearErrors">清空</button>
                <button class="perr-x" title="收起报错" @click="clearErrors">×</button>
              </div>
              <ol class="perr-list">
                <li v-for="e in codeErrors" :key="e.id" :class="'k-' + e.kind">
                  <div class="perr-line">
                    <span class="perr-tag">{{ kindLabel(e) }}</span>
                    <span class="perr-msg">{{ e.msg }}</span>
                    <button v-if="e.line" class="perr-jump" @click="jumpToError(e)">
                      跳到第 {{ e.line }} 行
                    </button>
                  </div>
                  <div v-if="e.loc" class="perr-loc">{{ e.loc }}</div>
                  <pre v-if="e.frames.length" class="perr-stack">{{ e.frames.join('\n') }}</pre>
                </li>
                <li v-if="resErrors.length" class="res-sum">
                  <button class="perr-jump" @click="resOpen = !resOpen">
                    {{ resOpen ? '收起' : '展开' }} {{ resErrors.length }} 个资源加载失败
                  </button>
                  <span class="dim">（多半是示例图片路径，不影响代码；点开可看具体是哪个文件）</span>
                </li>
                <template v-if="resOpen">
                  <li v-for="e in resErrors" :key="e.id" :class="'k-' + e.kind">
                    <div class="perr-line">
                      <span class="perr-tag">{{ kindLabel(e) }}</span>
                      <span class="perr-msg">{{ e.msg }}</span>
                    </div>
                  </li>
                </template>
              </ol>
            </div>
          </template>
        </section>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
/*
 * PgWorkbench —— 代码工作台（Playground 与「课堂作业」共用同一份）
 *
 * 这里只放「编辑 + 预览 + 本机存档」这一套通用逻辑，不掺业务：
 *   · 教师 / 学生 Playground：example 目录可选，改动存本机；
 *   · 课堂作业：fixedDir 锁死成作业指定的目录，带 bucket 单独分桶，
 *     交作业时通过 actions 插槽拿到 editedFiles 一起传上去。
 *
 * 为什么要 bucket：同一个学生可能既在 Playground 里玩第 6 课，又在第 6 课的
 * 课堂作业里改同一批文件。存档共用一格的话，交作业会把 Playground 里的东西一起交上去。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { api } from '../api'
import { buildTree, isPage as isPagePath, baseOf } from '../utils/pgTree'
import { createEditor, langNameFor } from '../utils/pgEditor'
import { buildPreviewDoc, ensureSfcSrcdoc, isNpmProject } from '../utils/pgPreview'
import { state } from '../store'
import { currentClassId } from '../utils/classSel'
import { onPresenceMessage } from '../utils/presence'
import DirIO from './DirIO.vue'
import PageHead from './PageHead.vue'
import FileIcon from './FileIcon.vue'

const props = defineProps({
  title: { type: String, default: '代码练习' },
  sub: { type: String, default: '' },
  fixedDir: { type: String, default: '' }, // 非空 = 锁定目录（课堂作业用）
  bucket: { type: String, default: 'pg' }, // 本机存档的键名前缀
  contentDir: { type: String, default: '' }, // 非空 = 页头显示「导出/导入这个内容目录」
  readonly: { type: Boolean, default: false }, // 只读（老师批阅时看学生的提交：能选中能搜索，改不动）
})

const examples = ref([])

/** 顶部那行目录名：作业自带代码 / 提交快照 用一句人话，不要露出 @a: / @s: 这种内部名字 */
const dirLabel = computed(() => {
  const d = (bundle.value && bundle.value.dir) || dir.value || ''
  if (d.indexOf('@a:') === 0) return '本次作业的起手代码'
  if (d.indexOf('@s:') === 0) return '学生提交的快照'
  return d
})
const dir = ref(props.fixedDir || '')
const bundle = ref(null)
const page = ref('')
const activeFile = ref('')
const edits = reactive({})
const autoRun = ref(true)
const error = ref('')
const running = ref(false)
const pageErrors = ref([]) // 预览里的报错：一条一个对象 { id, kind, name, msg, loc, line, file, frames }
const copied = ref(false) // 「复制」按钮的短暂回执
let pageErrSeq = 0
let copyTimer = null
const caret = reactive({ line: 1, col: 1 })
const closed = reactive({})
const showAll = ref(localStorage.getItem('pg-showall') === '1')
const fontPx = ref(Number(localStorage.getItem('pg-font') || 13))
const cmHost = ref(null)
const frame = ref(null)

/*
 * 预览区的滚动位置：srcdoc 一换，iframe 等于重新加载，滚动必然回到顶部。
 * 自动运行是「改一下就重跑」的，所以必须在重载后把位置放回去 ——
 * 只有换页面 / 换课时才从头开始（那是真的换内容了）。
 */
let pendingScroll = null
let lastRunPage = ''

/*
 * 工作区排版：
 *   layout = row（左右：代码在左、预览在右）| col（上下：代码在上、预览在下）
 *   codePct = 代码块占 .stack 的比例，按 20% 一挡（20/40/60/80）
 *   拖到 >88% 自动切上下排（左右已经不够宽了）；拖到 <8% 自动收起代码
 *
 * 这三个值**故意不记忆**：学生把分栏拖乱了、或者拖成不认识的布局时，
 * 刷新一下页面就回到默认（左右排 · 代码 60% · 代码可见），不用教怎么拖回来。
 */
/* 老版本把这三项存在本机，现在不记了：进页面顺手清掉，免得旧值留在那儿 */
const LEGACY_KEYS = ['pg-layout', 'pg-code-pct', 'pg-code-hidden']

/* 挡位少一点：20% 一挡，20 / 40 / 60 / 80 四档 */
const PCT_MIN = 20
const PCT_MAX = 80
const PCT_STEP = 20

function clampPct(v) {
  const n = Number(v)
  if (!isFinite(n)) return 40
  return Math.max(PCT_MIN, Math.min(PCT_MAX, Math.round(n / PCT_STEP) * PCT_STEP))
}

// 上课是「看代码」为主：默认代码块比预览宽一点（60 / 40），学生那边同样
const DEFAULT_PCT = 60
const layout = ref('row') // 默认左右排
const codePct = ref(DEFAULT_PCT) // 默认 60%
const codeHidden = ref(false) // 默认显示代码

/* 什么都不存：刷新即回默认（学生拖乱了靠刷新复位） */
function persistLayout() {
  /* 故意留空 */
}

/** 清掉老版本留下的三个键（只跑一次，失败无所谓） */
function clearLegacyLayout() {
  try {
    LEGACY_KEYS.forEach((k) => localStorage.removeItem(k))
  } catch (e) {
    /* 隐私模式忽略 */
  }
}

function toggleLayout() {
  layout.value = layout.value === 'row' ? 'col' : 'row'
  persistLayout()
  nextTick(() => requestMeasure())
}

function toggleCode() {
  codeHidden.value = !codeHidden.value
  persistLayout()
  nextTick(() => requestMeasure())
}

/** CodeMirror 在容器尺寸变化后要重新量一次，否则会出现「滚动区高度不对 / 空白」 */
function requestMeasure() {
  if (ed.value && ed.value.view) ed.value.view.requestMeasure()
}

/** 拖动分栏：只在指针移动时按挡位取整，松手才落盘 */
/*
 * 拖动分栏条（三档行为，全靠横向位移判断）：
 *   代码收起 —— 往右拖 40px 以上：把代码块拉回来
 *   竖排     —— 往左拖 60px 以上：回左右排（「拖到最大变竖排」因此可逆）
 *   左右排   —— 按 20% 一挡改宽度；拖到最宽转竖排，拖到最窄收起
 */
function startDrag(e) {
  e.preventDefault()
  const el = e.currentTarget
  const stackEl = el && el.parentElement
  if (!stackEl) return

  /*
   * 状态完全由「指针在代码区的横向位置」推导，而不是由「走了多少像素」推导：
   *   < 8%   → 收起代码块
   *   > 88%  → 竖排（横着已经放不下了）
   *   中间   → 横排，按 20% 一挡取整
   * 好处：按住不放一路拖，收起 → 横排 → 竖排 → 再拖回来，全都连续生效，
   * 不用松手重新点边框。
   */
  const rect = stackEl.getBoundingClientRect()
  const total = rect.width || 1
  const pctAt = (clientX) => ((clientX - rect.left) / total) * 100

  // 用指针捕获：拖动时指针可能跑到 iframe / 别处，收在分栏条上更稳
  try {
    if (el && el.setPointerCapture && e.pointerId !== undefined) el.setPointerCapture(e.pointerId)
  } catch (err) {
    /* 个别浏览器不支持，退回 window 监听 */
  }
  const cleanup = () => {
    el && el.removeEventListener('pointermove', move)
    el && el.removeEventListener('pointerup', cleanup)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', cleanup)
    persistLayout()
    requestMeasure()
  }

  const move = (ev) => {
    const p = pctAt(ev.clientX)

    // 太靠左：收起代码（继续按住往右拖会自己回来）
    if (p < 8) {
      if (!codeHidden.value) codeHidden.value = true
      return
    }
    // 太靠右：竖排（继续按住往左拖会自己回到横排）
    if (p > 88) {
      if (codeHidden.value) codeHidden.value = false
      if (layout.value !== 'col') layout.value = 'col'
      return
    }

    // 中间：横排 + 挡位
    if (codeHidden.value) codeHidden.value = false
    if (layout.value !== 'row') layout.value = 'row'
    const want = clampPct(p)
    if (codePct.value !== want) codePct.value = want
  }

  if (el) {
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', cleanup)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', cleanup)
}

const ed = shallowRef(null)
let runTimer = null

/* ---------------- 代码练习同步 ----------------
 * 老师点「同步代码」后，当前文件的内容（含之后每一次改动）推给学生端，学生那边只读跟随。
 * 学生开始跟随前会把自己的代码先暂存一份，老师点「停止同步」时原样还回去。
 * 状态同时落在服务端（state 表），刷新页面 / 晚进教室也能接上。
 */
const syncOn = ref(false) // 教师端：正在同步
const following = ref(false) // 学生端：正在跟随
const followFile = ref('')
let syncTimer = null
let caretPos = 0 // 老师当前光标（字符偏移），同步时一起推
let stash = null // 学生端：跟随前自己那份代码 { dir, edits }
let skipFlush = false // 这一次切课时包不落盘（避免把老师的代码写进学生的存档桶）
let offSync = null

const syncClassId = computed(() => currentClassId.value || (state.classes[0] && state.classes[0].id) || '')
const canSync = computed(() => state.role === 'teacher' && !props.fixedDir)
const syncTitle = computed(() =>
  !syncClassId.value
    ? '先在侧栏选一个班级'
    : syncOn.value
      ? '停止同步，学生回到自己的代码'
      : '把你正在写的这个文件同步给学生（学生端只读）'
)

function syncUrl() {
  return '/api/classes/' + encodeURIComponent(syncClassId.value) + '/pg-sync'
}

function publishSync() {
  if (!syncOn.value || !syncClassId.value || !bundle.value) return
  api
    .post(syncUrl(), {
      active: true,
      dir: dir.value,
      file: activeFile.value,
      page: page.value,
      caret: caretPos,
      code: textOf(activeFile.value),
    })
    .catch(() => {})
}

/** 打字时别每个字符推一次：停手 500ms 再发 */
function publishSoon() {
  if (!syncOn.value) return
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    publishSync()
  }, 500)
}

async function toggleSync() {
  if (syncOn.value) {
    syncOn.value = false
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = null
    try {
      await api.post(syncUrl(), { active: false })
    } catch (e) {
      error.value = e.message
    }
    return
  }
  if (!syncClassId.value) {
    error.value = '先在侧栏选一个班级，再点同步'
    return
  }
  syncOn.value = true
  publishSync()
}

/** 学生端：把老师那一段应用过来（只读） */
async function applySynced(msg) {
  if (!msg || !msg.file) return
  if (!following.value) {
    // 连「学生正在看哪个文件」一起记住：恢复时连视图一起回到原处，
    // 否则学生会以为自己写的代码丢了（其实只是还在别的文件里）
    stash = { dir: dir.value, file: activeFile.value, edits: Object.assign({}, edits) }
  }
  if (msg.dir && msg.dir !== dir.value && !props.fixedDir) {
    dir.value = msg.dir
    await loadDir() // 会把学生这一课自己的存档读回来，再被下面的老师版本覆盖
  }
  if (!bundle.value) return
  following.value = true

  // ① 老师换文件：编辑器跟着跳
  if (msg.file && bundle.value.files.some((f) => f.path === msg.file)) {
    followFile.value = msg.file
    edits[msg.file] = String(msg.code || '')
    if (activeFile.value !== msg.file) activeFile.value = msg.file
    await nextTick()
    const wantCaret = typeof msg.caret === 'number' ? msg.caret : null
    const cv = ed.value && ed.value.view
    // 内容没变（只是老师挪了光标）：不要整篇重设，否则学生那边会闪、滚动位置也会跳回顶部
    if (cv && cv.state.doc.toString() === String(msg.code || '')) {
      if (wantCaret !== null) ed.value.setCaret(wantCaret)
    } else {
      ed.value && ed.value.setDoc(String(msg.code || ''), wantCaret === null ? undefined : wantCaret)
      ed.value && ed.value.setLanguage(activeFile.value)
    }
  }

  // ② 老师换预览页（同一课里点左边目录）：右侧画面也跟着跳
  if (msg.page && msg.page !== page.value && bundle.value.files.some((f) => f.path === msg.page)) {
    page.value = msg.page
    if (autoRun.value) run()
  }

  if (ed.value) ed.value.setReadOnly(true)
  scheduleSave()
}

/** 停止跟随：把学生自己的代码还回去 */
async function stopFollow() {
  if (!following.value) return
  following.value = false
  followFile.value = ''
  const s = stash
  stash = null
  if (ed.value) ed.value.setReadOnly(false)
  if (!s) return

  // 老师中途换了课：连课一起回到学生原来那一节（他自己那份从本机存档读回）
  if (!props.fixedDir && s.dir && s.dir !== dir.value) {
    // 关键：此刻内存里的 edits 还是老师的代码，loadDir 开头会 flushEdits，
    // 不挡住就会把老师的代码写进学生「老师那一节课」的存档桶里 —— 之后就"停不掉了"。
    skipFlush = true
    try {
      dir.value = s.dir
      await loadDir()
    } finally {
      skipFlush = false
    }
    if (s.file && activeFile.value !== s.file) activeFile.value = s.file
    syncDoc()
    return
  }

  if (s.dir === dir.value) {
    Object.keys(edits).forEach((k) => delete edits[k])
    Object.assign(edits, s.edits)
    if (s.file && activeFile.value !== s.file) activeFile.value = s.file
    syncDoc()
    scheduleSave()
  }
}

function onSyncMsg(m) {
  if (!m || m.t !== 'pgsync') return
  if (m.active === false) {
    stopFollow()
    return
  }
  // 老师同步期间学生必须跟着：没有「先不听」，想自己写要等老师点停止
  applySynced(m)
}

/* ---------------- 改动的本机存档 ----------------
 * 同学的代码只存在自己这台机器的浏览器里：刷新、关掉浏览器、晚上关机，再打开还在。
 * 存两处信息：内容按「身份 + 目录」分桶，谁登录谁的那一份，机房共用一台机器也不串。
 */
const storeFail = ref(false) // 存不下（配额满 / 浏览器禁了 localStorage）
let savedDir = '' // 当前 edits 属于哪个目录（切目录时要存回原来那个桶）
let savedScope = '' // 当前 edits 属于谁：进页面时定下来，退出登录把 state 清空了也不影响落盘
let saveTimer = null

function scopeOf() {
  const s = state.student
  const raw =
    state.role === 'student' && s && s.sid
      ? 's-' + (s.classId || 'c') + '-' + s.sid
      : state.role === 'teacher'
        ? 't'
        : 'guest'
  return raw.replace(/[^0-9a-zA-Z_-]/g, '_')
}

function storeKey(d) {
  return props.bucket + '-edits:' + (savedScope || scopeOf()) + ':' + d
}

/** 记住「上次在看哪个页面」：键名同样带 bucket，作业之间不串 */
function pageKey(d) {
  return props.bucket + '-page-' + d
}

/** 把当前 edits 写回 localStorage（空表就删键，别留垃圾） */
function flushEdits() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  // 跟随时屏幕上是老师的代码：不能写进学生自己的存档桶（否则他自己的那一课被覆盖）
  if (following.value || skipFlush) return
  if (!savedDir) return
  try {
    const key = storeKey(savedDir)
    if (!Object.keys(edits).length) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(edits))
    storeFail.value = false
  } catch (e) {
    storeFail.value = true // 配额满了：内存里照常编辑，只是这次存不下
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushEdits, 400)
}

/** 切目录时把上一目录的存档读回来（只认当前包里真有的文件，防止旧存档串进新版本） */
function restoreEdits() {
  storeFail.value = false
  try {
    const raw = localStorage.getItem(storeKey(dir.value))
    if (!raw) return
    const saved = JSON.parse(raw)
    if (!saved || typeof saved !== 'object') return
    for (const p in saved) {
      if (typeof saved[p] !== 'string') continue
      if (bundle.value.files.some((f) => f.path === p)) edits[p] = saved[p]
    }
  } catch (e) {
    storeFail.value = true
  }
}

const pages = computed(() =>
  bundle.value ? bundle.value.files.filter((f) => isPagePath(f.path)).map((f) => f.path) : []
)
const tree = computed(() => (bundle.value ? buildTree(bundle.value.files) : { groups: [], byPath: {} }))
const langName = computed(() => langNameFor(activeFile.value))

const npmEntry = computed(() => {
  if (!page.value) return ''
  const t = textOf(page.value)
  const m = /<script\b[^>]*\bsrc\s*=\s*["']([^"']*\/src\/[^"']+)["']/i.exec(t)
  return m ? m[1] : 'npm run dev'
})

/* npm 工程页预览不了（浏览器里没有打包器），判断规则见 utils/pgPreview */
const npmPage = computed(() => {
  if (!bundle.value || !page.value) return false
  return isNpmProject(bundle.value.files, page.value)
})

const dirtyCount = computed(() => {
  let n = 0
  for (const k in edits) {
    const f = bundle.value && bundle.value.files.find((x) => x.path === k)
    if (!f || edits[k] !== f.text) n++
  }
  return n
})

/** 改动过的文件（用来标红点 / 数改动数） */
const editedFiles = computed(() => {
  if (!bundle.value) return []
  const out = []
  for (const f of bundle.value.files) {
    const t = edits[f.path]
    if (t !== undefined && t !== f.text) out.push({ path: f.path, text: t })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
})

/**
 * 交作业用：整份文件（改过的取改动，没改的取原文）。
 * 只交改过的文件虽然省流量，但老师那边没法把页面跑起来看渲染结果，
 * 所以连同没动过的一起交 —— 一整课也就几十 KB。
 */
const allFiles = computed(() => {
  if (!bundle.value) return []
  return bundle.value.files
    .map((f) => ({ path: f.path, text: edits[f.path] !== undefined ? edits[f.path] : f.text }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
})

const footText = computed(() => {
  if (storeFail.value) return '本机存不下（浏览器配额满或被禁），只在本页有效'
  if (!dirtyCount.value) return '改动会自动存到本机浏览器'
  return '已存本机 · ' + dirtyCount.value + ' 个文件'
})

const footTitle = computed(() =>
  state.role === 'student'
    ? '改动存在这台电脑的浏览器里，刷新 / 关掉浏览器再打开都还在；换人登录各存各的'
    : '改动存在这台电脑的浏览器里，刷新 / 关掉浏览器再打开都还在'
)

function textOf(p) {
  if (!bundle.value || !p) return ''
  if (edits[p] !== undefined) return edits[p]
  const f = bundle.value.files.find((x) => x.path === p)
  return f ? f.text : ''
}

function isDirty(p) {
  if (!p) return false
  const f = bundle.value && bundle.value.files.find((x) => x.path === p)
  if (!f) return false
  return edits[p] !== undefined && edits[p] !== f.text
}

function groupDirty(g) {
  return g.items.some((it) => isDirty(it.path))
}

function shortName(g, p) {
  return g.dir && p.indexOf(g.dir) === 0 ? p.slice(g.dir.length) : p
}

function shortPage(p) {
  const b = baseOf(p)
  const d = p.slice(0, p.length - b.length)
  return d ? d.replace(/\/$/, '') + '/' + b : b
}

function visibleItems(g) {
  if (showAll.value) return g.items
  const vis = g.items.filter((it) => it.role !== 'page' && it.path !== g.entry)
  // 组里只有入口（补充课的 q1.js 那种）：别把整组压成空
  return vis.length ? vis : g.items.filter((it) => it.role !== 'page')
}

function toggleGroup(i) {
  closed[i] = !closed[i]
}

function saveShowAll() {
  localStorage.setItem('pg-showall', showAll.value ? '1' : '0')
}

/* ---------------- 装载 ---------------- */

/* 关标签页 / 切后台时把最后 400ms 内的改动落地，别让防抖吃掉 */
function onHide() {
  if (document.visibilityState !== 'hidden') return
  flushEdits()
}

onMounted(async () => {
  clearLegacyLayout()
  offSync = onPresenceMessage(onSyncMsg)
  window.addEventListener('message', onFrameMessage)
  window.addEventListener('beforeunload', flushEdits)
  document.addEventListener('visibilitychange', onHide)
  try {
    if (props.fixedDir) {
      // 锁定目录（课堂作业）：不用拉示例清单，直接装这一课
      dir.value = props.fixedDir
      await loadDir()
      return
    }
    const res = await api.get('/api/examples')
    examples.value = res.lessons || []
    if (examples.value.length) {
      dir.value = localStorage.getItem('pg-dir') || examples.value[0].dir
      await loadDir()
    }
    // 学生端：进页面时如果老师正在同步，直接接上
    if (state.role === 'student') {
      const res = await api.get('/api/pgsync').catch(() => null)
      const pg = res && res.pg
      if (pg && pg.active) await applySynced(pg)
    }
  } catch (e) {
    error.value = e.message
  }
})

// 固定目录的场景允许外部换作业时就地重载
watch(
  () => props.fixedDir,
  async (v) => {
    if (!v || v === savedDir) return
    dir.value = v
    await loadDir()
  }
)

onBeforeUnmount(() => {
  if (offSync) offSync()
  flushEdits()
  window.removeEventListener('message', onFrameMessage)
  window.removeEventListener('beforeunload', flushEdits)
  document.removeEventListener('visibilitychange', onHide)
  if (runTimer) clearTimeout(runTimer)
  if (ed.value) ed.value.destroy()
})

async function loadDir() {
  flushEdits() // 先把上一个目录的改动存回它自己的桶
  if (!props.fixedDir) localStorage.setItem('pg-dir', dir.value)
  page.value = ''
  activeFile.value = ''
  pageErrors.value = []
  error.value = ''
  Object.keys(edits).forEach((k) => delete edits[k])
  Object.keys(closed).forEach((k) => delete closed[k])
  bundle.value = null
  try {
    const res = await api.get('/api/examples/' + encodeURIComponent(dir.value))
    bundle.value = res
    savedDir = dir.value
    savedScope = scopeOf()
    restoreEdits()
    const savedPage = localStorage.getItem(pageKey(dir.value))
    page.value = res.files.some((f) => f.path === savedPage && isPagePath(f.path))
      ? savedPage
      : (res.files.find((f) => /^index\.html$/i.test(f.path)) || res.files.find((f) => isPagePath(f.path)) || {}).path || ''
    const first =
      res.files.find((f) => f.path === 'App.vue') ||
      res.files.find((f) => !isPagePath(f.path) && /\.vue$/i.test(f.path)) ||
      res.files.find((f) => !isPagePath(f.path) && /\.(mjs|js)$/i.test(f.path)) ||
      res.files.find((f) => !isPagePath(f.path) && /\.css$/i.test(f.path)) ||
      res.files[0]
    if (first) activeFile.value = first.path
    await nextTick()
    ensureEditor()
    await nextTick()
    syncDoc()
    if (autoRun.value && page.value) run()
    // 老师正在同步时换了一节：新的一节也推过去（学生这边 dir 也跟着切）
    if (syncOn.value) publishSync()
  } catch (e) {
    error.value = e.message
  }
}

function ensureEditor() {
  if (!cmHost.value) return
  // 宿主换了（换课时包时 v-if 把工作区拆了重建）：老编辑器不能再复用
  if (ed.value && !cmHost.value.contains(ed.value.view.dom)) {
    try {
      ed.value.destroy()
    } catch (e) {
      /* 已经被拆掉也无所谓 */
    }
    ed.value = null
  }
  if (ed.value) return
  ed.value = createEditor(cmHost.value, {
    fontSize: fontPx.value,
    readOnly: props.readonly,
    onChange(text) {
      if (!activeFile.value) return
      const f = bundle.value && bundle.value.files.find((x) => x.path === activeFile.value)
      if (f && text === f.text) delete edits[activeFile.value] // 改回原样＝不算改过，别占存档
      else edits[activeFile.value] = text
      scheduleSave()
      if (autoRun.value) scheduleRun()
      publishSoon() // 老师端：改动同步给学生（学生端 syncOn 恒为 false，无副作用）
    },
    onCaret(c) {
      caret.line = c.line
      caret.col = c.col
      // 老师端：光标一动也推（节流 0.5 秒），学生端会跟着跳并滚到那一行
      if (typeof c.pos === 'number') {
        caretPos = c.pos
        if (syncOn.value) publishSoon()
      }
    },
    onRun: run,
  })
  // 换课时包会重建编辑器：跟随中的话把只读补回去
  if (following.value) ed.value.setReadOnly(true)
}

function syncDoc() {
  // 编辑器还没建好（宿主刚渲染、或换课时包时工作区被重建）：下一帧补一次，
  // 否则会出现「点了文件但代码块里是空的」
  if (!ed.value) {
    nextTick(() => {
      ensureEditor()
      if (ed.value) syncDoc()
    })
    return
  }
  const text = textOf(activeFile.value)
  ed.value.setDoc(text)
  ed.value.setLanguage(activeFile.value)
  // 兜底：该有内容却是空的（刚重建 / 还没量过），下一帧再设一次
  if (text && ed.value.view.state.doc.length === 0) {
    requestAnimationFrame(() => {
      if (ed.value && ed.value.view.state.doc.length === 0) ed.value.setDoc(text)
    })
  }
}

watch(activeFile, async () => {
  await nextTick()
  syncDoc()
})

/*
 * 老师这边「换文件 / 换预览页」也要推给学生（原来只在打字时推）：
 * 学生跟着跳文件、跳页面，才算真的"同步这一节"。
 */
watch([activeFile, page], () => {
  if (syncOn.value) publishSoon()
})

function adjustFont(d) {
  fontPx.value = Math.min(24, Math.max(11, fontPx.value + d))
  localStorage.setItem('pg-font', String(fontPx.value))
  if (ed.value) ed.value.setFontSize(fontPx.value)
}

/* ---------------- 打开文件 / 页面 ---------------- */

function openGroup(g) {
  if (following.value || !g.page) return // 老师同步期间：预览页跟着老师走
  page.value = g.page
  localStorage.setItem(pageKey(dir.value), g.page)
  // 组里没有源码（纯 HTML 课）：点标题就等于"看这个页面的源码"
  if (visibleItems(g).length === 0) activeFile.value = g.page
  if (autoRun.value) scheduleRun()
}

function openFile(p) {
  if (following.value) return // 老师同步期间：文件跟着老师走
  activeFile.value = p
  if (isPagePath(p)) {
    page.value = p
    localStorage.setItem(pageKey(dir.value), p)
    if (autoRun.value) scheduleRun()
    return
  }
  // 点源码时把预览切到用它的那个页面——独立版就是这个手感
  const owners = tree.value.byPath[p]
  if (owners && owners.length && owners[0] !== page.value) {
    page.value = owners[0]
    localStorage.setItem(pageKey(dir.value), page.value)
    if (autoRun.value) scheduleRun()
  }
}

function onPageChange() {
  if (following.value) return
  localStorage.setItem(pageKey(dir.value), page.value)
  if (autoRun.value) run()
}

function resetAll() {
  if (following.value) return // 老师同步期间不允许动自己的存档
  Object.keys(edits).forEach((k) => delete edits[k])
  flushEdits() // 存档一起清掉，否则下次打开又"复活"
  syncDoc()
  caret.line = 1
  caret.col = 1
  run()
}

/** 文件面板底部的「清空」：只清当前这一课的本机存档 */
function clearSaved() {
  if (!dirtyCount.value) return
  if (!window.confirm('清掉本机记住的 ' + dirtyCount.value + ' 个文件改动，回到原始示例？此操作不可撤销。')) return
  Object.keys(edits).forEach((k) => delete edits[k])
  flushEdits()
  syncDoc()
  run()
}

/* ---------------- 运行 ---------------- */

function scheduleRun() {
  if (runTimer) clearTimeout(runTimer)
  runTimer = setTimeout(run, 700)
}

/* 把 iframe 里的路径裁成「本课里的文件名」，一眼看得出是哪个文件 */
function shortFile(f) {
  const str = String(f || '')
  if (!str || str === 'about:srcdoc' || str === 'srcdoc') return ''
  const m = str.match(/\/([^/]+)$/)
  return m ? decodeURIComponent(m[1]) : str
}

/* 调用栈只留「哪个文件第几行」那几行，且把长地址裁短 */
function tidyStack(stack, fallbackFile) {
  const lines = String(stack || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^at |^\w*Error/.test(l))
  const keep = lines
    .filter((l) => /\/examples\/|srcdoc|:\d+:\d+/.test(l))
    .map((l) => l.replace(/https?:\/\/[^/]+/g, '').replace(/about:srcdoc/gi, fallbackFile || '页面'))
    .slice(0, 4)
  return keep.length ? keep : lines.slice(0, 3)
}

function onFrameMessage(e) {
  const d = e.data
  if (!d || !d.__pg) return
  if (e.source !== (frame.value && frame.value.contentWindow)) return

  const kind = d.kind || 'error'
  const msg = String(d.m || '未知错误').trim()
  const file = shortFile(d.f)
  const line = Number(d.l) || 0
  const col = Number(d.c) || 0

  // 同一轮里重复报同一个错（比如每次重跑都报），只留一条
  const dup = pageErrors.value.some((x) => x.msg === msg && x.line === line && x.kind === kind)
  if (dup) return

  const entry = {
    id: ++pageErrSeq,
    kind,
    name: String(d.name || ''),
    msg,
    file,
    line,
    col,
    loc: line ? (file ? file + ' · 第 ' + line + ' 行' + (col ? '，第 ' + col + ' 列' : '') : '第 ' + line + ' 行' + (col ? '，第 ' + col + ' 列' : '')) : '',
    frames: tidyStack(d.stack, file),
  }
  // 代码报错插到最前面（资源类的往后排）
  if (kind !== 'resource') {
    const at = pageErrors.value.findIndex((x) => x.kind === 'resource')
    if (at < 0) pageErrors.value.push(entry)
    else pageErrors.value.splice(at, 0, entry)
  } else {
    pageErrors.value.push(entry)
  }
  // 只留最近 6 条，避免一个循环报错把面板刷爆
  if (pageErrors.value.length > 6) pageErrors.value.splice(0, pageErrors.value.length - 6)
}

/* 代码报错（要认真看）与资源报错（示例图片 404，多数与代码无关）分开展示 */
const codeErrors = computed(() => pageErrors.value.filter((e) => e.kind !== 'resource'))
const resErrors = computed(() => pageErrors.value.filter((e) => e.kind === 'resource'))
const resOpen = ref(false)

function kindLabel(e) {
  if (e.kind === 'reject') return 'Promise'
  if (e.kind === 'console') return 'console'
  if (e.kind === 'resource') return '资源'
  if (e.kind === 'compile') return '编译'
  return e.name || '错误'
}

function clearErrors() {
  pageErrors.value = []
}

/** 报错里有行号：跳到编辑器对应行（若报错来自本课另一个文件，先切过去） */
async function jumpToError(e) {
  if (!e.line) return
  if (e.file && bundle.value && e.file !== activeFile.value) {
    const hit = bundle.value.files.find((f) => f.path === e.file || f.path.endsWith('/' + e.file))
    if (hit) {
      activeFile.value = hit.path
      await nextTick()
      syncDoc()
    }
  }
  if (ed.value && ed.value.gotoLine) ed.value.gotoLine(e.line)
}

function flashCopied() {
  copied.value = true
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => (copied.value = false), 1500)
}

async function copyErrors() {
  const text = pageErrors.value
    .map((e) => kindLabel(e) + ': ' + e.msg + (e.loc ? '\n  ' + e.loc : '') + (e.frames.length ? '\n  ' + e.frames.join('\n  ') : ''))
    .join('\n\n')
  try {
    await navigator.clipboard.writeText(text)
    flashCopied()
  } catch (err) {
    /* 剪贴板被拒（http 环境）：退回老办法 */
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      flashCopied()
    } catch (e2) {
      copied.value = false
    }
    ta.remove()
  }
}

/** 读预览区当前的滚动位置（滚动元素可能是 body / documentElement） */
function readFrameScroll() {
  try {
    const w = frame.value && frame.value.contentWindow
    if (!w) return null
    const d = w.document
    const se = d.scrollingElement || d.documentElement || d.body
    return { x: se ? se.scrollLeft : 0, y: se ? se.scrollTop : 0 }
  } catch (e) {
    return null
  }
}

/** 把滚动位置放回去（布局可能还在变，隔一帧再补一次） */
function applyFrameScroll(pos) {
  if (!pos) return
  const put = () => {
    try {
      const w = frame.value && frame.value.contentWindow
      if (!w) return
      const d = w.document
      const se = d.scrollingElement || d.documentElement || d.body
      if (se) {
        se.scrollLeft = pos.x
        se.scrollTop = pos.y
      }
      if (typeof w.scrollTo === 'function') w.scrollTo(pos.x, pos.y)
    } catch (e) {
      /* 拿不到就算了 */
    }
  }
  put()
  requestAnimationFrame(put)
}

function onFrameLoad() {
  if (!pendingScroll) return
  applyFrameScroll(pendingScroll)
  pendingScroll = null
}

async function run() {
  if (!bundle.value || !page.value) return
  error.value = ''
  pageErrors.value = []
  if (npmPage.value) {
    running.value = false
    return
  }
  if (!frame.value) return
  // 同一个页面重跑（打字自动运行）：记住当前位置，加载完放回去；换页面则从顶部开始
  pendingScroll = page.value === lastRunPage ? readFrameScroll() : null
  lastRunPage = page.value
  try {
    await ensureSfcSrcdoc()
    frame.value.srcdoc = buildPreviewDoc(allFiles.value, page.value, '/examples/' + encodeURI(dir.value) + '/')
    running.value = true
  } catch (e) {
    error.value = '预览失败：' + e.message
    running.value = false
  }
}

/* 交作业页面要拿这里的东西：改了哪些文件 / 有没有改动 / 手动重跑 / 重新装一次 */
defineExpose({ editedFiles, allFiles, dirtyCount, bundle, run, resetAll, reload: loadDir })
</script>

<style scoped>
/* 学生端正跟随老师代码时的一行提示（醒目但不挡编辑区） */
.syncbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  padding: 7px 10px;
  border: 1px solid #2f7d92;
  border-left-width: 3px;
  border-radius: 4px;
  background: #eef7fa;
  color: #1d5568;
}

.syncbar .mono {
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 12px;
}

.syncbar .dim {
  color: #5b7b86;
}
.pg {
  display: flex;
  flex-direction: column;
}

.fontbox {
  display: inline-flex;
  gap: 4px;
}

/* 整页占满一屏：头部固定，工作区吃掉剩下的高度。
   原来用 calc(100vh - 179px) 估算，不同页头高度下会差几十像素 —— 一屏看不全。 */
.pg {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pg > .content {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* 工作台是「越宽越好」的页面：不吃 .content 的 1520px 限宽，整屏铺满 */
  max-width: none;
  padding-bottom: 14px;
}

.work {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: stretch; /* 默认是 stretch，但这里显式写，避免被别的 .work 规则改成 center */
  gap: 12px;
}

/* 竖排：一屏放不下两块。高度仍锁 100dvh，滚动交给内容区自己 ——
   这样不会出现 body 滚动条把整页挤窄、头部跟着回缩的情况。 */
.pg-tall {
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

.pg-tall > .content {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 0, 0, 0.28) transparent;
}

.pg-tall > .content::-webkit-scrollbar {
  width: 10px;
}

.pg-tall > .content::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.22);
  border: 3px solid transparent;
  border-radius: 6px;
  background-clip: content-box;
}

.pg-tall > .content::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.35);
  background-clip: content-box;
}

.pg-tall > .content::-webkit-scrollbar-track {
  background: transparent;
}

.pg-tall .work {
  flex: 0 0 auto;
  min-height: 0;
}

.pg-tall .work {
  width: 100%;
}

.pg-tall .stack {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
}

.pg-tall .editor,
.pg-tall .preview {
  flex: 0 0 auto !important;
  /* 竖排一屏只放一块多一点：每块给到 78vh（最小 520），
     看着不扁，整块内容区自己滚 */
  height: 78vh;
  min-height: 520px;
  /* 右边留出 12px 槽：分栏条站这儿，不压住代码块的滚动条 */
  margin-right: 12px;
}

/* 收起代码后：预览直接吃满 */
.work.nocode .preview {
  flex: 1 1 auto !important;
  height: auto !important;
  min-height: 70vh;
}

.files {
  flex: 0 0 206px;
  min-height: 0;
}

/* 代码 + 预览这一叠：横排时左右分，竖排时上下分 */
.stack {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  gap: 0;
}

.work.dir-row .stack {
  flex-direction: row;
}

.work.dir-col .stack {
  flex-direction: column;
}

.editor {
  flex-grow: 0;
  flex-shrink: 0;
  min-width: 220px;
  min-height: 120px;
}

.preview {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

/* 中间那条可以拖的缝：横排拖宽度，竖排拖高度 */
.pg-split {
  display: block;
  flex: 0 0 10px;
  align-self: stretch;
  cursor: col-resize;
  border-radius: 3px;
  background: linear-gradient(to right, transparent 4px, var(--line) 4px, var(--line) 6px, transparent 6px);
}

.pg-split:hover {
  background: linear-gradient(to right, transparent 4px, var(--brand) 4px, var(--brand) 6px, transparent 6px);
}

/* 竖排：分栏条贴右边框（就是代码块的右边界），往左拖回左右排 */
.pg-split.edge-right {
  position: absolute;
  top: 0;
  right: 0;
  bottom: auto;
  height: 78vh; /* 与代码块等高 */
  min-height: 520px;
  width: 12px;
  flex: none;
  cursor: ew-resize;
  background: linear-gradient(to right, transparent 4px, var(--line) 4px, var(--line) 6px, transparent 6px);
}

.pg-split.edge-right:hover {
  background: linear-gradient(to right, transparent 4px, var(--brand) 4px, var(--brand) 6px, transparent 6px);
}

/* 代码收起后：左边留一条抓手，往右拖能把代码块拉回来 */
.pg-split.edge-left {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 10px;
  flex: none;
  cursor: ew-resize;
  background: linear-gradient(to right, transparent 3px, var(--brand) 3px, var(--brand) 6px, transparent 6px);
}

/* 窄屏：无论选的哪种，都按上下排显示，免得两块都挤成一条 */
@media (max-width: 1180px) {
  .work .stack {
    flex-direction: column;
  }
  .editor {
    flex-basis: auto !important;
    flex: 1 1 50%;
    min-width: 0;
  }
  .files {
    flex-basis: 176px;
  }
}

.files,
.editor,
.preview {
  background: #fff;
  border-radius: 4px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.files-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 11px;
  font-size: 12px;
  color: var(--sub);
  border-bottom: 1px solid var(--line-soft);
  background: #fbfcff;
}

.eye {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--sub);
  white-space: nowrap;
  cursor: pointer;
}

.treescroll {
  flex: 1;
  overflow: auto;
  padding-bottom: 8px;
}

.files-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-top: 1px solid var(--line-soft);
  background: #fbfcff;
  font-size: 11.5px;
  color: var(--sub);
  white-space: nowrap;
}

.files-foot .dot.off {
  background: #cbd5e1;
}

.files-foot .dot.fail {
  background: #ef4444;
}

.linkbtn {
  border: none;
  background: none;
  padding: 0 2px;
  color: #0e7490;
  font-size: 11.5px;
  cursor: pointer;
  text-decoration: underline;
  flex: 0 0 auto;
}

.linkbtn:hover {
  color: #155e75;
}

.grp + .grp {
  border-top: 1px solid var(--line-soft);
}

.ghead {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: none;
  text-align: left;
  font-size: 12.5px;
  font-weight: 600;
  color: #0e7490;
  cursor: pointer;
}

.ghead:hover {
  background: #f6f8fd;
}

.ghead.on {
  background: #ecfeff;
}

.ghead.static {
  color: #94a3b8;
  font-weight: 600;
  cursor: default;
  justify-content: space-between;
}

.caret {
  width: 12px;
  flex: 0 0 12px;
  color: #94a3b8;
  font-size: 11px;
}

.caret.none {
  visibility: hidden;
}

.item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 10px 5px 24px;
  border: none;
  background: none;
  text-align: left;
  font-size: 12.5px;
  color: #374151;
  cursor: pointer;
}

.item:hover {
  background: #f6f8fd;
}

.item.on {
  background: #eef2ff;
  color: #3730a3;
  font-weight: 600;
}

/* 文件类型徽标由 components/FileIcon.vue 提供（16px 圆角小牌子 + 颜色 + 字符） */

.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f59e0b;
  flex: 0 0 6px;
}

.ellip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.ed-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line-soft);
  background: #fbfcff;
  font-size: 12.5px;
  color: var(--sub);
  min-height: 38px;
}

.mono {
  font-family: Consolas, monospace;
  color: #334155;
}

.spacer {
  flex: 1;
}

.cm-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #282c34;
}

.cm-host :deep(.cm-editor) {
  height: 100%;
}

.cm-host :deep(.cm-scroller) {
  overflow: auto;
  scrollbar-width: thin; /* Firefox */
  scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
}

/* 代码块滚动条：细、圆角、悬停变亮（默认那条又宽又灰） */
.cm-host :deep(.cm-scroller::-webkit-scrollbar) {
  width: 10px;
  height: 10px;
}

.cm-host :deep(.cm-scroller::-webkit-scrollbar-thumb) {
  background: rgba(255, 255, 255, 0.22);
  border: 3px solid transparent;
  border-radius: 6px;
  background-clip: content-box;
}

.cm-host :deep(.cm-scroller::-webkit-scrollbar-thumb:hover) {
  background: rgba(255, 255, 255, 0.4);
  background-clip: content-box;
}

.cm-host :deep(.cm-scroller::-webkit-scrollbar-track) {
  background: transparent;
}

.frame {
  flex: 1;
  width: 100%;
  border: none;
  background: #fff;
  min-height: 0;
}

.npmcard {
  flex: 1;
  overflow: auto;
  padding: 26px 24px;
  background: #fffdf7;
  color: #475569;
  font-size: 13.5px;
  line-height: 1.75;
}

.npmcard h3 {
  margin: 6px 0 10px;
  font-size: 15px;
  color: #92400e;
}

.npmcard ol {
  margin: 10px 0;
  padding-left: 20px;
}

.npmcard li {
  margin: 4px 0;
}

.npmicon {
  font-size: 26px;
  color: #f59e0b;
}

.npmcard p {
  margin: 8px 0;
}

/* ---------------- 预览报错面板 ----------------
 * 学生在右侧看到的是「哪个文件、第几行、什么错、调用栈」，能直接照着改；
 * 面板本身可滚动、不挤占画面，头部固定在顶上。
 */
.perr {
  border-top: 1px solid #fecaca;
  background: #fef2f2;
  color: #7f1d1d;
  font: 12.5px/1.6 Consolas, 'Cascadia Mono', monospace;
  max-height: min(300px, 42vh);
  overflow: auto;
  flex: 0 0 auto;
}

.perr-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  background: #fee2e2;
  border-bottom: 1px solid #fecaca;
  font-family: system-ui, 'Microsoft YaHei', sans-serif;
  font-size: 12px;
}

.perr-head b {
  font-weight: 600;
  color: #991b1b;
}

.perr-head .dim {
  color: #b4645c;
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.perr-badge {
  flex: 0 0 auto;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: #dc2626;
  color: #fff;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}

.perr-badge.soft {
  background: #d99a1b;
}

.perr-list .res-sum {
  margin-bottom: 8px;
  color: #92400e;
}

.perr-list .res-sum .dim {
  color: #b08350;
  font-size: 11.5px;
}

.perr-mini {
  flex: 0 0 auto;
  border: 1px solid #fca5a5;
  background: #fff;
  color: #b91c1c;
  border-radius: 3px;
  padding: 1px 7px;
  font-size: 11.5px;
  cursor: pointer;
}

.perr-mini:hover {
  background: #fff1f1;
}

.perr-x {
  flex: 0 0 auto;
  border: none;
  background: none;
  color: #b91c1c;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 0 2px;
}

.perr-list {
  margin: 0;
  padding: 8px 10px 4px 26px;
}

.perr-list li {
  margin-bottom: 9px;
}

.perr-list li::marker {
  color: #f87171;
  font-size: 11px;
}

.perr-line {
  display: flex;
  align-items: baseline;
  gap: 7px;
  flex-wrap: wrap;
}

.perr-tag {
  flex: 0 0 auto;
  padding: 0 5px;
  border: 1px solid #fca5a5;
  border-radius: 3px;
  background: #fff1f1;
  color: #b91c1c;
  font-size: 11px;
  line-height: 16px;
  font-family: system-ui, 'Microsoft YaHei', sans-serif;
}

/* Promise 未捕获：橙色；console.error：灰色（不是「坏掉」，是代码自己打的） */
.perr-list .k-reject .perr-tag {
  border-color: #fdba74;
  background: #fff7ed;
  color: #c2410c;
}

.perr-list .k-console .perr-tag {
  border-color: #cbd5e1;
  background: #f8fafc;
  color: #475569;
}

/* .vue 编译失败：紫色，和运行时错误区分开（这类看不见行号，只能看消息） */
.perr-list .k-compile .perr-tag {
  border-color: #c4b5fd;
  background: #f5f3ff;
  color: #6d28d9;
}

/* 资源加载失败（图片 / 外部脚本 404）：不是代码写坏，用中性黄提醒 */
.perr-list .k-resource .perr-tag {
  border-color: #fcd34d;
  background: #fffbeb;
  color: #92400e;
}

.perr-list .k-resource .perr-msg {
  color: #92400e;
}

.perr-msg {
  flex: 1 1 240px;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.perr-list .k-console .perr-msg {
  color: #475569;
}

.perr-jump {
  flex: 0 0 auto;
  border: 1px solid #fca5a5;
  background: #fff;
  color: #b91c1c;
  border-radius: 3px;
  padding: 0 6px;
  font-size: 11px;
  line-height: 18px;
  cursor: pointer;
  font-family: system-ui, 'Microsoft YaHei', sans-serif;
}

.perr-jump:hover {
  background: #fee2e2;
}

.perr-loc {
  margin-top: 2px;
  color: #9a3412;
  font-size: 11.5px;
}

.perr-stack {
  margin: 5px 0 0;
  padding: 6px 8px;
  border: 1px dashed #fecaca;
  border-radius: 3px;
  background: #fffafa;
  color: #7c2d12;
  font: 11.5px/1.55 Consolas, 'Cascadia Mono', monospace;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 104px;
  overflow: auto;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #475569;
  white-space: nowrap;
}

code {
  font-family: Consolas, monospace;
  background: #f1f4f9;
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 12.5px;
}
</style>
