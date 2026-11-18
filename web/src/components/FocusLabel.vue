<template>
  <!--
    页头里的「当前状态」标签：跟随讲义中 / 同步练习中 / 做作业中 / 点名中 / 考试中

    为什么固定在这一块、固定这个尺寸：
      它是状态指示，不是操作。每个页都在同一个位置、同一个尺寸出现，
      切页时眼睛不用重新找；宽度固定，被占用的空间也稳定，右边那排工具不会左右跳。
      没状态时整个不渲染，不占位。

    数据只有一个来源（composables/useFocus.js），优先级判断全在服务端 focus.js 里，
    这里不做任何「谁该盖谁」的逻辑。
  -->
  <span v-if="focusActive" class="focus-label" :class="'fl-' + focusMeta.tone" :title="hint">
    <i class="dot"></i>{{ focusMeta.text }}
  </span>
</template>

<script setup>
import { computed } from 'vue'
import { useFocus } from '../composables/useFocus'

const { focusKind, focusPayload, focusMeta, focusActive } = useFocus()

/** 悬停看细节：正在考什么 / 在写哪份作业 / 老师讲到哪一节 */
const hint = computed(() => {
  const p = focusPayload.value || {}
  const k = focusKind.value
  if (k === 'exam') return '正在考试：' + (p.title || '（试卷）') + '，期间其他提示不会打断你'
  if (k === 'homework') return '正在做作业：' + (p.title || '（未命名）')
  if (k === 'follow') return '老师正在讲：' + (p.sectionTitle || '（本节）')
  if (k === 'pgsync') return '老师同步过来的练习：' + (p.file ? p.file.replace(/^.*\//, '') : '代码练习')
  if (k === 'spotlight') return '老师正在点名'
  return ''
})
</script>

<style scoped>
.focus-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  /* 固定尺寸：位置稳定比内容自适应重要 */
  width: 104px;
  height: 22px;
  padding: 0 8px;
  margin-left: 10px;
  border-radius: 11px;
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: 1;
  box-sizing: border-box;
  vertical-align: middle;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.focus-label .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: currentColor;
}

/* 考试最重（红），点名次之（橙），做作业（绿），内容同步（蓝，跟品牌色一致） */
.fl-err {
  background: #fdecea;
  color: #b3261e;
  border: 1px solid #f5c2bd;
}
.fl-warn {
  background: #fff4e5;
  color: #a15c00;
  border: 1px solid #f3d2a2;
}
.fl-ok {
  background: #e9f7ef;
  color: #1e7a43;
  border: 1px solid #c3e6d0;
}
.fl-brand {
  background: #eef4fb;
  color: #1c5a8c;
  border: 1px solid #d3e3f3;
}
.fl-mute {
  background: var(--bg-sub);
  color: #5b6673;
  border: 1px solid var(--line);
}
</style>
