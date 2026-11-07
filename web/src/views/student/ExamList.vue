<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>{{ moduleTitle }}</template>
        <template #sub>老师开始了才能开考；开考后计时，答案随打随存，限时就自动交卷</template>
        <template #right>
          <button class="btn mini" :disabled="loading" @click="load">刷新</button>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>
    <div v-if="loading && !list.length" class="card empty">正在读取…</div>
    <div v-else-if="!list.length" class="card empty">老师还没安排机试。</div>

    <div v-else class="grid2">
      <article v-for="a in list" :key="a.id" class="card hw" :class="{ shut: a.status !== 'open' }">
        <div class="hwtop">
          <span class="tag" :class="a.status === 'open' ? 'ok' : a.started ? 'mute' : 'warn'">
            {{ a.status === 'open' ? '考试中' : a.started ? '已结束' : '未开始' }}
          </span>
          <b class="ellip">{{ a.title }}</b>
        </div>
        <p v-if="a.note" class="note">{{ a.note }}</p>
        <div class="hwfoot">
          <!-- 字段名对齐后端：mySubmission（原先是 myLatest，永远拿不到，交卷了也显示「还没开考」） -->
          <span v-if="a.mySubmission" class="mini">
            <template v-if="a.mySubmission.score !== undefined && a.mySubmission.score !== null">已交卷 · <b class="score">{{ a.mySubmission.score }}</b> 分</template>
            <template v-else>已交卷 · 等老师判</template>
          </span>
          <span v-else class="dim mini">还没开考</span>
          <span class="spacer"></span>
          <router-link v-if="a.status === 'open'" class="btn mini primary" :to="'/student/modules/' + itemKey + '/' + a.id">
            {{ a.mySubmission ? '再看我的答卷' : '开考' }}
          </router-link>
          <span v-else-if="a.mySubmission" class="btn mini" style="opacity: 0.6; cursor: default">已结束</span>
          <span v-else class="btn mini" style="opacity: 0.5; cursor: default">等老师开始</span>
        </div>
      </article>
    </div>
  </PageShell>
</template>

<script setup>
/* 学生端机试列表：只有「开始」之后才有入口 */
import { computed, onMounted, ref } from 'vue'
import { api } from '../../api'
import { loadScheme, scheme } from '../../utils/scheme'
import PageHead from '../../components/PageHead.vue'
import PageShell from '../../components/PageShell.vue'

const props = defineProps({ itemKey: { type: String, default: 'exam' } })

const list = ref([])
const loading = ref(false)
const err = ref('')

const moduleTitle = computed(() => {
  const it = scheme.items.find((i) => i.key === props.itemKey)
  return it ? it.name : '机试'
})

onMounted(async () => {
  await loadScheme()
  await load()
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

.hwtop b {
  font-size: 14.5px;
  min-width: 0;
}

.note {
  margin: 0;
  font-size: 13px;
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
  padding-top: 6px;
  border-top: 1px solid var(--line-soft);
  font-size: 12.5px;
}

.score {
  color: var(--ok);
}
</style>
