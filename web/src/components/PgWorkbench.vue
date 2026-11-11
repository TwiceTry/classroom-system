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
        <PgFileTree
          :dir-label="dirLabel"
          :tree="tree"
          :page="page"
          :active-file="activeFile"
          :closed="closed"
          v-model:show-all="showAll"
          :bundle="bundle"
          :edits="edits"
          :dirty-count="dirtyCount"
          :store-fail="storeFail"
          :foot-text="footText"
          :foot-title="footTitle"
          :can-add="canAddFile"
          :add-hint="addHint"
          :new-paths="newFilePaths"
          :do-add="addFile"
          :do-remove="removeFile"
          @open-group="openGroup"
          @open-file="openFile"
          @toggle-group="toggleGroup"
          @clear-saved="clearSaved"
          />

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

        <PgPreview
          ref="previewRef"
          :page="page"
          :dir="dir"
          :npm-page="!!npmPage"
          :npm-entry="npmEntry"
          :running="running"
          :page-errors="pageErrors"
          :code-errors="codeErrors"
          :res-errors="resErrors"
          v-model:res-open="resOpen"
          :copied="copied"
          :kind-label="kindLabel"
          @load="onFrameLoad"
          @copy="copyErrors"
          @clear="clearErrors"
          @jump="jumpToError"
        />
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
import { buildTree, isPage as isPagePath, baseOf, visibleItemsOf } from '../utils/pgTree'
/* 新建文件的规则（校验、骨架、上限）—— usePgStore 恢复存档时用的是同一套 */
import {
  checkNewName,
  skeletonFor,
  NEW_FILE_MAX_COUNT,
  NEW_FILES_TOTAL_MAX,
} from '../utils/pgFile'
import { createEditor, langNameFor } from '../utils/pgEditor'
import { buildPreviewDoc, ensureSfcSrcdoc, isNpmProject } from '../utils/pgPreview'
import { usePgLayout } from '../composables/usePgLayout'
import { usePgStore } from '../composables/usePgStore'
import { usePgPreview } from '../composables/usePgPreview'
import { usePgEditor } from '../composables/usePgEditor'
import { usePgSync } from '../composables/usePgSync'
import { useFontSize } from '../composables/useFontSize'
import { state } from '../store'
import { currentClassId } from '../utils/classSel'
import { onPresenceMessage } from '../utils/presence'
import PgFileTree from './pg/PgFileTree.vue'
import PgPreview from './pg/PgPreview.vue'
import DirIO from './DirIO.vue'
import PageHead from './PageHead.vue'
import FileIcon from './FileIcon.vue'

/* 通知父组件「这次加载的是哪一份代码」（起手代码 / 我上次提交的），
 * 父组件据此决定提示文案，不要再靠 mine.length 猜。 */
const emit = defineEmits(['loaded'])

const props = defineProps({
  title: { type: String, default: '代码练习' },
  sub: { type: String, default: '' },
  fixedDir: { type: String, default: '' }, // 非空 = 锁定目录（课堂作业用）
  /*
   * 代码从哪来：
   *   'example'    —— 课程内容里的示例目录（Playground、绑定了示例的作业）
   *   'assignment' —— 作业的三层状态（起手代码 / 我的提交），走 /api/assignments/:id/code
   * 以前只有 fixedDir 一条路，作业拿不到「自己那份」，于是退化成拉全部示例。
   */
  source: { type: String, default: 'example' },
  assignmentId: { type: String, default: '' },
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
/* 只在「恢复最初状态」那一次请求里为 true，让后端强制给起手代码 */
let forceStarter = false
const bundle = ref(null)
const page = ref('')
const activeFile = ref('')
const edits = reactive({})
const autoRun = ref(true)
const error = ref('')
const running = ref(false)
const closed = reactive({})
const showAll = ref(localStorage.getItem('pg-showall') === '1')
/*
 * 代码编辑器字号不再单独存 pg-font —— 跟着全站字号走（正文 15 → 代码 13）。
 * codePx 是只读 computed，所以这里不能赋值：±1 的意图交给 adjustDoc，
 * 编辑器实际字号由下面的 watch(codePx) 同步。
 */
const { codePx: fontPx, adjustDoc: adjustDocSize } = useFontSize()
const cmHost = ref(null)
const frame = ref(null)


/*
 * 工作区排版：
 *   layout = row（左右：代码在左、预览在右）| col（上下：代码在上、预览在下）
 *   codePct = 代码块占 .stack 的比例，按 20% 一挡（20/40/60/80）
 *   拖到 >88% 自动切上下排（左右已经不够宽了）；拖到 <8% 自动收起代码
 *
 * 这三个值**故意不记忆**：学生把分栏拖乱了、或者拖成不认识的布局时，
 * 刷新一下页面就回到默认（左右排 · 代码 60% · 代码可见），不用教怎么拖回来。
 */
/*
 * 分栏排版（左右/上下、代码占比、代码收不收起）全在 composables/usePgLayout.js，
 * 这里只把编辑器实例递过去 —— CodeMirror 尺寸变了要重新量。
 */
const { layout, codePct, codeHidden, toggleLayout, toggleCode, startDrag, requestMeasure, clearLegacyLayout } =
  usePgLayout({ getEditor: () => ed.value })
/* ---------------- 代码练习同步 ----------------
 * 老师推 / 学生跟，全在 composables/usePgSync.js
 * 消息类型是 pgsync，服务端带 seq（学生端只认更新的，防乱序把旧代码盖回去）
 */
const syncClassId = computed(() => currentClassId.value || (state.classes[0] && state.classes[0].id) || '')

// 存档模块要问「现在能不能落盘」，但 sync 在下面才建 —— 用一个可变的检查函数接上
let frozenCheck = () => false

/** presence 频道的退订句柄（老师推代码给全班的广播走这条） */
let offSync = null

/* ---------------- 改动的本机存档 ----------------
 * 存在浏览器 localStorage，按「身份 + 目录」分桶；逻辑全在 composables/usePgStore.js
 */
const { storeFail, saved, scopeOf, storeKey, pageKey, flushEdits, scheduleSave, restoreEdits } = usePgStore({
  bucket: () => props.bucket,
  edits,
  dir,
  bundle,
  // 跟随时屏幕上是老师的代码，不能落盘（否则学生自己那一课被覆盖）
  isFrozen: () => frozenCheck(),
})

/**
 * 【唯一出口】服务端原文 + 本机改动 + 本机新建
 *
 * 预览（buildPreviewDoc）、提交（slot 的 all-files）、文件树、页面下拉
 * 全部从它派生 —— 早先这三处各读各的 bundle.files，加「新建文件」时
 * 就得改四个地方，漏一个就出现「建了看不见 / 交了没有」。
 *
 * 跟随时不并入新建文件：那一刻屏幕上是老师推的代码，混进学生自己的文件
 * 会让预览和同步都对不上。跟完切回自己的目录，文件还在。
 */
const allFiles = computed(() => {
  if (!bundle.value) return []
  const base = bundle.value.files
  const out = base.map((f) => ({
    path: f.path,
    text: edits[f.path] !== undefined ? edits[f.path] : f.text,
  }))
  if (!frozenCheck()) {
    for (const p in edits) {
      if (base.some((f) => f.path === p)) continue
      out.push({ path: p, text: edits[p], isNew: true })
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
})

/* ---------------- 新建 / 删除文件 ----------------
 * 校验规则在 utils/pgFile.js（usePgStore 从 localStorage 恢复时用的是同一套）。
 * 只允许「一级文件名」：服务端 lib/submitstore.js 的 safeName() 会把 / 换成 _，
 * 带目录提交后名字就变了，老师端对不上。
 */
const canAddFile = computed(() => !props.readonly && !frozenCheck())

/**
 * 「+」按钮的提示文案。
 *
 * 老师身份要特意说清「只在本机试写」—— 代码工作台里改的东西从来不落库
 * （改课程示例走「课程管理」那套 content-edit 接口），不说的话老师会以为
 * 自己改到示例里去了，下节课发现没变。
 */
const addHint = computed(() => {
  if (props.readonly) return '只读，不能新建'
  if (frozenCheck()) return '老师正在推代码，暂停新建'
  if (state.role === 'teacher') {
    return '在这台电脑上试写（只存本机，不进课程示例）；要改示例请用「课程管理」'
  }
  return '新建的文件只存在这台电脑上；交作业时会随「整份提交」一起交上去'
})

const newFilePaths = computed(() => {
  const base = (bundle.value && bundle.value.files) || []
  return Object.keys(edits).filter((p) => !base.some((f) => f.path === p))
})

const newFileBytes = computed(() => newFilePaths.value.reduce((n, p) => n + String(edits[p] || '').length, 0))

/** 新建一个文件：返回 { ok, why } —— 失败原因要能直接显示给用户 */
function addFile(rawName) {
  if (!canAddFile.value) {
    return { ok: false, why: props.readonly ? '只读模式不能新建' : '老师正在推代码，先停下来再新建' }
  }
  const name = String(rawName || '').trim()
  const chk = checkNewName(name, allFiles.value.map((f) => f.path))
  if (!chk.ok) return chk
  if (newFilePaths.value.length >= NEW_FILE_MAX_COUNT) {
    return { ok: false, why: '一次最多新建 ' + NEW_FILE_MAX_COUNT + ' 个文件' }
  }
  const body = skeletonFor(name)
  if (newFileBytes.value + body.length > NEW_FILES_TOTAL_MAX) {
    return { ok: false, why: '本机存档装不下了（新建文件总量上限 1.5 MB）' }
  }
  edits[name] = body
  /*
   * 立刻打开它：新建完不打开，学生会以为没建成。
   * 然后**立即** flushEdits，不用 scheduleSave —— 因为 openFile 会让编辑器加载这个
   * 文件，触发一次 onChange → 又一次 scheduleSave，400ms 的定时器被重置；
   * 学生这时候刷新页面，文件就没了（实测踩过一次）。新建是低频操作，同步存一下。
   */
  nextTick(() => openFile(name))
  flushEdits()
  return { ok: true, why: '' }
}

/** 删一个**自己新建**的文件；起手文件不给删（题目结构要稳） */
function removeFile(p) {
  const f = allFiles.value.find((x) => x.path === p)
  if (!f) return { ok: false, why: '没有这个文件' }
  if (!f.isNew) return { ok: false, why: '起手文件不能删，只能改' }
  delete edits[p]
  if (activeFile.value === p) {
    const next = allFiles.value.find((x) => x.path !== p)
    nextTick(() => openFile(next ? next.path : ''))
  }
  /* 删除同样立刻落盘：延时存的话，删完马上刷新又能看到它 */
  flushEdits()
  return { ok: true, why: '' }
}

/*
 * 下面两处原来直接读 bundle.value.files，现在全部改读 allFiles。
 *
 * 原因：学生自己新建的文件不在 bundle 里（那是服务端给的原始清单），
 * 只读 bundle 的话「下拉里选不到新页面」「树里看不见新文件」——
 * 建了等于没建。allFiles 是「服务端原文 + 本机改动 + 本机新建」的唯一出口，
 * 预览、提交、文件树、页面下拉都应该从它派生，只改一处才不会漏。
 */
const pages = computed(() => allFiles.value.filter((f) => isPagePath(f.path)).map((f) => f.path))
const tree = computed(() => buildTree(allFiles.value))
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

/**
 * 改动过的文件（用来标红点 / 数改动数 / 提交时的 changed）
 *
 * 学生新建的文件也算「改动」—— 不然提交时 changed 里没有它，
 * 老师端看提交就分不清「哪些是起手就有的、哪些是学生加进来的」。
 */
const editedFiles = computed(() => {
  if (!bundle.value) return []
  const base = bundle.value.files
  const out = []
  for (const f of allFiles.value) {
    const orig = base.find((x) => x.path === f.path)
    if (!orig) out.push({ path: f.path, text: f.text }) // 新建的
    else if (edits[f.path] !== undefined && edits[f.path] !== orig.text) {
      out.push({ path: f.path, text: f.text })
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
})

/* allFiles 已经提到上面（pages / tree / editedFiles 都要用它，放后面会踩 TDZ）。
 *
 * 交作业时用它是有意的：整份都交（改过的取改动、没改的取原文、新建的带上）。
 * 只交改过的文件虽然省流量，但老师那边没法把页面跑起来看渲染结果，
 * 一整课也就几十 KB。 */

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

function toggleGroup(i) {
  closed[i] = !closed[i]
}

// 文件树的「全部」勾选变了就记住（原来靠 @change，现在由子组件 emit）
watch(showAll, saveShowAll)

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
    if (props.source === 'assignment') {
      // 作业：不拉示例清单，直接装「我的提交 / 起手代码」
      dir.value = '@a:' + props.assignmentId // 占位，loadDir 里会换成后端给的真实标识
      await loadDir()
      return
    }
    if (props.fixedDir) {
      // 锁定目录（绑定了示例的作业）：不用拉示例清单，直接装这一课
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
    // 学生端：进页面时如果老师正在同步，直接接上（sync 为 null = 没在同步）
    if (state.role === 'student') {
      const res = await api.get('/api/pgsync').catch(() => null)
      if (res && res.sync) await resumeFrom(res.sync)
    }
  } catch (e) {
    error.value = e.message
  }
})

// 固定目录的场景允许外部换作业时就地重载
watch(
  () => props.fixedDir,
  async (v) => {
    if (!v || v === saved.dir) return
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
  disposePreview()
  destroy()
})

async function loadDir() {
  flushEdits() // 先把上一个目录的改动存回它自己的桶
  if (!props.fixedDir && props.source !== 'assignment') localStorage.setItem('pg-dir', dir.value)
  page.value = ''
  activeFile.value = ''
  pageErrors.value = []
  error.value = ''
  Object.keys(edits).forEach((k) => delete edits[k])
  Object.keys(closed).forEach((k) => delete closed[k])
  bundle.value = null
  const isAssignment = props.source === 'assignment'
  try {
    /*
     * 作业走 /api/assignments/:id/code —— 它一次把「该给学生看哪份代码」定好：
     *   有提交 → 给提交；没有 → 给起手代码；都没有 → 空。
     * 加 ?from=starter 就是「恢复最初状态」。
     */
    const url = isAssignment
      ? '/api/assignments/' + encodeURIComponent(props.assignmentId) + '/code' + (forceStarter ? '?from=starter' : '')
      : '/api/examples/' + encodeURIComponent(dir.value)
    const res = await api.get(url)
    bundle.value = res
    // 作业的 dir 由后端给（@a:<作业id> 起手代码 / @s:<提交id> 我的提交），本地草稿按它分桶
    if (isAssignment && res && res.dir) dir.value = res.dir
    if (isAssignment && res && res.source === 'empty') {
      error.value = '这次作业还没有起手代码（老师没给初始文件）。'
    }
    saved.dir = dir.value
    emit('loaded', { source: (res && res.source) || (isAssignment ? '' : 'example'), dir: dir.value })
    saved.scope = scopeOf()
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

/* ---------------- 编辑器 ---------------- */
// CodeMirror 实例与文档同步在 composables/usePgEditor.js。
// 下面三个回调说明「改完之后依次做什么」—— 编辑器本身不认识这三块。
const { ed, caret, ensureEditor, syncDoc, setReadOnly, setDocText, setCaret, gotoLine, currentText, adjustFont, destroy } =
  usePgEditor({
    cmHost,
    fontPx,
    activeFile,
    bundle,
    edits,
    readonly: props.readonly,
    /* Ctrl+滚轮 / A±  改的是全站字号，不是本页单独一份 */
    onFontDelta: adjustDocSize,
    getText: textOf,
    onChange() {
      scheduleSave() // ① 存本机（跟随时不写，由 usePgStore 判断）
      scheduleRun() // ② 重跑预览
      pushSoon() // ③ 推给学生（没在同步时内部直接返回）
    },
    onCaret(c) {
      pushCursor(c.pos)
    },
    onRun() {
      run()
    },
    afterCreate() {
      // 换课时包会重建编辑器，跟随中要重新锁上只读
      if (following.value) setReadOnly(true)
    },
  })

/*
 * 全站字号变了 → 编辑器跟着缩放。
 * fontPx（= codePx）是只读 computed，不能像以前那样 fontPx.value = n，
 * 所以改成「adjustDoc 改全局 → 这个 watch 把新值灌给编辑器」。
 * 换课重建编辑器后也会走一次（afterCreate），不会有遗漏。
 */
watch(fontPx, (v) => {
  if (ed.value) ed.value.setFontSize(v)
})

/* ---------------- 老师推代码给学生 ---------------- */
const {
  syncOn,
  following,
  followFile,
  canSync,
  syncTitle,
  toggle: toggleSync,
  pushSoon,
  pushCursor,
  onMessage: onSyncMsg,
  resumeFrom,
  isFrozen,
} = usePgSync({
  classId: syncClassId,
  dir,
  activeFile,
  page,
  bundle,
  edits,
  fixedDir: props.fixedDir,
  role: state.role,
  // 只把「编辑器要做的三件事」递过去，sync 不需要知道 CodeMirror 长什么样
  editor: { setReadOnly, setDocText, setCaret, syncDoc },
  getText: textOf,
  loadDir,
  runPreview: () => run(),
  saveLater: () => scheduleSave(),
  error,
  autoRun,
})

/*
 * 预览区的 iframe 在子组件里，而 usePgPreview 要往它的 srcdoc 里塞文档。
 * 子组件用 defineExpose 把元素本身暴露出来，这里转交给 frame 这个 ref。
 */
const previewRef = ref(null)
watch(
  () => (previewRef.value ? previewRef.value.frameEl : null),
  (el) => {
    frame.value = el
  }
)

// 接上：存档模块问「能不能落盘」时，看同步状态
frozenCheck = () => isFrozen()

/*
 * 跟随时锁只读。
 * 不能只在 applySync 里调一次 —— 那时工作区可能正在重建（换课时包会 v-if 拆掉重来），
 * 新编辑器还没建好，setReadOnly 落空，学生就能改老师的代码。
 */
watch(following, (v) => {
  nextTick(() => setReadOnly(!!v))
})

/* ---------------- 打开文件 / 页面 ---------------- */

function openGroup(g) {
  if (following.value || !g.page) return // 老师同步期间：预览页跟着老师走
  page.value = g.page
  localStorage.setItem(pageKey(dir.value), g.page)
  // 组里没有源码（纯 HTML 课）：点标题就等于"看这个页面的源码"
  if (visibleItemsOf(g, showAll.value).length === 0) activeFile.value = g.page
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

/**
 * 「恢复最初状态」：把编辑器换回老师给的起手代码。
 *
 * 只清**未提交的本地改动**，**不动已经提交的那份** ——
 * 提交上挂着分数和计分记录，删了等于把分一起撤掉（那是「清空提交」的语义，不是这个按钮）。
 */
async function resetToStarter() {
  if (props.source !== 'assignment' || following.value) return
  const ok = window.confirm(
    '把编辑器恢复成老师给的初始代码？\n\n· 还没提交的改动会丢掉\n· 已经提交的那份和分数不受影响'
  )
  if (!ok) return
  Object.keys(edits).forEach((k) => delete edits[k])
  Object.keys(closed).forEach((k) => delete closed[k])
  forceStarter = true
  try {
    await loadDir() // loadDir 开头的 flushEdits 会把空表对应的存档键删掉
  } catch (e) {
    error.value = e.message
  } finally {
    forceStarter = false
  }
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

/* ---------------- 运行与预览 ----------------
 * 拼 srcdoc / 抓 iframe 报错 / 重跑时保住滚动位置，全在 composables/usePgPreview.js
 */
const {
  pageErrors,
  copied,
  resOpen,
  codeErrors,
  resErrors,
  kindLabel,
  clearErrors,
  jumpToError,
  copyErrors,
  readFrameScroll,
  applyFrameScroll,
  onFrameLoad,
  onFrameMessage,
  scheduleRun,
  run,
  dispose: disposePreview,
} = usePgPreview({
  frame,
  bundle,
  page,
  dir,
  allFiles,
  npmPage,
  error,
  running,
  activeFile,
  getEditor: () => ed.value,
  onOpenFile: async () => {
    await nextTick()
    syncDoc()
  },
})

defineExpose({ editedFiles, allFiles, dirtyCount, bundle, run, resetAll, resetToStarter, reload: loadDir })
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

/*
 * 左右排：锁一屏，两栏各自内部滚动。
 *
 * 不加这段的话 .pg 没有高度约束，整条链 .pg → .content → .work → .stack
 * 高度都是 auto，代码一长整页就被撑出视口、底部被截掉。
 *
 * 注意只看 :not(.pg-tall) —— 上下排（.pg-tall）保持原设计：
 * 两块各 78vh，故意把页面撑大，靠整页滚动上下浏览。那个行为不要动。
 */
.pg:not(.pg-tall) {
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

.pg:not(.pg-tall) > .content {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pg:not(.pg-tall) .work {
  flex: 1 1 auto;
  min-height: 0;
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
  /*
   * 必须是 flex 列：里面是 .ed-head（固定 38px）+ .cm-host（flex: 1）。
   * 原来这里是 block，.cm-host 的 flex: 1 不起作用 → 高度变 auto →
   * CodeMirror 自己撑开，超出 .editor 的部分被裁掉，长代码既看不到也滚不了。
   */
  display: flex;
  flex-direction: column;
  overflow: hidden; /* 滚动交给 .cm-host 里的 .cm-scroller */
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



/* Promise 未捕获：橙色；console.error：灰色（不是「坏掉」，是代码自己打的） */
.perr-list .k-reject .perr-tag {
  border-color: #fdba74;
  background: #fff7ed;
  color: #c2410c;
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
