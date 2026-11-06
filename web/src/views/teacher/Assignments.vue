<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>{{ moduleTitle }}</template>
        <template #sub>新建 → 点「开始」收作业 → 学生交一份这里就多一条，按时间顺序排，边看边打分</template>
        <template #right>
          <button class="btn mini" :disabled="loading" @click="loadAll">刷新</button>
          <button class="btn mini" @click="openLib" title="作业设计目录：已导入 / 新建的设计都可以在这里挑、导入、导出">作业目录</button>
          <button class="btn primary" @click="openEditor('new')">＋ 新建作业</button>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>

    <!-- 批阅进度：谁没交、批了几个 -->
    <div v-if="prog && prog.studentCount" class="progbar">
      <span class="pb-k">已交</span>
      <b>{{ prog.submitted }}</b><span class="dim">/ {{ prog.studentCount }} 人</span>
      <span class="pb-sep"></span>
      <span class="pb-k">已批</span>
      <b>{{ prog.graded }}</b>
      <span class="dim">· 待批 {{ prog.pending }}</span>
      <span class="pb-sep"></span>
      <span class="pb-k">未交</span>
      <b :class="{ 'pb-warn': prog.missing.length }">{{ prog.missing.length }}</b>
      <button v-if="prog.missing.length" class="linkish" @click="showMissing = !showMissing">
        {{ showMissing ? '收起名单' : '看名单' }}
      </button>
      <span v-if="showMissing" class="pb-miss dim">{{ missingText }}</span>
    </div>

    <!-- 作业切换条：一个学期就几份，横向摆开比下拉好点 -->
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
      <span class="dim">{{ a.status === 'open' ? '进行中' : a.started ? '已结束' : '未开始' }}</span>
      <span v-if="a.weight && Number(a.weight) !== 1" class="cnt" :title="'权重 ' + a.weight">×{{ a.weight }}</span>
      <span class="cnt">{{ a.studentCount }}</span>
    </button>
    <span v-if="!list.length && !loading" class="dim" style="font-size: 13px">还没有作业，点右上角「新建作业」。</span>
    </div>

    <template v-if="d">
    <!-- 控制台：开始 / 结束 -->
    <div class="card ctrl">
      <div class="ctrl-l">
        <h3>
          {{ d.assignment.title }}
          <span class="tag" :class="d.assignment.status === 'open' ? 'ok' : d.assignment.started ? 'mute' : 'warn'">
            {{ d.assignment.status === 'open' ? '进行中' : d.assignment.started ? '已结束' : '未开始' }}
          </span>
        </h3>
        <p class="dim mini">
          {{ d.assignment.selfCode ? '作业自带代码（建作业时复制了一份）' : '对应示例：' + d.assignment.dirTitle }}
          <span v-if="d.assignment.note"> · {{ d.assignment.note }}</span>
        </p>
        <p class="mini dim">
          <span v-if="d.assignment.openedAt">开始于 {{ when(d.assignment.openedAt) }}</span>
          <span v-else>还没开始过，学生端现在是灰的</span>
          <span v-if="d.assignment.closedAt"> · 结束于 {{ when(d.assignment.closedAt) }}</span>
        </p>
      </div>
      <div class="ctrl-r">
        <button v-if="d.assignment.status !== 'open'" class="btn primary" @click="start">
          ▶ 开始作业（学生可以交了）
        </button>
        <button v-else class="btn danger" @click="stop">■ 结束作业（停止收卷）</button>
        <button class="btn mini" @click="openEditor('edit')">改标题 / 说明</button>
        <button class="btn mini danger" @click="remove">删除</button>
      </div>
    </div>

    <!-- 统计 -->
    <div class="stats">
      <div class="st">
        <span class="stn">{{ d.stats.rosterCount }}</span>
        <span class="stl">应交人数</span>
      </div>
      <div class="st">
        <span class="stn ok">{{ d.stats.submittedStudents }}</span>
        <span class="stl">已交人数</span>
      </div>
      <div class="st">
        <span class="stn">{{ d.stats.submissionCount }}</span>
        <span class="stl">提交条数</span>
      </div>
      <div class="st">
        <span class="stn" :class="{ warn: d.stats.submissionCount > d.stats.gradedCount }">{{ d.stats.gradedCount }}</span>
        <span class="stl">
          {{
          d.stats.submissionCount > d.stats.gradedCount
          ? '已批 · 还差 ' + (d.stats.submissionCount - d.stats.gradedCount) + ' 条'
          : '已批 · 都批完了'
          }}
        </span>
      </div>
      <div class="st">
        <span class="stn" :class="{ err: d.stats.missing.length }">{{ d.stats.missing.length }}</span>
        <span class="stl">未交</span>
      </div>
    </div>

    <!-- 提交记录（时间顺序） -->
    <div class="card">
      <CardHead>
        <template #title>提交记录 · 按交的时间排</template>
        <template #right>
          <span class="pill" :class="{ on: !classId }" @click="setClass('')">全部班级</span>
          <span
          v-for="c in classes"
          :key="c.id"
          class="pill"
          :class="{ on: classId === c.id }"
          @click="setClass(c.id)"
          >
          {{ c.name }}
        </span>
        <span class="dim mini">每 8 秒自动刷新</span>
      </template>
    </CardHead>

    <div v-if="!d.submissions.length" class="empty">
      {{ d.assignment.status === 'open' ? '还没有人交，等一会儿再看。' : '这次作业没有提交记录。' }}
    </div>

    <DataTable
      v-else
      :columns="subCols"
      :rows="d.submissions"
      row-key="id"
      clickable
      :empty="'还没有人交'"
      @row-click="review"
    >
      <template #cell-no="{ index }">{{ index + 1 }}</template>
      <template #cell-when="{ row }">
        {{ clock(row.createdAt) }}
        <span v-if="fresh(row.createdAt)" class="tag ok" style="margin-left: 6px">新</span>
      </template>
      <template #cell-sid="{ row }"><span class="mono">{{ row.sid }}</span></template>
      <template #cell-className="{ row }"><span class="dim">{{ row.className }}</span></template>
      <template #cell-files="{ row }">{{ row.changedCount }} / {{ row.fileCount }}</template>
      <template #cell-score="{ row }">
        <span :class="{ ok: row.score !== null }">{{ row.score === null ? '—' : row.score }}</span>
      </template>
      <template #cell-comment="{ row }"><span class="cmt dim">{{ row.comment || '—' }}</span></template>
      <template #cell-actions="{ row }">
        <button class="btn mini" @click.stop="review(row)">看代码 / 打分</button>
      </template>
    </DataTable>
    </div>

    <!-- 未交名单 -->
    <div v-if="d.stats.missing.length" class="card">
    <CardHead>
      <template #title>未交 · {{ d.stats.missing.length }} 人</template>
      <div class="right dim mini">按当前班级筛选</div>
    </CardHead>
    <div class="miss">
      <span v-for="m in d.stats.missing" :key="m.classId + m.sid" class="missi">
        {{ m.name }}<em>{{ m.sid }}</em>
      </span>
    </div>
    </div>
    </template>

    <div v-else-if="!loading" class="card empty">
    {{ list.length ? '选一份作业看提交' : '还没有作业。先「新建作业」，选一课要改的代码示例。' }}
    </div>


    <!-- 审阅 + 打分 -->
    <div v-if="viewing" class="mask" @click.self="closeReview">
    <div class="modal wide xwide">
    <div class="modal-head">
      <h3>
        {{ viewing.name }} <span class="dim mono">{{ viewing.sid }}</span>
        <span class="tag" style="margin-left: 6px">{{ when(viewing.createdAt) }}</span>
      </h3>
      <div class="right">
        <label class="check mini"><input v-model="onlyChanged" type="checkbox" /> 只看改过的</label>
        <button class="btn mini" :disabled="reviewIdx <= 0" @click="step(-1)">↑ 上一条</button>
        <button class="btn mini" :disabled="reviewIdx >= d.submissions.length - 1" @click="step(1)">↓ 下一条</button>
        <button class="btn mini" @click="closeReview">×</button>
      </div>
    </div>

    <div class="modal-body review">
      <div v-if="loadingFiles" class="empty">正在读取提交的文件…</div>
      <template v-else>
        <div class="rev-code">
          <CodeViewer :files="codeFiles" :marked="viewing.changed" :font-size="12.5" />
        </div>

        <div class="rev-run">
          <div class="rev-head">
            <select v-if="pages.length" v-model="previewPage" class="select" @change="runPreview">
              <option v-for="p in pages" :key="p" :value="p">{{ p }}</option>
            </select>
            <span class="spacer"></span>
            <span v-if="previewNpm" class="tag warn">npm 工程</span>
            <span v-else-if="previewOk" class="tag ok">已渲染</span>
            <button class="btn mini" :disabled="previewBusy || previewNpm" @click="runPreview">▶ 运行</button>
          </div>
          <div v-if="previewNpm" class="npmnote">
            这一课的入口是 <code>{{ npmEntry }}</code>，代码靠 Vite 打包、裸模块由 node_modules 解析，
            浏览器里跑不起来（不是学生交坏了）。左边源码照样能看。
          </div>
          <template v-else>
            <!-- 跑的是学生交上来的代码：不给 allow-same-origin，隔离成独立源，
            免得有人借这份代码读到教师端的令牌 -->
            <iframe
            ref="frame"
            class="rev-frame"
            title="学生提交的渲染结果"
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            ></iframe>
          <div v-if="previewError" class="perr">
            <b>页面报错</b>
            <span>{{ previewError }}</span>
            <button class="perr-x" @click="previewError = ''">×</button>
          </div>
          <p class="dim mini rev-note">
            渲染用的是学生交上来的那份代码（在本页内跑，不落服务器）；改了分页或想重跑，点「运行」。
          </p>
        </template>
      </div>
    </template>

    <p v-if="!loadingFiles" class="dim mini filenote">
      整份交了 {{ viewing.fileCount }} 个文件，其中改了 {{ viewing.changedCount }} 个
      <template v-if="viewing.changedCount">：{{ viewing.changed.join('、') }}</template>
    </p>
    </div>

    <div class="modal-foot grade">
    <!-- 打什么控件由这一项的规则决定（等级 / 量规 / 卷面分），页面不写死 -->
    <GradeBox v-if="moduleItem" :item="moduleItem" :model-value="grade" />
    <p class="dim mini" style="margin: 2px 0 6px">
      本次权重 ×{{ d && d.assignment ? d.assignment.weight || 1 : 1 }}
      （计入「{{ moduleTitle }}」，加权平均时按这个比重算）
    </p>
    <input v-model="grade.comment" class="input" placeholder="评语（可选，学生看得到）" />
    <span class="spacer"></span>
    <span v-if="viewing.score !== null" class="dim mini">
      上次：{{ viewing.score }} 分 {{ viewing.gradedAt ? '· ' + when(viewing.gradedAt) : '' }}
    </span>
    <button class="btn line" :disabled="saving" @click="clearGrade">清掉</button>
    <button class="btn line" :disabled="saving" title="分数与评语清空、计分记录作废，学生可以再交一次" @click="redo">打回重做</button>
    <button class="btn primary" :disabled="saving" @click="saveGrade">
      {{ saving ? '保存中…' : '保存并下一条' }}
    </button>
    </div>
    </div>
    </div>

    <!-- 作业目录：设计都在这里，新建作业时从这儿挑 -->
    <div v-if="lib.open" class="mask" @click.self="lib.open = false">
      <div class="modal wide">
        <div class="modal-head">
          <h3>作业目录 · {{ moduleTitle }}</h3>
          <button class="btn mini" style="margin-left: auto" @click="lib.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="row" style="margin-bottom: 10px">
            <button class="btn mini" @click="libPick.click()" :disabled="lib.busy">⤒ 上传设计包</button>
            <input ref="libPick2" type="file" accept=".zip" style="display: none" @change="onDesignUpload" />
            <button class="btn mini" :disabled="lib.busy" @click="downloadTpl">⤓ 下载模板</button>
            <span class="dim mini">一个设计包 = <code>homework.json</code> + <code>code/</code>（起手代码）；模板里带说明</span>
          </div>

          <p v-if="lib.err" class="hint err">{{ lib.err }}</p>
          <p v-if="!designs.length" class="dim mini">还没有设计。上传一个设计包，或者新建作业时选「空白」自己写。</p>

          <div v-for="x in designs" :key="x.id" class="lib-row">
            <div class="lib-main">
              <b>{{ x.title }}</b>
              <span class="dim mini">{{ x.fileCount }} 个文件 · 权重 {{ x.weight }}<template v-if="x.dueAt"> · 截止 {{ when(x.dueAt) }}</template></span>
            </div>
            <div class="lib-acts">
              <button class="btn mini" @click="useDesign(x)">用这个建作业</button>
              <button class="btn mini" @click="exportDesign(x)">导出</button>
              <button class="btn mini danger" @click="removeDesign(x)">删除</button>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <span class="dim mini">删设计不影响已经建出来的作业（它们有自己的代码副本）</span>
          <span class="spacer"></span>
          <button class="btn" @click="lib.open = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- 新建 / 修改作业 -->
    <div v-if="editing" class="mask" @click.self="editing = ''">
    <div class="modal">
    <div class="modal-head">
    <h3>{{ editing === 'new' ? '新建' + moduleTitle : '修改' + moduleTitle }}</h3>
    <button class="btn mini" @click="editing = ''">×</button>
    </div>
    <div class="modal-body form">
    <label class="field">
      <span>
        作业设计（学生的起手代码从这儿来）
        <em class="mini wtip">课堂作业不再挂「代码示例」，有自己的一份代码</em>
      </span>
      <div class="row">
        <select v-if="editing === 'new'" v-model="form.designId" class="select" @change="onDesignChange">
          <option value="">空白（系统给一份最小三件套）</option>
          <option v-for="x in designs" :key="x.id" :value="x.id">{{ x.title }}（{{ x.fileCount }} 个文件）</option>
        </select>
        <span v-else class="dim mini">修改作业不会动起手代码（代码在建作业时就复制好了）</span>
        <button v-if="editing === 'new'" class="btn mini" :disabled="saving" @click="libPick.click()">上传设计包…</button>
        <input ref="libPick" type="file" accept=".zip" style="display: none" @change="onDesignUpload" />
      </div>
    </label>
    <label class="field">
      <span>截止时间（可留空 = 不限）</span>
      <div class="row">
        <input v-model="form.dueAt" class="input" type="datetime-local" style="width: 220px" />
        <label class="check">
          <input v-model="form.allowLate" type="checkbox" />
          截止后仍收（自动标「迟交」，按方案的迟交系数打折）
        </label>
      </div>
    </label>
    <label class="field">
      <span>作业标题（学生端显示这个）</span>
      <input v-model="form.title" class="input" maxlength="60" :placeholder="dirTitleOf(form.dir)" />
    </label>
    <label class="field">
      <span>作业说明（学生能看到，可留空）</span>
      <textarea v-model="form.note" class="textarea" rows="4" maxlength="500" placeholder="例如：把列表改成卡片，加上删除按钮"></textarea>
    </label>
    <label class="field">
      <span>
        本次权重（占「{{ moduleTitle }}」的比重）
        <em class="mini wtip">默认 1，越大越吃重；比如期末综合练习填 2，随堂小练填 0.5</em>
      </span>
      <input v-model.number="form.weight" class="input" type="number" min="0.1" max="20" step="0.5" style="width: 120px" />
    </label>
    <p class="dim mini">
      多项作业按权重加权平均（{{ weightHint }}）。新建的作业一律是「未开始」，等你在列表里点「开始」学生才交得上。
    </p>
    </div>
    <div class="modal-foot">
    <span class="spacer"></span>
    <button class="btn" @click="editing = ''">取消</button>
    <button class="btn primary" :disabled="saving" @click="saveEditor">{{ saving ? '保存中…' : '保存' }}</button>
    </div>
    </div>
    </div>

    <Toast :text="toast" @close="toast = ''" />
  </PageShell>
</template>

<script setup>
/*
 * 教师端「课堂作业」
 *
 * 一页把老师的全套动作串起来：
 *   建作业（选一课示例）→ 开始 / 结束（控制学生能不能交）→ 按时间顺序看提交 →
 *   点开某一条看代码 + 打分。
 *
 * 几个刻意的决定：
 *   · 提交列表按「交的时间」正序，不是按学号：谁先交谁在上面，正好是课堂的节奏；
 *   · 只看改过的文件（默认开）：学生改了什么一眼看清，需要上下文再关掉；
 *   · 打分框放在弹层底部：「看代码 → 给分 → 下一条」一条流水线，不用来回关窗口；
 *   · 未交名单跟着班级筛选走，讲评时可以顺手点个名。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { api, download, getCourse, getToken } from '../../api'
import CodeViewer from '../../components/CodeViewer.vue'
import GradeBox from '../../components/GradeBox.vue'
import Toast from '../../components/Toast.vue'
import { clock, when } from '../../utils/time'
import { buildPreviewDoc, ensureSfcSrcdoc, isNpmProject, pagesOf } from '../../utils/pgPreview'
import { loadScheme, scheme } from '../../utils/scheme'
import PageHead from '../../components/PageHead.vue'
import DataTable from '../../components/DataTable.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'

/* 哪个考核项的模块：由路由 /teacher/modules/:itemKey 传进来 */
const props = defineProps({
  itemKey: { type: String, default: 'homework' },
})

/** 这一项在方案里的定义（等级表、量规维度、卷面满分都从这儿来） */
const moduleItem = computed(() => scheme.items.find((i) => i.key === props.itemKey) || null)
const moduleTitle = computed(() => (moduleItem.value ? moduleItem.value.name : '课堂作业'))

/** 权重怎么算的，用当前方案里的等级表说明一句（改了分值/等级表这里也跟着变） */
const weightHint = computed(() => {
  const it = moduleItem.value
  if (!it) return '按每次的权重加权平均'
  const grades = (it.grades || []).map((g) => g.name).join(' / ')
  return '每次判 ' + (grades || '等级') + '，按每次权重加权平均，最后折算到本项 ' + it.full + ' 分'
})

const list = ref([])
const dirs = ref([])
const classes = ref([])
const curId = ref('')
const d = ref(null) // { assignment, submissions, stats }
const classId = ref('')
const err = ref('')
const toast = ref('')

/* 提交记录表：列定义（原来写死在模板里，现在一处声明） */
const subCols = [
  { key: 'no', label: '#', num: true, width: '46px' },
  { key: 'when', label: '提交时间', hint: '先交的在前' },
  { key: 'sid', label: '学号' },
  { key: 'name', label: '姓名' },
  { key: 'className', label: '班级' },
  { key: 'files', label: '改动 / 文件', num: true },
  { key: 'score', label: '分数', num: true },
  { key: 'comment', label: '评语' },
  { key: 'actions', label: '', width: '120px' },
]
const loading = ref(false)
const saving = ref(false)
let timer = null

/* 审阅弹层 */
const viewing = ref(null)
const reviewIdx = ref(-1)
const subFiles = ref([]) // [{path,text}] 学生交上来的整份文件
const loadingFiles = ref(false)
const onlyChanged = ref(true)
// 打分的三种载体都在这里（等级 / 卷面 / 量规），页面按规则各取所需
const grade = reactive({ grade: '', late: false, raw: '', dims: {}, comment: '' })

/* 弹层里的预览（跑学生交的代码） */
const frame = ref(null)
const previewPage = ref('')
const previewError = ref('')
const previewOk = ref(false)
const previewBusy = ref(false)

/* 新建 / 修改 */
const editing = ref('') // '' | 'new' | 'edit'
const form = reactive({ dir: '', designId: '', title: '', note: '', weight: 1, dueAt: '', allowLate: true })

/* ---------------- 作业目录（设计） ---------------- */
const designs = ref([])
const libPick = ref(null)
const libPick2 = ref(null)
const lib = reactive({ open: false, busy: false, err: '' })

/* ---------------- 批阅进度 ---------------- */
const prog = ref(null)
const showMissing = ref(false)
const missingText = computed(() => {
  if (!prog.value) return ''
  return prog.value.missing.map((m) => m.name).join('、')
})

async function loadDesigns() {
  try {
    const r = await api.get('/api/courses/' + encodeURIComponent(getCourse()) + '/designs?kind=homework')
    designs.value = (r.homework || []).map((d) => Object.assign({}, d, { dueAt: d.dueAt || '' }))
  } catch (e) {
    designs.value = []
  }
}

async function loadProgress() {
  prog.value = null
  showMissing.value = false
  if (!curId.value) return
  try {
    prog.value = await api.get('/api/assignments/' + encodeURIComponent(curId.value) + '/progress')
  } catch (e) {
    prog.value = null
  }
}

function openLib() {
  lib.open = true
  lib.err = ''
  loadDesigns()
}

/** 选了设计：把它的标题/说明/权重/截止带过来（老师可以改） */
function onDesignChange() {
  const x = designs.value.find((d) => d.id === form.designId)
  if (!x) return
  if (!form.title || form.title === lastAutoTitle) {
    form.title = x.title
    lastAutoTitle = x.title
  }
  if (!form.note) form.note = x.note || ''
  if (!form.dueAt && x.dueAt) form.dueAt = toLocalInput(x.dueAt)
  form.weight = x.weight === undefined ? 1 : Number(x.weight) || 1
  form.allowLate = x.allowLate !== false
}

/** ISO → datetime-local 需要的 "YYYY-MM-DDTHH:mm" */
function toLocalInput(iso) {
  const d = new Date(iso)
  if (!isFinite(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 上传一个设计包 → 进库 → 直接选中它 */
async function onDesignUpload(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  lib.busy = true
  lib.err = ''
  try {
    const buf = await f.arrayBuffer()
    const token = getToken()
    const res = await fetch(
      '/api/courses/' + encodeURIComponent(getCourse()) + '/designs/import?kind=homework',
      {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: buf,
      }
    )
    const j = await res.json().catch(() => null)
    if (!res.ok) throw new Error((j && j.error) || '导入失败（' + res.status + '）')
    toast.value = '已导入设计：' + j.design.title
    await loadDesigns()
    form.designId = j.design.id
    onDesignChange()
  } catch (err) {
    lib.err = err.message
    toast.value = err.message
  } finally {
    lib.busy = false
  }
}

function downloadTpl() {
  download('/api/courses/' + encodeURIComponent(getCourse()) + '/designs/template.zip?kind=homework', 'homework-design-template.zip')
  toast.value = '模板已下载：改完压缩成 zip 再上传'
}

function exportDesign(x) {
  download(
    '/api/courses/' + encodeURIComponent(getCourse()) + '/designs/' + encodeURIComponent(x.id) + '/zip?kind=homework',
    'homework-' + x.id + '.zip'
  )
}

async function removeDesign(x) {
  if (!window.confirm('从作业目录里删掉「' + x.title + '」？\n\n已经建出来的作业不受影响（它们有自己的代码副本）。')) return
  try {
    await api.del('/api/courses/' + encodeURIComponent(getCourse()) + '/designs/' + encodeURIComponent(x.id) + '?kind=homework')
    toast.value = '已从目录删除'
    await loadDesigns()
  } catch (e) {
    toast.value = e.message
  }
}

/** 目录里直接「用这个建作业」：关掉目录，打开新建弹层并选中它 */
function useDesign(x) {
  lib.open = false
  openEditor('new')
  form.designId = x.id
  onDesignChange()
}

/* 代码面板里显示哪些文件：「只看改过的」勾着就只列他动过的，取消就列整份 */
const codeFiles = computed(() => {
  const changed = new Set((viewing.value && viewing.value.changed) || [])
  if (!onlyChanged.value) return subFiles.value
  const out = subFiles.value.filter((f) => changed.has(f.path))
  return out.length ? out : subFiles.value
})

/* 预览：用交上来的整份文件，选一个页面跑 */
const pages = computed(() => pagesOf(subFiles.value))
const previewNpm = computed(() => !!previewPage.value && isNpmProject(subFiles.value, previewPage.value))
const npmEntry = computed(() => {
  const f = subFiles.value.find((x) => x.path === previewPage.value)
  const m = f && /<script\b[^>]*\bsrc\s*=\s*["']([^"']*\/src\/[^"']+)["']/i.exec(f.text)
  return m ? m[1] : 'npm run dev'
})

async function runPreview() {
  if (!previewPage.value || previewNpm.value) return
  const iframe = frame.value
  if (!iframe) return
  previewBusy.value = true
  previewError.value = ''
  try {
    await ensureSfcSrcdoc()
    const dirName = (viewing.value && viewing.value.dir) || (d.value && d.value.assignment.dir) || ''
    // base 指向能真取到共享运行时的接口（vue.global.js / sfc-boot.js 在示例目录的上级）
    iframe.srcdoc = buildPreviewDoc(subFiles.value, previewPage.value, '/api/example-files/' + encodeURI(dirName) + '/')
    previewOk.value = true
  } catch (e) {
    previewError.value = '预览失败：' + e.message
    previewOk.value = false
  } finally {
    previewBusy.value = false
  }
}

function onPreviewMessage(e) {
  const m = e.data
  if (!m || !m.__pg) return
  if (e.source !== (frame.value && frame.value.contentWindow)) return
  previewError.value = m.l ? m.m + '（行 ' + m.l + '）' : m.m
}

onMounted(async () => {
  window.addEventListener('message', onPreviewMessage)
  await loadAll()
  // 学生交作业是随时发生的，老师这边靠轮询兜住（WS 只发给学生端）
  timer = setInterval(() => {
    if (document.hidden) return
    if (d.value && curId.value && !viewing.value) loadDetail(true)
  }, 8000)
})

onUnmounted(() => {
  window.removeEventListener('message', onPreviewMessage)
  if (timer) clearInterval(timer)
})

async function loadAll() {
  loading.value = true
  err.value = ''
  try {
    await loadScheme() // 等级表 / 量规维度 / 卷面满分都从方案来
    const res = await api.get('/api/assignments?itemKey=' + encodeURIComponent(props.itemKey))
    list.value = res.items || []
    dirs.value = res.dirs || []
    classes.value = res.allClasses || []
    if (!curId.value) {
      const openOne = list.value.filter((a) => a.status === 'open')
      curId.value = (openOne.length ? openOne[openOne.length - 1] : list.value[list.value.length - 1] || {}).id || ''
    }
    if (curId.value) {
      await loadDetail()
      loadProgress()
    } else {
      d.value = null
      prog.value = null
    }
  } catch (e) {
    err.value = e.message
  } finally {
    loading.value = false
  }
}

async function loadDetail(quiet) {
  if (!curId.value) return
  try {
    const q = classId.value ? '?classId=' + encodeURIComponent(classId.value) : ''
    d.value = await api.get('/api/assignments/' + encodeURIComponent(curId.value) + q)
    if (!quiet) return
  } catch (e) {
    if (!quiet) err.value = e.message
  }
}

function select(id) {
  if (curId.value === id) return
  curId.value = id
  d.value = null
  classId.value = ''
  loadDetail()
  loadProgress()
}

function setClass(id) {
  classId.value = id
  loadDetail()
}

/** 刚刚交上来的那条标个「新」，老师一眼看到有人交了 */
function fresh(iso) {
  const t = new Date(iso).getTime()
  return isFinite(t) && Date.now() - t < 120000
}

/* ---------------- 开始 / 结束 ---------------- */

async function start() {
  if (!d.value) return
  const ok = window.confirm(
    '开始「' + d.value.assignment.title + '」？\n\n学生端立刻能进入这次作业并提交，已经在学生端的学生也会自动刷新。'
  )
  if (!ok) return
  try {
    const res = await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/start')
    toast.value = res.delivered
      ? '已开始，' + res.delivered + ' 个学生端已收到通知'
      : '已开始（有学生端稍后刷新也能看到）'
    await loadAll()
  } catch (e) {
    toast.value = e.message
  }
}

async function stop() {
  if (!d.value) return
  const ok = window.confirm(
    '结束「' + d.value.assignment.title + '」？\n\n结束后学生就交不上来了（已经交的照样能看、能批）。'
  )
  if (!ok) return
  try {
    const res = await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/stop')
    toast.value = res.delivered ? '已结束，' + res.delivered + ' 个学生端已收到通知' : '已结束，停止收卷'
    await loadAll()
  } catch (e) {
    toast.value = e.message
  }
}

async function remove() {
  if (!d.value) return
  const n = d.value.stats.submissionCount
  const ok = window.confirm(
    '删除「' + d.value.assignment.title + '」？\n\n' + (n ? '连同学生交上来的 ' + n + ' 条记录一起删，删了就找不回来。' : '这份作业还没有提交记录。')
  )
  if (!ok) return
  try {
    await api.del('/api/assignments/' + encodeURIComponent(curId.value))
    curId.value = ''
    d.value = null
    toast.value = '已删除'
    await loadAll()
  } catch (e) {
    toast.value = e.message
  }
}

/* ---------------- 新建 / 修改 ---------------- */

function dirTitleOf(dir) {
  const x = dirs.value.find((y) => y.dir === dir)
  return x ? x.title : ''
}

/** 标题还是「跟着目录自动填的」那个，换课时就跟着换；老师手动改过就不动了 */
let lastAutoTitle = ''

function onDirChange() {
  const t = dirTitleOf(form.dir)
  if (!form.title || form.title === lastAutoTitle) {
    form.title = t
    lastAutoTitle = t
  }
}

function openEditor(mode) {
  editing.value = mode
  if (mode === 'new') {
    loadDesigns()
    form.designId = ''
    form.dir = ''
    form.title = ''
    lastAutoTitle = ''
    form.note = ''
    form.weight = 1
    form.dueAt = ''
    form.allowLate = true
  } else if (d.value) {
    form.dir = d.value.assignment.dir
    form.title = d.value.assignment.title
    form.note = d.value.assignment.note || ''
    form.weight = d.value.assignment.weight === undefined ? 1 : Number(d.value.assignment.weight) || 1
    form.dueAt = d.value.assignment.dueAt ? toLocalInput(d.value.assignment.dueAt) : ''
    form.allowLate = d.value.assignment.allowLate !== false
  }
}

async function saveEditor() {
  saving.value = true
  try {
    const dueIso = form.dueAt ? new Date(form.dueAt).toISOString() : ''
    const body = {
      itemKey: props.itemKey,
      title: form.title,
      note: form.note,
      weight: form.weight,
      dueAt: dueIso,
      allowLate: !!form.allowLate,
    }
    if (editing.value === 'new') body.designId = form.designId || ''
    if (editing.value === 'new') {
      const res = await api.post('/api/assignments', body)
      curId.value = res.assignment.id
      toast.value = '建好了，记得点「开始收」学生才交得上'
    } else {
      await api.patch('/api/assignments/' + encodeURIComponent(curId.value), body)
      toast.value = '已保存'
    }
    editing.value = ''
    await loadAll()
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}

/* ---------------- 审阅 + 打分 ---------------- */

async function review(s) {
  reviewIdx.value = d.value.submissions.findIndex((x) => x.id === s.id)
  viewing.value = s
  grade.grade = s.grade || ''
  grade.late = !!s.late
  grade.raw = s.raw === null || s.raw === undefined ? '' : String(s.raw)
  grade.dims = Object.assign({}, s.dims || {})
  grade.comment = s.comment || ''
  await loadSubmission(s)
}

function step(dir) {
  const next = d.value.submissions[reviewIdx.value + dir]
  if (next) review(next)
}

function closeReview() {
  viewing.value = null
  subFiles.value = []
  previewPage.value = ''
  previewError.value = ''
  previewOk.value = false
}

async function loadSubmission(s) {
  loadingFiles.value = true
  subFiles.value = []
  previewPage.value = ''
  previewError.value = ''
  previewOk.value = false
  try {
    const res = await api.get(
      '/api/assignments/' + encodeURIComponent(curId.value) + '/submissions/' + encodeURIComponent(s.id)
    )
    subFiles.value = res.files || []
    // 默认跑 index.html；没有就第一页。学生交的是整份，不用再回去拿原始示例
    const list = pagesOf(subFiles.value)
    previewPage.value = list.find((p) => /^index\.html?$/i.test(p)) || list[0] || ''
  } catch (e) {
    toast.value = e.message
  } finally {
    loadingFiles.value = false
    // iframe 是 v-else 才渲染的，等它上屏之后再灌 srcdoc
    await nextTick()
    if (viewing.value && previewPage.value) runPreview()
  }
}

async function saveGrade() {
  if (!viewing.value) return
  saving.value = true
  try {
    const res = await api.post(
      '/api/assignments/' + encodeURIComponent(curId.value) +
        '/submissions/' + encodeURIComponent(viewing.value.id) + '/grade',
      { grade: grade.grade, late: grade.late, raw: grade.raw, dims: grade.dims, comment: grade.comment }
    )
    // 就地把列表里的那行改掉，不重新拉整页，免得打断「下一条」的节奏
    const i = d.value.submissions.findIndex((x) => x.id === viewing.value.id)
    if (i >= 0) d.value.submissions[i] = res.submission
    d.value.stats.gradedCount = d.value.submissions.filter((x) => x.score !== null).length
    toast.value = '已保存'
    if (reviewIdx.value < d.value.submissions.length - 1) step(1)
    else closeReview()
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}

/** 打回重做：清分 + 作废计分记录，学生就能再交 */
async function redo() {
  if (!viewing.value) return
  if (!window.confirm('打回「' + (viewing.value.name || '这位同学') + '」的这次提交？\n\n分数与评语会清空、计分记录作废，学生可以重新提交。')) return
  saving.value = true
  try {
    const res = await api.post(
      '/api/assignments/' + encodeURIComponent(curId.value) +
        '/submissions/' + encodeURIComponent(viewing.value.id) + '/redo'
    )
    const i = d.value.submissions.findIndex((x) => x.id === viewing.value.id)
    if (i >= 0) d.value.submissions[i] = res.submission
    viewing.value = res.submission
    d.value.stats.gradedCount = d.value.submissions.filter((x) => x.score !== null).length
    toast.value = res.message || '已打回'
    loadProgress()
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}

async function clearGrade() {
  if (!viewing.value) return
  grade.grade = ''
  grade.late = false
  grade.raw = ''
  grade.dims = {}
  saving.value = true
  try {
    const res = await api.post(
      '/api/assignments/' + encodeURIComponent(curId.value) +
        '/submissions/' + encodeURIComponent(viewing.value.id) + '/grade',
      { grade: '', late: false, raw: '', dims: '', comment: grade.comment }
    )
    const i = d.value.submissions.findIndex((x) => x.id === viewing.value.id)
    if (i >= 0) d.value.submissions[i] = res.submission
    viewing.value = res.submission
    toast.value = '已清掉分数'
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
/* 批阅进度条（已交 / 已批 / 未交） */
.progbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 2px 0 8px;
  font-size: 12.5px;
  color: #40505f;
}

.pb-k {
  color: #6b7a88;
}

.pb-sep {
  width: 1px;
  height: 12px;
  background: var(--line);
  margin: 0 4px;
}

.pb-warn {
  color: #b4740f;
}

.pb-miss {
  flex-basis: 100%;
  line-height: 1.6;
}

/* 作业目录里的每一行 */
.lib-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  margin-bottom: 6px;
  background: #fff;
}

.lib-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.lib-acts {
  display: flex;
  gap: 4px;
  flex: 0 0 auto;
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

.linkish:hover {
  text-decoration: underline;
}

.wtip {
  margin-left: 6px;
  color: #1d4ed8;
  font-style: normal;
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
  gap: 6px;
}

.hwpill .cnt {
  padding: 0 5px;
  border-radius: 8px;
  background: #eef1f3;
  color: #5a6570;
  font-size: 11.5px;
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

.ctrl-l {
  min-width: 0;
}

.ctrl-l h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 15.5px;
}

.ctrl-l p {
  margin: 2px 0;
  font-size: 12.5px;
}

.ctrl-r {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.st {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stn {
  font-size: 21px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

.stn.ok {
  color: var(--ok);
}

.stn.warn {
  color: var(--warn);
}

.stn.err {
  color: var(--err);
}

.stl {
  font-size: 12px;
  color: var(--dim);
}

.cmt {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.miss {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px;
}

.missi {
  padding: 2px 8px;
  border-radius: 3px;
  background: #fbf4e9;
  border: 1px solid #dfcba8;
  color: #7a5a20;
  font-size: 12.5px;
}

.missi em {
  font-style: normal;
  margin-left: 5px;
  color: #a08a5e;
  font-size: 11.5px;
}

/* 审阅弹层比常规 wide 更宽：左边代码 + 右边渲染，两侧都得看得清 */
.modal.xwide {
  max-width: min(1480px, 96vw);
  max-height: 92vh;
}

/* 审阅：左代码 / 右渲染，下面一行说明 */
.review {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(360px, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 10px;
  height: min(68vh, 660px);
  overflow: hidden;
}

.rev-code {
  min-width: 0;
  min-height: 0;
}

/* 文件列表挤一点，把宽度让给代码 */
.rev-code :deep(.cv) {
  grid-template-columns: 158px minmax(0, 1fr);
}

.rev-run {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  overflow: hidden;
  background: #fff;
}

.rev-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line-soft);
  background: #fbfcff;
}

.rev-head .select {
  padding: 4px 8px;
  font-size: 12.5px;
  max-width: 62%;
}

.rev-frame {
  flex: 1;
  width: 100%;
  border: none;
  background: #fff;
  min-height: 0;
}

.npmnote {
  flex: 1;
  padding: 16px 14px;
  font-size: 12.5px;
  line-height: 1.75;
  color: #92400e;
  background: #fffdf7;
  overflow: auto;
}

.rev-note {
  margin: 0;
  padding: 5px 8px;
  border-top: 1px solid var(--line-soft);
  background: #fbfcff;
}

.perr {
  border-top: 1px solid #fecaca;
  background: #fef2f2;
  color: #b91c1c;
  padding: 6px 28px 6px 8px;
  font: 11.5px/1.55 Consolas, monospace;
  white-space: pre-wrap;
  max-height: 92px;
  overflow: auto;
  position: relative;
}

.perr b {
  margin-right: 5px;
}

.perr-x {
  position: absolute;
  top: 2px;
  right: 4px;
  border: none;
  background: none;
  color: #b91c1c;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}

.filenote {
  margin: 0;
  grid-column: 1 / -1;
}

.grade {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

/* 等级 + 迟交占一整行，评语和按钮在下一行 */
.gline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
  padding-bottom: 2px;
  border-bottom: 1px dashed var(--line-soft);
  margin-bottom: 2px;
}

.field.inline {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: #4a525a;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.check.mini {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--dim);
}
</style>
