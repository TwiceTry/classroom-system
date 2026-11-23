<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>{{ moduleTitle }}</template>
        <!-- 副标题放状态，不放操作说明（那是第一次才需要看的） -->
        <template #sub>{{ subText }}</template>
        <template #right>
          <button class="btn mini" :disabled="loading" @click="load">刷新</button>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>
    <div v-if="loading && !list.length" class="card empty">正在读取…</div>
    <div v-else-if="!list.length" class="card empty">老师还没安排机试。</div>

    <div v-else class="grid2">
      <article v-for="a in list" :key="a.id" class="card hw" :class="{ shut: !collectingOf(a) }">
        <div class="hwtop">
          <span class="tag" :class="stateOf(a).tone">{{ stateOf(a).text }}</span>
          <b class="ellip">{{ a.title }}</b>
        </div>
        <p v-if="a.note" class="note">{{ a.note }}</p>
        <div class="hwfoot">
          <!--
            「交没交卷」看 submittedAt，不看 mySubmission 存不存在 ——
            学生一开考就会建一条 submission，用"存在"判断的话，
            考试中刷新一下列表会看到自己「已交卷」，实际还在答题。

            三种情况分开说：
              还没交卷        → 考试信息（限时 / 满分 / 题量）
              开考了没交       → 考到一半 / 时间到还没交
              交了           → 已交卷（有分就带分）

            第一格原来写死一句「还没开考」：不跟状态变（老师没开、已结束、没交卷
            三种情况显示得一模一样），上面那个状态标签又已经说过一遍。
            换成考试信息 —— 学生决定点不点「开考」之前，想知道的是这些。
          -->
          <span v-if="!a.mySubmission && infoText(a)" class="dim mini">{{ infoText(a) }}</span>
          <!--
            列表里拿不到「还剩几分钟」—— 限时是试卷上的（duration），
            而列表接口只给作业级字段。剩余时间在开考页里显示，那里有完整状态。
            这里只交代「开考了、还没交卷」这一件事。
          -->
          <span v-if="a.mySubmission && !a.mySubmission.submittedAt" class="mini">
            已开考 · <b class="over">还没交卷</b>
          </span>
          <span v-if="a.mySubmission && a.mySubmission.submittedAt" class="mini">
            <template v-if="a.mySubmission.score !== undefined && a.mySubmission.score !== null">
              已交卷 · <b class="score">{{ a.mySubmission.score }}</b> 分
            </template>
            <template v-else>已交卷 · 等老师判</template>
          </span>
          <span class="spacer"></span>
          <router-link
            v-if="collectingOf(a)"
            class="btn mini primary"
            :to="'/student/modules/' + itemKey + '/' + a.id"
          >
            {{ a.mySubmission ? (a.mySubmission.submittedAt ? '再看我的答卷' : '继续答题') : '进入考试' }}
          </router-link>
          <router-link
            v-else-if="a.mySubmission"
            class="btn mini"
            :to="'/student/modules/' + itemKey + '/' + a.id"
          >
            看我的答卷
          </router-link>
          <!--
            原来这里一句「等老师开始」包了两件事：还没开的，和已经结束的。
            考完的学生看到「等老师开始」会以为还有戏。
          -->
          <span v-else class="btn mini" style="opacity: 0.5; cursor: default">
            {{ stateOf(a).key === 'draft' ? '等老师开始' : '已结束' }}
          </span>
        </div>
      </article>
    </div>
  </PageShell>
</template>

<script setup>
/* 学生端机试列表：只有「开始」之后才有入口 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api } from '../../api'
import { loadScheme, scheme } from '../../utils/scheme'
import { onPresenceMessage } from '../../utils/presence'
import PageHead from '../../components/PageHead.vue'
import PageShell from '../../components/PageShell.vue'
/* 状态是算出来的，和教师端共用同一份判断 */
import { collectingOf as collectingBase, stateOf as stateBase } from '../../utils/assignmentState'

const props = defineProps({ itemKey: { type: String, default: 'exam' } })

const list = ref([])
const loading = ref(false)
const err = ref('')
/* 轮询句柄：到点自动结束靠它推时钟 + 重拉列表 */
let timer = null
/* 广播监听的解绑函数 */
let offPresence = null

const moduleTitle = computed(() => {
  const it = scheme.items.find((i) => i.key === props.itemKey)
  return it ? it.name : '机试'
})

/* 时钟：让「到点自动结束」不依赖数据新鲜度（Vue 追踪不到 Date.now()） */
const nowTick = ref(Date.now())
function collectingOf(x) {
  return collectingBase(x, nowTick.value)
}
function stateOf(x) {
  return stateBase(x, nowTick.value, '考试中')
}

/**
 * 卡片上那行考试信息：限时 45 分钟 · 满分 100 分 · 20 题 · 题库随机卷。
 *
 * 数据来自列表接口的 paperInfo（后端读老师上传的试卷源文件算出来的）。
 * 没装卷子时 paperInfo 是 null —— 那就什么都不显示，别写「限时 0 分钟」。
 */
function infoText(a) {
  const p = a && a.paperInfo
  if (!p) return ''
  const out = []
  out.push(p.duration ? '限时 ' + p.duration + ' 分钟' : '不限时')
  if (p.fullScore) out.push('满分 ' + p.fullScore + ' 分')
  if (p.questions) out.push(p.questions + ' 题')
  if (p.kind === 'bank') out.push('题库随机卷')
  return out.join(' · ')
}

/**
 * 页头副标题 = 现在什么情况。
 * 原来写的是「老师开始了才能开考；开考后计时，答案随打随存，限时就自动交卷」——
 * 操作说明看第二遍就是噪音，而这里本该说「有几场、我考完了没」。
 */
const subText = computed(() => {
  const n = list.value.length
  if (!n) return '老师还没安排机试'
  const open = list.value.filter(collectingOf).length
  const done = list.value.filter((a) => a.mySubmission && a.mySubmission.submittedAt).length
  const parts = []
  parts.push(open ? open + ' 场可以开考' : '现在没有可以开考的')
  if (done) parts.push('已交 ' + done + ' 场')
  return parts.join(' · ')
})

onMounted(async () => {
  await loadScheme()
  await load()

  /*
   * 老师点「开始考试」的那一刻，这一页要立刻变 —— 不能让学生手动刷新。
   * 广播比 8 秒轮询快，两个人做的事是一样的（重拉列表），所以两条路都留着：
   * 广播管"马上"，轮询管"老师忘了点 / 网络抖了一下"。
   */
  offPresence = onPresenceMessage((m) => {
    /* 作业类的广播都重拉一次：开考 / 结束 / 改时长 / 让我重考 */
    if (!m || m.t !== 'assignment') return
    load()
  })

  /* 和教师端一样：定时推时钟 + 重拉列表，到点之后状态自己翻 */
  timer = setInterval(() => {
    nowTick.value = Date.now()
    if (document.hidden) return
    load()
  }, 8000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (offPresence) offPresence()
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
</script>

<style scoped>
.grid2 {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 12px;
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

.hwtop b {
  font-size: var(--fs-lg);
  min-width: 0;
}

.note {
  margin: 0;
  font-size: var(--fs-md);
  line-height: 1.6;
  white-space: pre-wrap;
  color: #3b434b;
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

.score {
  color: var(--ok);
}
</style>
