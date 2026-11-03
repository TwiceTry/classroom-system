<template>
  <!--
    单个内容目录的导入 / 导出：挂在「讲义 / 课程材料 / 代码练习（示例）/ 机试试卷」这些 tab 上。
    学科包（整门课）在课程管理里导，这里是「只要这一个目录」的轻量搬运。
  -->
  <span class="dio">
    <button class="btn mini" :disabled="busy" :title="'把这个目录打成一个 zip（只含' + label + '，不含课程信息与方案）'" @click="doExport">
      ⤓ 导出{{ label }}
    </button>
    <button class="btn mini" :disabled="busy" :title="'从一个 zip 导入到' + label + '目录（先给报告，确认后才写）'" @click="pick">
      ⤒ 导入{{ label }}
    </button>
    <button class="btn mini" :disabled="busy" :title="'下载「' + label + '」的空白模板：命名规则与示例文件，新部署时照着改就行'" @click="doTemplate">
      模板
    </button>
    <input ref="fileEl" type="file" accept=".zip" style="display: none" @change="onFile" />

    <Teleport to="body">
      <div v-if="open" class="mask" @click.self="close">
        <div class="modal">
          <div class="modal-head">
            <h3>导入{{ label }}：{{ fileName }}</h3>
            <button class="btn mini" @click="close">×</button>
          </div>
          <div class="modal-body form">
            <p v-if="err" class="hint err">{{ err }}</p>

            <template v-if="report">
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
          </div>
          <div class="modal-foot">
            <span class="spacer"></span>
            <button class="btn" @click="close">取消</button>
            <button class="btn primary" :disabled="!report || busy" @click="doApply">
              {{ busy ? '写入中…' : '确认导入' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <Toast :text="toast" />
  </span>
</template>

<script setup>
import { ref } from 'vue'
import { api, download, getCourse } from '../api'
import Toast from './Toast.vue'

const props = defineProps({
  dir: { type: String, required: true }, // lecture / materials / 代码示例 / exams
  label: { type: String, default: '内容' },
})

const fileEl = ref(null)
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
      '/api/teacher/courses/' + encodeURIComponent(cid) + '/content.zip?dir=' + encodeURIComponent(props.dir),
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
    '/api/teacher/courses/' + encodeURIComponent(cid) + '/content/template.zip?dir=' + encodeURIComponent(props.dir),
    'template-' + props.dir + '.zip'
  )
  say('模板已下载：改完压缩成 zip 再导回来')
}

function pick() {
  if (fileEl.value) fileEl.value.value = ''
  fileEl.value && fileEl.value.click()
}

async function onFile(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
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
      '/api/teacher/courses/' + encodeURIComponent(cid) + '/content/inspect?dir=' + encodeURIComponent(props.dir),
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
      '/api/teacher/courses/' +
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
