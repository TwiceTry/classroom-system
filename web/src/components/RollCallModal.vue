<template>
  <!--
    ┌──────────────────────────────────────────────────────┐
    │ 点名核对   1-2节 · 2026-11-15 · 学生端同步显示  [结束] │  头
    ├──────────────────────────────────────────────────────┤
    │                                                      │
    │  张沛楠                                               │  人
    │  2515270146 · 在线 · 考勤 —                            │
    │                                                      │
    │  [ 出勤 ][ 迟到 ][ 缺勤 ][ 请假 ][ 早退 ]              │  动作（插槽）
    │                                                      │
    ├──────────────────────────────────────────────────────┤
    │ 已抽 3/60   剩 57   在线 38      [未标记 ▾][随机][☑锁定] │  统计 | 工具
    ├──────────────────────────────────────────────────────┤
    │ [从头开始]                    [先放着]  [下一个 ›]     │  操作
    └──────────────────────────────────────────────────────┘

    考勤点名和课堂互动共用这一个弹层。两边只有两处不同，都用插槽/可选 prop 表达：
      · 中间的「动作」——考勤是判出勤状态，互动是加分
      · 统计右边的「筛选项」——只有考勤有（抽谁 / 顺序还是随机）

    所有控件同一个高度（30px）、同一个圆角（6px），底栏用两端对齐，
    所以不管插槽里塞几个按钮，竖着看都是齐的。
  -->
  <div v-if="modelValue" class="mask" @click.self="close">
    <div class="modal rcm">
      <!-- 头 -->
      <div class="rcm-head">
        <h3>
          {{ title }}
          <span v-if="subtitle" class="rcm-sub">{{ subtitle }}</span>
        </h3>
        <button class="rcm-btn" :title="endTitle" @click="$emit('end')">结束点名</button>
      </div>

      <!-- 人 + 动作 -->
      <div class="rcm-body">
        <p v-if="!who" class="rcm-empty">{{ emptyText }}</p>
        <template v-else>
          <div class="rcm-person">
            <b class="rcm-name">{{ who.name }}</b>
            <div class="rcm-meta">
              <span class="rcm-sid">{{ who.sid }}</span>
              <span class="rcm-sep">·</span>
              <span class="rcm-tag" :class="who.online ? 'on' : 'off'">
                <i></i>{{ who.online ? '在线' : '离线' }}
              </span>
              <template v-if="who.scoreText">
                <span class="rcm-sep">·</span>
                <span class="rcm-score">{{ who.scoreText }}</span>
              </template>
            </div>
          </div>
          <div class="rcm-actions">
            <slot name="actions"></slot>
          </div>
        </template>
      </div>

      <!-- 统计 + 工具 -->
      <div class="rcm-statsbar">
        <div class="rcm-stats">
          <span class="rcm-stat">已抽 <b>{{ picked }}</b><em v-if="total">/{{ total }}</em></span>
          <span v-if="remaining !== null" class="rcm-stat">剩 <b>{{ remaining }}</b></span>
          <span v-if="online !== null" class="rcm-stat">在线 <b>{{ online }}</b></span>
        </div>
        <div class="rcm-tools">
          <select
            v-if="scopes && scopes.length"
            class="rcm-sel"
            :value="scope"
            @change="$emit('update:scope', $event.target.value)"
          >
            <option v-for="o in scopes" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <button
            v-if="orderable"
            class="rcm-btn"
            :class="{ on: order === 'seq' }"
            :title="order === 'seq' ? '按名单顺序一个个来' : '随机抽'"
            @click="$emit('update:order', order === 'seq' ? 'random' : 'seq')"
          >
            {{ order === 'seq' ? '顺序' : '随机' }}
          </button>
          <label class="rcm-lock" title="锁定时学生点不掉弹窗，必须等你点「结束」">
            <input
              type="checkbox"
              :checked="locked"
              @change="$emit('update:locked', $event.target.checked)"
            />
            锁定
          </label>
        </div>
      </div>

      <!-- 操作 -->
      <div class="rcm-foot">
        <button
          class="rcm-btn"
          :disabled="!canReset"
          title="清空本轮「已抽过」，所有人重新可抽"
          @click="$emit('reset')"
        >
          重置抽取
        </button>
        <span class="rcm-gap"></span>
        <button class="rcm-btn" title="只收起这个弹窗，学生端的提示还开着" @click="close">先放着</button>
        <button class="rcm-btn primary" :disabled="busy || drawing" @click="$emit('next')">
          {{ drawing ? '抽取中…' : nextText }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 「考勤点名」/「课堂点名」 */
  title: { type: String, default: '点名' },
  /** 头部灰字：节次 / 日期 / 「学生端同步显示」 */
  subtitle: { type: String, default: '' },
  /**
   * 当前被点的人：{ name, sid, online, scoreText }
   * scoreText 由调用方拼（考勤「考勤 —」、互动「互动 5/10」），组件不猜业务含义。
   */
  who: { type: Object, default: null },

  /** 本轮已抽人数 */
  picked: { type: Number, default: 0 },
  /** 本轮总人数（0 表示不显示分母） */
  total: { type: Number, default: 0 },
  /** 还能抽几个；null 表示不显示 */
  remaining: { type: Number, default: null },
  /** 在线人数；null 表示不显示 */
  online: { type: Number, default: null },

  /** 筛选下拉的选项（[{value,label}]）；空数组就不显示 —— 课堂互动不传 */
  scopes: { type: Array, default: () => [] },
  scope: { type: String, default: '' },
  /** 要不要显示「顺序/随机」切换 —— 只有考勤显示 */
  orderable: { type: Boolean, default: false },
  order: { type: String, default: 'random' },

  locked: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  drawing: { type: Boolean, default: false },
  canReset: { type: Boolean, default: true },

  endTitle: { type: String, default: '收起学生端的点名提示，本轮进度保留' },
  emptyText: { type: String, default: '还没抽人，点右下「下一个」开始。' },
  nextText: { type: String, default: '下一个 ›' },
})

const emit = defineEmits([
  'update:modelValue',
  'update:locked',
  'update:scope',
  'update:order',
  'end',
  'next',
  'reset',
])

function close() {
  emit('update:modelValue', false)
}
</script>

<style scoped>
/* 宽度固定，不随插槽内容变 —— 两个页面打开时是同一个尺寸 */
.rcm {
  width: min(580px, 94vw);
  padding: 0;
}

/* ── 统一控件尺寸 ───────────────────────────────
   所有按钮、下拉、锁定框都按这一套走，所以竖着看是齐的。 */
.rcm-btn,
.rcm-sel {
  height: 30px;
  padding: 0 12px;
  border: 1px solid #d5dbe2;
  border-radius: 6px;
  background: var(--card);
  color: #2f3a45;
  font-size: var(--fs-md);
  line-height: 1;
  cursor: pointer;
  box-sizing: border-box;
}
.rcm-sel {
  padding: 0 8px;
  max-width: 132px;
}
.rcm-btn:hover:not(:disabled) {
  border-color: #9dbcc8;
}
.rcm-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.rcm-btn.on {
  border-color: #9dbcc8;
  background: #eef6ff;
  color: #2b6cb0;
}
.rcm-btn.primary {
  border-color: #2b6cb0;
  background: #2b6cb0;
  color: #fff;
}
.rcm-btn.primary:hover:not(:disabled) {
  background: #245a94;
}

/* ── 头 ─────────────────────────────────────── */
.rcm-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid #eef1f4;
}
.rcm-head h3 {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.rcm-sub {
  font-size: var(--fs-sm);
  font-weight: 400;
  color: #8a94a6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rcm-head .rcm-btn {
  margin-left: auto;
  flex: none;
}

/* ── 人 + 动作 ───────────────────────────────── */
.rcm-body {
  padding: 16px var(--sp-4) var(--sp-3);
  min-height: 148px;
}
.rcm-empty {
  margin: var(--sp-6) 0;
  text-align: center;
  color: #8a94a6;
  font-size: var(--fs-md);
}
.rcm-person {
  margin: var(--sp-3);
}
.rcm-name {
  display: block;
  font-size: 28px;
  line-height: 1.25;
  font-weight: 600;
  color: #1f2d3d;
  letter-spacing: 0.5px;
}
.rcm-meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: 4px;
  font-size: var(--fs-sm);
  color: #8a94a6;
}
.rcm-sid {
  font-family: ui-monospace, Consolas, monospace;
}
.rcm-sep {
  color: #cdd5de;
}
.rcm-tag {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
}
.rcm-tag i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #c4ccd6;
}
.rcm-tag.on {
  color: #2e9e5b;
}
.rcm-tag.on i {
  background: #2e9e5b;
}
.rcm-score {
  color: #5b6b7b;
}

/* 业务按钮：等宽平铺，几个都一样宽 —— 考勤 5 个、互动 3 个，都对齐 */
.rcm-actions {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 8px;
}
/* 只统一尺寸，颜色/边框留给各页自己的 .kbtn（插槽内容属于父作用域，样式照常命中） */
.rcm-actions :deep(button) {
  height: 34px;
  border-radius: 6px;
  box-sizing: border-box;
  font-size: var(--fs-md);
}

/* ── 统计 + 工具 ─────────────────────────────── */
.rcm-statsbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding: var(--sp-2) var(--sp-4);
  background: #fafbfc;
  border-top: 1px solid #eef1f4;
}
.rcm-stats {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: var(--fs-sm);
  color: #7b8794;
}
.rcm-stat b {
  color: #2f3a45;
  font-size: var(--fs-md);
}
.rcm-stat em {
  font-style: normal;
  color: #a3adb8;
}
.rcm-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.rcm-lock {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  height: 30px;
  padding: 0 var(--sp-2);
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: var(--fs-sm);
  color: #5b6b7b;
  cursor: pointer;
  box-sizing: border-box;
}
.rcm-lock:hover {
  border-color: #d5dbe2;
}
.rcm-lock input {
  margin: 0;
}

/* ── 操作 ───────────────────────────────────── */
.rcm-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px var(--sp-4) 16px;
}
.rcm-gap {
  flex: 1;
}
</style>
