<template>
  <PageShell>
    <template #head>
      <PageHead @reload="loadAll">
        <template #title>{{ moduleTitle }}</template>
        <template #sub>导入试卷 / 题库 → 开始 → 学生限时作答 → 客观题自动判、主观题你判 → 自动出答卷文件</template>
        <!--
          专属区。label 用「试卷库」而不是「试卷」：这里是**整个 content/exams 目录**
          的搬运（批量搬走/搬入试卷库），而列表里每个机试还有「导入这份卷子」的按钮
          （只给那一个作业装卷子）—— 两个都叫「导入试卷」会点错。
          刷新走通用区的「↻」。
        -->
        <template #right>
          <DirIO dir="exams" label="试卷库" />
          <button class="btn primary" @click="openEditor">＋ 新建机试</button>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>

    <div class="card hwbar">
      <button
      v-for="a in list"
      :key="a.id"
      class="pill hwpill"
      :class="{ on: a.id === curId }"
      @click="select(a.id)"
      >
      <!-- 状态读 collecting（实际还收不收），不读 status —— 到期不用老师手动点结束 -->
      <i class="led" :class="collectingOf(a) ? 'on' : a.started ? 'off' : ''"></i>
      {{ a.title }}
      <span class="dim">{{ stateOf(a).text }}</span>
    </button>
    <span v-if="!list.length && !loading" class="dim" style="font-size: var(--fs-md)">还没建过机试，点右上角「＋ 新建机试」。</span>
    </div>

    <template v-if="d">
    <div class="card ctrl">
      <div class="ctrl-l">
        <h3>
          {{ d.assignment.title }}
          <span class="tag" :class="stateOf(d.assignment).tone">{{ stateOf(d.assignment).text }}</span>
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
        <!--
          改时长。已经开始考的人也会立刻生效 ——
          后端会把他们的答卷 state 里那份 paper 快照一起改掉，不然改源文件对他们无效。
        -->
        <button
          v-if="d.paper"
          class="btn mini"
          :title="'现在是 ' + (d.paper.duration || 0) + ' 分钟。改完正在考的人也会立刻按新时长走'"
          @click="changeDuration"
        >
          改时长（{{ d.paper.duration || 0 }} 分钟）
        </button>
        <button v-if="d.paper" class="btn mini" title="排好版的空白卷，打印或存 PDF" @click="openPaper(false)">试卷</button>
        <button v-if="d.paper" class="btn mini" title="带参考答案与解析，只给老师" @click="openPaper(true)">答案卷</button>
        <!-- 到期之后自动变成「再开一场」（会提示先改截止时间），不用老师先去改状态 -->
        <button v-if="!collectingOf(d.assignment)" class="btn primary" :disabled="!d.paper" @click="start">
          ▶ {{ d.assignment.started ? '再开一场' : '开始考试' }}
        </button>
        <button v-else class="btn danger" @click="stop">■ 结束</button>
        <button class="btn mini danger" @click="remove">删除</button>
      </div>
    </div>

    <div v-if="!d.paper" class="card empty">
      还没有试卷。按 <code>data/exams/_template.json</code> 的格式写一份 JSON（支持统一卷 / 题库随机卷），
      点上面「导入试卷 / 题库」。
    </div>

    <!--
      分批开考：机器不够的时候只能一批一批来。
      和「▶ 开始考试」的分工 ——
        开始考试   全班同时
        分批       一次放几个人，这批交完点「结束这批」，再放下一批
      两者不冲突：整场开着全班都能考；整场关着时只有批次放的人能考。
    -->
    <div class="card batchcard">
      <CardHead>
        <template #title>分批开考</template>
        <template #meta>
          <span class="dim mini">勾几个人 → 开始这一批；这批做完点「结束这批」，再放下一批</span>
        </template>
      </CardHead>

      <div v-if="d.batches && d.batches.length" class="blist">
        <div
          v-for="b in d.batches"
          :key="b.id"
          class="brow"
          :class="{ live: b.status === 'open' && !b.overDue, timeup: b.status === 'open' && b.overDue }"
        >
          <span class="bseq">第 {{ b.seq }} 批</span>
          <span class="bstat">{{ b.status === 'open' ? (b.overDue ? '时间到' : '进行中') : '已结束' }}</span>
          <span class="dim mini">{{ b.count }} 人 · 已开考 {{ b.started }} · 已交 {{ b.submitted }}</span>
          <span v-if="b.status === 'open' && b.leftMin" class="bleft">还剩 {{ b.leftMin }} 分钟</span>
          <span v-else-if="b.status === 'open' && b.overDue" class="bleft over">已到时间</span>
          <span v-if="b.note" class="dim mini">· {{ b.note }}</span>
          <span class="spacer"></span>
          <button v-if="b.status === 'open'" class="btn mini" @click="stopBatch(b)">结束这批</button>
        </div>
      </div>

      <div class="pickbar">
        <button class="btn mini" @click="pickUnstarted">勾还没开考的</button>
        <button class="btn mini" @click="pickAll">全选</button>
        <button class="btn mini" @click="picked = []">清空</button>
        <span class="dim mini">已勾 {{ picked.length }} 人</span>
        <label class="minbox" title="这一批每人限时多少分钟（从他点「开考」那刻算）。留空 = 用试卷上的时长">
          限时
          <input v-model="batchMin" type="number" min="0" max="300" placeholder="试卷" />
          分钟
        </label>
        <span class="spacer"></span>
        <button class="btn primary" :disabled="!picked.length || busy" @click="startBatch">
          ▶ 开始这一批
        </button>
      </div>

      <div class="pickers">
        <label
          v-for="s in d.roster || []"
          :key="s.sid"
          class="pk"
          :class="{ on: picked.includes(s.sid), done: s.submitted }"
        >
          <input type="checkbox" :checked="picked.includes(s.sid)" @change="togglePick(s.sid)" />
          <span class="pkn">{{ s.name }}</span>
          <em v-if="s.submitted">已交</em>
          <em v-else-if="s.started">在考</em>
        </label>
      </div>
    </div>

    <div class="card">
      <CardHead>
        <template #title>学生答卷 · {{ d.rows.length }} 人开考</template>
        <template #meta><span class="dim mini">每 8 秒刷新 · 客观题交卷即得分，主观题等你判</span></template>
      </CardHead>
      <!--
        补考放行名单。
        这些人不在下面的答卷表里（重考会删掉他们的答卷），
        单独列出来，否则放行完就再也看不到、也取消不了。
      -->
      <div v-if="d.passes && d.passes.length" class="passes">
        <span class="pk">补考放行</span>
        <span
          v-for="p in d.passes"
          :key="p.sid"
          class="pi"
          :class="{ used: p.used }"
          :title="(p.used ? '已重新开考 / 已交卷 · ' : '还没进来 · ') + (p.className || '') + ' · ' + (p.at || '').slice(0, 16).replace('T', ' ')"
        >
          {{ p.name }}
          <button class="px" title="取消放行（他就进不来了）" @click="unpass(p)">×</button>
        </span>
        <span class="dim mini">这场已经结束，只有名单里的人还能开考</span>
      </div>

      <DataTable
        :columns="rowCols"
        :rows="d.rows"
        row-key="id"
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
          <!--
            立即交卷：只给「开考了还没交」的人。
            设备坏了、违纪、卡住的时候用 —— 把他已经答的收上来正常判分。
            注意它和「重考」是两回事：这个是收卷（分数算数），重考是清空重来。
          -->
          <button
            v-if="!row.submittedAt"
            class="btn mini"
            :title="'把 ' + (row.name || row.sid) + ' 现在答的收上来并判分（不是重考，分数算数）'"
            @click.stop="forceSubmit(row)"
          >
            立即交卷
          </button>
          <!--
            重考：清掉这次的答卷和分，让他重新开考（重新计时）。
            题库卷会换一套题 —— 不然重考就是背答案。
          -->
          <button
            class="btn mini danger"
            :title="'清掉 ' + (row.name || row.sid) + ' 这次交的答卷和分数，让他重新开考'"
            @click.stop="resetOne(row)"
          >
            重考
          </button>
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
              <input v-for="q in subjective" :key="q.id" v-model="manual[q.id]" class="input" type="number" min="0" :max="q.score" :title="q.id" style="width: 58px; margin: var(--sp-2)" />
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
/* 状态是算出来的 —— 和课堂作业页共用同一份判断，避免两个页面各写一套又分叉 */
import { collectingOf as collectingBase, stateOf as stateBase } from '../../utils/assignmentState'
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

/*
 * 时钟 tick：让「到点自动结束」不依赖数据新鲜度。
 * Vue 追踪不到 Date.now()，必须有个 ref 在推，依赖它的地方才会重算。
 */
const nowTick = ref(Date.now())

/** 这场考试还收不收 —— 包一层只是把 nowTick 带上 */
function collectingOf(x) {
  return collectingBase(x, nowTick.value)
}
/** 给人看的状态。机试那个词叫「考试中」 */
function stateOf(x) {
  return stateBase(x, nowTick.value, '考试中')
}

onMounted(async () => {
  await loadAll()
  timer = setInterval(() => {
    /* 先推时钟（纯本地、不发请求），所以放在 hidden 判断之前 ——
       后台标签页切回来那一刻状态也是对的 */
    nowTick.value = Date.now()
    if (document.hidden) return
    /* 列表也要刷：胶囊和小灯读的是它，到期得自己翻过去 */
    loadList()
    if (curId.value && !viewing.value) loadDetail(true)
  }, 8000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

/** 只刷列表（不重拉方案），轮询用 */
async function loadList() {
  try {
    const res = await api.get('/api/assignments?itemKey=' + encodeURIComponent(props.itemKey))
    list.value = res.items || []
  } catch (e) {
    /* 轮询失败下一轮再试 */
  }
}

async function loadAll() {
  loading.value = true
  err.value = ''
  try {
    await loadScheme()
    const res = await api.get('/api/assignments?itemKey=' + encodeURIComponent(props.itemKey))
    list.value = res.items || []
    if (!curId.value) {
      /* 默认选中「还在收」的那场（到期的不算 —— 那场已经开不了考了） */
      const openOne = list.value.filter((a) => collectingOf(a))
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

/**
 * 改这场考试的时长。
 *
 * 用 prompt 而不是弹窗表单：这是低频、单字段的操作，
 * 为它做一个弹窗反而多两次点击。改完立刻广播，正在考的学生倒计时会当场变。
 */
async function changeDuration() {
  if (!d.value || !d.value.paper) return
  const cur = d.value.paper.duration || 45
  const input = window.prompt('这场考试限时多少分钟？', String(cur))
  if (input === null) return
  const mins = Math.floor(Number(input))
  if (!(mins > 0)) {
    toast.value = '要填大于 0 的分钟数'
    return
  }
  try {
    const res = await api.patch('/api/exams/' + encodeURIComponent(curId.value) + '/duration', { minutes: mins })
    toast.value =
      '已改成 ' + mins + ' 分钟' +
      (res.inProgress ? '（' + res.inProgress + ' 个正在考的人立刻生效）' : '')
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  }
}

/**
 * 让单个学生重考。
 *
 * 会清掉：这次的答卷（答案 + 那份 md）、记在计分表里的分。
 * 下次他进考试页就是全新的：重新抽题（题库卷换一套）、重新计时、满时长。
 *
 * 二次确认是必须的 —— 这个操作不可撤销，而「重考」两个字看着不像删除。
 */
async function resetOne(row) {
  /* 答卷 id 在 row.id —— 后端 submissionView 给的就是 id，没有 submissionId 这个字段 */
  if (!row || !row.id) return
  const who = row.name || row.sid
  const ok = window.confirm(
    '让 ' + who + ' 重考？\n\n' +
      '· 这次交的答卷和记的分会被清掉，找不回来\n' +
      '· 他可以重新开考，重新计时（满时长）\n' +
      '· 题库卷会抽另一套题；统一卷还是同一份'
  )
  if (!ok) return
  try {
    const res = await api.post(
      '/api/exams/' + encodeURIComponent(curId.value) + '/submissions/' + encodeURIComponent(row.id) + '/reset'
    )
    toast.value = res.message || who + ' 已重置'
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  }
}

/**
 * 强制收某个人的卷（立即交卷）。
 *
 * 和 resetOne 的区别要在确认框里说清楚 —— 两个按钮挨着，
 * 一个「收卷、分数算数」，一个「清空重来」，点错后果完全不同。
 */
async function forceSubmit(row) {
  if (!row || !row.id) return
  const who = row.name || row.sid
  const ok = window.confirm(
    '立即收 ' + who + ' 的卷？\n\n' +
      '· 他**现在答的**会被收上来，客观题立刻判分，分数算数\n' +
      '· 收完他就不能再改了（页面会自己变成「已交卷」）\n' +
      '· 这**不是**重考：要清空重来请点「重考」'
  )
  if (!ok) return
  try {
    const res = await api.post(
      '/api/exams/' + encodeURIComponent(curId.value) + '/submissions/' + encodeURIComponent(row.id) + '/force-submit'
    )
    toast.value = res.message || who + ' 的卷子已收'
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  }
}

/* ---------------- 分批开考 ---------------- */

/** 这一批勾了谁 / 限时几分钟 / 防连点 */
const picked = ref([])
const batchMin = ref('')
const busy = ref(false)

function togglePick(sid) {
  const i = picked.value.indexOf(sid)
  picked.value = i >= 0 ? picked.value.filter((x) => x !== sid) : picked.value.concat([sid])
}

/** 勾上还没开考的人 —— 分批最常用的一手 */
function pickUnstarted() {
  picked.value = ((d.value && d.value.roster) || []).filter((s) => !s.started).map((s) => s.sid)
}

function pickAll() {
  picked.value = ((d.value && d.value.roster) || []).map((s) => s.sid)
}

/** 开始这一批：只放这几个人进来，整场状态不动 */
async function startBatch() {
  if (!picked.value.length || busy.value) return
  const n = picked.value.length
  const mins = Math.max(0, Math.floor(Number(batchMin.value) || 0))
  if (
    !window.confirm(
      '开始新的一批？\n\n这一批 ' + n + ' 个人可以开考，其他人还是进不来。\n' +
        (mins > 0 ? '每人限时 ' + mins + ' 分钟（从他自己点「开考」那刻算）。\n' : '') +
        '做完之后点「结束这批」，再放下一批。'
    )
  )
    return
  busy.value = true
  try {
    const res = await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/start', {
      sids: picked.value.slice(),
      minutes: mins,
    })
    toast.value = res.message || n + ' 人已放行'
    picked.value = []
    await loadAll()
  } catch (e) {
    toast.value = e.message
  } finally {
    busy.value = false
  }
}

async function stopBatch(b) {
  if (!b) return
  if (!window.confirm('结束第 ' + b.seq + ' 批？\n\n这批 ' + b.count + ' 人就不能再作答了（已交的照样留着）。\n整场不受影响，你可以接着放下一批。')) return
  try {
    const res = await api.post(
      '/api/assignments/' + encodeURIComponent(curId.value) + '/batches/' + encodeURIComponent(b.id) + '/stop'
    )
    toast.value = res.message || '第 ' + b.seq + ' 批已结束'
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  }
}

/** 取消某人的补考放行 */
async function unpass(p) {
  if (!p) return
  if (!window.confirm('取消 ' + (p.name || p.sid) + ' 的补考放行？\n\n取消后他就进不来这场考试了（已经交的答卷不受影响）。')) return
  try {
    await api.del('/api/exams/' + encodeURIComponent(curId.value) + '/passes/' + encodeURIComponent(p.sid))
    toast.value = (p.name || p.sid) + ' 的放行已取消'
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  }
}

async function start() {
  if (!d.value) return
  const a = d.value.assignment
  /*
   * 截止时间已经过了、而且不收迟交 —— 光点开始没用：
   * status 本来就是 open，collecting 仍然算 false，学生还是开不了考。
   * 与其让他点完看不出变化，不如直接说清楚要先改时间。
   */
  if (stateOf(a).key === 'overdue') {
    toast.value = '截止时间已经过了，先把这场机试的截止时间往后调，再开始'
    return
  }
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
/* ---------------- 分批开考（和课堂作业那份是同一套形状） ---------------- */

.blist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--sp-3);
}
.brow {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px var(--sp-2) 6px var(--sp-3);
  border-left: 2px solid transparent;
  border-radius: var(--r-sm);
  background: var(--bg-sub);
  font-size: var(--fs-md);
}
.brow.live {
  border-left-color: var(--brand);
  background: #eef4f9;
}
.brow.timeup {
  border-left-color: #d08a2e;
  background: #fdf6ec;
}
.brow .bseq {
  font-weight: 600;
  color: #1f2937;
}
.brow .bstat {
  font-size: var(--fs-sm);
  color: #8b95a1;
}
.brow.live .bstat {
  color: var(--brand);
}
.brow .bleft {
  font-size: var(--fs-sm);
  color: #a15c00;
  font-variant-numeric: tabular-nums;
}
.brow .bleft.over {
  color: var(--err);
  font-weight: 600;
}

.pickbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--line-soft);
  margin-bottom: var(--sp-2);
}
.minbox {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-sm);
  color: #5b6673;
}
.minbox input {
  width: 58px;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  font: inherit;
  text-align: center;
}

.pickers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 190px;
  overflow: auto;
}
.pk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px 3px 6px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  background: #fff;
  font-size: var(--fs-sm);
  color: #3c4650;
  cursor: pointer;
  user-select: none;
}
.pk:hover {
  border-color: #b9c6d3;
}
.pk.on {
  background: #e8f1f8;
  border-color: var(--brand);
  font-weight: 600;
}
.pk.done {
  opacity: 0.5;
}
.pk input {
  margin: 0;
  accent-color: var(--brand);
}
.pk em {
  font-style: normal;
  font-size: 10.5px;
  color: #8b95a1;
}

/*
 * 补考放行名单：一行小标签，跟在答卷表上面。
 * 不放表格里 —— 这些人恰恰是「没有答卷」的那几个，塞进表格会出现
 * 一行全空、只剩名字的记录，反而看不懂。
 */
.passes {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: #fff8ec;
  border: 1px solid #f0dcc0;
}
.passes .pk {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: #a15c00;
  margin-right: 2px;
}
.passes .pi {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px 1px 8px;
  border-radius: 999px;
  background: #fff;
  border: 1px solid #f0dcc0;
  font-size: var(--fs-sm);
  color: #7a4a00;
}
/* 已经进来考过 / 交过的：压暗，老师一眼看出这条放行用掉了 */
.passes .pi.used {
  opacity: 0.55;
}
.passes .px {
  border: none;
  background: none;
  padding: 0 3px;
  font-size: 13px;
  line-height: 1;
  color: #b0b8c2;
  cursor: pointer;
  border-radius: 50%;
}
.passes .px:hover {
  color: var(--err);
  background: rgba(220, 60, 60, 0.1);
}

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
  gap: var(--sp-2);
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
  gap: var(--sp-3);
  padding: 12px var(--sp-3);
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
  gap: var(--sp-3);
  flex-wrap: wrap;
  padding: 8px 0 12px;
  border-bottom: 1px solid var(--line-soft);
}

.scorebar b {
  font-size: var(--fs-lg);
  font-variant-numeric: tabular-nums;
}

.scorebar .total {
  color: var(--ok);
  font-size: 18px;
}

.sec {
  margin: var(--sp-3);
}

.sec h4 {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-md);
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
  font-size: var(--fs-md);
  line-height: 1.7;
}

.opts {
  margin: 0 0 4px;
  padding: var(--sp-4);
  font-size: var(--fs-sm);
  color: #475569;
}

.ans {
  margin: 2px 0 0;
  font-size: var(--fs-sm);
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
