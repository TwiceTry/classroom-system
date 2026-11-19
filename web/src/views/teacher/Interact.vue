<template>
  <!-- ws：中栏名单 + 右栏记录；fixed-top：bar 和 picker 固定，只有名单滚 -->
  <PageShell body-class="ws fixed-top">
    <template #head>
      <PageHead @reload="() => reload(true)">
        <template #title>课堂互动</template>
        <!--
          副标题改放状态：这一场抽了几个、还剩几个没抽过。
          操作说明（抽人 → 提问 → 记分…）挪到 title。
        -->
        <template #sub>
          <span :title="'抽人 → 提问 → 记分：点快捷按钮会自动抽一个本轮没抽过的学生并记分。'">
            {{ intSub }}
          </span>
        </template>

        <!-- 专属区：点名相关。刷新走通用区的「↻」（重新抽一轮不影响当前抽到的人） -->
        <!--
          点名入口与状态合一：没点名时是「随机点名」按钮，点名中是「● 点名中 · 张三」胶囊。
          两者占同一个位置、同一个高度，所以页面不会因为点名而跳动。
          点胶囊打开弹窗；旁边的「结束」直接收掉。
        -->
        <template #right>
          <span class="tag mute">{{ itemName }} · 满分 {{ full }}</span>
          <button v-if="current" class="spot-chip" title="点开看这次点名" @click="spotOpen = true">
            <i class="dot"></i>点名中 · {{ current.name }}
          </button>
          <button v-else class="btn primary" :disabled="!activeId || drawing" @click="openSpot">
            {{ drawing ? '抽取中…' : '随机点名' }}
          </button>
          <button
            v-if="current"
            class="btn mini danger"
            title="收起学生端的点名提示（你自己这边的名单不动）"
            @click="endSpot"
          >
            结束
          </button>
        </template>
      </PageHead>
    </template>
    <p v-if="error" class="hint err">{{ error }}</p>

    <div class="card bar">
      <div class="classes">
        <button v-for="c in classes" :key="c.id" class="pill" :class="{ on: c.id === activeId }" @click="pick(c.id)">
          {{ c.name }}<span class="dim"> {{ c.studentCount ?? c.count ?? '' }} 人</span>
        </button>
        <span v-if="!classes.length" class="dim">还没有班级，先去「班级管理」建一个。</span>
      </div>
      <span class="spacer"></span>
      <span class="dim mini" v-if="activeId">
        本轮已抽 {{ roll.pickedCount }} 人 · 还剩 {{ roll.remaining }} 人 · 在线 {{ onlineCount }}
      </span>
    </div>

    <!--
      这里原来有一张 .card.picker：抽到谁 + 一排快捷加分 + 自定义分值，占 107px。
      但「抽到谁」弹窗里有大字、「快捷加分」名单表每行都有、
      自定义分值刚搬进弹窗了 —— 三处都在说同一件事，删掉。
      现在抽到的人只在页头那颗「点名中 · 张三」胶囊上，点开就是弹窗。
    -->

    <!-- 中栏：名单（主滚动区）。上面那条 bar 固定不动 -->
    <div class="scroll-body">
    <section class="card">
      <CardHead>
        <template #title>名单 · {{ students.length }}</template>
        <span class="spacer"></span>
        <input v-model="search" class="input" placeholder="搜学号 / 姓名" style="width: 140px" />
      </CardHead>
      <DataTable
        :columns="listCols"
        :rows="visible"
        row-key="sid"
        :row-class="(row) => ({ hl: current && current.sid === row.sid })"
        :empty="'这个班还没有名单。'"
      >
        <template #cell-sid="{ row }"><span class="sid">{{ row.sid }}</span></template>
        <!-- 读 onlineMap（轮询来的实时状态），不读 row.online（reload 那一刻的快照） -->
      <template #cell-online="{ row }"><i class="dot" :class="{ on: onlineMap[row.sid] }"></i></template>
        <template #cell-score="{ row }"><span class="score">{{ row.score }}</span></template>
        <template #cell-count="{ row }"><span class="dim">{{ row.count }}</span></template>
        <template #cell-actions="{ row }">
          <button class="mini-btn" :disabled="busy" @click="add(row, 1)">+1</button>
          <button class="mini-btn" :disabled="busy" @click="add(row, 2)">+2</button>
          <button class="mini-btn danger" :disabled="busy" @click="add(row, -1)">−1</button>
        </template>
      </DataTable>
    </section>
    </div>

    <!-- 右栏：本次课记录。抄在名单右边，永远看得见，不用滚回去找 -->
    <template #right>
    <section class="card">
      <CardHead>
        <template #title>本次课记录</template>
      </CardHead>
      <EventFeed
        :items="recent"
        empty-title="这一项还没有记录"
        empty-text="在名单里点 +1 / −1 记分，这里会实时出现流水，点 × 能撤回。"
        @undo="undo"
      >
        <!-- 只到分：右栏 210px，秒会把「抢答加分」这种原因挤掉 -->
        <template #at="{ row }">{{ clock(row.at).slice(0, 5) }}</template>
      </EventFeed>
    </section>
    </template>


    <!--
      点名弹窗（形态照搬「考勤点名」的核对弹层）：
      抽到人自动打开，一眼看清「谁被点了 / 学生端在显示 / 点结束收掉」。

      关掉弹窗 ≠ 结束点名：关掉只是自己这边不挡视线，学生端还开着，
      顶部那条「点名中」还在 —— 想真结束必须点弹窗头上或状态条里的「结束点名」。
    -->
    <RollCallModal
      v-model="spotOpen"
      title="课堂点名"
      :subtitle="itemName + ' · 学生端同步显示'"
      :who="spotWho"
      :picked="roll.pickedCount"
      :total="students.length"
      :remaining="roll.remaining"
      :online="onlineCount"
      :locked="spotLock"
      :busy="busy"
      :drawing="drawing"
      :can-reset="!!activeId"
      end-title="收起学生端点名提示，本轮已抽过的人保留"
      empty-text="还没抽人。点右下「下一个」随机抽一个本轮没抽过的学生。"
      @update:locked="setSpotLock"
      @end="endSpot"
      @next="nextSpot"
      @reset="resetRoll"
    >
      <!--
        业务按钮：这一页是「加分」，考勤那页是「判考勤」。
        原来页面上还有一张 picker 卡片放同样的按钮 + 自定义分值 ——
        和这里的按钮、和名单表每行的 +1 +2 −1 三重重复，还占 107px 高度。
        卡片删了，把只有它才有的「自定义分值」搬进来。
      -->
      <template #actions>
        <button
          v-for="p in presets"
          :key="p.label"
          class="kbtn"
          :class="{ minus: (p.delta || 0) < 0 }"
          :disabled="busy"
          @click="quick(p)"
        >
          {{ p.label }}
        </button>
        <span class="custom-act">
          <input
            v-model.number="customDelta"
            type="number"
            step="1"
            class="input"
            title="自定义分值，正负都行"
          />
          <button
            class="kbtn"
            :disabled="busy || !customDelta"
            @click="quick({ label: '自定义', delta: customDelta })"
          >
            记
          </button>
        </span>
      </template>
    </RollCallModal>

    <Toast :text="toast" />
  </PageShell>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { api } from '../../api'
import Toast from '../../components/Toast.vue'
import { currentClassId, setClassId } from '../../utils/classSel'
import { spotLock, setSpotLock } from '../../utils/spotlight'
import PageHead from '../../components/PageHead.vue'
import DataTable from '../../components/DataTable.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'
import RollCallModal from '../../components/RollCallModal.vue'
import EventFeed from '../../components/EventFeed.vue'

/** 方案里没配预设时的兜底按钮（还能用下面的自定义分值） */
const FALLBACK_PRESETS = [
  { label: '发言 +1', delta: 1 },
  { label: '上台演示 +2', delta: 2 },
  { label: '课堂违纪 −1', delta: -1 },
]

const props = defineProps({
  itemKey: { type: String, default: '' },
})

const classes = ref([])
const activeId = ref('')
const students = ref([])

/**
 * 在线状态单独存一份，和考勤页同一套做法。
 *
 * 为什么不能直接用 students[i].online：
 *   students 是 reload() 时整批换掉的，而 reload 只在切班、点完名之后调 ——
 *   学生中途连上 / 掉线，页面根本不会重拉，那些点就一直是打开页面那一刻的样子。
 *   /presence 是轻量的（只回 sid 列表），单独轮询它，10 秒一次。
 */
const onlineMap = reactive({})
let presenceTimer = null
const presets = ref([])
const recent = ref([])
const roll = reactive({ pickedCount: 0, remaining: 0 })
const itemName = ref('课堂互动')
const full = ref(10)
const current = ref(null)
const search = ref('')
const customDelta = ref(1)
const busy = ref(false)

/*
 * 给 RollCallModal 的归一化数据。
 * 考勤页那边「分数」是考勤状态、这边是互动分，组件不猜业务含义，
 * 只显示调用方拼好的 scoreText。
 */
const spotWho = computed(() => {
  const c = current.value
  if (!c) return null
  return {
    name: c.name || '',
    sid: c.sid || '',
    online: !!c.online,
    scoreText: '互动 ' + (c.score === undefined ? 0 : c.score) + ' / ' + full.value,
  }
})

/* 名单表 */
/*
 * 列的顺序照「老师认人的顺序」排，不照数据库字段排。
 *
 * 原来学号在最左（104px 的 10 位数字），姓名排在它右边 ——
 * 可互动时老师认的是脸和名字，学号只在重名时才需要。
 * 现在姓名第一列、加粗放大；学号退到第二列、弱一档。
 *
 * 这和考勤页的格子是同一套优先级（姓名 > 状态/分数 > 学号），
 * 所以老师在两个页面之间来回切时，眼睛落点是一致的。
 */
const listCols = [
  { key: 'name', label: '姓名', width: '96px', tdClass: 'who' },
  { key: 'sid', label: '学号', width: '104px', tdClass: 'sidcol' },
  { key: 'online', label: '在线', num: true, width: '52px' },
  /* 次数在分数左边：老师心里数的是「我点过他几次」，分是它算出来的结果 */
  { key: 'count', label: '次数', num: true, width: '46px' },
  { key: 'score', label: '互动分', num: true, width: '62px', tdClass: 'score' },
  { key: 'actions', label: '当场记', width: '132px' },
]
const drawing = ref(false)
/* 点名弹窗开着没（只是自己这边挡不挡视线，与「点名是否结束」是两回事） */
const spotOpen = ref(false)
const error = ref('')
const toast = ref('')

/* 统计也跟着 onlineMap 走 —— 否则会出现「列表全暗、上面写着在线 6」 */
const onlineCount = computed(() => students.value.filter((s) => onlineMap[s.sid]).length)

/**
 * 页头副标题：这一场互动到哪一步了。
 *
 * 例：`已抽 3 人 · 还剩 54 · 在线 12`
 * 老师关心的是「还有谁没被抽到」，不是「这个页面怎么操作」。
 */
const intSub = computed(() => {
  if (!students.value.length) return '这个班还没有名单'
  const total = students.value.length
  const picked = Number(roll.pickedCount || 0)
  const parts = ['已抽 ' + picked + ' 人']
  /* 抽过一轮之后 remaining 会回到总数，「还剩」就没意义了 */
  if (picked > 0 && picked < total) parts.push('还剩 ' + (total - picked))
  parts.push('在线 ' + onlineCount.value + ' / ' + total)
  return parts.join(' · ')
})
const visible = computed(() => {
  const q = search.value.trim()
  return q ? students.value.filter((s) => s.sid.indexOf(q) >= 0 || s.name.indexOf(q) >= 0) : students.value
})

function show(text) {
  toast.value = text
  setTimeout(() => {
    if (toast.value === text) toast.value = ''
  }, 2200)
}

function clock(iso) {
  const d = new Date(iso)
  return isNaN(d) ? '' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function url(suffix) {
  return '/api/classes/' + encodeURIComponent(activeId.value) + suffix
}

function withItem(path) {
  if (!props.itemKey) return path
  return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'itemKey=' + encodeURIComponent(props.itemKey)
}

async function loadClasses() {
  const res = await api.get('/api/classes')
  classes.value = res.items || []
  if (currentClassId.value && classes.value.some((c) => c.id === currentClassId.value)) {
    activeId.value = currentClassId.value
  }
  if (!activeId.value && classes.value.length) activeId.value = classes.value[0].id
  if (activeId.value) setClassId(activeId.value)
}

async function reload(keepCurrent) {
  if (!activeId.value) return
  error.value = ''
  try {
    const res = await api.get(withItem(url('/interact')))
    students.value = res.students || []
    presets.value = res.presets && res.presets.length ? res.presets : FALLBACK_PRESETS
    recent.value = res.recent || []
    itemName.value = res.itemName || '课堂互动'
    full.value = res.full || 10
    roll.pickedCount = (res.roll && res.roll.pickedCount) || 0
    roll.remaining = (res.roll && res.roll.remaining) || 0
    if (!keepCurrent) current.value = null
    else if (current.value) current.value = students.value.find((s) => s.sid === current.value.sid) || null
  } catch (e) {
    error.value = e.message
  }
}

/** 在线状态单独取（学生心跳会变，而名单不是每次都重拉） */
async function loadPresence() {
  if (!activeId.value) return
  try {
    const res = await api.get(url('/presence'))
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
  current.value = null
  /* 换班之后名单整批换了，在线状态要立刻跟着换一次，别等下一轮轮询 */
  reload().then(loadPresence)
}

/** 抽一个人（本轮不重复） */
async function drawOne() {
  const res = await api.post(url('/rollcall/draw'), { count: 1, exclude: true, lock: spotLock.value })
  const who = (res.drawn || [])[0]
  if (!who) return null
  /* 抽到了但浮层没推下去（有学生在考试时点名被挡）——必须告诉老师 */
  if (res.blocked) {
    const k = res.focus && res.focus.kind
    show(k === 'exam' ? '有学生正在考试，点名浮层没有推到学生端' : '学生端被别的状态占着，点名浮层没推下去')
  }
  current.value = students.value.find((s) => s.sid === who.sid) || { sid: who.sid, name: who.name, score: 0, count: 0, online: false }
  roll.pickedCount = res.pickedCount === undefined ? roll.pickedCount : res.pickedCount
  roll.remaining = res.remaining === undefined ? roll.remaining : res.remaining
  return current.value
}

async function drawOnly() {
  drawing.value = true
  try {
    const who = await drawOne()
    if (who) show('抽到：' + who.name)
    return who
  } catch (e) {
    error.value = e.message
    return null
  } finally {
    drawing.value = false
  }
}

/**
 * 「随机点名」按钮：打开点名弹窗，没有当前人就先抽一个。
 *
 * 点完弹窗立刻出现 —— 不能让老师点完只看到页面里那张卡片变了个名字，
 * 而不知道学生端已经弹出提示了、也不知道要点「结束」收掉。
 */
async function openSpot() {
  spotOpen.value = true
  if (!current.value) await drawOnly()
}

/** 弹窗里的「下一个 ›」：再抽一个，弹窗保持开着 */
async function nextSpot() {
  await drawOnly()
  spotOpen.value = true
}

/** 快捷按钮：没人就抽一个，然后加分 */
async function quick(p) {
  if (busy.value) return
  busy.value = true
  try {
    let target = current.value
    if (!target) target = await drawOne()
    if (!target) {
      show('全班都抽过了，点「重置抽取」再来一轮')
      return
    }
    await give(target, p.delta || 0, p.label)
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function add(s, delta) {
  if (busy.value) return
  busy.value = true
  try {
    await give(s, delta, delta > 0 ? '互动 +' + delta : '互动 ' + delta)
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

/** 真正写一条互动记录（reason 必填时用按钮文字顶上） */
async function give(s, delta, label) {
  if (!delta) return
  const body = {
    sid: s.sid,
    item: itemKey.value,
    delta,
    reason: label || '课堂互动',
  }
  const before = Number((students.value.find((x) => x.sid === s.sid) || {}).score) || 0
  await api.post(url('/events'), body)
  await reload(true)
  const hit = students.value.find((x) => x.sid === s.sid)
  current.value = hit || current.value

  const after = Number(hit ? hit.score : 0)
  const cap = Number(full.value) || 0
  /*
   * 加分顶到满分时，分数不会涨，但次数会 +1。
   * 不说清楚的话，老师看到「怎么没加」会连着点好几下 —— 分数没变，
   * 「次数」却一路涨，事后再看记录会莫名其妙。
   */
  if (delta > 0 && cap > 0 && after >= cap && after <= before + 1e-9) {
    show(s.name + ' 已经是满分 ' + cap + ' 了，分数加不上去（这一下只记了一次）')
    return
  }

  show(s.name + ' ' + (delta > 0 ? '+' + delta : delta) + '（' + (hit ? hit.score : '?') + ' / ' + full.value + '）')
}

async function undo(r) {
  try {
    await api.post(url('/events/' + encodeURIComponent(r.id) + '/void'), {})
    await reload(true)
    show('已撤销 ' + r.name + ' 的那一条')
  } catch (e) {
    error.value = e.message
  }
}

/** 结束这次点名：收起学生端浮层（服务端清状态 + 广播 clear），本轮抽过的人保持不变 */
async function endSpot() {
  try {
    await api.post(url('/spotlight'), { clear: true })
    current.value = null
    spotOpen.value = false
    show('已结束点名，学生端提示已收起')
  } catch (e) {
    error.value = e.message
  }
}

/** 刷新后：把上次点名的那个人接回来（服务端存着 latest spotlight） */
async function restoreSpot() {
  try {
    const res = await api.get(url('/spotlight'))
    const sp = res && res.spotlight
    if (!sp || sp.kind !== 'interact' || !sp.sid) return
    const hit = students.value.find((x) => x.sid === sp.sid)
    if (hit) current.value = hit
  } catch (e) {
    /* 忽略 */
  }
}

async function resetRoll() {
  try {
    /* kind=interact：只清课堂互动这一份「已抽过」，不动考勤的 */
    await api.post(url('/rollcall/reset'), { kind: 'interact' })
    current.value = null
    await reload()
    show('已重置抽取（全班重新参与）')
  } catch (e) {
    error.value = e.message
  }
}

const itemKey = computed(() => props.itemKey || 'interact')

onMounted(async () => {
  await loadClasses()
  await reload()
  await restoreSpot()
  await loadPresence()
  /* 10 秒一次，和考勤页同频 —— 学生连上/掉线不用手动刷新就能看到 */
  presenceTimer = setInterval(loadPresence, 10000)
})

onUnmounted(() => {
  if (presenceTimer) clearInterval(presenceTimer)
})
</script>

<style scoped>
/*
 * 只排内部，不碰外边距 —— 这个元素的 class 是 `card bar`，
 * `.bar` 的 margin 会盖掉 `.card` 的，首卡比别的页往右/往上 8px。
 * 卡片外边距统一由 .card 负责。
 */
.bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.classes {
  display: flex;
  gap: var(--sp-2);
  flex-wrap: wrap;
  flex: 1;
  min-width: 200px;
}

.spacer {
  flex: 1;
}

/*
 * 抽到谁 + 快捷加分这一块是全页的**主动作**，但它和下面那张白底名单表
 * 长得一模一样 —— 一片白、一片灰线，眼睛没有落点。
 * 给一块浅浅的底色把它托起来：这是"现在正在做的事"，
 * 下面的表格是"参考数据"，两者本来就该分层。
 */
/*
 * 弹窗里那组「自定义分值 + 记」。
 * 它作为一个整体占 .rcm-actions 的一格（那里是等宽 grid），
 * 所以内部用 flex 排，别让 input 把格子撑开。
 */
.custom-act {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.custom-act .input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 var(--sp-2);
  text-align: center;
}
.custom-act .kbtn {
  flex: none;
  width: 38px;
  padding: 0;
}

/*
 * 名单区自己滚，页面不滚。
 *
 * 60 人的表有 2400px 高，以前整页滚 —— 老师滚下去找人，页头的点名胶囊、
 * 上面「抽到谁 + 快捷加分」全跑出屏幕，点一个人要来回滚两趟。
 * 现在只有这块滚，上面永远在。
 * 300px = 页头 + bar + picker + 内边距（实测）。
 */
/*
 * 名单区吃掉剩下的高度，自己滚（页面本身不滚，body-class="fit"）。
 * 左边表格和右边信息栏各自 overflow，互不影响。
 * 不要写 max-height：按视口硬算，页头一变高就错位。
 */
.split {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 12px;
  align-items: stretch;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding-right: 2px;
  padding-bottom: 16px;
}

.split > * {
  min-height: 0;
  overflow: auto;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.grid tr.hl {
  background: #fffbeb;
}

.grid td.score {
  font-weight: 600;
}

/*
 * 姓名列：互动时老师认的是脸和名字，这一列该最重。
 * 用 --fs-lg(15) 而不是考勤格子那档 17 —— 表格一行 40px 高，
 * 17 会把行撑开，一屏少看四五个人。差这两像素换来多看见几个人更划算。
 *
 * **必须 :deep()**：这些 <td> 是 DataTable 子组件渲染的，
 * 拿不到 Interact 自己的 data-v 属性 —— 写成 `.grid td.who` 一条都不生效
 * （实测字号还是 13.5 / 字重 400，等于没改）。
 */
:deep(.grid td.who) {
  font-size: var(--fs-lg);
  font-weight: 600;
  letter-spacing: 0.2px;
  color: #111827;
}

/* 学号列：只在重名时才需要，弱一档、等宽对齐 */
:deep(.grid td.sidcol) {
  font-size: var(--fs-sm);
  color: #9aa5b4;
  font-variant-numeric: tabular-nums;
}

.grid .dot,
.who .dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #cbd5e1;
}

.grid .dot.on,
.who .dot.on {
  background: #16a34a;
  box-shadow: 0 0 0 2px #dcfce7;
}

/* 卡片撑满右栏，记录列表自己滚 —— 和班级管理、考勤那边保持一致 */
.recent {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.recent li {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) 2px;
  border-bottom: 1px dashed #eef1f5;
  font-size: var(--fs-sm);
}

.recent li.voided {
  opacity: 0.45;
  text-decoration: line-through;
}

.recent .d {
  font-weight: 600;
  color: #15803d;
}

.recent .d.minus {
  color: #b91c1c;
}

.recent .why {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

/* ---------------- 点名状态条 ---------------- */
.spotbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0 0 12px;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid #f0c9c4;
  border-left: 4px solid #c0392b;
  background: #fdf4f3;
  border-radius: var(--r-lg);
  font-size: var(--fs-md);
}
.spotbar b {
  color: #c0392b;
}
.spotbar .sb-who {
  font-variant-numeric: tabular-nums;
}
/* 跳动的小红点：静止的圆点在余光里看不见，动一下才注意得到 */
.spotbar .dot.on.pulse {
  animation: spot-pulse 1.4s ease-in-out infinite;
}
@keyframes spot-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(192, 57, 43, 0.45); }
  50% { opacity: 0.55; box-shadow: 0 0 0 5px rgba(192, 57, 43, 0); }
}

/* ---------------- 点名弹窗 ---------------- */
/* .mask / .modal / .modal-head / .modal-body 在 styles/app.css 里是全局的，这里只补差异 */
.spotbox {
  max-width: 560px;
}
.spotwho {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  padding: 4px 0 16px;
}
.spotwho .wname {
  font-size: 30px;
  font-weight: 600;
  letter-spacing: 1px;
  line-height: 1.1;
}
.spotwho .wsid {
  font-size: var(--fs-md);
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}
.spotwho .tag .dot {
  margin-right: 4px;
}
.drawbtns {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 0 var(--sp-4);
}
.kbtn {
  padding: var(--sp-2) 16px;
  border: 1px solid #cfe6cf;
  background: #f6fbf6;
  color: #2e7d32;
  border-radius: var(--r-lg);
  font-size: var(--fs-md);
  cursor: pointer;
}
.kbtn:hover:not(:disabled) {
  background: #edf7ed;
}
.kbtn.minus {
  border-color: #f0c9c4;
  background: #fdf4f3;
  color: #c0392b;
}
.kbtn.minus:hover:not(:disabled) {
  background: #fae9e6;
}
.kbtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.drawfoot {
  border-top: 1px solid #eef0f2;
  padding-top: 12px;
}
.df-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: 8px;
}
.df-row:last-child {
  margin-bottom: 0;
}
</style>
