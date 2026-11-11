<template>
  <!--
    学生端「点名」大屏浮层：老师抽到谁，这里整屏显示谁。
      · 考勤点名（kind=attend）：核对人是否在场
      · 课堂互动（kind=interact）：抽到的人等老师提问（不写「请回答」——
        有时候点名人只是想让人站起来，问题还没出口）
    抽到自己时整块变成青蓝并放大，一眼就知道是自己。
  -->
  <transition name="spot">
    <div v-if="show" class="spot" :class="[kind, { mine, locked }]" @click="onClickMask">
      <div class="spot-card" :class="{ rolling }">
        <p class="spot-k">{{ title }}</p>
        <p class="spot-name" :class="{ flash: rolling }">{{ shownName }}</p>
        <!-- 结果没出来之前不露学号：滚动的意义就是「不知道是谁」 -->
        <template v-if="revealed">
          <!-- 同名同学不少见，学号一起显示才认得出是谁 -->
          <p v-if="sid" class="spot-sid">{{ sid }}</p>
          <p class="spot-hint">{{ hint }}</p>
          <p class="spot-meta">
            <span v-if="seq" class="seq">第 {{ seq }} / {{ total }} 人</span>
            <span v-if="mine" class="me">就是你</span>
            <span v-if="locked" class="lock">等老师结束这次点名</span>
            <span v-else class="dim">点一下可关闭</span>
          </p>
        </template>
        <p v-else class="spot-hint rolling-hint">正在抽人…</p>
      </div>
    </div>
  </transition>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getToken } from '../api'
import { api } from '../api'
import { onPresenceMessage } from '../utils/presence'
import { state } from '../store'

const show = ref(false)
const kind = ref('attend')
const sid = ref('')
const name = ref('')
const seq = ref(0)
const total = ref(0)
const shownName = ref('') // 屏幕上显示的名字（滚动时不断变，停下就是结果）
const revealed = ref(false) // 结果是否已经揭晓（揭晓前不显示学号 / 提示 / 徽标）
const rolling = ref(false) // 正在滚动
let rollTimer = null
let lastAt = 0
const label = ref('')
const locked = ref(true)

let timer = null
let off = null

const mySid = computed(() => (state.student && state.student.sid) || '')
// 滚动过程中不算「我」：不然整块会提前变成青蓝色，等于提前暴露答案
const mine = computed(() => revealed.value && !!mySid.value && mySid.value === sid.value)

const title = computed(() => {
  if (label.value) return label.value
  return kind.value === 'interact' ? '课 堂 点 名' : '考 勤 核 对'
})

/* 提示只说「现在该干什么」，不预设问题已经问过了 */
const hint = computed(() => {
  if (kind.value === 'interact') return mine.value ? '准备一下，老师要提问' : '准备回答问题'
  return mine.value ? '请在座位上应一声' : '老师在核对到场情况'
})

function dismiss() {
  if (locked.value) return // 老师锁着：点不掉，等它自己结束
  show.value = false
  if (timer) clearTimeout(timer)
  timer = null
}

function onClickMask() {
  dismiss()
}

/**
 * 广播与「刷新后拉取」共用同一套字段。
 * @param {object} msg 服务端消息
 * @param {boolean} live true = 刚抽出来的（要滚动），false = 刷新后接回来的（直接显示结果）
 */
function applySpot(msg, live) {
  kind.value = msg.kind === 'interact' ? 'interact' : 'attend'
  sid.value = msg.sid || ''
  name.value = msg.name || ''
  seq.value = Number(msg.seq) || 0
  total.value = Number(msg.total) || 0
  label.value = msg.label || ''
  locked.value = msg.lock !== false
  show.value = true

  // 同一条消息（广播 + 拉取各来一次）不要重复滚
  const at = Number(msg.at) || 0
  const dup = at && at === lastAt
  lastAt = at || lastAt

  const pool = Array.isArray(msg.pool) ? msg.pool.filter(Boolean) : []
  if (live && !dup && name.value && pool.length >= 4 && !prefersStill()) {
    startRoll(pool, name.value)
  } else {
    stopRoll()
    shownName.value = name.value
    revealed.value = true
  }

  if (timer) clearTimeout(timer)
  // 锁定时等老师「结束」；但老师万一忘了点就关了页面，5 分钟兜底收起（服务端同样 5 分钟失效）
  timer = setTimeout(() => (show.value = false), locked.value ? 5 * 60 * 1000 : 15000)
}

/** 系统开了「减少动态效果」就别滚了，直接给答案 */
function prefersStill() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  } catch (e) {
    return false
  }
}

/**
 * 名字快速滚动 → 逐渐变慢 → 停在被抽中的人。
 * 总时长约 1.1 秒，间隔从 45ms 逐渐拉到 ~170ms（越接近答案越慢，才有「摇奖」的手感）。
 */
function startRoll(pool, finalName) {
  stopRoll()
  rolling.value = true
  revealed.value = false
  const totalMs = 1100
  const t0 = Date.now()
  let last = ''

  const tick = () => {
    const passed = Date.now() - t0
    if (passed >= totalMs) {
      shownName.value = finalName
      rolling.value = false
      revealed.value = true
      rollTimer = null
      return
    }
    // 随机取一个，尽量避免和上一帧一样（连读同一个名字会像卡住）
    let next = pool[Math.floor(Math.random() * pool.length)]
    if (next === last && pool.length > 1) next = pool[(pool.indexOf(next) + 1) % pool.length]
    last = next
    shownName.value = next

    const p = passed / totalMs
    const delay = 45 + 130 * p * p // 越到后面越慢
    rollTimer = setTimeout(tick, delay)
  }

  shownName.value = pool[0]
  rollTimer = setTimeout(tick, 45)
}

function stopRoll() {
  if (rollTimer) clearTimeout(rollTimer)
  rollTimer = null
  rolling.value = false
}

function onMsg(msg) {
  if (!msg) return
  /*
   * 兜底：老师切到了别的动作（讲义跟随 / 推代码），这个点名浮层必须让位。
   * 正常情况下服务端会先发 spotlight clear，走下面那条分支；
   * 但两类消息是两次广播，中间有个毫秒级窗口，万一 clear 丢了（弱网、重连），
   * 学生屏幕上就会一直挂着一个早就结束的点名。focus 这条是最后一道保险。
   */
  if (msg.t === 'focus' && msg.active !== 'spotlight') {
    locked.value = false
    dismiss()
    return
  }
  if (msg.t !== 'spotlight') return
  if (msg.clear) {
    locked.value = false
    dismiss()
    return
  }
  applySpot(msg, true)
}

onMounted(() => {
  if (!getToken()) return // 游客：这个组件用不到（点名信息要登录）
  off = onPresenceMessage(onMsg)
  // 刷新 / 晚进教室：问一次服务端「这一班现在点到谁」，有就接着显示
  api
    .get('/api/spotlight')
    .then((res) => {
      const sp = res && res.spotlight
      if (sp && sp.sid) applySpot(sp, false)
    })
    .catch(() => {})
})

onUnmounted(() => {
  if (off) off()
  if (timer) clearTimeout(timer)
  stopRoll()
})
</script>

<style scoped>
.spot {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: 4vh 4vw;
  background: rgba(14, 18, 22, 0.9);
  backdrop-filter: blur(3px);
  cursor: pointer;
}

.spot-card {
  width: min(1100px, 92vw);
  padding: 8vh 6vw 7vh;
  border-radius: 18px;
  background: #23272c;
  border: 2px solid #3d4650;
  color: #f2f5f7;
  text-align: center;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
  animation: spot-in 0.26s cubic-bezier(0.2, 0.9, 0.3, 1);
}

/* 课堂点名用青蓝边框，考勤核对用中性灰：远处也能分清是在做什么 */
.spot.interact .spot-card {
  border-color: #2f7d92;
  box-shadow: 0 0 0 2px rgba(47, 125, 146, 0.35), 0 30px 80px rgba(0, 0, 0, 0.55);
}

/* 抽到自己：整块变青蓝 + 呼吸光晕 */
.spot.mine .spot-card {
  background: #1d3d47;
  border-color: #5ec3dd;
  animation: spot-in 0.26s cubic-bezier(0.2, 0.9, 0.3, 1), spot-pulse 1.8s ease-in-out infinite;
}

.spot-k {
  margin: 0 0 2.2vh;
  font-size: clamp(19px, 2vw, 26px);
  letter-spacing: 0.7em;
  text-indent: 0.7em;
  color: #93a7b6;
  text-transform: none;
}

.spot.mine .spot-k {
  color: #a7e0ef;
}

.spot-name {
  margin: 0;
  font-size: clamp(72px, 11vw, 132px);
  line-height: 1.08;
  font-weight: 700;
  letter-spacing: 0.06em;
  /* 名字长短不一，滚动时高度会跳：给个最小高度锁住版面 */
  min-height: 1.1em;
}

/* 滚动中：轻微发虚 + 呼吸，营造「还没定」的感觉；停下来的瞬间自然清晰 */
.spot-name.flash {
  animation: spot-flash 0.22s linear infinite;
}

@keyframes spot-flash {
  0% {
    opacity: 0.55;
    transform: translateY(0.01em) scale(0.995);
  }
  50% {
    opacity: 1;
    transform: translateY(-0.005em) scale(1);
  }
  100% {
    opacity: 0.55;
    transform: translateY(0.01em) scale(0.995);
  }
}

/* 滚动期间卡片边框也跟着呼吸一下，远看也知道「在抽」 */
.spot-card.rolling {
  animation: spot-in 0.26s cubic-bezier(0.2, 0.9, 0.3, 1), spot-rolling 1.1s ease-in-out infinite;
}

@keyframes spot-rolling {
  0%,
  100% {
    border-color: #3d4b57;
  }
  50% {
    border-color: #6f8b9c;
  }
}

.rolling-hint {
  color: #8a99a6 !important;
  letter-spacing: 0.12em;
}

/* 系统开了「减少动态效果」：不闪，直接给结果 */
@media (prefers-reduced-motion: reduce) {
  .spot-name.flash,
  .spot-card.rolling {
    animation: none;
  }
}

/* 学号：同名同学靠它区分，字号比姓名小一档但仍然远看得清 */
.spot-sid {
  margin: 1.6vh 0 0;
  font-size: clamp(20px, 2.2vw, 30px);
  letter-spacing: 0.18em;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  color: #9fb0bd;
}

.spot.mine .spot-sid {
  color: #bfe6f2;
}

.spot-hint {
  margin: 2.4vh 0 0;
  font-size: clamp(16px, 1.9vw, 24px);
  color: #b9c6d1;
}

.spot.mine .spot-hint {
  color: #cdeef7;
  font-weight: 600;
}

.spot-meta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin: 3vh 0 0;
  font-size: clamp(13px, 1.2vw, 17px);
  color: #7d8792;
}

.spot-meta .seq {
  font-variant-numeric: tabular-nums;
}

.spot-meta .lock {
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid #4a5560;
  color: #9fb0bd;
  font-size: clamp(12px, 1.1vw, 15px);
}

/* 锁定时给出「点不掉」的视觉暗示：光标不变成手 */
.spot.locked {
  cursor: default;
}

.spot-meta .me {
  padding: 4px 14px;
  border-radius: 999px;
  background: #4fb3cc;
  color: #06222b;
  font-weight: 700;
  font-size: clamp(13px, 1.2vw, 16px);
  letter-spacing: 0.08em;
}

@keyframes spot-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.97);
  }
}

@keyframes spot-pulse {
  50% {
    box-shadow: 0 0 0 3px rgba(94, 195, 221, 0.45), 0 30px 80px rgba(0, 0, 0, 0.55);
  }
}

.spot-enter-active,
.spot-leave-active {
  transition: opacity 0.18s ease;
}

.spot-enter-from,
.spot-leave-to {
  opacity: 0;
}
</style>
