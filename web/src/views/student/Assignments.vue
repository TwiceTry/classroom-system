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
          <!--
            分批模式：让他知道自己是第几批，而不是以为「老师把我漏了」。
            这一批有自己的时限时把剩余也带上 —— 否则他只能靠整场的截止时间猜。
          -->
          <span v-if="a.myBatch" class="batchno" :class="{ over: a.myBatch.overDue }">
            第 {{ a.myBatch.seq }} 批<template v-if="a.myBatch.overDue"> · 时间到</template>
            <template v-else-if="a.myBatch.leftMin"> · 还剩 {{ a.myBatch.leftMin }} 分钟</template>
          </span>
          <b class="ellip">{{ a.title }}</b>
        </div>

        <p class="dim mini meta">{{ a.dirTitle }}</p>
        <!--
          截止时间。学生最关心的其实是「还来不来得及」，所以除了时间点还带剩余量，
          24 小时内标橙、过了截止标红。
        -->
        <p v-if="a.dueAt" class="due" :class="dueTone(a)">
          <b class="left">{{ dueLeftText(a) }}</b>
          <span class="when">{{ dueWhen(a) }}</span>
        </p>
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
          <!--
            没交过的也要能点进去：未开始 / 已结束的详情页会交代清楚现在处在哪一步，
            卡在列表上只能看到卡片、看不到题目要求。
            原来这里是个灰掉的 span 写「等老师开始」—— 已结束的作业也在说这句，是错的。
          -->
          <router-link v-else class="btn mini" :to="'/student/assignments/' + a.id">
            看看题目
          </router-link>
        </div>

        <!--
          老师的评语单独一行。
          原来只在详情页的提交记录表里，卡片上看不到 ——
          学生翻到自己那次作业、看到分数就走了，评语从来没被读过。
          有评语才出现，没有不占地方。
        -->
        <p v-if="a.mySubmission && a.mySubmission.comment" class="cmt">
          <span class="cmt-k">老师评语</span>{{ a.mySubmission.comment }}
        </p>
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
/*
 * 拆成两段，因为它们的**重要程度差一个量级**：
 *
 *   「还剩 3 小时」  ← 学生扫一眼就想知道的，用 --fs-proj-lg(21) 单独一行
 *   「截止 11-20」   ← 想核对时才看，小字跟在下面
 *
 * 原来挤在一句括号里（「截止 11-20 00:32（还剩 3 小时）」），
 * 两个信息一样重、一样小，等于都没有分量。
 */
function dueLeftText(a) {
  if (!a.dueAt) return ''
  /*
   * 老师已经点过「停止」：哪怕截止时间还没到，这次也交不上了。
   * 原来这里照样算「还剩 3 天」，学生看着还有时间，实际交不上去。
   */
  if (a.started && a.status !== 'open') return '已结束'
  const left = dueLeft(a)
  if (left <= 0) return a.allowLate ? '已过截止 · 仍可交' : '已截止'
  const mins = Math.round(left / 60000)
  if (mins < 60) return '还剩 ' + mins + ' 分钟'
  if (mins < 1440) return '还剩 ' + Math.round(mins / 60) + ' 小时'
  return '还剩 ' + Math.round(mins / 1440) + ' 天'
}

function dueWhen(a) {
  return a.dueAt ? '截止 ' + fmtAt(a.dueAt) : ''
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
/*
 * 截止提示拆两行：
 *   .left  「还剩 3 小时」  --fs-proj-lg(21) —— 学生扫卡片时只想看这一个数
 *   .when  「截止 11-20」   12.5px 灰，想核对时才看
 *
 * 21px 是投影档的第二档（第一档 17 给考勤格子的姓名）。
 * 用在这里的理由和那边一样：这不是"老师凑近看的表格"，
 * 是学生在一堆卡片里扫一眼就要判断"来不来得及"。
 */
.hw .due {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin: 2px 0 0;
  font-variant-numeric: tabular-nums;
}
.hw .due .left {
  font-size: var(--fs-proj-lg);
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.2px;
  color: #3c4650;
}
.hw .due .when {
  font-size: var(--fs-sm);
  color: #8b95a1;
}

/* 分批时的批次号：小方块，和状态标签并排但更弱 —— 它是补充说明 */
.hw .batchno {
  padding: 1px 6px;
  border-radius: var(--r-sm);
  background: var(--bg-sub);
  font-size: var(--fs-xs);
  color: #7b8794;
  font-variant-numeric: tabular-nums;
}

/*
 * 老师评语：卡片底部单独一块浅底，和上面「已提交 …」那行状态分开。
 * 最多两行（long 评语在详情页有全文），免得一张卡片被撑得很高。
 */
.hw .cmt {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-sub);
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: #3c4650;
}
.hw .cmt-k {
  margin-right: var(--sp-2);
  font-size: var(--fs-xs);
  color: var(--dim);
}

/* 24 小时内：提醒但不刺眼（只染倒计时那个数，时间点保持安静） */
.hw .due.soon .left {
  color: #a15c00;
}
/* 过了截止：红 */
.hw .due.over .left {
  color: var(--err);
}

/* 左右和 .card 统一成 16（原来 12，比其它卡片窄 4px） */
.hw {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
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
