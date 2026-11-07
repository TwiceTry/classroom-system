<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>我的分数</template>
        <template #sub>每一项都有给分理由和时间；有疑问当堂找老师核对</template>
        <template #right>
          <button class="btn mini" :disabled="loading" @click="load">刷新</button>
        </template>
      </PageHead>
    </template>
    <p v-if="error" class="hint err" style="margin-bottom:12px">{{ error }}</p>
    <div v-if="loading && !data" class="empty">读取中…</div>

    <template v-if="data">
      <section class="card hero">
        <div class="who">
          <h3>{{ data.student.name }}</h3>
          <p class="dim">{{ data.student.className }} · {{ data.student.sid }}</p>
        </div>
        <div class="rank" v-if="data.rank">
          <span class="dim">班级排名</span>
          <b>{{ data.rank.index }}<i>/ {{ data.rank.count }}</i></b>
        </div>
        <div class="total">
          <span class="dim">总评</span>
          <b :class="data.total >= 60 ? 'ok' : 'bad'">{{ data.total }}</b>
          <span class="dim">/ 100</span>
        </div>
        <div class="break">
          <span>过程 + 期末 <b>{{ data.base }}</b></span>
          <span v-if="data.extra">加分 <b>+{{ data.extra }}</b></span>
          <span v-if="data.capped" class="tag warn">已按 100 封顶</span>
        </div>
      </section>

      <div class="items">
        <section v-for="row in data.rows" :key="row.key" class="card item" :class="{ extra: row.extra }">
          <div class="ihead">
            <h3>{{ row.name }}</h3>
            <span class="inum"><b>{{ row.score }}</b> / {{ row.full }}</span>
          </div>
          <div class="bar"><i :style="{ width: Math.min(100, (row.score / row.full) * 100) + '%' }"></i></div>
          <p class="hint-text">{{ hintOf(row.key) }}</p>

          <ul class="events">
            <li v-for="e in row.events" :key="e.id" :class="{ voided: e.voided }">
              <span class="when">{{ fmt(e.createdAt) }}</span>
              <span class="sum">{{ e.summary }}</span>
              <span v-if="e.voided" class="tag mute">已撤销</span>
              <p class="reason">{{ e.reason }}</p>
            </li>
            <li v-if="!row.events.length" class="none">暂无记录</li>
          </ul>
        </section>
      </div>

      <p class="dim" style="text-align:center;margin-top:6px">
        计分规则：考勤 10 + 课堂互动 10 + 课堂作业 20 + 期末机试 30 + 期末大作业 30，加分计入总分但不超过 100。
      </p>
    </template>
  </PageShell>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { api } from '../../api'
import PageHead from '../../components/PageHead.vue'
import PageShell from '../../components/PageShell.vue'

const data = ref(null)
const loading = ref(false)
const error = ref('')

onMounted(load)

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await api.get('/api/student/score')
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

/*
 * 规则说明直接取后端给的 hint。
 *
 * 这里原来硬编码了一张 map，写着「默认全勤 10 分、缺勤 −2、迟到 −1」——
 * 而方案里实际是「起始 5 分、缺勤每次 −1、迟到不扣」。
 * 学生看着这张说明去算自己的分，怎么都算不平。
 *
 * 后端的 hint 是**按当前方案参数现算**的（改了分值、改了扣分规则，它跟着变），
 * 所以前端不该再存一份副本 —— 任何写死的说明迟早会和真实规则脱节。
 */
function hintOf(key) {
  const it = (data.value.items || []).find((x) => x.key === key)
  return (it && it.hint) || ''
}

function fmt(iso) {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}
</script>

<style scoped>
.hero {
  display: flex;
  align-items: center;
  gap: 26px;
  flex-wrap: wrap;
  border-left: 3px solid var(--brand);
  padding-left: 16px;
}

.hero .who h3 {
  margin: 0;
  font-size: 18px;
}

.hero .dim {
  color: var(--dim);
}

.hero .rank b {
  display: block;
  font-size: 22px;
  font-variant-numeric: tabular-nums;
}

.hero .rank i {
  font-style: normal;
  font-size: 12.5px;
  color: var(--dim);
  margin-left: 4px;
}

.hero .total {
  margin-left: auto;
  text-align: right;
}

.hero .total b {
  font-size: 40px;
  line-height: 1;
  margin: 0 4px;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

.hero .total b.bad {
  color: var(--err);
}

.break {
  display: flex;
  gap: 14px;
  align-items: center;
  font-size: 13px;
  color: var(--sub);
  flex-wrap: wrap;
}

.break b {
  color: var(--ink);
  font-size: 15.5px;
  font-variant-numeric: tabular-nums;
}

.items {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 14px;
}

.item {
  margin-bottom: 0;
}

.item.extra {
  border-style: dashed;
}

.ihead {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.ihead h3 {
  margin: 0;
  font-size: 15.5px;
}

.inum {
  margin-left: auto;
  font-size: 12.5px;
  color: var(--sub);
  font-variant-numeric: tabular-nums;
}

.inum b {
  font-size: 22px;
  color: var(--brand-ink);
}

.bar {
  height: 5px;
  margin: 9px 0 8px;
  background: #ebebe7;
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  background: #6f8fa6;
}

.hint-text {
  margin: 0 0 10px;
  font-size: 12.5px;
  color: var(--dim);
  line-height: 1.6;
}

.events {
  list-style: none;
  margin: 0;
  padding: 10px 0 0;
  border-top: 1px solid var(--line-soft);
  max-height: 240px;
  overflow: auto;
}

.events li {
  padding: 6px 0;
  border-bottom: 1px dashed var(--line-soft);
  font-size: 13.5px;
}

.events li.voided {
  opacity: 0.55;
}

.events li.none {
  color: var(--dim);
  border: none;
}

.when {
  font-size: 12px;
  color: var(--dim);
  margin-right: 8px;
  font-variant-numeric: tabular-nums;
}

.sum {
  color: var(--brand-ink);
  font-weight: 600;
}

.reason {
  margin: 2px 0 0;
  font-size: 13px;
  color: #475569;
}
</style>
