<template>
  <!--
    单个内容目录的导入 / 导出：挂在「讲义 / 课程材料 / 代码练习（示例）/ 机试试卷」这些 tab 上。
    学科包（整门课）在课程管理里导，这里是「只要这一个目录」的轻量搬运。

    「下载模板」不放这一层：它只在「准备导入」时才有用，
    和导出并排会出现两个 ⤓，让人以为都是导出。挪进导入窗口里（见下）。
  -->
  <span class="dio">
    <button class="btn mini" :disabled="busy" :title="'把这个目录打成一个 zip（只含' + label + '，不含课程信息与方案）'" @click="doExport">
      ⤓ 导出{{ label }}
    </button>
    <button class="btn mini" :disabled="busy" :title="'从一个 zip 导入到' + label + '目录（先给报告，确认后才写）'" @click="openDialog">
      ⤒ 导入{{ label }}
    </button>
    <!--
      外壳（标题/空态/选文件/模板/底部按钮）统一由 ImportDialog 负责，
      这里只写「内容目录」自己那份报告。
    -->
    <ImportDialog
      v-model="open"
      :title="'导入' + label"
      :file-name="fileName"
      accept=".zip"
      :busy="busy"
      :error="err"
      :has-report="!!report"
      pick-text="⤒ 选择 zip 文件"
      template-label="⤓ 没有包？下载空模板"
      template-hint="模板下载后可以直接改（改文件名、换内容），再压缩成 zip 从这里导入。"
      :confirm-text="busy ? '写入中…' : '确认导入'"
      :confirm-disabled="!report"
      @pick="onFile"
      @template="doTemplate"
      @confirm="doApply"
      @close="close"
    >
      <template #hint>
        <p class="dim mini" style="margin-top: 0">
          选一个 zip，里面就是「{{ label }}」目录的内容（根目录对根目录）。<br />
          系统会先只读解析出一份报告：新增几个、覆盖几个、几个没变 —— 你看过再决定怎么写。
        </p>
      </template>

      <template #report>
        <p class="dio-line">
          包内 <b>{{ report.total }}</b> 个文件：
          <b class="ok-c">新增 {{ report.added.length }}</b> ·
          覆盖 {{ report.changed.length }} ·
          未变 {{ report.unchanged.length }}
          <template v-if="report.extra.length">· 本地多出 {{ report.extra.length }}</template>
        </p>
        <p v-if="report.samples.length" class="mono mini dim">{{ report.samples.join('、') }}</p>

        <p v-if="report.extra.length" class="mini">
          本地多出这 {{ report.extra.length }} 个文件：
          <button class="linkish" @click="showExtra = !showExtra">{{ showExtra ? '收起' : '展开' }}</button>
        </p>
        <p v-if="showExtra && report.extra.length" class="mono mini dim">
          <span v-for="p in report.extra.slice(0, 300)" :key="p" class="dio-extra">− {{ p }}</span>
          <span v-if="report.extra.length > 300" class="dim">…（只列前 300 个）</span>
        </p>

        <label class="check">
          <input v-model="mode" type="radio" value="merge" />
          追加 / 覆盖同名文件（本地多出来的保留）
        </label>
        <label class="check">
          <input v-model="mode" type="radio" value="replace" />
          整体替换（本地多出来的移到 data/.trash/，可捞回）
        </label>
      </template>
    </ImportDialog>

    <Toast :text="toast" />
  </span>
</template>

<script setup>
import { ref } from 'vue'
import { api, download, getCourse } from '../api'
import Toast from './Toast.vue'
import ImportDialog from './ImportDialog.vue'

const props = defineProps({
  dir: { type: String, required: true }, // lecture / materials / 代码示例 / exams
  label: { type: String, default: '内容' },
})

const open = ref(false)
const busy = ref(false)
const err = ref('')
const toast = ref('')
const fileName = ref('')
const report = ref(null)
const showExtra = ref(false)
const mode = ref('merge')
let zipBuf = null

function say(t) {
  toast.value = t
  setTimeout(() => {
    if (toast.value === t) toast.value = ''
  }, 3500)
}

function close() {
  open.value = false
  report.value = null
  err.value = ''
  zipBuf = null
  fileName.value = ''
}

async function doExport() {
  const cid = getCourse()
  if (!cid) return say('先选一门课')
  busy.value = true
  try {
    download(
      '/api/courses/' + encodeURIComponent(cid) + '/content.zip?dir=' + encodeURIComponent(props.dir),
      props.dir + '.zip'
    )
    say('正在导出' + props.label + '…')
  } catch (e) {
    say(e.message)
  } finally {
    busy.value = false
  }
}

function doTemplate() {
  const cid = getCourse()
  if (!cid) return say('先选一门课')
  download(
    '/api/courses/' + encodeURIComponent(cid) + '/content/template.zip?dir=' + encodeURIComponent(props.dir),
    'template-' + props.dir + '.zip'
  )
  say('模板已下载：改完压缩成 zip 再导回来')
}

/** 打开导入窗口（空态）——不直接弹文件选择器，先让人看清要交什么、能下模板 */
function openDialog() {
  close()
  open.value = true
}

/** 文件由 ImportDialog 的隐藏 input 选好后 emit 过来 */
async function onFile(f) {
  if (!f) return
  const cid = getCourse()
  if (!cid) return say('先选一门课')
  busy.value = true
  err.value = ''
  fileName.value = f.name
  try {
    zipBuf = await f.arrayBuffer()
    const token = localStorage.getItem('teach-system-token') || ''
    const res = await fetch(
      '/api/courses/' + encodeURIComponent(cid) + '/content/inspect?dir=' + encodeURIComponent(props.dir),
      {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: zipBuf,
      }
    )
    const j = await res.json().catch(() => null)
    if (!res.ok) throw new Error((j && j.error) || '解析失败（' + res.status + '）')
    report.value = j
    showExtra.value = false
    mode.value = 'merge'
    open.value = true
  } catch (e2) {
    say(e2.message)
  } finally {
    busy.value = false
  }
}

async function doApply() {
  const cid = getCourse()
  busy.value = true
  err.value = ''
  try {
    const token = localStorage.getItem('teach-system-token') || ''
    const res = await fetch(
      '/api/courses/' +
        encodeURIComponent(cid) +
        '/content/apply?dir=' +
        encodeURIComponent(props.dir) +
        '&mode=' +
        mode.value,
      {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: zipBuf,
      }
    )
    const j = await res.json().catch(() => null)
    if (!res.ok) throw new Error((j && j.error) || '导入失败（' + res.status + '）')
    close()
    say(
      '导入完成：写入 ' +
        j.written +
        ' 个文件' +
        (j.removed ? '，移走 ' + j.removed + ' 个（在 data/' + j.trash.dir + '）' : '') +
        '；刷新页面即可看到'
    )
  } catch (e) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.dio {
  display: inline-flex;
  gap: 4px;
}

.dio-line {
  margin: 0 0 4px;
  font-size: 13px;
}

.dio-extra {
  display: block;
}

.linkish {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: #1f6feb;
  cursor: pointer;
  text-decoration: underline dotted;
}
</style>
