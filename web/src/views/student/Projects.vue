<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>{{ moduleTitle() }}</template>
        <template #sub>课程项目：写说明、贴部署或仓库地址、上传源码包，交到你自己名下</template>
        <template #right>
          <button class="btn mini" :disabled="loading" @click="load">刷新</button>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>

    <div v-if="loading && !list.length" class="card empty">正在读取…</div>
    <div v-else-if="!list.length" class="card empty">老师还没布置大作业。</div>

    <div v-else class="grid2">
      <article v-for="a in list" :key="a.id" class="card hw" :class="{ shut: a.status !== 'open' }">
        <div class="hwtop">
          <span class="tag" :class="tagOf(a)">{{ statusOf(a) }}</span>
          <b class="ellip">{{ a.title }}</b>
        </div>

        <p class="dim mini meta">
          <span v-if="a.openedAt">{{ when(a.openedAt) }} 开始</span>
          <span v-else>还没开始收</span>
          <span v-if="a.closedAt"> · {{ when(a.closedAt) }} 截止</span>
        </p>
        <p v-if="a.note" class="note">{{ a.note }}</p>

        <div class="hwfoot">
          <span v-if="!a.myLatest" class="dim mini">还没交过</span>
          <span v-else class="mini">
            交过 {{ a.mine.length }} 次，最近 {{ when(a.myLatest.createdAt) }}
            <template v-if="a.myLatest.score !== null"> · <b class="score">{{ a.myLatest.score }}</b> 分</template>
            <template v-else> · 待批</template>
          </span>
          <span class="spacer"></span>
          <router-link v-if="a.status === 'open'" class="btn mini primary" :to="'/student/projects/' + a.id">
            {{ a.myLatest ? '再交一次' : '去提交' }}
          </router-link>
          <router-link v-else-if="a.myLatest" class="btn mini" :to="'/student/projects/' + a.id">看我的提交</router-link>
          <span v-else class="btn mini" style="opacity: 0.5; cursor: default">等老师开始</span>
        </div>
      </article>
    </div>


    <Toast :text="toast" @close="toast = ''" />
  </PageShell>
</template>

<script setup>
/*
 * 学生端「大作业」列表
 *
 * 大作业和课堂作业在服务端是同一张表（kind=project），但学生这里分成两个入口：
 * 课堂作业是「改代码」，大作业是「交项目材料」，页面上不该混成一个列表。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from '../../api'
import Toast from '../../components/Toast.vue'
import { when } from '../../utils/time'
import { onPresenceMessage } from '../../utils/presence'
import { loadScheme, scheme } from '../../utils/scheme'
import PageHead from '../../components/PageHead.vue'
import PageShell from '../../components/PageShell.vue'

const props = defineProps({ itemKey: { type: String, default: 'project' } })
const moduleTitle = () => { const it = scheme.items.find((i) => i.key === props.itemKey); return it ? it.name : '大作业' }

const list = ref([])
const loading = ref(false)
const err = ref('')
const toast = ref('')
let off = null

onMounted(async () => {
  await loadScheme()
  await load()
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
    list.value = res.assignments || []
  } catch (e) {
    err.value = e.message
  } finally {
    loading.value = false
  }
}

function statusOf(a) {
  if (a.status === 'open') return '收作业中'
  return a.started ? '已截止' : '未开始'
}

function tagOf(a) {
  if (a.status === 'open') return 'ok'
  return a.started ? 'mute' : 'warn'
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
  padding: 12px 14px;
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
  font-size: 14.5px;
  min-width: 0;
}

.meta {
  margin: -4px 0 0;
  font-size: 12px;
}

.note {
  margin: 0;
  font-size: 13px;
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
  padding-top: 6px;
  border-top: 1px solid var(--line-soft);
  font-size: 12.5px;
}

.hwfoot .btn {
  flex: 0 0 auto;
  white-space: nowrap;
}

.score {
  color: var(--ok);
  font-size: 13.5px;
}
</style>
