<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>{{ moduleTitle() }}</template>
        <template #sub>老师点了「开始」才收作业。改动先存本机，交上去老师就能看到你写的东西</template>
        <template #right>
          <button class="btn mini" :disabled="loading" @click="load">刷新</button>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>

    <div v-if="loading && !list.length" class="card empty">正在读取…</div>
    <div v-else-if="!list.length" class="card empty">老师还没布置课堂作业。</div>

    <div v-else class="grid2">
      <article v-for="a in list" :key="a.id" class="card hw" :class="{ shut: a.status !== 'open' }">
        <div class="hwtop">
          <span class="tag" :class="tagOf(a)">{{ statusOf(a) }}</span>
          <b class="ellip">{{ a.title }}</b>
        </div>

        <p class="dim mini meta">{{ a.dirTitle }}</p>
        <!--
          截止时间。学生最关心的其实是「还来不来得及」，所以除了时间点还带剩余量，
          24 小时内标橙、过了截止标红。
        -->
        <p v-if="a.dueAt" class="due" :class="dueTone(a)">{{ dueText(a) }}</p>
        <p v-if="a.note" class="note">{{ a.note }}</p>
        <p v-else class="note dim">按老师的要求改代码，改完点提交。</p>

        <div class="hwfoot">
          <!--
            这里原来读 a.myLatest / a.mine，而后端给的是 mySubmission —— 字段名对不上，
            于是**交了也永远显示「还没交过」**，按钮也一直是「去做作业」。
            现在统一用后端的 mySubmission。
          -->
          <span v-if="!a.mySubmission" class="dim mini">还没交过</span>
          <span v-else class="mini">
            已提交 {{ when(a.mySubmission.createdAt) }}
            <template v-if="a.mySubmission.score !== undefined && a.mySubmission.score !== null">
              · <b class="score">{{ a.mySubmission.score }}</b> 分
            </template>
            <template v-else>· 待批</template>
            <template v-if="a.mySubmission.late"> · 迟交</template>
          </span>
          <span class="spacer"></span>
          <router-link v-if="a.status === 'open'" class="btn mini primary" :to="'/student/assignments/' + a.id">
            {{ a.mySubmission ? '继续改 / 重交' : '去做作业' }}
          </router-link>
          <router-link v-else-if="a.mySubmission" class="btn mini" :to="'/student/assignments/' + a.id">
            看我的提交
          </router-link>
          <span v-else class="btn mini" :class="{ disabled: true }" style="opacity: 0.5; cursor: default">
            等老师开始
          </span>
        </div>
      </article>
    </div>


    <Toast :text="toast" @close="toast = ''" />
  </PageShell>
</template>

<script setup>
/*
 * 学生端「课堂作业」列表
 *
 * 只做两件事：把老师布置过哪些作业列出来 / 告诉学生自己交了没、几分。
 * 进来就能看到全部作业（没开始的也列出来），这样学生知道「马上要做哪几题」，
 * 但没开始的那张卡只有一个灰按钮 —— 点了也进不去，服务端同样拒收。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from '../../api'
import Toast from '../../components/Toast.vue'
import { when, at as fmtAt } from '../../utils/time'
import { onPresenceMessage } from '../../utils/presence'
import { loadScheme, scheme } from '../../utils/scheme'
import PageHead from '../../components/PageHead.vue'
import PageShell from '../../components/PageShell.vue'

/* 看哪个模块（课堂作业 / 机试 / 报告…）：由 /student/modules/:itemKey 传进来 */
const props = defineProps({ itemKey: { type: String, default: 'homework' } })
const moduleTitle = () => { const it = scheme.items.find((i) => i.key === props.itemKey); return it ? it.name : '课堂作业' }

const list = ref([])
const loading = ref(false)
const err = ref('')
const toast = ref('')
let off = null

onMounted(async () => {
  await loadScheme()
  await load()
  // 老师一点「开始 / 结束」，学生这边不用刷新就能变状态
  off = onPresenceMessage((m) => {
    if (m && m.t === 'assignment') load()
  })
})

onUnmounted(() => {
  if (off) off()
})

async function load() {
  loading.value = true
  err.value = ''
  try {
    const res = await api.get('/api/student/assignments?itemKey=' + encodeURIComponent(props.itemKey))
    list.value = res.items || []
  } catch (e) {
    err.value = e.message
  } finally {
    loading.value = false
  }
}

function statusOf(a) {
  if (a.status === 'open') return '进行中'
  return a.started ? '已结束' : '未开始'
}

function tagOf(a) {
  if (a.status === 'open') return 'ok'
  return a.started ? 'mute' : 'warn'
}

/* ---------------- 截止时间 ---------------- */

/** 还剩多少毫秒（没设截止返回 0） */
function dueLeft(a) {
  const t = Date.parse(a.dueAt || '')
  return t ? t - Date.now() : 0
}

/**
 * 截止提示。
 *
 * 不只给时间点，还给「还剩多久」—— 学生扫一眼卡片时想的不是
 * 「11-20 23:59 是什么时候」，而是「现在还来不来得及」。
 * 一天以内按小时、一小时以内按分钟，超过一天才说天数。
 */
function dueText(a) {
  if (!a.dueAt) return ''
  const left = dueLeft(a)
  const at = '截止 ' + fmtAt(a.dueAt)
  if (left <= 0) return at + (a.allowLate ? '（已过 · 可迟交）' : '（已截止）')
  const mins = Math.round(left / 60000)
  if (mins < 60) return at + '（还剩 ' + mins + ' 分钟）'
  if (mins < 1440) return at + '（还剩 ' + Math.round(mins / 60) + ' 小时）'
  return at + '（还剩 ' + Math.round(mins / 1440) + ' 天）'
}

/** 紧迫程度：过了截止红、24 小时内橙、其余常规 */
function dueTone(a) {
  if (!a.dueAt) return ''
  const left = dueLeft(a)
  if (left <= 0) return 'over'
  if (left < 86400000) return 'soon'
  return ''
}
</script>

<style scoped>
.grid2 {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: var(--sp-3);
}

/*
 * 截止时间这一行。
 * 用 tabular-nums：一堆卡片并排时，时间里的数字等宽，看起来才齐。
 */
.hw .due {
  margin: 2px 0 0;
  font-size: var(--fs-sm);
  color: #5b6673;
  font-variant-numeric: tabular-nums;
}
/* 24 小时内：提醒但不刺眼 */
.hw .due.soon {
  color: #a15c00;
  font-weight: 600;
}
/* 过了截止：红 */
.hw .due.over {
  color: var(--err);
}

.hw {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px var(--sp-3);
}

.hw.shut {
  background: #fcfcfb;
}

.hwtop {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.hwtop .tag {
  flex: 0 0 auto;
  white-space: nowrap;
}

.hwtop b {
  font-size: var(--fs-lg);
  min-width: 0;
}

.meta {
  margin: -4px 0 0;
  font-size: var(--fs-sm);
}

.note {
  margin: 0;
  font-size: var(--fs-md);
  line-height: 1.6;
  color: #3b434b;
  white-space: pre-wrap;
}

.hwfoot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: auto;
  padding: var(--sp-2);
  border-top: 1px solid var(--line-soft);
  font-size: var(--fs-sm);
}

.hwfoot .btn {
  flex: 0 0 auto;
  white-space: nowrap;
}

.score {
  color: var(--ok);
  font-size: var(--fs-md);
}
</style>
