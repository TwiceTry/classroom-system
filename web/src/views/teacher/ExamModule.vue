<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>{{ moduleTitle }}</template>
        <template #sub>导入试卷 / 题库 → 开始 → 学生限时作答 → 客观题自动判、主观题你判 → 自动出答卷文件</template>
        <template #right>
          <!--
            label 用「试卷库」而不是「试卷」：
            这里是**整个 content/exams 目录**的搬运（批量搬走/搬入试卷库），
            而列表里每个机试还有「导入这份卷子」的按钮（只给那一个作业装卷子）——
            两个都叫「导入试卷」会点错。
          -->
          <DirIO dir="exams" label="试卷库" />
          <button class="btn mini" :disabled="loading" @click="loadAll">刷新</button>
          <button class="btn primary" @click="openEditor">＋ 新建机试</button>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>

    <div class="hwbar">
      <button
      v-for="a in list"
      :key="a.id"
      class="pill hwpill"
      :class="{ on: a.id === curId }"
      @click="select(a.id)"
      >
      <i class="led" :class="a.status === 'open' ? 'on' : a.started ? 'off' : ''"></i>
      {{ a.title }}
      <span class="dim">{{ a.status === 'open' ? '考试中' : a.started ? '已结束' : '未开始' }}</span>
    </button>
    <span v-if="!list.length && !loading" class="dim" style="font-size: 13px">还没建过机试，点右上角。</span>
    </div>

    <template v-if="d">
    <div class="card ctrl">
      <div class="ctrl-l">
        <h3>
          {{ d.assignment.title }}
          <span class="tag" :class="d.assignment.status === 'open' ? 'ok' : d.assignment.started ? 'mute' : 'warn'">
            {{ d.assignment.status === 'open' ? '考试中' : d.assignment.started ? '已结束' : '未开始' }}
          </span>
        </h3>
        <p class="dim mini" v-if="d.paper">
          {{ d.paper.kind === 'bank' ? '题库随机卷（每人一份）' : '统一卷（全班同一份）' }} ·
          {{ d.paper.fullScore }} 分
          <template v-if="d.paper.duration"> · 限时 {{ d.paper.duration }} 分钟</template>
          <template v-if="d.paper.sections.length"> · {{ d.paper.sections.map((s) => s.title + '(' + (s.pick || s.count) + '题)').join('、') }}</template>
        </p>
        <p class="dim mini" v-else>还没装卷子。点下面的「导入这份卷子」，或先用右上角的「⤒ 导入试卷库」批量搬。</p>
      </div>
      <div class="ctrl-r">
        <input ref="fileInput" type="file" accept=".json" style="display: none" @change="onFile" />
        <button
          class="btn mini"
          title="只给这一个机试装卷子：支持试卷 JSON 或题库 JSON"
          @click="fileInput.click()"
        >
          {{ d.paper ? '换这份卷子（JSON）' : '导入这份卷子（JSON）' }}
        </button>
        <button v-if="d.paper" class="btn mini" title="排好版的空白卷，打印或存 PDF" @click="openPaper(false)">试卷</button>
        <button v-if="d.paper" class="btn mini" title="带参考答案与解析，只给老师" @click="openPaper(true)">答案卷</button>
        <button v-if="d.assignment.status !== 'open'" class="btn primary" :disabled="!d.paper" @click="start">▶ 开始考试</button>
        <button v-else class="btn danger" @click="stop">■ 结束</button>
        <button class="btn mini danger" @click="remove">删除</button>
      </div>
    </div>

    <div v-if="!d.paper" class="card empty">
      还没有试卷。按 <code>data/exams/_template.json</code> 的格式写一份 JSON（支持统一卷 / 题库随机卷），
      点上面「导入试卷 / 题库」。
    </div>

    <div v-else class="card">
      <CardHead>
        <template #title>学生答卷 · {{ d.rows.length }} 人开考</template>
        <template #meta><span class="dim mini">每 8 秒刷新 · 客观题交卷即得分，主观题等你判</span></template>
      </CardHead>
      <DataTable
        :columns="rowCols"
        :rows="d.rows"
        row-key="submissionId"
        clickable
        :empty="'还没有学生开考。'"
        @row-click="open"
      >
        <template #cell-no="{ index }">{{ index + 1 }}</template>
        <template #cell-answered="{ row }">{{ row.answered }} / {{ row.itemCount }}</template>
        <template #cell-total="{ row }"><b>{{ row.total === null ? '—' : row.total }}</b></template>
        <template #cell-score="{ row }">
          <span :class="{ ok: row.score !== null }">{{ row.score === null ? '—' : row.score }}</span>
        </template>
        <template #cell-actions="{ row }">
          <button class="btn mini" @click.stop="open(row)">{{ row.submittedAt ? '看答卷 / 判分' : '看进度' }}</button>
        </template>
      </DataTable>
    </div>
    </template>


    <!-- 判卷 -->
    <div v-if="viewing" class="mask" @click.self="viewing = null">
    <div class="modal wide">
      <div class="modal-head">
        <h3>
          {{ viewing.name }} <span class="dim mono">{{ viewing.sid }}</span>
          <span class="tag" style="margin-left: 6px">{{ viewing.submittedAt ? '已交卷' : '作答中' }}</span>
        </h3>
        <button v-if="viewing && viewing.submittedAt" class="btn mini" style="margin-left: 8px" @click="openSheet(viewing.submissionId)">
          打印答卷
        </button>
        <button class="btn mini" style="margin-left: auto" @click="viewing = null">关闭</button>
      </div>

      <div class="modal-body">
        <div v-if="detail.loading" class="empty">正在读取答卷…</div>
        <template v-else-if="detail.paper">
          <div class="scorebar">
            <span>客观题 <b>{{ detail.graded ? detail.graded.autoScore : '—' }}</b></span>
            <span>主观题
              <input v-for="q in subjective" :key="q.id" v-model="manual[q.id]" class="input" type="number" min="0" :max="q.score" :title="q.id" style="width: 58px; margin-left: 6px" />
            </span>
            <span>总分 <b class="total">{{ totalPreview }}</b> / {{ detail.paper.fullScore }}</span>
            <span class="spacer"></span>
            <input v-model="comment" class="input" placeholder="评语（学生看得到）" style="width: 240px" />
            <button class="btn primary" :disabled="saving" @click="saveGrade">{{ saving ? '保存中…' : '判分并记账' }}</button>
          </div>

          <section v-for="s in detail.paper.sections" :key="s.id" class="sec">
            <h4>{{ s.title }}（{{ s.score }} 分 / 题）</h4>
            <article v-for="q in s.questions" :key="q.id" class="q">
              <p class="stem"><b>{{ q.id }}</b> {{ q.stem }}</p>
              <ul v-if="q.options && q.options.length" class="opts">
                <li v-for="(o, oi) in q.options" :key="oi">{{ o }}</li>
              </ul>
              <p class="ans">
                学生：<b :class="markOf(q, s.type)">{{ detail.answers[q.id] || '（未作答）' }}</b>
                <span v-if="s.type !== 'short'" class="dim"> · 参考答案：{{ q.answer }}</span>
                <span v-if="s.type === 'short'" class="dim"> · 满分 {{ q.score }}</span>
              </p>
            </article>
          </section>
        </template>
        <div v-else class="empty">这个学生还没开始作答。</div>
      </div>
    </div>
    </div>

    <!-- 新建 -->
    <div v-if="editing" class="mask" @click.self="editing = false">
    <div class="modal">
      <div class="modal-head">
        <h3>新建机试</h3>
        <button class="btn mini" @click="editing = false">×</button>
      </div>
      <div class="modal-body form">
        <label class="field">
          <span>标题</span>
          <input v-model="form.title" class="input" placeholder="期末机试" />
        </label>
        <label class="field">
          <span>说明（学生端显示）</span>
          <textarea v-model="form.note" class="textarea" rows="4" placeholder="闭卷，90 分钟，交卷后不能再改。"></textarea>
        </label>
        <p class="dim mini">建好之后导入试卷 / 题库，再点「开始考试」。</p>
      </div>
      <div class="modal-foot">
        <span class="spacer"></span>
        <button class="btn" @click="editing = false">取消</button>
        <button class="btn primary" :disabled="saving" @click="create">保存</button>
      </div>
    </div>
    </div>

    <Toast :text="toast" @close="toast = ''" />
  </PageShell>
</template>

<script setup>
/*
 * 教师端「机试」模块
 *
 * 卷子格式见 server/lib/exam.js 顶部（模板 data/exams/_template.json）：
 *   统一卷 kind=paper / 题库随机卷 kind=bank，四种题型（选择 / 判断 / 填空 / 简答）。
 * 判卷：客观题自动算，主观题在这里给分，点「判分并记账」→ 总分落进计分表 + 出答卷文件。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { api, openDoc } from '../../api'
import Toast from '../../components/Toast.vue'
import { clock, when } from '../../utils/time'
import { loadScheme, scheme } from '../../utils/scheme'
import PageHead from '../../components/PageHead.vue'
import DirIO from '../../components/DirIO.vue'
import DataTable from '../../components/DataTable.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'

const props = defineProps({ itemKey: { type: String, default: 'exam' } })

const moduleTitle = computed(() => {
  const it = scheme.items.find((i) => i.key === props.itemKey)
  return it ? it.name : '机试'
})

const list = ref([])
const curId = ref('')
const d = ref(null)
const err = ref('')
const toast = ref('')

/* 学生答卷表 */
const rowCols = [
  { key: 'no', label: '#', num: true, width: '46px' },
  { key: 'sid', label: '学号', tdClass: 'mono' },
  { key: 'name', label: '姓名' },
  { key: 'startedAt', label: '开考', value: (r) => (r.startedAt ? clock(r.startedAt) : '—') },
  { key: 'answered', label: '作答' },
  { key: 'autoScore', label: '客观', num: true },
  { key: 'manualScore', label: '主观', num: true },
  { key: 'total', label: '总分', num: true },
  { key: 'score', label: '计分表', num: true },
  { key: 'actions', label: '', width: '132px' },
]
const loading = ref(false)
const saving = ref(false)
const fileInput = ref(null)
let timer = null

const viewing = ref(null)
const detail = reactive({ loading: false, paper: null, answers: {}, graded: null })
const manual = reactive({})
const comment = ref('')

const editing = ref(false)
const form = reactive({ title: '', note: '' })

const subjective = computed(() => {
  if (!detail.paper) return []
  const out = []
  for (const s of detail.paper.sections) if (s.type === 'short') for (const q of s.questions) out.push(q)
  return out
})

const totalPreview = computed(() => {
  const auto = detail.graded ? Number(detail.graded.autoScore) || 0 : 0
  let manualSum = 0
  for (const q of subjective.value) manualSum += Number(manual[q.id]) || 0
  return Math.round((auto + manualSum) * 10) / 10
})

onMounted(async () => {
  await loadAll()
  timer = setInterval(() => {
    if (document.hidden) return
    if (curId.value && !viewing.value) loadDetail(true)
  }, 8000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

async function loadAll() {
  loading.value = true
  err.value = ''
  try {
    await loadScheme()
    const res = await api.get('/api/assignments?itemKey=' + encodeURIComponent(props.itemKey))
    list.value = res.items || []
    if (!curId.value) {
      const openOne = list.value.filter((a) => a.status === 'open')
      curId.value = (openOne.length ? openOne[openOne.length - 1] : list.value[list.value.length - 1] || {}).id || ''
    }
    if (curId.value) await loadDetail()
    else d.value = null
  } catch (e) {
    err.value = e.message
  } finally {
    loading.value = false
  }
}

async function loadDetail(quiet) {
  if (!curId.value) return
  try {
    d.value = await api.get('/api/exams/' + encodeURIComponent(curId.value))
  } catch (e) {
    if (!quiet) err.value = e.message
  }
}

/** 打开排好版的卷子（HTML，A4 打印版）：answers=true 是答案卷 */
function openPaper(answers) {
  if (!curId.value) return
  openDoc('/api/exams/' + encodeURIComponent(curId.value) + '/paper-file/html' + (answers ? '?answers=1' : ''))
}

/** 打开某个学生的答卷（判完才有） */
function openSheet(submissionId) {
  if (!curId.value) return
  openDoc(
    '/api/exams/' + encodeURIComponent(curId.value) + '/submissions/' + encodeURIComponent(submissionId) + '/paper-file/html'
  )
}

function select(id) {
  if (curId.value === id) return
  curId.value = id
  d.value = null
  loadDetail()
}

function openEditor() {
  form.title = moduleTitle.value
  form.note = ''
  editing.value = true
}

async function create() {
  saving.value = true
  try {
    const res = await api.post('/api/assignments', {
      itemKey: props.itemKey,
      title: form.title,
      note: form.note,
    })
    curId.value = res.assignment.id
    editing.value = false
    await loadAll()
    toast.value = '建好了，接着导入试卷 / 题库'
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}

async function onFile(e) {
  const file = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!file) return
  try {
    const text = await file.text()
    const source = JSON.parse(text)
    const res = await api.post('/api/exams/' + encodeURIComponent(curId.value) + '/paper', { source })
    await loadDetail()
    toast.value = '导入成功：' + res.summary.title + '（' + res.summary.fullScore + ' 分' + (res.warnings && res.warnings.length ? '，有提示见控制台' : '') + '）'
    if (res.warnings && res.warnings.length) console.warn('[exam] 导入提示：', res.warnings)
  } catch (e2) {
    toast.value = '导入失败：' + (e2 && e2.message ? e2.message : e2)
  }
}

async function start() {
  if (!d.value) return
  if (!window.confirm('开始考试？学生端立刻能开考并开始计时。')) return
  try {
    const res = await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/start')
    toast.value = res.delivered ? '已开始，' + res.delivered + ' 个学生端已收到' : '已开始'
    await loadAll()
  } catch (e) {
    toast.value = e.message
  }
}

async function stop() {
  if (!d.value) return
  if (!window.confirm('结束这场机试？结束后学生不能再作答（已交的照样能判）。')) return
  try {
    await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/stop')
    toast.value = '已结束'
    await loadAll()
  } catch (e) {
    toast.value = e.message
  }
}

async function remove() {
  if (!d.value) return
  if (!window.confirm('删除这场机试？连同学生答卷一起删。')) return
  try {
    await api.del('/api/assignments/' + encodeURIComponent(curId.value))
    curId.value = ''
    d.value = null
    await loadAll()
    toast.value = '已删除'
  } catch (e) {
    toast.value = e.message
  }
}

async function open(r) {
  viewing.value = r
  detail.loading = true
  detail.paper = null
  for (const k of Object.keys(manual)) delete manual[k]
  comment.value = r.comment || ''
  try {
    const res = await api.get(
      '/api/exams/' + encodeURIComponent(curId.value) + '/submissions/' + encodeURIComponent(r.submissionId)
    )
    detail.paper = res.paper
    detail.answers = res.answers || {}
    detail.graded = res.graded || null
    if (res.graded) for (const it of res.graded.items) if (it.type === 'short') manual[it.qid] = it.got
  } catch (e) {
    toast.value = e.message
  } finally {
    detail.loading = false
  }
}

function markOf(q, type) {
  if (type === 'short') return ''
  return ''
}

async function saveGrade() {
  if (!viewing.value) return
  saving.value = true
  try {
    const res = await api.post(
      '/api/exams/' + encodeURIComponent(curId.value) + '/submissions/' + encodeURIComponent(viewing.value.submissionId) + '/grade',
      { scores: Object.assign({}, manual), comment: comment.value }
    )
    detail.graded = res.graded
    toast.value = '已判分：' + res.graded.total + ' / ' + res.fullScore + '，已记进计分表'
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.hwbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.hwpill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.led {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #cbd5e1;
}

.led.on {
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.16);
}

.led.off {
  background: #94a3b8;
}

.ctrl {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  margin-bottom: 12px;
}

.ctrl-l h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 15.5px;
}

.ctrl-r {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.scorebar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding: 8px 0 12px;
  border-bottom: 1px solid var(--line-soft);
}

.scorebar b {
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

.scorebar .total {
  color: var(--ok);
  font-size: 18px;
}

.sec {
  margin-top: 14px;
}

.sec h4 {
  margin: 0 0 6px;
  font-size: 13px;
  color: #374151;
}

.q {
  padding: 8px 0;
  border-top: 1px solid var(--line-soft);
}

.q:first-of-type {
  border-top: none;
}

.stem {
  margin: 0 0 4px;
  font-size: 13px;
  line-height: 1.7;
}

.opts {
  margin: 0 0 4px;
  padding-left: 18px;
  font-size: 12.5px;
  color: #475569;
}

.ans {
  margin: 2px 0 0;
  font-size: 12.5px;
}

.spacer {
  flex: 1;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
