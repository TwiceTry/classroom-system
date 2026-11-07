<template>
  <div class="gbox">
    <!-- 卷面分：机试 / 笔试这类 raw 规则 -->
    <template v-if="mode === 'raw'">
      <label class="field inline">
        <span>卷面分（0–{{ item.rawFull || 100 }}）</span>
        <input v-model="v.raw" class="input" type="number" min="0" :max="item.rawFull || 100" style="width: 88px" />
        <em class="dim mini">折算 {{ rawScore }} / {{ item.full }}</em>
      </label>
    </template>

    <!-- 量规：大作业 / 课程设计 -->
    <template v-else-if="mode === 'rubric'">
      <div class="dims">
        <label v-for="d in item.dims || []" :key="d.key" class="drow">
          <span>{{ d.name }}</span>
          <input v-model="v.dims[d.key]" class="input" type="number" min="0" :max="d.full" />
          <em class="dim">/ {{ d.full }}</em>
        </label>
        <p class="dtotal">合计 <b>{{ dimsTotal }}</b> / {{ item.full }} · 记入「{{ item.name }}」项</p>
      </div>
    </template>

    <!-- 等级：作业 / 报告 -->
    <template v-else>
      <div class="gline">
        <span class="dim mini">等级</span>
        <button
          v-for="g in item.grades || []"
          :key="g.key"
          class="pill"
          :class="{ on: v.grade === g.key }"
          @click="v.grade = g.key"
        >
          {{ g.label || g.name || g.key }}
        </button>
        <label class="check mini">
          <input v-model="v.late" type="checkbox" />
          迟交（×{{ item.lateFactor === undefined ? 1 : item.lateFactor }}）
        </label>
        <span class="dim mini">= {{ letterScore }} 分，记入「{{ item.name }}」项</span>
      </div>
    </template>
  </div>
</template>

<script setup>
/*
 * GradeBox —— 按「方案的规则」渲染打分控件
 *
 * 一个模块批阅时该给什么控件，取决于这一项的 rule.type：
 *   raw    → 卷面分输入（机试、笔试）
 *   rubric → 维度逐项打分（大作业、课程设计）
 *   其它   → 等级 A/B/C/X + 迟交（作业、报告，对应 avg 规则）
 * 所以「加一项新考核」不用再写一套批阅界面。
 */
import { computed } from 'vue'

const props = defineProps({
  item: { type: Object, required: true },
  modelValue: { type: Object, required: true },
})
// 直接改父组件传下来的那个对象（父组件用 reactive 持有，改完即脏）
const v = props.modelValue

const mode = computed(() => (props.item.rule ? props.item.rule.type : 'avg'))

/*
 * 等级折算：按**本项满分**算，不是固定 100。
 *
 * 这里原来写的是 100 × 系数：作业项满分 20 时，选 A 会显示「= 100 分」，
 * 而保存下去实际是 20 分（后端 grading.js 也有过同一个错，已修）。
 * 老师看到 100、结果是 20，等于在骗人。
 *
 * 现在与后端同口径：item.full × 等级系数 × 迟交系数，夹到 [0, full]。
 */
const letterScore = computed(() => {
  const g = (props.item.grades || []).find((x) => x.key === v.grade)
  if (!g) return '—'
  const late = props.item.lateFactor === undefined ? 0.5 : Number(props.item.lateFactor)
  const full = Number(props.item.full) || 100
  const raw = full * g.factor * (v.late ? late : 1)
  return Math.round(Math.min(full, Math.max(0, raw)) * 10) / 10
})

const rawScore = computed(() => {
  const raw = Number(v.raw)
  if (!isFinite(raw) || raw < 0) return '—'
  const f = props.item.factor === undefined ? 1 : Number(props.item.factor)
  return Math.round(raw * f * 10) / 10
})

const dimsTotal = computed(() => {
  let s = 0
  for (const d of props.item.dims || []) s += Number(v.dims[d.key]) || 0
  return Math.round(s * 10) / 10
})

</script>

<style scoped>
.gbox {
  display: contents;
}

.gline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
}

.dims {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.drow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: #4a525a;
}

.drow span {
  width: 78px;
  flex: 0 0 78px;
}

.drow input {
  width: 74px;
  padding: 4px 8px;
  font-size: 12.5px;
}

.dtotal {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: #4a525a;
}

.dtotal b {
  font-size: 15px;
  color: var(--ink);
}

.field.inline {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: #4a525a;
}
</style>
