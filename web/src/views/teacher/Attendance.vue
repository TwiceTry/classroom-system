<template>
  <!-- ws：中栏网格 + 右栏异常；fixed-top：bar 固定，只有网格滚 -->
  <PageShell body-class="ws fixed-top">
    <template #head>
      <PageHead @reload="reload">
        <template #title>考勤点名</template>
        <template #sub>点一下就存：网格点格子循环，列表点行内按钮；只记异常，回到「出勤」= 撤销。
          随机点名可随机 / 顺序，也能按状态筛；抽到谁，学生端会同步弹大字提示。</template>
        <!--
          刷新走通用区那个「↻」（这一页最需要它：在线人数和名单一直在变）。

          点名入口与状态合一：没点名时是「随机点名」按钮，点名中是「● 点名中 · 张三」胶囊，
          两者占同一个位置、同一个高度 —— 页面不会因为点名而多出一块东西。
        -->
        <template #right>
          <span class="tag mute" v-if="full">{{ itemName }} · 满分 {{ full }}</span>
          <button v-if="current" class="spot-chip" title="点开接着点" @click="drawing = true">
            <i class="dot"></i>点名中 · {{ current.name }}
          </button>
          <button v-else class="btn primary" :disabled="!students.length" @click="openDraw">
            随机点名
          </button>
          <button
            v-if="current"
            class="btn mini danger"
            title="收起学生端的点名提示，本轮进度保留"
            @click="closeDraw"
          >
            结束
          </button>
        </template>
      </PageHead>
    </template>
    <p v-if="error" class="hint err">{{ error }}</p>

    <!--
      一条 bar 分两行：
        第一行「选哪一批数据」—— 班级 / 日期 / 节次 / 显示方式 / 清空
        第二行「这批数据怎么样」—— 各状态计数 / 在线数 / 今天有几节
      原来统计单独占一张卡片（55px），和 bar 说的是同一件事却分两处，
      合并后省一张卡，也省一次「上面的数字和下面的名单对不上」的困惑。

      视图和排序收进「显示」菜单：它们改的是"怎么看"，一天改一次，
      不该和日期、节次抢同一行的醒目位置。
    -->
    <div class="card bar">
      <div class="bar-row">
        <div class="classes">
          <button v-for="c in classes" :key="c.id" class="pill" :class="{ on: c.id === activeId }" @click="pick(c.id)">
            {{ c.name }}<span class="dim"> {{ c.studentCount ?? c.count ?? '' }} 人</span>
          </button>
          <span v-if="!classes.length" class="dim">还没有班级，先去「班级管理」建一个。</span>
        </div>
        <span class="spacer"></span>
        <label class="field inline">
          <span>日期</span>
          <input v-model="day" type="date" class="input" @change="reload" />
        </label>
        <label class="field inline">
          <span>节次</span>
          <select v-model="slot" class="select" style="width: 108px" @change="reload">
            <option v-for="x in slotOptions" :key="x" :value="x">{{ x }}</option>
          </select>
        </label>

        <details class="menu">
          <summary class="btn mini">显示 · {{ view === 'grid' ? '网格' : '列表' }}</summary>
          <div class="menu-body">
            <div class="seg">
              <button class="segbtn" :class="{ on: view === 'grid' }" @click="view = 'grid'">网格</button>
              <button class="segbtn" :class="{ on: view === 'list' }" @click="view = 'list'">列表</button>
            </div>
            <label class="field inline">
              <span>排序</span>
              <select v-model="sortBy" class="select" style="width: 118px">
                <option value="sid">学号</option>
                <option value="online">在线优先</option>
                <option value="status">异常优先</option>
                <option value="score">考勤分低优先</option>
              </select>
            </label>
          </div>
        </details>

        <button class="btn mini danger" :disabled="!abnormalCount" @click="clearSlot">
          清空异常（{{ abnormalCount }}）
        </button>
      </div>

      <div class="bar-row stats-row">
        <span v-for="k in kinds" :key="k.kind" class="stat" :class="'k-' + k.kind">
          {{ k.kind }} <b>{{ countOf(k.kind) }}</b>
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
    </div>

    <div v-if="!students.length && !loading" class="card empty">这个班还没有名单，先去「班级管理」导入。</div>

    <!-- 中栏：网格 / 列表（主滚动区）。上面那条 bar 固定不动 -->
    <div class="scroll-body">

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
      <!--
        在线状态读 onlineMap，不读 s.online。
        s.online 是 loadClasses 那一刻的快照，教学机代理后续上报的在线变化只写进 onlineMap，
        s.online 永远停在打开页面时那一刻 —— 表现是"上面写着在线 6，格子上一个绿点都没有"。
      -->
      <i class="dot" :class="{ on: onlineMap[s.sid] }"></i>
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
      <!--
        和网格同一个坑：row.online 是 loadClasses 那一刻的快照，
        教学机代理后续上报只写进 onlineMap，所以这些点一直不亮。
        两个视图（网格 / 列表）必须读同一个来源，否则会「网格亮、列表全暗」。
      -->
      <template #cell-online="{ row }"><i class="dot" :class="{ on: onlineMap[row.sid] }"></i></template>
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



    </div>

    <!--
      右栏：本次课记录（这一天的考勤流水，最新的在上，能逐条撤回）。

      原来这里是「本节异常」——一张迟到/缺勤名单。那个信息网格里其实一眼就有
      （格子带颜色和状态标签），而**这次课都点了谁**在网格里是看不出来的：
      格子上只有当前状态，看不出「刚才把张三从缺勤改回了出勤」这种过程。
      所以右栏让给流水，异常压成底部一行摘要。

      和「课堂互动」右栏是同一个形状、同一个行为 —— 换页面不用重新学。
    -->
    <template #right>
      <section class="card">
        <CardHead>
          <template #title>本次课记录</template>
          <template #meta>
            <span class="dim mini">{{ recent.length }} 条</span>
          </template>
        </CardHead>

        <EventFeed
          :items="recent"
          :empty-title="students.length ? '今天还没有考勤记录' : '还没有名单'"
          :empty-text="
            students.length
              ? '点网格里的格子改状态，或者用随机点名，这里会实时出现流水，点 × 能撤回。'
              : '先去「班级管理」导入名单，这里才有得看。'
          "
          @undo="undoRecent"
        >
          <template #at="{ row }">{{ row.slot }} {{ clockOf(row.at) }}</template>
        </EventFeed>

        <!-- 异常压成一行摘要：谁没到还是要一眼能看到，但不占一整块 -->
        <p v-if="abnormalList.length" class="abn-tip dim mini">
          {{ abnormalList.length }} 人异常：{{ abnormalSummary }}（网格里标着色）
        </p>
        <p
          v-else
          class="abn-tip dim mini"
          :title="'网格：点格子循环（' + kinds.map((k) => k.kind).join(' → ') + ' → 回「出勤」）。列表：点行内按钮直接落库、再点同一状态可取消。'"
        >
          点格子循环切换状态；列表点行内按钮。全部记录见这里，能逐条撤回。
        </p>
      </section>
    </template>


    <!-- 随机点名：抽一个人，当场判考勤（判完自动抽下一个） -->
    <RollCallModal
      v-model="drawing"
      title="考勤点名"
      :subtitle="slot + ' · ' + day + ' · 学生端同步显示'"
      :who="attendWho"
      :picked="drawn.size"
      :total="students.length"
      :remaining="candidates.length"
      :online="null"
      :scopes="scopeOptions"
      :scope="scope"
      orderable
      :order="inOrder ? 'seq' : 'random'"
      :locked="spotLock"
      :busy="!!current && busySet.has(current.sid)"
      :can-reset="!!activeId"
      :empty-text="drawHint"
      end-title="收起学生端点名提示，本轮进度保留"
      @update:locked="setSpotLock"
      @update:scope="scope = $event"
      @update:order="(v) => (inOrder = v === 'seq')"
      @end="closeDraw"
      @next="drawOne"
      @reset="resetRound"
    >
      <!-- 业务按钮：这一页是「判考勤」，课堂互动那页是「加分」 -->
      <template #actions>
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
      </template>

      <!-- 「抽谁 / 顺序还是随机」现在是组件的 props（scopes / orderable），
           不再走插槽 —— 那样控件尺寸和父组件样式各管一半，对不齐。 -->
    </RollCallModal>

    <Toast :text="toast" />
  </PageShell>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { api } from '../../api'
import Toast from '../../components/Toast.vue'
import { currentClassId, setClassId } from '../../utils/classSel'
import { clock, startClock } from '../../utils/timetable'
/*
 * 注意别名：utils/timetable 的 `clock` 是个 **ref 对象**（当前节次时钟的状态），
 * 不是格式化函数。上面那行一直在 import 它（给节次判断用）。
 * 显示「这条记录是几点」要用 utils/time 里的 clock(iso) —— 两个同名，
 * 不别名的话模板里 `clock(row.at)` 等于调用一个 ref，直接
 * "xxx is not a function"，整页崩掉。
 */
import { clock as clockOf } from '../../utils/time'
import { spotLock, setSpotLock } from '../../utils/spotlight'
import PageHead from '../../components/PageHead.vue'
import DataTable from '../../components/DataTable.vue'
import PageShell from '../../components/PageShell.vue'
import RollCallModal from '../../components/RollCallModal.vue'
import EventFeed from '../../components/EventFeed.vue'
/*
 * CardHead 一直没 import —— 模板里写着 <CardHead>，但它是未知元素，
 * 于是 <template #title> 整块不渲染（右栏只显示 meta 那一行）。
 * 之前没人发现是因为右栏标题区本来就空着也不显眼。
 */
import CardHead from '../../components/CardHead.vue'

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

/**
 * 这一天的考勤流水（右栏「本次课记录」）。
 *
 * 和「课堂互动」右栏同一个形状：{id, sid, name, kind, delta, reason, at, slot, voided}。
 * 后端按时间升序给，这里直接用（已经是倒序了，见 routes/attendance.js）。
 */
const recent = ref([])

/**
 * 撤回一条流水。
 *
 * 撤销是「打 voided 标记」而不是删行（events 表 append-only），
 * 所以撤完那条还在列表里、只是灰掉 —— 老师能看出「点过、撤了」，
 * 而不是以为没点上。
 */
async function undoRecent(r) {
  if (!r || r.voided) return
  try {
    await api.post(base('/events/' + encodeURIComponent(r.id) + '/void'), {})
    await reload()
    toast.value = '已撤销 ' + (r.name || r.sid) + ' 的那一条'
  } catch (e) {
    error.value = e.message
  }
}
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
  return '/api/classes/' + encodeURIComponent(activeId.value) + suffix
}

function withItem(path) {
  if (!props.itemKey) return path
  return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'itemKey=' + encodeURIComponent(props.itemKey)
}

async function loadClasses() {
  try {
    const res = await api.get('/api/classes')
    classes.value = res.items || []
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
    recent.value = res.recent || []
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
    // 服务端会回这一项的新分值；万一没回，保留原值，绝不清零
    if (res && res.score !== undefined) scoreMap[sid] = res.score

    /*
     * 右栏「本次课记录」就地更新。
     *
     * 原来这里只同步了 marks / slotStats / picked / scoreMap，**没管 recent** ——
     * 于是老师点完格子，网格里的状态变了，右栏列流水却纹丝不动，
     * 非要切到别的 tab 再切回来（触发 reload）才看得到。
     *
     * 不整页 reload 是为了不闪：reload 会重建整个网格、丢掉滚动位置，
     * 而这是个「点一下看看」的高频操作。
     *
     * 两件事：
     *   ① 这个学生**本节**的旧条目标成已撤（服务端 voidSlot 已经撤了）
     *   ② 新状态不是「出勤」就插到最前面
     */
    {
      const list = recent.value.map((r) =>
        r.sid === sid && r.slot === slot.value && !r.voided ? Object.assign({}, r, { voided: true }) : r
      )
      if (next !== '出勤' && res.eventId) {
        const stu = students.value.find((x) => x.sid === sid)
        list.unshift({
          id: res.eventId,
          sid,
          name: (stu && stu.name) || '',
          kind: next,
          delta: res.delta,
          reason: next,
          at: new Date().toISOString(),
          slot: slot.value,
          voided: false,
        })
      }
      /* 和列表容量保持一致（后端取最近 50 条） */
      recent.value = list.slice(0, 50)
    }
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

/*
 * 给 RollCallModal 的归一化数据（和课堂互动那边同一个形状）。
 * 分数这一栏两边含义不同：这里是考勤状态，那边是互动分，
 * 所以只传拼好的文案，组件不猜。
 */
/**
 * 本节有异常的人（迟到 / 缺勤 / 请假 / 早退）。
 *
 * 60 人的网格里，异常的那几个混在一片"出勤"里要靠颜色找。
 * 右栏单独列一遍，点名时一眼知道"这节课谁没到"。
 */
const abnormalList = computed(() =>
  students.value.filter((s) => {
    const k = kindOf(s.sid)
    return k && k !== '出勤'
  }),
)

/**
 * 异常的一行摘要（「1 迟到 · 2 缺勤」）。
 *
 * 右栏让给计分流水之后，异常只剩这一行了 —— 但「谁没到」还是得一眼看到，
 * 所以按状态分组计数，比列一串名字省地方。
 */
const abnormalSummary = computed(() => {
  const m = new Map()
  for (const s of abnormalList.value) {
    const k = kindOf(s.sid)
    if (!k || k === '出勤') continue
    m.set(k, (m.get(k) || 0) + 1)
  }
  return [...m.entries()].map(([k, n]) => n + ' ' + k).join(' · ')
})

/** 考勤状态 → 标签配色 */
function kindTag(k) {
  if (k === '迟到' || k === '早退') return 'warn'
  if (k === '缺勤') return 'err'
  if (k === '请假') return 'mute'
  return 'ok'
}

const attendWho = computed(() => {
  const c = current.value
  if (!c) return null
  const sc = scoreMap[c.sid]
  return {
    name: c.name || '',
    sid: c.sid || '',
    online: !!onlineMap[c.sid],
    scoreText: '考勤 ' + (sc === undefined ? '—' : sc) + ' / ' + full.value,
  }
})

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

/**
 * 抽一个还没标过考勤的人。
 *
 * 以前这里**在浏览器本地随机**挑，抽过的人记在本地 `drawn`。
 * 课堂互动那边却是调 `/rollcall/draw`、记在服务端的 `picked` ——
 * 两本账，同一节课里考勤点过的人，切到互动还能再抽到。
 *
 * 现在统一走服务端：
 *   · 候选名单用 sids 传上去（「未标记 / 只看在线」这类筛选只有前端知道）
 *   · exclude 由服务端按 picked 判断 —— 两个页共用同一份「本轮已抽」
 *   · order 决定顺序还是随机
 * 拿回来的 picked 直接当本地 drawn 用，两边永远一致。
 */
async function drawOne() {
  const pool = candidates.value
  if (!pool.length) {
    current.value = null
    return
  }
  try {
    const res = await api.post(base('/rollcall/draw'), {
      count: 1,
      exclude: true,
      lock: spotLock.value,
      sids: pool.map((s) => s.sid),
      order: inOrder.value ? 'seq' : 'random',
      kind: 'attend',
    })
    const who = (res.drawn || [])[0]
    if (!who) {
      current.value = null
      return
    }
    /*
     * 抽是抽到了（后端已经记进「本轮已抽」），但浮层可能没推到学生端 ——
     * 有学生正在考试（优先级 100）时点名（80）推不下去。
     * 这里必须说一句，否则老师看到弹窗里有人、学生那边没反应，会以为坏了。
     */
    if (res.blocked) {
      const k = res.focus && res.focus.kind
      error.value =
        k === 'exam'
          ? '有学生正在考试，这次点名的浮层没有推到学生端（考完再点）'
          : '学生端被别的状态占着（' + (k || '未知') + '），这次点名的浮层没推下去'
    }
    current.value = students.value.find((s) => s.sid === who.sid) || { sid: who.sid, name: who.name || '' }
    /* 服务端回来的 picked 就是权威的「本轮已抽」，同步成镜像 */
    drawn.clear()
    for (const sid of res.picked || []) drawn.add(sid)
    saveAttendState()
  } catch (e) {
    error.value = e.message
    current.value = null
  }
}

function openDraw() {
  drawing.value = true
  // 关掉再打开时接着上一个人（老师可能只是先看一眼），没有才抽
  if (!current.value) drawOne()
}

/**
 * 结束点名（和课堂互动同一套语义）。
 *
 *   关掉弹窗 ≠ 结束点名：点「先放着」/ 点遮罩只是自己这边不挡视线，
 *   学生端还显示着，页头那颗「点名中 · 张三」也还在，随时能点回来。
 *
 *   只有这个函数会真结束：清学生端提示 + 清教师端「当前抽到谁」。
 *
 * 原来这里只清了学生端（announce），漏了 current —— 于是学生端的浮层收了、
 * 页头那颗胶囊还挂着「点名中」，看着像没结束。两件事必须一起做。
 */
function closeDraw() {
  drawing.value = false
  current.value = null
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

/**
 * 重置抽取：清空本轮「已抽过」，所有人重新可抽。
 *
 * 必须在**服务端**清一次。抽人已经改成走 /rollcall/draw、由服务端记 picked，
 * 只清本地 drawn 的话，下一次 draw 服务端还是会把整班当成"都抽过了"——
 * 表现就是点了没反应（这正是之前的毛病）。
 *
 * kind=attend：只清考勤这一份，不动课堂互动的。
 */
async function resetRound() {
  drawn.clear()
  current.value = null
  try {
    await api.post(base('/rollcall/reset'), { kind: 'attend' })
  } catch (e) {
    /* 清不掉也照样往下走，至少本轮界面是新的 */
  }
  await drawOne()
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
  gap: var(--sp-2);
  padding: var(--sp-2) 0 var(--sp-4);
}

.who .wname {
  font-size: 30px;
  font-weight: 600;
  letter-spacing: 1px;
  line-height: 1.1;
}

.who .wsid {
  font-size: var(--fs-md);
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
  padding: var(--sp-2) var(--sp-2);
  font-size: var(--fs-md);
  text-align: center;
}

.drawbtns .kbtn em {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: var(--fs-xs);
  opacity: 0.66;
}

.drawfoot {
  margin: var(--sp-4);
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.drawfoot .df-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.drawfoot .df-row + .df-row {
  margin: var(--sp-2);
}

/* 两行：第一行选数据（班级/日期/节次），第二行看结果（各状态计数） */
.bar {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin: var(--sp-2);
}

.bar-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.stats-row {
  padding: var(--sp-2);
  border-top: 1px dashed #eef1f4;
}

/* 「显示」菜单的样式已经提到 app.css（考核方案页也要用，一处维护） */

.classes {
  display: flex;
  gap: var(--sp-2);
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
  gap: var(--sp-2);
  margin: 0;
}

.field.inline > span {
  white-space: nowrap;
  font-size: var(--fs-sm);
  color: #475569;
}

.seg {
  display: flex;
  border: 1px solid #d8dee6;
  border-radius: var(--r-md);
  overflow: hidden;
}

.segbtn {
  padding: 3px var(--sp-2);
  font-size: var(--fs-sm);
  background: var(--card);
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
  margin: var(--sp-2);
  font-size: var(--fs-md);
}

.stat {
  padding: 2px 8px;
  border-radius: var(--r-md);
  background: #f4f6f8;
}

.stat em {
  font-style: normal;
  color: #94a3b8;
  font-size: var(--fs-xs);
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
  font-size: var(--fs-sm);
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
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.slotchip {
  padding: 1px 8px;
  border: 1px solid #d8dee6;
  border-radius: 10px;
  background: var(--card);
  font-size: var(--fs-xs);
  color: #475569;
  cursor: pointer;
}

.slotchip.on {
  border-color: var(--brand);
  background: var(--brand-wash);
  color: var(--brand-ink);
}

/*
 * 名单区自己滚，页面不滚 —— 这样页头（点名胶囊、随机点名）和上面那条统计
 * 永远在屏幕上。60 人的班一屏放不下，以前整页滚，点完一个人要滚回顶上去看统计。
 * 300px 是「页头 + 两行 bar + 内边距」的实测高度，留了些余量。
 */
/*
 * 名单区吃掉剩下的高度，自己滚。页面本身不滚（body-class="fit"），
 * 所以页头、点名胶囊、上面那条统计永远不会被滚走。
 * 不要再写 max-height：那是按视口硬算的，页头一变高就错。
 */
/* 网格本身不再管滚动 —— 外层 .scroll-body 才是滚动容器（见 .content.ws.fixed-top） */
.roster {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
  gap: 8px;
  padding-bottom: 8px;
}

/* 右栏：本节异常。卡片撑满整栏，列表自己滚，底部说明钉住 */
.abn {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.abn-tip {
  flex: none;
  margin: var(--sp-2) 0 0;
  padding-top: var(--sp-2);
  border-top: 1px dashed var(--line);
  line-height: 1.5;
}

/* 右栏空态：标题一句 + 说明一句，说清「这里什么时候会有东西」 */
.abn-empty {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-3) var(--sp-1);
  line-height: 1.6;
  border-bottom: none;
}
.abn-empty b {
  font-weight: 600;
  color: var(--ink);
  font-size: var(--fs-md);
}
.abn-empty span {
  font-size: var(--fs-sm);
  color: var(--dim);
}
.abn li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: var(--sp-1) 0;
  font-size: var(--fs-sm);
  border-bottom: 1px solid var(--line-soft);
}
.abn li:last-child {
  border-bottom: none;
}
.abn li b {
  font-weight: 500;
  color: var(--ink);
}

.stu {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 8px var(--sp-2);
  border: 1px solid #d8dee6;
  border-left-width: 4px;
  border-radius: var(--r-sm);
  background: var(--card);
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
  font-size: var(--fs-md);
  color: #1f2937;
}

.stu .sid {
  font-size: var(--fs-xs);
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}

.stu .mark {
  font-size: var(--fs-xs);
  color: #475569;
}

.stu .score {
  font-size: var(--fs-xs);
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
  padding: var(--sp-2) 8px;
}

.kbtn {
  padding: 2px var(--sp-2);
  border: 1px solid #d8dee6;
  border-radius: var(--r-md);
  background: var(--card);
  font-size: var(--fs-sm);
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
  font-size: var(--fs-md);
}
</style>
