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
          <button class="btn mini" :disabled="!activeId" title="收起学生端的点名提示（你自己这边的名单不动）" @click="endSpot">
            结束点名
          </button>
          <button class="btn primary" :disabled="!activeId || drawing" @click="drawOnly">
            {{ drawing ? '抽取中…' : '随机点名' }}
          </button>
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
      <span class="spacer"></span>
      <span class="dim mini" v-if="activeId">
        本轮已抽 {{ roll.pickedCount }} 人 · 还剩 {{ roll.remaining }} 人 · 在线 {{ onlineCount }}
      </span>
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
  roll.pickedCount = res.pickedCount
  roll.remaining = res.remaining
  return current.value
}

async function drawOnly() {
  drawing.value = true
  try {
    const who = await drawOne()
    if (who) show('抽到：' + who.name)
  } catch (e) {
    error.value = e.message
  } finally {
    drawing.value = false
  }
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
  await api.post(url('/events'), body)
  await reload(true)
  const hit = students.value.find((x) => x.sid === s.sid)
  current.value = hit || current.value
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
</style>
