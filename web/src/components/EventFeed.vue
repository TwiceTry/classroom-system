<template>
  <!--
    右栏「本次课记录」—— 一个模块的计分流水，最新的在上，能逐条撤回。

    抽成组件是因为「课堂互动」和「考勤点名」的右栏要长得一模一样：
    同一个形状、同一个撤回行为。各写一套的话，改一处忘一处，
    老师在两个页面上会看到两种列表。

    数据形状（两个页面都按这个给）：
      { id, sid, name, delta, reason, at, voided, ... }
    「时间那一格显示什么」由调用方决定（sub 插槽）：
    互动显示 clock(at)，考勤显示「第3节 14:22」。
  -->
  <ul class="feed">
    <li v-for="r in items" :key="r.id" :class="{ voided: r.voided }">
      <b class="who">{{ r.name || r.sid }}</b>
      <span class="d" :class="{ minus: r.delta < 0 }">{{ r.delta > 0 ? '+' + r.delta : r.delta }}</span>
      <span class="why dim" :title="r.reason">{{ r.reason }}</span>
      <span class="spacer"></span>
      <span class="at dim mini">
        <slot name="at" :row="r">{{ r.at }}</slot>
      </span>
      <!--
        撤销过的显示一个「已撤」而不是把 × 灰掉 ——
        灰按钮会让人以为「点一下能恢复」，而撤销是终局的（events 表 append-only）。
      -->
      <span v-if="r.voided" class="voided-tag">已撤</span>
      <button v-else-if="undoable" class="xbtn" title="撤销这条计分" @click="$emit('undo', r)">×</button>
    </li>

    <li v-if="!items.length" class="empty">
      <b>{{ emptyTitle || '还没有记录' }}</b>
      <span v-if="emptyText">{{ emptyText }}</span>
    </li>
  </ul>
</template>

<script setup>
defineProps({
  /** 流水（新的在前） */
  items: { type: Array, default: () => [] },
  /** 能不能撤回（只读场景传 false） */
  undoable: { type: Boolean, default: true },
  emptyTitle: { type: String, default: '' },
  emptyText: { type: String, default: '' },
})

defineEmits(['undo'])
</script>

<style scoped>
.feed {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.feed li {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) 2px;
  border-bottom: 1px dashed #eef1f5;
  font-size: var(--fs-sm);
  line-height: 1.5;
}

/* 撤销过的整条压暗，并且划掉 —— 一眼看出「这条不算了」 */
.feed li.voided {
  opacity: 0.5;
}
.feed li.voided .who,
.feed li.voided .d,
.feed li.voided .why {
  text-decoration: line-through;
}
.voided-tag {
  flex: none;
  font-size: var(--fs-xs);
  color: var(--dim);
  padding: 0 4px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
}

.who {
  flex: none;
  max-width: 76px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.d {
  flex: none;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: #15803d;
}
.d.minus {
  color: #b91c1c;
}
.why {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 104px;
}
.at {
  flex: none;
  font-variant-numeric: tabular-nums;
}

/*
 * 撤回按钮。
 * 平时很淡（一行一个满色 × 会很花），悬停才变红 ——
 * 它是个破坏性操作，不该在视觉上和「+1」一样重。
 */
.xbtn {
  flex: none;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--dim);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.12s, color 0.12s, background 0.12s;
}
.xbtn:hover {
  opacity: 1;
  color: #b91c1c;
  background: #fbeeec;
  border-color: #e2bdb9;
}

/* 空态：说清楚「这里什么时候会有东西」 */
.empty {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-3) var(--sp-1);
  border-bottom: none;
  line-height: 1.6;
}
.empty b {
  font-weight: 600;
  color: var(--ink);
  font-size: var(--fs-md);
}
.empty span {
  font-size: var(--fs-sm);
  color: var(--dim);
}
</style>
