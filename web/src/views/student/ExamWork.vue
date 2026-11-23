<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>{{ state.paper ? state.paper.title : '机试' }}</template>
        <template #sub><template v-if="state.paper">
            共 {{ totalCount }} 题 · 满分 {{ state.paper.fullScore }} 分
            <template v-if="state.paper.duration"> · 限时 {{ state.paper.duration }} 分钟</template>
          </template>
          <template v-else>开考后计时开始，答案随时自动保存</template></template>
        <template #right>
          <span v-if="state.paper && !submitted" class="tag" :class="left < 60 ? 'err' : 'ok'">{{ clockText }}</span>
          <span v-if="submitted" class="tag ok">已交卷</span>
          <!--
            「开始考试」按钮去掉了 —— 点进来就是要考，不该再确认一次。
            进来时自动调一次 start（见 onMounted），判不起就直接说原因。
          -->
          <button v-if="state.started && !submitted" class="btn primary" :disabled="busy" @click="submit">交卷</button>
          <router-link class="btn mini" :to="'/student/modules/' + itemKey">← 返回</router-link>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>

    <!--
      进不来时才显示这张卡。
      进来时已经自动调过一次 start（onMounted），所以这里说的不是「你去点一下」，
      而是「为什么没进来」—— 后端把原因写在 startErr 里（还没轮到你 / 已结束 / 没开始）。
    -->
    <div v-if="!state.started" class="card empty">
      <template v-if="busy">
        <b>正在出卷…</b> 马上就好
      </template>
      <template v-else-if="startErr">
        <b>{{ startErr }}</b>
        <p class="dim mini" style="margin: 6px 0 0">
          等老师放你进来之后刷新一下就好；如果是分批考试，轮到你那一批时会自动进来。
        </p>
      </template>
      <template v-else>老师还没开始这场机试，等一会儿再来。</template>
    </div>

    <template v-else>
      <div v-if="submitted" class="card result">
        <b>已交卷</b>
        <span v-if="score !== null">· 得分 {{ score }} 分</span>
        <button v-if="state.submitted" class="btn mini" style="margin-left: 8px" @click="openMine">
          我的答卷（打印版）
        </button>
        <span v-else>· 等老师判主观题</span>
        <span v-if="comment" class="dim">· 评语：{{ comment }}</span>
      </div>

      <section v-for="s in sections" :key="s.id" class="card sec">
        <CardHead>
          <template #title>{{ s.title }}</template>
          <template #meta><span class="dim mini">{{ s.questions.length }} 题 × {{ s.score }} 分</span></template>
        </CardHead>

        <article v-for="(q, qi) in s.questions" :key="q.id" class="q">
          <p class="stem"><b>{{ qi + 1 }}.</b> {{ q.stem }} <span class="dim mini">（{{ q.score }} 分）</span></p>

          <!-- 选择 -->
          <div v-if="s.type === 'choice'" class="opts">
            <label v-for="(o, oi) in q.options" :key="oi" class="opt" :class="{ on: answers[q.id] === letter(oi) }">
              <input
              type="radio"
              :name="q.id"
              :value="letter(oi)"
              :checked="answers[q.id] === letter(oi)"
              :disabled="submitted"
              @change="pick(q.id, letter(oi))"
              />
              {{ typeof o === 'string' ? o : o.text || o.label || o.key }}
              </label>
          </div>

          <!-- 判断 -->
          <div v-else-if="s.type === 'judge'" class="opts">
            <label v-for="v in ['对', '错']" :key="v" class="opt" :class="{ on: answers[q.id] === v }">
              <input type="radio" :name="q.id" :value="v" :checked="answers[q.id] === v" :disabled="submitted" @change="pick(q.id, v)" />
              {{ v }}
            </label>
          </div>

          <!-- 填空 -->
          <input
          v-else-if="s.type === 'fill'"
          class="input"
          style="max-width: 420px"
          :value="answers[q.id] || ''"
          :disabled="submitted"
          placeholder="填答案"
          @input="type(q.id, $event.target.value)"
          />

          <!-- 简答 -->
          <textarea
          v-else
          class="textarea"
          rows="5"
          :value="answers[q.id] || ''"
          :disabled="submitted"
          placeholder="写你的思路和要点"
          @input="type(q.id, $event.target.value)"
          ></textarea>
      </article>
    </section>
    </template>


    <Toast :text="toast" @close="toast = ''" />
  </PageShell>
</template>

<script setup>
/*
 * 学生端机试页
 *
 * 开考才出卷（题库卷每人一份，按「作业 + 学号」定种子，重进还是同一份）；
 * 答案边打边存到服务器（1 秒防抖），所以断电/换机器也不丢，接着答。
 * 限时到 0 就自动交卷。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api, openDoc } from '../../api'
import Toast from '../../components/Toast.vue'
import { loadScheme, scheme } from '../../utils/scheme'
import { onPresenceMessage } from '../../utils/presence'
/* 全局状态（这里有个局部的 state，所以要起别名，别撞名） */
import { state as appState } from '../../store'
import PageHead from '../../components/PageHead.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'

const route = useRoute()
const id = route.params.id
const itemKey = String(route.params.itemKey || 'exam')

const state = reactive({ started: false, paper: null, answers: {}, submitted: false })
const score = ref(null)

/** 看自己那张答过的卷子（判完才有；没判会提示等老师） */
function openMine() {
  openDoc('/api/student/exams/' + encodeURIComponent(route.params.id) + '/paper-file/html')
}
const comment = ref('')
const err = ref('')
const toast = ref('')
const busy = ref(false)
const canStart = ref(false)
const left = ref(0)
/** 自动开考失败的原因（还没轮到你 / 已结束 / 没开始），显示在空态卡里 */
const startErr = ref('')

let saveTimer = null
let tick = null
let offPresence = null
/* 上次和服务端对表的时刻（毫秒），用来判断倒计时该不该校准 */
let syncedAt = 0

const submitted = computed(() => state.submitted)
// 模板里用的是 answers[q.id] —— 必须在这里导出，否则渲染时读到的是 undefined
const answers = computed(() => state.answers)
const sections = computed(() => (state.paper ? state.paper.sections : []))
const totalCount = computed(() => sections.value.reduce((n, s) => n + s.questions.length, 0))
const clockText = computed(() => {
  if (!state.paper || !state.paper.duration) return '不限时'
  const m = Math.floor(left.value / 60)
  const s = left.value % 60
  return '剩余 ' + m + ':' + String(s).padStart(2, '0')
})

onMounted(async () => {
  await loadScheme()
  const mod = scheme.modules.find((m) => m.itemKey === itemKey)
  canStart.value = !!mod
  await load()
  /*
   * 还没在考 → 直接开考。
   *
   * 点进这场考试就等于说「我要考」，再让他点一次「开始考试」是多余的；
   * 而且那一屏占着位置，学生一进来看到「还没开始」，会以为老师没放他进来。
   *
   * 幂等：后端 start 里 ensureSubmission 会复用已有答卷，重复进入不重开计时。
   */
  if (!state.started && canStart.value) await start()

  /*
   * 老师那边的三个动作要立刻反映到这一页，不能等学生刷新：
   *
   *   open      放行 —— 老师可能刚刚点了开始
   *   close     结束 —— **立刻交卷**（已答的都算数）
   *   duration  改时长 —— 老师延长 / 缩短，倒计时马上跟着变
   */
  offPresence = onPresenceMessage((m) => {
    if (!m || m.t !== 'assignment' || m.id !== id) return
    if (m.action === 'close') {
      /* 别等本地倒计时归零：老师已经停了，再等就是白答 */
      submit(true, '老师结束了这场机试，已自动交卷')
    } else if (m.action === 'open') {
      load()
    } else if (m.action === 'duration') {
      syncRemaining()
      toast.value = '老师把考试时长改成了 ' + m.minutes + ' 分钟'
    } else if (m.action === 'exam-force-submit') {
      /*
       * 老师替我收卷了（设备坏了交不上、违纪、卡住）。
       *
       * 本地要立刻冻结：不冻的话他还能继续打字，而服务端已经不收答案了
       * （保存那条会拒绝「已经交卷了」）—— 他会以为改动都生效了，实际一条没存。
       */
      const me = (appState.student && appState.student.sid) || ''
      if (m.sid && me && m.sid !== me) return
      state.submitted = true
      if (saveTimer) clearTimeout(saveTimer)
      toast.value = '老师已经收卷了，不能再改'
      /* 拉一次分数和评语，别让他盯着一个空分 */
      syncRemaining()
    } else if (m.action === 'exam-reset') {
      /*
       * 老师让我重考。
       *
       * 服务端已经把答卷和分数清掉了，但这一页还挂着旧数据 ——
       * 不清的话学生看到的仍是「已交卷 · 等老师判」，永远等不到重考入口。
       * 清完回到「未开考」，他再点开始就是一份新卷子（题库卷会换一套题）。
       */
      const me = (appState.student && appState.student.sid) || ''
      /* 广播是全班的，只处理点名给自己的那条 */
      if (m.sid && me && m.sid !== me) return
      state.started = false
      state.paper = null
      state.answers = {}
      state.submitted = false
      score.value = null
      comment.value = ''
      left.value = 0
      if (saveTimer) clearTimeout(saveTimer)
      toast.value = '老师让你重考：点「开始」就是一套新卷子'
    }
  })

  tick = setInterval(() => {
    if (!state.started || submitted.value) return
    if (!state.paper || !state.paper.duration) return
    if (left.value > 0) left.value--
    else submit(true)
    /*
     * 每 30 秒和服务端对一次表。
     *
     * 本地每秒减一在正常情况下够用，但切到别的标签页时浏览器会节流定时器
     * （后台标签页里 setInterval 可能被压到 1 分钟一次），
     * 那段时间倒计时就走慢了 —— 学生回来发现"还剩 20 分钟"，实际只剩 5 分钟。
     * 以服务端的 remaining 为准，慢多少都能拉回来。
     */
    if (Date.now() - syncedAt > 30000) syncRemaining()
  }, 1000)
})

onUnmounted(() => {
  if (tick) clearInterval(tick)
  if (saveTimer) clearTimeout(saveTimer)
  if (offPresence) offPresence()
})

/** 和服务端对表：remaining 是唯一可信的剩余秒数（它按 startedAt + 时长算） */
async function syncRemaining() {
  try {
    const res = await api.get('/api/student/exams/' + encodeURIComponent(id) + '/current')
    if (!res || !res.started) return
    if (typeof res.remaining === 'number') left.value = res.remaining
    syncedAt = Date.now()
    /* 老师在别处把时长改了：这张卷子也更新，界面上「限时 X 分钟」才对 */
    if (res.paper && res.paper.duration) state.paper.duration = res.paper.duration
    /*
     * 服务端说已经交过了（另一个标签页交了 / 老师强制收了）：同步过来，别让人继续答。
     * 分数和评语一起带回来 —— 强制交卷时学生没走 submit 那条路，不会有别的地方给他设分。
     */
    if (res.submittedAt) {
      if (!state.submitted) {
        state.submitted = true
        toast.value = '这份答卷已经交过了'
      }
      state.paper = state.paper || res.paper
      if (res.score !== undefined && res.score !== null) score.value = res.score
      comment.value = res.comment || ''
    }
  } catch (e) {
    /* 对表失败不影响本地倒计时，下一秒再试 */
  }
}

async function load() {
  err.value = ''
  try {
    const res = await api.get('/api/student/exams/' + encodeURIComponent(id) + '/current')
    if (!res.started) return
    apply(res)
  } catch (e) {
    err.value = e.message
  }
}

function apply(res) {
  state.started = true
  state.paper = res.paper
  state.answers = res.answers || {}
  state.submitted = !!res.submittedAt
  left.value = typeof res.remaining === 'number' ? res.remaining : 0
  /* 刚跟服务端对过表，30 秒内不用再拉 */
  syncedAt = Date.now()
  score.value = res.score === undefined ? null : res.score
  comment.value = res.comment || ''
}

/**
 * 开考。**进来就自动调一次**，不再让用户点按钮。
 *
 * 点进这场考试本身就是「我要考」的表示，多一步确认只会让人以为还没开始。
 * 后端 start 是幂等的（ensureSubmission 复用已有答卷），重复进来不会重开计时。
 *
 * 失败不是错误，是「现在进不来」——403 的 message 已经写清了是
 * 「还没轮到你」还是「这场已经结束了」，直接拿来当说明。
 */
async function start() {
  busy.value = true
  startErr.value = ''
  err.value = ''
  try {
    const res = await api.post('/api/student/exams/' + encodeURIComponent(id) + '/start')
    apply(res)
  } catch (e) {
    startErr.value = e.message || '这场考试现在进不来'
  } finally {
    busy.value = false
  }
}

const letter = (i) => String.fromCharCode(65 + i)

function pick(qid, v) {
  state.answers[qid] = v
  queueSave()
}

function type(qid, v) {
  state.answers[qid] = v
  queueSave()
}

/** 边打边存：1 秒防抖，避免每敲一个字打一次请求 */
function queueSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveAnswers, 1000)
}

async function saveAnswers() {
  if (submitted.value) return
  try {
    await api.post('/api/student/exams/' + encodeURIComponent(id) + '/answers', { answers: state.answers })
  } catch (e) {
    err.value = e.message
  }
}

/**
 * 交卷。
 *
 * @param {boolean} auto  是否自动交（不再弹确认框）
 * @param {string}  why   自定义提示。不传就按 auto 给默认文案 ——
 *                        自动交的几种原因（时间到 / 老师结束）要说清是哪种，
 *                        否则学生分不清是"时间到了"还是"被老师收了"
 */
async function submit(auto, why) {
  if (submitted.value) return
  if (!auto && !window.confirm('交卷后不能再改，确定交吗？')) return
  busy.value = true
  try {
    if (saveTimer) clearTimeout(saveTimer)
    /* 先把最后这一批答案存上去 —— 自动交卷时尤其要，否则最后几秒的作答会丢 */
    await saveAnswers()
    const res = await api.post('/api/student/exams/' + encodeURIComponent(id) + '/submit')
    state.submitted = true
    if (typeof res.total === 'number') score.value = res.total
    toast.value = why || (auto ? '时间到，已自动交卷' : '交卷了，等老师判主观题')
  } catch (e) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.sec {
  margin-bottom: 12px;
}

.q {
  padding: var(--sp-2) 0;
  border-top: 1px solid var(--line-soft);
}

.q:first-of-type {
  border-top: none;
}

.stem {
  margin: 0 0 8px;
  font-size: var(--fs-md);
  line-height: 1.7;
}

.opts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.opt {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  font-size: var(--fs-md);
  cursor: pointer;
  background: var(--card);
}

.opt.on {
  border-color: #93b4f7;
  background: #eef4ff;
}

.result {
  margin-bottom: 12px;
  font-size: var(--fs-md);
}
</style>
