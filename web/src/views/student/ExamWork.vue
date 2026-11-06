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
          <button v-if="!state.started && canStart" class="btn primary" :disabled="busy" @click="start">开始考试</button>
          <button v-if="state.started && !submitted" class="btn primary" :disabled="busy" @click="submit">交卷</button>
          <router-link class="btn mini" :to="'/student/modules/' + itemKey">← 返回</router-link>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>

    <div v-if="!state.started" class="card empty">
      <template v-if="canStart">
        <b>还没开始。</b> 点右上角「开始考试」出卷并计时；开始后答案会随打随存，
        {{ state.paper && state.paper.duration ? '时间到自动截止。' : '交卷后不能再改。' }}
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

let saveTimer = null
let tick = null

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
  tick = setInterval(() => {
    if (!state.started || submitted.value) return
    if (!state.paper || !state.paper.duration) return
    if (left.value > 0) left.value--
    else submit(true)
  }, 1000)
})

onUnmounted(() => {
  if (tick) clearInterval(tick)
  if (saveTimer) clearTimeout(saveTimer)
})

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
  score.value = res.score === undefined ? null : res.score
  comment.value = res.comment || ''
}

async function start() {
  busy.value = true
  err.value = ''
  try {
    const res = await api.post('/api/student/exams/' + encodeURIComponent(id) + '/start')
    apply(res)
    toast.value = '卷子出好了，开始计时'
  } catch (e) {
    err.value = e.message
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

async function submit(auto) {
  if (submitted.value) return
  if (!auto && !window.confirm('交卷后不能再改，确定交吗？')) return
  busy.value = true
  try {
    if (saveTimer) clearTimeout(saveTimer)
    await saveAnswers()
    const res = await api.post('/api/student/exams/' + encodeURIComponent(id) + '/submit')
    state.submitted = true
    if (typeof res.total === 'number') score.value = res.total
    toast.value = auto ? '时间到，已自动交卷' : '交卷了，等老师判主观题'
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
  padding: 10px 0;
  border-top: 1px solid var(--line-soft);
}

.q:first-of-type {
  border-top: none;
}

.stem {
  margin: 0 0 8px;
  font-size: 13.5px;
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
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  background: #fff;
}

.opt.on {
  border-color: #93b4f7;
  background: #eef4ff;
}

.result {
  margin-bottom: 12px;
  font-size: 13.5px;
}
</style>
