<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>考勤点名</template>
        <template #sub>点一下就存：网格点格子循环，列表点行内按钮；只记异常，回到「出勤」= 撤销。
          随机点名可随机 / 顺序，也能按状态筛；抽到谁，学生端会同步弹大字提示。</template>
        <template #right>
          <span class="tag mute" v-if="full">{{ itemName }} · 满分 {{ full }}</span>
          <button class="btn mini" :disabled="loading" @click="reload">刷新</button>
        </template>
      </PageHead>
    </template>
    <p v-if="error" class="hint err">{{ error }}</p>

    <div class="card bar">
      <div class="classes">
        <button v-for="c in classes" :key="c.id" class="pill" :class="{ on: c.id === activeId }" @click="pick(c.id)">
          {{ c.name }}<span class="dim"> {{ c.count }} 人</span>
        </button>
        <span v-if="!classes.length" class="dim">还没有班级，先去「班级管理」建一个。</span>
      </div>
      <div class="tools">
        <label class="field inline">
          <span>日期</span>
          <input v-model="day" type="date" class="input" @change="reload" />
        </label>
        <label class="field inline">
          <span>节次</span>
          <select v-model="slot" class="select" style="width: 116px" @change="reload">
            <option v-for="x in slotOptions" :key="x" :value="x">{{ x }}</option>
          </select>
        </label>
        <div class="seg">
          <button class="segbtn" :class="{ on: view === 'grid' }" @click="view = 'grid'">网格</button>
          <button class="segbtn" :class="{ on: view === 'list' }" @click="view = 'list'">列表</button>
        </div>
        <label class="field inline">
          <span>排序</span>
          <select v-model="sortBy" class="select" style="width: 122px">
            <option value="sid">学号</option>
            <option value="online">在线优先</option>
            <option value="status">异常优先</option>
            <option value="score">考勤分低优先</option>
          </select>
        </label>
        <button class="btn mini" :disabled="!students.length" title="随机抽一个人，当场判考勤" @click="openDraw">
          随机点名
        </button>
        <button class="btn mini danger" :disabled="!abnormalCount" @click="clearSlot">
          清空本节异常（{{ abnormalCount }}）
        </button>
      </div>
    </div>

    <div class="card stats">
      <span v-for="k in kinds" :key="k.kind" class="stat" :class="'k-' + k.kind">
        {{ k.kind }} <b>{{ countOf(k.kind) }}</b>
        <em v-if="k.delta">（{{ k.delta }} 分/次）</em>
      </span>
      <span class="online"><i class="live"></i>在线 <b>{{ onlineCount }}</b> / {{ students.length }}</span>
      <span class="spacer"></span>
      <span class="slotchips">
        <button
        v-for="x in slotStats"
        :key="x.slot"
        class="slotchip"
        :class="{ on: x.slot === slot }"
        @click="switchSlot(x.slot)"
        >
        {{ x.slot }} · {{ x.count }}
      </button>
      <span v-if="!slotStats.length" class="dim mini">今天这一节还没有记录</span>
    </span>
    </div>

    <div v-if="!students.length && !loading" class="card empty">这个班还没有名单，先去「班级管理」导入。</div>

    <!-- 网格 -->
    <div v-show="view === 'grid' && students.length" class="roster">
    <button
    v-for="s in sorted"
    :key="s.sid"
    class="stu"
    :class="['st-' + kindOf(s.sid), { saving: busySet.has(s.sid) }]"
    title="点一下切换：出勤 → 迟到 → 缺勤 → 请假 → 早退（点回出勤 = 撤销这条）"
    @click="cycle(s.sid)"
    >
    <b>
      <i class="dot" :class="{ on: s.online }"></i>
      {{ s.name }}
    </b>
    <span class="sid">{{ s.sid }}</span>
    <span class="mark">{{ kindOf(s.sid) }}</span>
    <span class="score">{{ scoreOf(s.sid) }} / {{ full }}</span>
    </button>
    </div>

    <!-- 列表 -->
    <div v-show="view === 'list' && students.length" class="card">
    <DataTable
      :columns="listCols"
      :rows="sorted"
      row-key="sid"
      :row-class="(row) => ['st-' + kindOf(row.sid), { saving: busySet.has(row.sid) }]"
      :empty="'这个班还没有名单。'"
    >
      <template #cell-sid="{ row }"><span class="sid">{{ row.sid }}</span></template>
      <template #cell-online="{ row }"><i class="dot" :class="{ on: row.online }"></i></template>
      <template #cell-score="{ row }"><span class="score">{{ scoreOf(row.sid) }}</span></template>
      <template #cell-actions="{ row }">
        <button
          v-for="k in kinds"
          :key="k.kind"
          class="kbtn"
          :class="[{ on: kindOf(row.sid) === k.kind }, 'k-' + k.kind]"
          :disabled="busySet.has(row.sid)"
          @click="mark(row.sid, k.kind)"
        >
          {{ k.kind }}
        </button>
      </template>
    </DataTable>
    </div>

    <p class="dim mini" style="margin-top: 10px">
    网格：点格子循环（{{ kinds.map((k) => k.kind).join(' → ') }} → 回「出勤」）。列表：点行内按钮直接落库、再点同一状态可取消。
    记录都能在「班级管理 → 全班流水」里看到。排序只改显示顺序（学号 / 在线优先 / 异常优先 / 考勤分低优先），标记不会丢。
    </p>


    <!-- 随机点名：抽一个人，当场判考勤（判完自动抽下一个） -->
    <div v-if="drawing" class="mask" @click.self="closeDraw">
      <div class="modal drawbox">
        <div class="modal-head">
          <h3>
            点名核对 <span class="dim">{{ slot }} · {{ day }} · 学生端同步显示</span>
          </h3>
          <button class="btn mini" style="margin-left: auto" title="收起学生端点名提示，本轮进度保留" @click="closeDraw">
            结束点名
          </button>
        </div>
        <div class="modal-body">
          <p v-if="!current" class="empty">{{ drawHint }}</p>
          <template v-else>
            <div class="who">
              <b class="wname">{{ current.name }}</b>
              <span class="wsid">{{ current.sid }}</span>
              <span class="tag" :class="onlineMap[current.sid] ? 'ok' : 'mute'">
                <i class="dot" :class="{ on: onlineMap[current.sid] }"></i>
                {{ onlineMap[current.sid] ? '在线' : '离线' }}
              </span>
              <span class="dim">考勤 {{ scoreMap[current.sid] === undefined ? '—' : scoreMap[current.sid] }} / {{ full }}</span>
            </div>
            <div class="drawbtns">
              <button
                v-for="k in kinds"
                :key="k.kind"
                class="kbtn"
                :class="['k-' + k.kind, { on: kindOf(current.sid) === k.kind }]"
                :disabled="busySet.has(current.sid)"
                @click="judge(k.kind)"
              >
                {{ k.kind }}<em v-if="k.delta">{{ k.delta }}</em>
              </button>
            </div>
          </template>
          <div class="drawfoot">
            <div class="df-row">
              <span class="dim">本轮已抽 {{ drawn.size }} 人 · 还剩 {{ candidates.length }} 人</span>
              <span class="spacer"></span>
              <label class="field inline">
                <span>抽谁</span>
                <select v-model="scope" class="select" style="width: 122px">
                  <option v-for="o in scopeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </label>
            </div>
            <div class="df-row">
              <label class="check" title="锁定时学生点不掉弹窗，必须等你点「结束」">
                <input
                  type="checkbox"
                  :checked="spotLock"
                  @change="setSpotLock($event.target.checked)"
                />
                学生端锁定
              </label>
              <button
                class="btn mini"
                :class="{ on: inOrder }"
                :title="inOrder ? '按学号顺序一个个来' : '随机抽'"
                @click="inOrder = !inOrder"
              >
                {{ inOrder ? '顺序点名' : '随机点名' }}
              </button>
              <button class="btn mini" @click="resetRound">从头开始</button>
              <span class="spacer"></span>
              <button class="btn mini" :disabled="!candidates.length" @click="drawOne">下一个 ›</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Toast :text="toast" />
  </PageShell>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { api } from '../../api'
import Toast from '../../components/Toast.vue'
import { currentClassId, setClassId } from '../../utils/classSel'
import { clock, startClock } from '../../utils/timetable'
import { spotLock, setSpotLock } from '../../utils/spotlight'
import PageHead from '../../components/PageHead.vue'
import DataTable from '../../components/DataTable.vue'
import PageShell from '../../components/PageShell.vue'

const props = defineProps({
  itemKey: { type: String, default: '' },
})

const kinds = ref([
  { kind: '出勤', delta: 0 },
  { kind: '迟到', delta: -1 },
  { kind: '缺勤', delta: -2 },
  { kind: '请假', delta: 0 },
  { kind: '早退', delta: -1 },
])
const order = ['出勤', '迟到', '缺勤', '请假', '早退']
const slotOptions = ['1-2节', '3-4节', '5-6节', '7-8节', '9-10节']

const classes = ref([])
const activeId = ref('')
const students = ref([])
const marks = ref([])
const slotStats = ref([])
const day = ref(new Date().toISOString().slice(0, 10))
const slot = ref(slotOptions[0])
const view = ref('grid')
const SORT_KEY = 'teach-att-sort'
const sortBy = ref(localSort())

function localSort() {
  try {
    const v = localStorage.getItem(SORT_KEY) || ''
    return ['sid', 'online', 'status', 'score'].indexOf(v) >= 0 ? v : 'sid'
  } catch (e) {
    return 'sid'
  }
}
const loading = ref(false)
const error = ref('')
const toast = ref('')
const itemName = ref('考勤')
const full = ref(10)
const busySet = reactive(new Set())

/* 列表视图的列（网格视图不走表格） */
const listCols = [
  { key: 'sid', label: '学号', width: '104px' },
  { key: 'name', label: '姓名', width: '80px' },
  { key: 'online', label: '在线', num: true, width: '52px' },
  { key: 'score', label: '考勤分', num: true, width: '76px', tdClass: 'score' },
  { key: 'actions', label: '本节状态（点即保存）', width: '360px', tdClass: 'btns' },
]

const picked = reactive({})
const scoreMap = reactive({})
const onlineMap = reactive({})

const abnormalCount = computed(() => Object.values(picked).filter((k) => k && k !== '出勤').length)
const onlineCount = computed(() => students.value.filter((s) => onlineMap[s.sid]).length)

/** 状态越靠前越「要紧」：缺勤 > 早退 > 迟到 > 请假 > 出勤 */
const SEVERITY = { 缺勤: 0, 早退: 1, 迟到: 2, 请假: 3, 出勤: 9 }

/**
 * 排序后的名单（网格 / 列表共用）：
 *   学号            —— 默认，跟名单顺序一致，找人最快
 *   在线优先        —— 在线的排在前面（想知道谁还没连上）
 *   异常优先        —— 缺勤/早退/迟到/请假 排前面，按严重程度；同为异常再按在线、学号
 *   考勤分低优先    —— 扣分多的排前面（想找需要提醒的人）
 * 排序只影响显示顺序，标记与分数都是按学号存的，切换不会丢。
 */
const sorted = computed(() => {
  const list = students.value.slice()
  const bySid = (a, b) => String(a.sid).localeCompare(String(b.sid), 'zh-Hans-CN', { numeric: true })
  const mode = sortBy.value
  if (mode === 'sid') return list.sort(bySid)
  if (mode === 'online') {
    return list.sort((a, b) => {
      const oa = onlineMap[a.sid] ? 0 : 1
      const ob = onlineMap[b.sid] ? 0 : 1
      return oa - ob || bySid(a, b)
    })
  }
  if (mode === 'score') {
    return list.sort((a, b) => (scoreMap[a.sid] || 0) - (scoreMap[b.sid] || 0) || bySid(a, b))
  }
  // 异常优先
  return list.sort((a, b) => {
    const sa = SEVERITY[kindOf(a.sid)] === undefined ? 9 : SEVERITY[kindOf(a.sid)]
    const sb = SEVERITY[kindOf(b.sid)] === undefined ? 9 : SEVERITY[kindOf(b.sid)]
    return sa - sb || (onlineMap[a.sid] ? 0 : 1) - (onlineMap[b.sid] ? 0 : 1) || bySid(a, b)
  })
})

function kindOf(sid) {
  return picked[sid] || '出勤'
}

function countOf(kind) {
  return Object.values(picked).filter((k) => k === kind).length
}

function scoreOf(sid) {
  return Math.round((scoreMap[sid] || 0) * 10) / 10
}

// 记住上次用的排序方式（老师一般固定一种习惯）
watch(sortBy, (v) => {
  try {
    localStorage.setItem(SORT_KEY, v)
  } catch (e) {
    /* 隐私模式忽略 */
  }
})

function show(text) {
  toast.value = text
  setTimeout(() => {
    if (toast.value === text) toast.value = ''
  }, 2200)
}

function base(suffix) {
  return '/api/teacher/classes/' + encodeURIComponent(activeId.value) + suffix
}

function withItem(path) {
  if (!props.itemKey) return path
  return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'itemKey=' + encodeURIComponent(props.itemKey)
}

async function loadClasses() {
  try {
    const res = await api.get('/api/teacher/classes')
    classes.value = res.classes || []
    // 跟着侧栏选的班走（属于当前课程才用）
    if (currentClassId.value && classes.value.some((c) => c.id === currentClassId.value)) {
      activeId.value = currentClassId.value
    }
    if (!activeId.value && classes.value.length) activeId.value = classes.value[0].id
    if (activeId.value) setClassId(activeId.value)
  } catch (e) {
    error.value = e.message
  }
}

async function reload() {
  if (!activeId.value) return
  loading.value = true
  error.value = ''
  try {
    const res = await api.get(
      withItem(
        base('/attendance') +
          '?date=' +
          encodeURIComponent(day.value) +
          '&slot=' +
          encodeURIComponent(slot.value)
      )
    )
    students.value = res.students || []
    marks.value = res.marks || []
    slotStats.value = res.slotStats || []
    kinds.value = res.kinds || kinds.value
    itemName.value = res.itemName || '考勤'
    full.value = res.full || 10
    if (res.day) day.value = res.day
    for (const k of Object.keys(picked)) delete picked[k]
    for (const k of Object.keys(scoreMap)) delete scoreMap[k]
    for (const k of Object.keys(onlineMap)) delete onlineMap[k]
    for (const s of res.students || []) {
      picked[s.sid] = '出勤'
      onlineMap[s.sid] = !!s.online
      const hit = (res.scores || []).find((x) => x.sid === s.sid)
      scoreMap[s.sid] = hit ? hit.score : 0
    }
    for (const m of marks.value) picked[m.sid] = m.kind
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

/** 在线状态单独取（学生心跳会变，日期/节次不变时也得刷） */
async function loadPresence() {
  if (!activeId.value) return
  try {
    const res = await api.get(base('/presence'))
    const set = new Set((res.online || []).map((s) => s.sid))
    for (const s of students.value) onlineMap[s.sid] = set.has(s.sid)
  } catch (e) {
    /* 拿不到不影响点名 */
  }
}

function pick(id) {
  if (id === activeId.value) return
  activeId.value = id
  setClassId(id)
  reload().then(() => {
    loadPresence()
    restoreSpot()
  })
}

function switchSlot(x) {
  if (slot.value === x) return
  slot.value = x
  reload()
}

/** 一条一条即时保存：点出勤 = 撤销这个人在本节的记录 */
async function mark(sid, kind) {
  if (!sid || busySet.has(sid)) return
  const prev = kindOf(sid)
  const next = kind === prev ? '出勤' : kind
  picked[sid] = next
  busySet.add(sid)
  try {
    const res = await api.post(withItem(base('/attendance/mark')), {
      sid,
      kind: next,
      date: day.value,
      slot: slot.value,
    })
    picked[sid] = res.kind || next
    scoreMap[sid] = res.score
    // 本地同步这一节的记录清单（顶部的「1-2节 · n」跟着变）
    const others = marks.value.filter((m) => m.sid !== sid)
    if (next !== '出勤') others.push({ sid, kind: next, delta: res.delta, slot: slot.value, eventId: res.eventId })
    marks.value = others
    const c = slotStats.value.find((x) => x.slot === slot.value)
    const n = others.filter((m) => (m.slot || slot.value) === slot.value).length
    if (c) c.count = n
    else if (n) slotStats.value.push({ slot: slot.value, count: n })
    if (n === 0) slotStats.value = slotStats.value.filter((x) => x.slot !== slot.value)
  } catch (e) {
    picked[sid] = prev
    error.value = e.message
  } finally {
    busySet.delete(sid)
  }
}

/** 网格里点一下：按顺序切到下一个状态 */
function cycle(sid) {
  const cur = kindOf(sid)
  const i = order.indexOf(cur)
  mark(sid, order[(i + 1) % order.length])
}

/** 清空本节所有异常（全撤回「出勤」） */
async function clearSlot() {
  const list = students.value.filter((s) => kindOf(s.sid) !== '出勤')
  if (!list.length) return
  if (!window.confirm('把本节已记的 ' + list.length + ' 条异常全部撤回？（等于全勤）')) return
  for (const s of list) {
    // 串行，避免同一秒内写太多
    // eslint-disable-next-line no-await-in-loop
    await mark(s.sid, '出勤').catch(() => {})
  }
  show('已清空本节异常')
}

/* ---------------- 随机点名（看出勤） ----------------
 * 用途和「课堂互动」的随机点名不同：那个是抽人回答问题（抽到谁给谁加分），
 * 这个是抽人核对到场情况 —— 抽到后当场判状态，判完自动抽下一个，一路扫完整班。
 * 本轮抽过的不再重复；勾上「只抽还没标的」就只从当前仍是「出勤」的人里抽。
 */
const drawing = ref(false)
const drawn = reactive(new Set())
const current = ref(null)

/* 抽谁：按状态筛（没标的 / 已标异常 / 某个具体状态 / 在线 / 离线） */
const scope = ref('unmarked')
const scopeOptions = [
  { value: 'unmarked', label: '还没标的' },
  { value: 'all', label: '全班' },
  { value: 'abnormal', label: '已标异常' },
  { value: '缺勤', label: '只看缺勤' },
  { value: '迟到', label: '只看迟到' },
  { value: '请假', label: '只看请假' },
  { value: '早退', label: '只看早退' },
  { value: 'online', label: '只看在线' },
  { value: 'offline', label: '只看离线' },
]

/* 顺序点名：按学号一条条来，适合对名单 / 挨个问 */
const inOrder = ref(false)

const candidates = computed(() =>
  students.value
    .filter((s) => {
      if (drawn.has(s.sid)) return false
      const k = kindOf(s.sid)
      switch (scope.value) {
        case 'all':
          return true
        case 'abnormal':
          return k !== '出勤'
        case 'online':
          return !!onlineMap[s.sid]
        case 'offline':
          return !onlineMap[s.sid]
        case '缺勤':
        case '迟到':
        case '请假':
        case '早退':
          return k === scope.value
        default:
          return k === '出勤'
      }
    })
    .sort((a, b) => String(a.sid).localeCompare(String(b.sid), 'zh', { numeric: true }))
)

const drawHint = computed(() =>
  students.value.length ? '这一档里已经抽完了，换个「抽谁」或点「从头开始」' : '这个班还没有名单'
)

/** 抽到谁就同步到学生端（学生开着任意页面都能看到） */
function announce(payload) {
  api.post(base('/spotlight'), Object.assign({ kind: 'attend' }, payload)).catch(() => {})
}

/** 这一轮的点名进度存服务端：刷新 / 换设备后能接着来 */
function saveAttendState() {
  if (!activeId.value) return
  api
    .post(base('/attend-state'), {
      day: day.value,
      slot: slot.value,
      drawn: [...drawn],
      order: inOrder.value,
      scope: scope.value,
    })
    .catch(() => {})
}

function drawOne() {
  const pool = candidates.value
  if (!pool.length) {
    current.value = null
    return
  }
  const idx = inOrder.value ? 0 : Math.floor(Math.random() * pool.length)
  const hit = pool[idx]
  drawn.add(hit.sid)
  current.value = hit
  announce({ sid: hit.sid, seq: drawn.size, total: students.value.length, lock: spotLock.value })
  saveAttendState()
}

function openDraw() {
  drawing.value = true
  // 关掉再打开时接着上一个人（老师可能只是先看一眼），没有才抽
  if (!current.value) drawOne()
}

function closeDraw() {
  drawing.value = false
  announce({ clear: true })
}

/** 判完自动抽下一个：老师只用照着念名字、点状态 */
async function judge(kind) {
  const stu = current.value
  if (!stu) return
  await mark(stu.sid, kind)
  if (candidates.value.length) drawOne()
  else current.value = null
}

function resetRound() {
  drawn.clear()
  current.value = null
  drawOne()
}

/** 打开页面 / 换班时：把上次的点名进度接回来（含还开着的点名弹层） */
async function restoreSpot() {
  if (!activeId.value) return
  try {
    const res = await api.get(base('/spotlight'))
    const a = res.attend
    if (a && a.day === day.value && a.slot === slot.value) {
      drawn.clear()
      for (const sid of a.drawn || []) drawn.add(sid)
      inOrder.value = !!a.order
      scope.value = a.scope || 'unmarked'
    }
    const sp = res.spotlight
    if (sp && sp.kind === 'attend' && sp.sid) {
      const stu = students.value.find((x) => x.sid === sp.sid)
      if (stu) {
        current.value = stu
        drawing.value = true
      }
    }
  } catch (e) {
    /* 恢复失败不影响使用 */
  }
}

// 换班 / 换日期 / 换节次 = 新的一轮
watch([activeId, day, slot], () => {
  drawn.clear()
  current.value = null
})

let presenceTimer = null

onMounted(async () => {
  await loadClasses()
  // 一进来就落在这节课上：服务器告诉我们现在是第几节，就用它对应的两节档
  await new Promise((resolve) => {
    startClock()
    const t0 = Date.now()
    const wait = () => {
      if (clock.value.ready || Date.now() - t0 > 2000) resolve()
      else setTimeout(wait, 120)
    }
    wait()
  })
  if (clock.value.pair && slotOptions.indexOf(clock.value.pair) >= 0) slot.value = clock.value.pair
  await reload()
  await restoreSpot()
  await loadPresence()
  presenceTimer = setInterval(loadPresence, 10000)
})

onUnmounted(() => {
  if (presenceTimer) clearInterval(presenceTimer)
})
</script>

<style scoped>
/* ---------------- 随机点名弹层 ---------------- */
.drawbox {
  max-width: 560px;
}

.who {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 6px 0 18px;
}

.who .wname {
  font-size: 30px;
  font-weight: 600;
  letter-spacing: 1px;
  line-height: 1.1;
}

.who .wsid {
  font-size: 13px;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

.who .tag .dot {
  margin-right: 4px;
}

.drawbtns {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.drawbtns .kbtn {
  min-width: 88px;
  padding: 9px 10px;
  font-size: 13px;
  text-align: center;
}

.drawbtns .kbtn em {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: 11px;
  opacity: 0.66;
}

.drawfoot {
  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.drawfoot .df-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.drawfoot .df-row + .df-row {
  margin-top: 10px;
}

.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.classes {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 200px;
}

.tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.field.inline {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
}

.field.inline > span {
  white-space: nowrap;
  font-size: 12px;
  color: #475569;
}

.seg {
  display: flex;
  border: 1px solid #d8dee6;
  border-radius: 4px;
  overflow: hidden;
}

.segbtn {
  padding: 3px 10px;
  font-size: 12px;
  background: #fff;
  border: none;
  cursor: pointer;
  color: #475569;
}

.segbtn.on {
  background: var(--brand);
  color: #fff;
}

.stats {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  font-size: 13px;
}

.stat {
  padding: 2px 8px;
  border-radius: 4px;
  background: #f4f6f8;
}

.stat em {
  font-style: normal;
  color: #94a3b8;
  font-size: 11.5px;
  margin-left: 2px;
}

.stat.k-迟到 {
  background: #fef9c3;
}
.stat.k-缺勤 {
  background: #fee2e2;
}
.stat.k-请假 {
  background: #dbeafe;
}
.stat.k-早退 {
  background: #fde68a;
}

.online {
  font-size: 12.5px;
  color: #15803d;
}

.online .live {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #16a34a;
  margin-right: 4px;
  vertical-align: 1px;
}

.spacer {
  flex: 1;
}

.slotchips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.slotchip {
  padding: 1px 8px;
  border: 1px solid #d8dee6;
  border-radius: 10px;
  background: #fff;
  font-size: 11.5px;
  color: #475569;
  cursor: pointer;
}

.slotchip.on {
  border-color: var(--brand);
  background: var(--brand-wash);
  color: var(--brand-ink);
}

.roster {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
  gap: 8px;
}

.stu {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 8px 10px;
  border: 1px solid #d8dee6;
  border-left-width: 4px;
  border-radius: 5px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s;
}

.stu:hover {
  background: #f8fafc;
}

.stu.saving {
  opacity: 0.55;
}

.stu b {
  font-size: 13.5px;
  color: #1f2937;
}

.stu .sid {
  font-size: 11px;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}

.stu .mark {
  font-size: 11.5px;
  color: #475569;
}

.stu .score {
  font-size: 11px;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}

.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #cbd5e1;
  margin-right: 4px;
  vertical-align: 1px;
}

.dot.on {
  background: #16a34a;
  box-shadow: 0 0 0 2px #dcfce7;
}

.stu.st-迟到,
tr.st-迟到 {
  border-left-color: #eab308;
  background: #fefce8;
}
.stu.st-缺勤,
tr.st-缺勤 {
  border-left-color: #dc2626;
  background: #fef2f2;
}
.stu.st-请假,
tr.st-请假 {
  border-left-color: #2563eb;
  background: #eff6ff;
}
.stu.st-早退,
tr.st-早退 {
  border-left-color: #f59e0b;
  background: #fffbeb;
}
.stu.st-出勤 {
  border-left-color: #cbd5e1;
}

.grid tr.saving {
  opacity: 0.55;
}

.grid td.sid {
  font-variant-numeric: tabular-nums;
  color: #475569;
}

.grid td.score {
  font-weight: 600;
}

.grid td.btns {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  padding: 6px 8px;
}

.kbtn {
  padding: 2px 9px;
  border: 1px solid #d8dee6;
  border-radius: 4px;
  background: #fff;
  font-size: 12px;
  color: #475569;
  cursor: pointer;
}

.kbtn.on {
  color: #fff;
  border-color: transparent;
}

.kbtn.on.k-出勤 {
  background: #64748b;
}
.kbtn.on.k-迟到 {
  background: #ca8a04;
}
.kbtn.on.k-缺勤 {
  background: #dc2626;
}
.kbtn.on.k-请假 {
  background: #2563eb;
}
.kbtn.on.k-早退 {
  background: #d97706;
}

.empty {
  padding: 16px;
  color: #64748b;
  font-size: 13px;
}
</style>
