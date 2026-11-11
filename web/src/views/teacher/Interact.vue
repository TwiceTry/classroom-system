<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>课堂互动</template>
        <template #sub>抽人 → 提问 → 记分：点快捷按钮会自动抽一个本轮没抽过的学生并记分，
          抽到谁学生端同步弹「课堂点名」；也能在名单里直接加减分，实时写进「{{ itemName }}」。</template>
        <template #right>
          <span class="tag mute">{{ itemName }} · 满分 {{ full }}</span>
          <button class="btn mini" :disabled="!activeId" @click="resetRoll">重置抽取</button>
          <label class="check" title="锁定时学生点不掉弹窗，必须等你重置或换人">
            <input
              type="checkbox"
              :checked="spotLock"
              @change="setSpotLock($event.target.checked)"
            />
            学生端锁定
          </label>
          <!--
            原来这里是 :disabled="!activeId" —— activeId 是「当前选的班级」，
            只要选了班就一直可点，哪怕根本没在点名。改成按「有没有正在点名的人」判断，
            并且进行中时变红，一眼看得出「现在有个点名没结束」。
          -->
          <button
            class="btn mini"
            :class="{ danger: !!current }"
            :disabled="!current"
            :title="current ? '收起学生端的点名提示（你自己这边的名单不动）' : '现在没有进行中的点名'"
            @click="endSpot"
          >
            结束点名
          </button>
          <button class="btn primary" :disabled="!activeId || drawing" @click="openSpot">
            {{ drawing ? '抽取中…' : '随机点名' }}
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
      点名状态条。
      老师上课时会切到名单 / 记录那边去，回头就忘了「学生端那个弹窗还开着吗、
      要不要收」—— 之前没有任何标记，只能凭记忆。这里给一条显眼的提示 + 结束按钮。
    -->
    <div v-if="current" class="spotbar">
      <i class="dot on pulse"></i>
      <b>点名中</b>
      <span class="sb-who">{{ current.name }} · {{ current.sid }}</span>
      <span class="dim mini">{{ spotLock ? '学生端已锁定，等你结束' : '学生端显示中' }}</span>
      <span class="spacer"></span>
      <button class="btn mini" @click="spotOpen = true">看点名</button>
      <button class="btn mini danger" @click="endSpot">结束点名</button>
    </div>

    <!-- 抽到的人 + 快捷加减分 -->
    <div class="card picker">
      <div class="who" :class="{ none: !current }">
        <template v-if="current">
          <i class="dot" :class="{ on: current.online }"></i>
          <b>{{ current.name }}</b>
          <span class="sid">{{ current.sid }}</span>
          <span class="tag ok">互动 {{ current.score }} / {{ full }}</span>
        </template>
        <template v-else>
          <span class="dim">点下面任一按钮 → 自动抽一个没抽过的学生并记分；也可以先点「随机点名」再决定给多少分。</span>
        </template>
      </div>
      <div class="presets">
        <button
        v-for="p in presets"
        :key="p.label"
        class="pill big"
        :class="{ minus: (p.delta || 0) < 0 }"
        :disabled="busy"
        @click="quick(p)"
        >
        {{ p.label }}
      </button>
      <span class="custom">
        <input v-model.number="customDelta" type="number" step="1" class="input" style="width: 74px" />
        <button class="btn mini" :disabled="busy || !customDelta" @click="quick({ label: '自定义', delta: customDelta })">
          记这次
        </button>
      </span>
    </div>
    </div>

    <div class="split">
    <!-- 名单 -->
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
        <template #cell-online="{ row }"><i class="dot" :class="{ on: row.online }"></i></template>
        <template #cell-score="{ row }"><span class="score">{{ row.score }}</span></template>
        <template #cell-count="{ row }"><span class="dim">{{ row.count }}</span></template>
        <template #cell-actions="{ row }">
          <button class="mini-btn" :disabled="busy" @click="add(row, 1)">+1</button>
          <button class="mini-btn" :disabled="busy" @click="add(row, 2)">+2</button>
          <button class="mini-btn danger" :disabled="busy" @click="add(row, -1)">−1</button>
        </template>
      </DataTable>
    </section>

    <!-- 最近记录 -->
    <section class="card">
      <CardHead>
        <template #title>本次课记录</template>
      </CardHead>
      <ul class="recent">
        <li v-for="r in recent" :key="r.id" :class="{ voided: r.voided }">
          <b>{{ r.name }}</b>
          <span class="d" :class="{ minus: r.delta < 0 }">{{ r.delta > 0 ? '+' + r.delta : r.delta }}</span>
          <span class="why dim">{{ r.reason }}</span>
          <span class="spacer"></span>
          <span class="dim mini">{{ clock(r.at) }}</span>
          <button v-if="!r.voided" class="mini-btn danger" title="撤销这条" @click="undo(r)">×</button>
        </li>
        <li v-if="!recent.length" class="dim">还没有记录。</li>
      </ul>
    </section>
    </div>


    <!--
      点名弹窗（形态照搬「考勤点名」的核对弹层）：
      抽到人自动打开，一眼看清「谁被点了 / 学生端在显示 / 点结束收掉」。

      关掉弹窗 ≠ 结束点名：关掉只是自己这边不挡视线，学生端还开着，
      顶部那条「点名中」还在 —— 想真结束必须点弹窗头上或状态条里的「结束点名」。
    -->
    <div v-if="spotOpen" class="mask" @click.self="spotOpen = false">
      <div class="modal spotbox">
        <div class="modal-head">
          <h3>
            课堂点名 <span class="dim">{{ itemName }} · 学生端同步显示</span>
          </h3>
          <button
            class="btn mini"
            style="margin-left: auto"
            title="收起学生端点名提示，本轮已抽过的人保留"
            @click="endSpot"
          >
            结束点名
          </button>
        </div>
        <div class="modal-body">
          <p v-if="!current" class="empty">还没抽人。点右下「下一个」随机抽一个本轮没抽过的学生。</p>
          <template v-else>
            <div class="spotwho">
              <b class="wname">{{ current.name }}</b>
              <span class="wsid">{{ current.sid }}</span>
              <span class="tag" :class="current.online ? 'ok' : 'mute'">
                <i class="dot" :class="{ on: current.online }"></i>
                {{ current.online ? '在线' : '离线' }}
              </span>
              <span class="dim">互动 {{ current.score }} / {{ full }}</span>
            </div>
            <div class="drawbtns">
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
            </div>
          </template>

          <div class="drawfoot">
            <div class="df-row">
              <span class="dim">
                本轮已抽 {{ roll.pickedCount }} 人 · 还剩 {{ roll.remaining }} 人 · 在线 {{ onlineCount }}
              </span>
              <span class="spacer"></span>
              <label class="check" title="锁定时学生点不掉弹窗，必须等你点「结束」">
                <input
                  type="checkbox"
                  :checked="spotLock"
                  @change="setSpotLock($event.target.checked)"
                />
                学生端锁定
              </label>
            </div>
            <div class="df-row">
              <button class="btn mini" :disabled="!activeId" @click="resetRoll">从头开始</button>
              <span class="spacer"></span>
              <button class="btn mini" title="只收起弹窗，学生端的点名提示还开着" @click="spotOpen = false">
                先放着
              </button>
              <button class="btn primary" :disabled="!activeId || drawing" @click="nextSpot">
                {{ drawing ? '抽取中…' : '下一个 ›' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Toast :text="toast" />
  </PageShell>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../../api'
import Toast from '../../components/Toast.vue'
import { currentClassId, setClassId } from '../../utils/classSel'
import { spotLock, setSpotLock } from '../../utils/spotlight'
import PageHead from '../../components/PageHead.vue'
import DataTable from '../../components/DataTable.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'

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
const presets = ref([])
const recent = ref([])
const roll = reactive({ pickedCount: 0, remaining: 0 })
const itemName = ref('课堂互动')
const full = ref(10)
const current = ref(null)
const search = ref('')
const customDelta = ref(1)
const busy = ref(false)

/* 名单表 */
const listCols = [
  { key: 'sid', label: '学号', width: '104px' },
  { key: 'name', label: '姓名', width: '78px' },
  { key: 'online', label: '在线', num: true, width: '52px' },
  { key: 'score', label: '互动分', num: true, width: '62px', tdClass: 'score' },
  { key: 'count', label: '次数', num: true, width: '46px' },
  { key: 'actions', label: '当场记', width: '132px' },
]
const drawing = ref(false)
/* 点名弹窗开着没（只是自己这边挡不挡视线，与「点名是否结束」是两回事） */
const spotOpen = ref(false)
const error = ref('')
const toast = ref('')

const onlineCount = computed(() => students.value.filter((s) => s.online).length)
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

function pick(id) {
  if (id === activeId.value) return
  activeId.value = id
  setClassId(id)
  current.value = null
  reload()
}

/** 抽一个人（本轮不重复） */
async function drawOne() {
  const res = await api.post(url('/rollcall/draw'), { count: 1, exclude: true, lock: spotLock.value })
  const who = (res.drawn || [])[0]
  if (!who) return null
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
    await api.post(url('/rollcall/reset'), {})
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
})
</script>

<style scoped>
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

.spacer {
  flex: 1;
}

.picker {
  margin-bottom: 10px;
}

.who {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  min-height: 34px;
  margin-bottom: 10px;
}

.who b {
  font-size: 20px;
}

.who .sid {
  font-size: 12px;
  color: #94a3b8;
}

.who.none {
  font-size: 13px;
}

.presets {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pill.big {
  padding: 6px 14px;
  font-size: 13.5px;
}

.pill.minus {
  border-color: #fecaca;
  color: #b91c1c;
}

.custom {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
}

.split {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 12px;
  align-items: start;
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

.recent {
  list-style: none;
  margin: 0;
  padding: 0;
}

.recent li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 2px;
  border-bottom: 1px dashed #eef1f5;
  font-size: 12.5px;
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
  gap: 10px;
  margin: 0 0 12px;
  padding: 9px 14px;
  border: 1px solid #f0c9c4;
  border-left: 4px solid #c0392b;
  background: #fdf4f3;
  border-radius: 8px;
  font-size: 13.5px;
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
  gap: 10px;
  padding: 4px 0 16px;
}
.spotwho .wname {
  font-size: 30px;
  font-weight: 600;
  letter-spacing: 1px;
  line-height: 1.1;
}
.spotwho .wsid {
  font-size: 13px;
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
  padding: 0 0 18px;
}
.kbtn {
  padding: 9px 16px;
  border: 1px solid #cfe6cf;
  background: #f6fbf6;
  color: #2e7d32;
  border-radius: 8px;
  font-size: 14px;
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
  gap: 10px;
  margin-bottom: 8px;
}
.df-row:last-child {
  margin-bottom: 0;
}
</style>
