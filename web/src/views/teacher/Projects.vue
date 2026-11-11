<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>{{ moduleTitle }}</template>
        <template #sub>课程项目：布置 → 开始收 → 学生交说明 / 链接 / 附件（落在学生自己的目录里）→ 逐个批阅打分</template>
        <template #right>
          <button class="btn mini" :disabled="loading" @click="loadAll">刷新</button>
          <button class="btn mini" @click="openLib" title="大作业设计目录：题目与附件要求都在这里">作业目录</button>
          <button class="btn primary" @click="openEditor('new')">＋ 新建大作业</button>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>

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
      <span class="dim">{{ a.status === 'open' ? '收作业中' : a.started ? '已截止' : '未开始' }}</span>
      <span class="cnt">{{ a.studentCount }}</span>
    </button>
    <span v-if="!list.length && !loading" class="dim" style="font-size: 13px">
      还没布置大作业，点右上角「新建大作业」。
    </span>
    </div>

    <template v-if="d">
    <div class="card ctrl">
      <div class="ctrl-l">
        <h3>
          {{ d.assignment.title }}
          <span class="tag" :class="d.assignment.status === 'open' ? 'ok' : d.assignment.started ? 'mute' : 'warn'">
            {{ d.assignment.status === 'open' ? '收作业中' : d.assignment.started ? '已截止' : '未开始' }}
          </span>
        </h3>
        <p class="dim mini">{{ d.assignment.note || '（没写要求）' }}</p>
        <p class="mini dim">
          <span v-if="d.assignment.openedAt">开始于 {{ when(d.assignment.openedAt) }}</span>
          <span v-else>还没开始收，学生端是灰的</span>
          <span v-if="d.assignment.closedAt"> · 截止于 {{ when(d.assignment.closedAt) }}</span>
        </p>
      </div>
      <div class="ctrl-r">
        <button v-if="d.assignment.status !== 'open'" class="btn primary" @click="start">▶ 开始收</button>
        <button v-else class="btn danger" @click="stop">■ 截止（停止提交）</button>
        <button class="btn mini" @click="openEditor('edit')">改标题 / 要求</button>
        <button class="btn mini danger" @click="remove">删除</button>
      </div>
    </div>

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
      {{ d.assignment.status === 'open' ? '还没有人交，等一会儿再看。' : '这次大作业没有提交记录。' }}
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
      <template #cell-note="{ row }">{{ row.note || (row.url ? '（有链接）' : '—') }}</template>
      <template #cell-score="{ row }">
        <span :class="{ ok: row.graded }">{{ !row.graded ? '—' : row.score }}</span>
      </template>
      <template #cell-actions="{ row }">
        <button class="btn mini" @click.stop="review(row)">看提交 / 打分</button>
      </template>
    </DataTable>
    </div>

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
    {{ list.length ? '选一次大作业看提交' : '还没布置大作业。点「新建大作业」，写清要求再开始收。' }}
    </div>


    <!-- 批阅 -->
    <div v-if="viewing" class="mask" @click.self="closeReview">
    <div class="modal wide">
    <div class="modal-head">
      <h3>
        {{ viewing.name }} <span class="dim mono">{{ viewing.sid }}</span>
        <span class="tag" style="margin-left: 6px">{{ when(viewing.createdAt) }}</span>
      </h3>
      <div class="right">
        <button class="btn mini" :disabled="reviewIdx <= 0" @click="step(-1)">↑ 上一条</button>
        <button class="btn mini" :disabled="reviewIdx >= d.submissions.length - 1" @click="step(1)">↓ 下一条</button>
        <button class="btn mini" @click="closeReview">×</button>
      </div>
    </div>

    <div class="modal-body rev">
      <div class="who">
        <p class="dim mini">{{ viewing.className }} · 第 {{ reviewIdx + 1 }} 条 / 共 {{ d.submissions.length }} 条</p>
        <h4>说明</h4>
        <p v-if="viewing.note" class="note">{{ viewing.note }}</p>
        <p v-else class="dim">（没写说明）</p>

        <h4>链接</h4>
        <p v-if="viewing.url" class="url">
          <a :href="viewing.url" target="_blank" rel="noopener noreferrer">{{ viewing.url }}</a>
        </p>
        <p v-else class="dim">（没给链接）</p>

        <h4>
          附件（{{ viewing.fileCount }}）
          <button v-if="viewing.files.length > 1" class="btn mini" style="margin-left: 8px" @click="grabAll(viewing)">
            ⤓ 全部下载
          </button>
        </h4>
        <ul v-if="viewing.files.length" class="files">
          <li v-for="f in viewing.files" :key="f">
            <span class="ellip">{{ f }}</span>
            <button class="btn mini" @click="grab(viewing, f)">下载</button>
          </li>
        </ul>
        <p v-else class="dim">（没传附件）</p>

        <h4>评分证据（老师侧，学生看不到）</h4>
        <ul v-if="viewing.evidence && viewing.evidence.length" class="files">
          <li v-for="f in viewing.evidence" :key="f.name">
            <span class="ellip">{{ f.name }}</span>
            <button class="btn mini" @click="openEvidence(f)">下载</button>
            <button class="btn mini danger" @click="delEvidence(f)">删除</button>
          </li>
        </ul>
        <p v-else class="dim">（还没有证据）</p>
        <div class="row" style="margin-top: 6px">
          <button class="btn mini" :disabled="!viewing || !viewing.graded" @click="evPick.click()">
            ＋ 上传证据
          </button>
          <input ref="evPick" type="file" multiple style="display: none" @change="uploadEvidence" />
          <span class="dim mini">
            {{ viewing && !viewing.graded
              ? '先给分，再传证据（证据挂在这次评分上）'
              : '截图 / 抽查记录 / 查重结果，单个 ≤6MB；只存老师侧，学生看不到' }}
          </span>
        </div>
      </div>

      <div class="gradebox">
        <p v-if="d && d.assignment && d.assignment.status === 'open'" class="hint" style="margin: 0 0 8px">
          还在收作业。一般等「结束提交」后再批 —— 批过之后学生再交会被拦下（要重做请点「打回重做」）。
        </p>
        <!-- 打什么控件由这一项的规则决定（量规 / 卷面分 / 等级） -->
        <GradeBox v-if="moduleItem" :item="moduleItem" :model-value="grade" />
        <textarea v-model="grade.comment" class="textarea" rows="5" maxlength="1000" placeholder="评语（学生看得到）"></textarea>
        <p class="dim mini">
          批完就记进「{{ moduleItem ? moduleItem.name : '大作业' }}」这一项（{{ moduleItem ? moduleItem.full : 30 }} 分），
          改判会先撤掉上一次那条账，不会重复计。
        </p>
        <span class="spacer"></span>
        <div class="gfoot">
          <span v-if="viewing.graded" class="dim mini">上次：{{ viewing.score }} 分</span>
          <button class="btn line" :disabled="saving" @click="clearGrade">清掉分数</button>
          <button class="btn line" :disabled="saving" title="分数与评语清空、计分记录作废，学生可以重新交" @click="redo">
            打回重做
          </button>
          <button class="btn primary" :disabled="saving" @click="saveGrade">
            {{ saving ? '保存中…' : '保存并下一条' }}
          </button>
        </div>
      </div>
    </div>
    </div>
    </div>

    <!-- 作业目录 -->
    <div v-if="lib.open" class="mask" @click.self="lib.open = false">
      <div class="modal wide">
        <div class="modal-head">
          <h3>作业目录 · {{ moduleTitle }}</h3>
          <button class="btn mini" style="margin-left: auto" @click="lib.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="row" style="margin-bottom: 10px">
            <button class="btn mini" @click="libPick2.click()" :disabled="lib.busy">⤒ 上传设计包</button>
            <input ref="libPick2" type="file" accept=".zip" style="display: none" @change="onDesignUpload" />
            <button class="btn mini" :disabled="lib.busy" @click="downloadTpl">⤓ 下载模板</button>
            <span class="dim mini">设计包就是一个 <code>project.json</code>（题目 + 要不要链接 + 收哪些附件类型）</span>
          </div>
          <p v-if="lib.err" class="hint err">{{ lib.err }}</p>
          <p v-if="!designs.length" class="dim mini">还没有设计。上传一个设计包，或新建时直接手填题目。</p>
          <div v-for="x in designs" :key="x.id" class="lib-row">
            <div class="lib-main">
              <b>{{ x.title }}</b>
              <span class="dim mini">
                收 {{ (x.attachments && x.attachments.length ? x.attachments : ['zip','pdf','md','png','mp4','pptx']).map((e) => '.' + e).join(' ') }}
                <template v-if="x.requireUrl"> · 必须填链接</template>
                <template v-if="!x.requireFile"> · 附件可选</template>
              </span>
            </div>
            <div class="lib-acts">
              <button class="btn mini" @click="useDesign(x)">用这个建大作业</button>
              <button class="btn mini" @click="exportDesign(x)">导出</button>
              <button class="btn mini danger" @click="removeDesign(x)">删除</button>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <span class="dim mini">删设计不影响已经建出来的作业</span>
          <span class="spacer"></span>
          <button class="btn" @click="lib.open = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- 新建 / 修改 -->
    <div v-if="editing" class="mask" @click.self="editing = ''">
    <div class="modal">
    <div class="modal-head">
      <h3>{{ editing === 'new' ? '新建大作业' : '修改大作业' }}</h3>
      <button class="btn mini" @click="editing = ''">×</button>
    </div>
    <div class="modal-body form">
      <label class="field">
        <span>
          作业设计（题目与附件要求从这儿来）
          <em class="mini wtip">大作业没有代码，只有题目 + 学生交的附件</em>
        </span>
        <div class="row">
          <select v-if="editing === 'new'" v-model="form.designId" class="select" @change="onDesignChange">
            <option value="">不选（直接手填题目）</option>
            <option v-for="x in designs" :key="x.id" :value="x.id">{{ x.title }}</option>
          </select>
          <span v-else class="dim mini">修改不会动已有的提交</span>
          <button v-if="editing === 'new'" class="btn mini" :disabled="saving" @click="libPick.click()">上传设计包…</button>
          <input ref="libPick" type="file" accept=".zip" style="display: none" @change="onDesignUpload" />
        </div>
      </label>
      <label class="field">
        <span>标题</span>
        <input v-model="form.title" class="input" maxlength="60" placeholder="期末大作业：个人作品" />
      </label>
      <label class="field">
        <span>要求（学生端显示这段，写清要做到什么、怎么交）</span>
        <textarea v-model="form.note" class="textarea" rows="6" maxlength="500" placeholder="例如：用 Vue3 做一个至少 3 个页面的小项目，交源码包 + 部署地址 + 一页说明。"></textarea>
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
      <p class="dim mini">新建的大作业一律是「未开始」，等你在上面点「开始收」学生才交得上。</p>
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
 * 教师端「大作业」
 *
 * 跟「课堂作业」共用 assignments / submissions 两张表（kind=project），但流程不一样：
 *   课堂作业是「改某一课的代码」→ 老师看代码 + 跑渲染；
 *   大作业是「交自己的项目材料」→ 老师看说明 / 链接 / 附件，按 30 分制打个分。
 * 所以分成两个页面，互不干扰（也不共用一份 800 行的组件）。
 *
 * 边界：这里的分只是这条提交的批阅结果，**不会自动写进计分表**；
 * 要算进总评，仍去计分页按量规（功能/代码/界面/文档）落一笔 —— 跟点名一样，批阅不改账。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { api, download, getCourse, getToken } from '../../api'
import GradeBox from '../../components/GradeBox.vue'
import { loadScheme, scheme } from '../../utils/scheme'
import Toast from '../../components/Toast.vue'
import { clock, when } from '../../utils/time'
import PageHead from '../../components/PageHead.vue'
import DataTable from '../../components/DataTable.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'

/* 哪个考核项的模块：由路由 /teacher/modules/:itemKey 传进来 */
const props = defineProps({
  itemKey: { type: String, default: 'project' },
})

const moduleItem = computed(() => scheme.items.find((i) => i.key === props.itemKey) || null)
const moduleTitle = computed(() => (moduleItem.value ? moduleItem.value.name : '大作业'))

const list = ref([])
const classes = ref([])
const curId = ref('')
const d = ref(null)
const classId = ref('')
const err = ref('')
const toast = ref('')

/* 提交记录表 */
const subCols = [
  { key: 'no', label: '#', num: true, width: '46px' },
  { key: 'when', label: '提交时间', hint: '先交的在前' },
  { key: 'sid', label: '学号', tdClass: 'mono' },
  { key: 'name', label: '姓名' },
  { key: 'className', label: '班级', tdClass: 'dim' },
  { key: 'fileCount', label: '附件', num: true },
  { key: 'note', label: '说明', tdClass: 'cmt dim' },
  { key: 'score', label: '分数', num: true },
  { key: 'actions', label: '', width: '132px' },
]
const loading = ref(false)
const saving = ref(false)
const busyEv = ref(false)
let timer = null

const viewing = ref(null)
const reviewIdx = ref(-1)
// 打分的三种载体（量规 / 等级 / 卷面），GradeBox 按规则各取所需
const grade = reactive({ dims: {}, grade: '', late: false, raw: '', comment: '' })

const editing = ref('')
const form = reactive({ designId: '', dueAt: '', allowLate: true, title: '', note: '' })

/* ---------------- 作业目录（大作业设计） ---------------- */
const designs = ref([])
const libPick = ref(null)
const libPick2 = ref(null)
const lib = reactive({ open: false, busy: false, err: '' })

/* ---------------- 批阅进度 ---------------- */
const prog = ref(null)
const showMissing = ref(false)
const missingText = computed(() => (prog.value ? prog.value.missing.map((m) => m.name).join('、') : ''))

async function loadDesigns() {
  try {
    const r = await api.get('/api/courses/' + encodeURIComponent(getCourse()) + '/designs?kind=project')
    /* 接口返回 { courseId, kind, items }；原来读 r.project 永远是 undefined，
     * 同样表现为「上传成功但列表空、下拉选不出来」。详见 Assignments.vue 同一处。 */
    designs.value = r.items || r.project || []
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

function onDesignChange() {
  const x = designs.value.find((d) => d.id === form.designId)
  if (!x) return
  if (!form.title) form.title = x.title
  if (!form.note) form.note = x.note || ''
}

function toLocalInput(iso) {
  const d = new Date(iso)
  if (!isFinite(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes())
}

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
      '/api/courses/' + encodeURIComponent(getCourse()) + '/designs/import?kind=project',
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
  download('/api/courses/' + encodeURIComponent(getCourse()) + '/designs/template.zip?kind=project', 'project-design-template.zip')
  toast.value = '模板已下载：改完压缩成 zip 再上传'
}

function exportDesign(x) {
  download(
    '/api/courses/' + encodeURIComponent(getCourse()) + '/designs/' + encodeURIComponent(x.id) + '/zip?kind=project',
    'project-' + x.id + '.zip'
  )
}

async function removeDesign(x) {
  if (!window.confirm('从作业目录里删掉「' + x.title + '」？\n\n已经建出来的作业不受影响。')) return
  try {
    await api.del('/api/courses/' + encodeURIComponent(getCourse()) + '/designs/' + encodeURIComponent(x.id) + '?kind=project')
    toast.value = '已从目录删除'
    await loadDesigns()
  } catch (e) {
    toast.value = e.message
  }
}

function useDesign(x) {
  lib.open = false
  openEditor('new')
  form.designId = x.id
  onDesignChange()
}

onMounted(async () => {
  await loadAll()
  timer = setInterval(() => {
    if (document.hidden) return
    if (d.value && curId.value && !viewing.value) loadDetail(true)
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

function fresh(iso) {
  const t = new Date(iso).getTime()
  return isFinite(t) && Date.now() - t < 120000
}

/* ---------------- 开始 / 截止 / 删除 ---------------- */

async function start() {
  if (!d.value) return
  if (!window.confirm('开始收「' + d.value.assignment.title + '」？\n\n学生端立刻能提交，已经开着的学生端会自动刷新。')) return
  try {
    const res = await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/start')
    toast.value = res.delivered ? '已开始，' + res.delivered + ' 个学生端已收到通知' : '已开始'
    await loadAll()
  } catch (e) {
    toast.value = e.message
  }
}

async function stop() {
  if (!d.value) return
  if (!window.confirm('截止「' + d.value.assignment.title + '」？\n\n截止后学生交不上来（已交的照样能看、能批）。')) return
  try {
    const res = await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/stop')
    toast.value = res.delivered ? '已截止，' + res.delivered + ' 个学生端已收到通知' : '已截止，停止提交'
    await loadAll()
  } catch (e) {
    toast.value = e.message
  }
}

async function remove() {
  if (!d.value) return
  const n = d.value.stats.submissionCount
  const ok = window.confirm(
    '删除「' + d.value.assignment.title + '」？\n\n' +
      (n ? '连同 ' + n + ' 条提交（含学生交上来的附件）一起删，删了就找不回来。' : '这次大作业还没有提交记录。')
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

function openEditor(mode) {
  editing.value = mode
  if (mode === 'new') {
    loadDesigns()
    form.designId = ''
    form.title = '期末大作业'
    form.note = ''
    form.dueAt = ''
    form.allowLate = true
  } else if (d.value) {
    form.title = d.value.assignment.title
    form.note = d.value.assignment.note || ''
    form.dueAt = d.value.assignment.dueAt ? toLocalInput(d.value.assignment.dueAt) : ''
    form.allowLate = d.value.assignment.allowLate !== false
  }
}

async function saveEditor() {
  saving.value = true
  try {
    const dueIso = form.dueAt ? new Date(form.dueAt).toISOString() : ''
    const body = { title: form.title, note: form.note, dueAt: dueIso, allowLate: !!form.allowLate }
    if (editing.value === 'new') {
      body.itemKey = props.itemKey
      body.designId = form.designId || ''
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

/* ---------------- 批阅 ---------------- */

function review(s) {
  reviewIdx.value = d.value.submissions.findIndex((x) => x.id === s.id)
  viewing.value = s
  grade.dims = Object.assign({}, s.dims || {})
  grade.grade = s.grade || ''
  grade.late = !!s.late
  grade.raw = s.raw === null || s.raw === undefined ? '' : String(s.raw)
  grade.comment = s.comment || ''
}

function step(dir) {
  const next = d.value.submissions[reviewIdx.value + dir]
  if (next) review(next)
}

function closeReview() {
  viewing.value = null
}

async function saveGrade() {
  if (!viewing.value) return
  saving.value = true
  try {
    const res = await api.post(
      '/api/assignments/' + encodeURIComponent(curId.value) +
        '/submissions/' + encodeURIComponent(viewing.value.id) + '/grade',
      { dims: grade.dims, grade: grade.grade, late: grade.late, raw: grade.raw, comment: grade.comment }
    )
    const i = d.value.submissions.findIndex((x) => x.id === viewing.value.id)
    if (i >= 0) d.value.submissions[i] = res.submission
    d.value.stats.gradedCount = d.value.submissions.filter((x) => x.graded).length
    toast.value = '已保存'
    if (reviewIdx.value < d.value.submissions.length - 1) step(1)
    else closeReview()
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}

/** 打回重做：清分 + 作废计分记录，学生就能重新交 */
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
    d.value.stats.gradedCount = d.value.submissions.filter((x) => x.graded).length
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
  grade.dims = {}
  grade.grade = ''
  grade.late = false
  grade.raw = ''
  saving.value = true
  try {
    const res = await api.post(
      '/api/assignments/' + encodeURIComponent(curId.value) +
        '/submissions/' + encodeURIComponent(viewing.value.id) + '/grade',
      { dims: '', grade: '', raw: '', comment: grade.comment }
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

/* ---------------- 评分证据 ---------------- */
const evPick = ref(null)

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result || ''))
    r.onerror = () => reject(new Error('读取失败：' + file.name))
    r.readAsDataURL(file)
  })
}

async function uploadEvidence(e) {
  const files = Array.from((e.target.files || []))
  e.target.value = ''
  if (!files.length || !viewing.value) return
  busyEv.value = true
  try {
    for (const f of files) {
      const dataUrl = await readAsDataUrl(f)
      const res = await api.post(
        '/api/assignments/' + encodeURIComponent(curId.value) +
          '/submissions/' + encodeURIComponent(viewing.value.id) + '/evidence',
        { name: f.name, dataUrl }
      )
      const i = d.value.submissions.findIndex((x) => x.id === viewing.value.id)
      if (i >= 0) d.value.submissions[i] = res.submission
      viewing.value = res.submission
    }
    // 证据清单是派生表（xlsx），给分后由数据层钩子自动重写
    toast.value = '证据已保存（同时更新该学生的 大作业/证据清单.xlsx）'
  } catch (err) {
    toast.value = err.message
  } finally {
    busyEv.value = false
  }
}

function openEvidence(f) {
  if (f && f.url) download(f.url, f.name)
}

async function delEvidence(f) {
  if (!viewing.value) return
  if (!window.confirm('删掉这条评分证据？\n\n' + (f.name || ''))) return
  busyEv.value = true
  try {
    const res = await api.del(
      '/api/assignments/' + encodeURIComponent(curId.value) +
        '/submissions/' + encodeURIComponent(viewing.value.id) + '/evidence?name=' + encodeURIComponent(f.name)
    )
    const i = d.value.submissions.findIndex((x) => x.id === viewing.value.id)
    if (i >= 0) d.value.submissions[i] = res.submission
    viewing.value = res.submission
    toast.value = '已删除（文件移进 data/.trash/evidence/，可捞回）'
  } catch (err) {
    toast.value = err.message
  } finally {
    busyEv.value = false
  }
}

/** 一次把这份提交的附件都下一遍（浏览器会连着弹几个下载，稍等几秒） */
async function grabAll(s) {
  for (let i = 0; i < s.files.length; i++) {
    grab(s, s.files[i])
    await new Promise((r) => setTimeout(r, 400)) // 别让浏览器把并发下载掐掉
  }
}

/** 下载学生附件（带令牌，所以走 fetch + blob） */
function grab(s, name) {
  download(
    // 第二段是**学号**（后端按 students 目录找文件），不是提交记录 id —— 原来传 s.id 一律 404
    '/api/files/assignments/' + encodeURIComponent(curId.value) + '/' + encodeURIComponent(s.sid) + '/' + encodeURIComponent(name)
  )
}
</script>

<style scoped>
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
  white-space: pre-wrap;
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
  max-width: 300px;
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

/* 批阅弹层：左看材料 / 右打分 */
.rev {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(320px, 1fr);
  gap: 16px;
  height: min(62vh, 560px);
}

.who {
  min-width: 0;
  overflow: auto;
  padding-right: 4px;
}

.who h4 {
  margin: 12px 0 4px;
  font-size: 13px;
  color: #4a525a;
}

.who h4:first-of-type {
  margin-top: 6px;
}

.note {
  margin: 0;
  font-size: 13px;
  line-height: 1.75;
  white-space: pre-wrap;
  color: #3b434b;
}

.url {
  margin: 0;
  font-size: 12.5px;
  word-break: break-all;
}

.gradebox {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  border-left: 1px solid var(--line-soft);
  padding-left: 14px;
}

.dims {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.drow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: #4a525a;
}

.drow span {
  width: 78px;
  flex: 0 0 78px;
}

.drow input {
  width: 74px;
  padding: 4px 8px;
  font-size: 12.5px;
}

.dtotal {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: #4a525a;
}

.dtotal b {
  font-size: 15px;
  color: var(--ink);
}

.gfoot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
  justify-content: flex-end;
}

.field.inline {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: #4a525a;
}

.files {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.files li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: 1px solid var(--line-soft);
  border-radius: 3px;
  background: #fbfcff;
  font-size: 12.5px;
}

.ellip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
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
