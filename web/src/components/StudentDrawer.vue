<template>
  <div class="mask" @click.self="$emit('close')">
    <div class="modal wide">
      <div class="modal-head">
        <div>
          <h3>{{ student.name }}</h3>
          <p class="dim" style="margin: 2px 0 0">{{ student.sid }}</p>
        </div>
        <div style="margin-left: auto; text-align: right">
          <span class="dim">总评</span>
          <b class="total">{{ row.total }}</b>
          <span class="dim">/ 100</span>
        </div>
        <button class="btn mini" @click="$emit('close')">关闭</button>
      </div>

      <div class="modal-body">
        <p v-if="row.capped" class="hint warn" style="margin-bottom: 12px">
          过程分 + 加分已超过 100，总评按 100 计。
        </p>

        <div class="items">
          <div v-for="r in row.rows" :key="r.item.key" class="item" :class="{ extra: r.item.extra }">
            <div class="ihead">
              <span class="iname">{{ r.item.name }}</span>
              <span class="inum"><b>{{ r.score }}</b> / {{ r.item.full }}</span>
            </div>
            <div class="bar"><i :style="{ width: (r.score / r.item.full) * 100 + '%' }"></i></div>
            <div class="irow">
              <span class="ihint">{{ (r.events || []).filter((e) => !e.voided).length }} 条记录</span>
              <!-- 有独立模块的项不在这里记分：分数只能由模块批阅写入，避免两处重复记 -->
              <router-link
                v-if="moduleTo(r.item.key)"
                class="btn mini"
                :to="moduleTo(r.item.key)"
                @click="$emit('close')"
              >
                去模块评分
              </router-link>
              <button
                v-else-if="!props.readonly"
                class="btn mini"
                :title="r.item.key === 'exam' ? '机试模块还没做，暂时在这里录卷面分' : ''"
                @click="$emit('score', r.item.key)"
              >
                记分
              </button>
            </div>
          </div>
        </div>

        <h4 class="log-title">{{ props.readonly ? '记分流水' : '记分流水（撤销不删记录，可回溯）' }}</h4>
        <ul class="list">
          <li v-for="e in sortedEvents" :key="e.id" :class="{ voided: e.voided }">
            <div class="lhead">
              <span class="when">{{ fmt(e.createdAt) }}</span>
              <span class="tag" :class="'tag-' + e.item">{{ itemName(e.item) }}</span>
              <b class="delta">{{ summary(e) }}</b>
              <span v-if="e.voided" class="tag mute">已撤销</span>
              <span class="spacer"></span>
              <button v-if="!props.readonly && !e.voided" class="btn mini danger" @click="$emit('void', e.id)">撤销</button>
              <button v-else-if="!props.readonly" class="btn mini" @click="$emit('restore', e.id)">恢复</button>
            </div>
            <p class="reason">{{ e.reason }}</p>
            <p class="lf">
              <span class="dim">{{ e.operator }}</span>
              <a v-for="f in e.evidence || []" :key="f.url" :href="f.url" target="_blank" rel="noopener" class="evi-link">
                {{ f.name }}
              </a>
            </p>
          </li>
          <li v-if="!sortedEvents.length" class="empty">还没有任何记分记录</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { moduleForItem } from '../utils/scheme'

const props = defineProps({
  /** 只读：班级管理页只看分，不给记分 / 撤销入口 */
  readonly: { type: Boolean, default: false },
  student: { type: Object, required: true },
  row: { type: Object, required: true },
  items: { type: Array, default: () => [] },
})
defineEmits(['close', 'score', 'void', 'restore'])

/* 有没有模块、跳哪个路由，全看考核方案（/api/scheme 里的 modules）：
 * 方案里把模块关掉，这里就自动退回「记分」按钮，不会出现死链。 */
function moduleTo(key) {
  const m = moduleForItem(key)
  return m ? m.teacherRoute : ''
}

const sortedEvents = computed(() => {
  const all = []
  /*
   * r.events 要防 undefined：/api/classes/:id/scores 返回的 rows[] 目前只有
   * { item, score } —— 没有 events 字段（scoring.js 里是有 events 的，
   * 说明那个接口另外做了裁剪，或者走了别的分支）。
   * 不防的话点开学生抽屉直接整页报错：Cannot read properties of undefined。
   */
  for (const r of props.row.rows || []) for (const e of r.events || []) all.push(e)
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
})

function itemName(key) {
  const it = props.items.find((x) => x.key === key)
  return it ? it.short : key
}

function fmt(iso) {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

function summary(e) {
  const map = {
    attend: () => (e.delta > 0 ? '+' : '') + e.delta + ' 分' + (e.kind ? '（' + e.kind + '）' : ''),
    interact: () => (e.delta > 0 ? '+' : '') + e.delta + ' 分',
    bonus: () => '+' + e.delta + ' 分',
    homework: () => '等级 ' + e.grade + (e.late ? ' · 迟交' : ''),
    exam: () => '卷面 ' + e.raw + ' → ' + Math.round(e.raw * 30) / 100,
    project: () => '量规合计 ' + dimSum(e),
  }
  return (map[e.item] || (() => e.reason))()
}

function dimSum(e) {
  if (!e.dims) return 0
  let s = 0
  for (const k in e.dims) s += Number(e.dims[k]) || 0
  return Math.round(s * 10) / 10
}
</script>

<style scoped>
.total {
  font-size: 30px;
  color: var(--brand-ink);
  margin: 0 4px;
  font-variant-numeric: tabular-nums;
}

.items {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(215px, 1fr));
  gap: 10px;
  margin-bottom: 18px;
}

.item {
  padding: 11px 13px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  background: #fbfcff;
}

.item.extra {
  border-style: dashed;
}

.ihead {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.iname {
  font-weight: 600;
  font-size: 14px;
}

.inum {
  margin-left: auto;
  font-size: 12.5px;
  color: var(--sub);
  font-variant-numeric: tabular-nums;
}

.inum b {
  font-size: 18px;
  color: var(--brand-ink);
}

.bar {
  height: 6px;
  margin: 9px 0 8px;
  border-radius: 4px;
  background: #eaeefb;
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: #6f8fa6;
}

.irow {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ihint {
  font-size: 12px;
  color: var(--dim);
}

.log-title {
  margin: 0 0 10px;
  font-size: 14.5px;
  color: #475569;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.list > li {
  padding: 10px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  margin-bottom: 8px;
  background: #fff;
}

.list > li.voided {
  opacity: 0.62;
  background: #fafafa;
}

.lhead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.when {
  font-size: 12.5px;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

.delta {
  font-size: 14px;
  color: var(--brand-ink);
}

.tag-attend {
  background: #eef2ff;
  color: #4338ca;
}

.tag-homework {
  background: #ecfeff;
  color: #0e7490;
}

.tag-exam {
  background: #fef2f2;
  color: var(--err);
}

.tag-project {
  background: #f5f3ff;
  color: #6d28d9;
}

.tag-bonus {
  background: #ecfdf5;
  color: var(--ok);
}

.tag-interact {
  background: #fff7ed;
  color: var(--warn);
}

.reason {
  margin: 5px 0 2px;
  font-size: 13.8px;
}

.lf {
  margin: 0;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}

.evi-link {
  font-size: 12.5px;
  padding: 1px 8px;
  border-radius: 4px;
  background: #f1f5f9;
}
</style>
