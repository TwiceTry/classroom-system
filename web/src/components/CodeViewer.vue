<template>
  <div class="cv">
    <aside class="cvl">
      <div v-for="f in files" :key="f.path" class="cvrow">
        <button class="cvitem" :class="{ on: f.path === cur }" :title="f.path" @click="open(f.path)">
          <span class="ellip">{{ f.path }}</span>
          <span v-if="markedSet.has(f.path)" class="dot" title="这个文件被学生改过"></span>
        </button>
      </div>
      <p v-if="!files.length" class="dim" style="padding: 10px 12px">没有文件</p>
    </aside>
    <section class="cve">
      <div class="ed-head">
        <span class="mono ellip">{{ cur || '—' }}</span>
        <span class="tag">{{ lang }}</span>
        <span class="spacer"></span>
        <span v-if="markedSet.has(cur)" class="tag warn">已改动</span>
        <span class="dim">只读</span>
      </div>
      <div ref="host" class="cvhost"></div>
    </section>
  </div>
</template>

<script setup>
/*
 * CodeViewer —— 只读代码查看器（教师审阅学生提交时用）
 *
 * 和 PgWorkbench 里的编辑器同一个 CodeMirror 实例工厂，只是开了 readOnly：
 * 能选中、能 Ctrl+F 搜索、能折叠，但改不动 —— 免得老师一边看一边误改了学生的代码。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createEditor, langNameFor } from '../utils/pgEditor'

const props = defineProps({
  files: { type: Array, default: () => [] }, // [{ path, text }]
  marked: { type: Array, default: () => [] }, // 学生改动过的文件路径
  startAt: { type: String, default: '' },
  fontSize: { type: Number, default: 13 },
})

const host = ref(null)
const cur = ref('')
const ed = ref(null)
const markedSet = computed(() => new Set(props.marked || []))
const lang = computed(() => langNameFor(cur.value))

function open(p) {
  cur.value = p
  sync()
}

function sync() {
  if (!ed.value) return
  const f = props.files.find((x) => x.path === cur.value)
  ed.value.setDoc(f ? f.text : '')
  ed.value.setLanguage(cur.value)
}

onMounted(async () => {
  if (host.value) {
    ed.value = createEditor(host.value, { fontSize: props.fontSize, readOnly: true })
  }
  cur.value = pickFirst()
  await nextTick()
  sync()
})

onBeforeUnmount(() => {
  if (ed.value) ed.value.destroy()
})

/** 默认打开哪个文件：优先「学生改过的第一个」，没有就看第一个文件 */
function pickFirst() {
  if (props.startAt && props.files.some((f) => f.path === props.startAt)) return props.startAt
  const hit = props.files.find((f) => markedSet.value.has(f.path))
  return (hit || props.files[0] || {}).path || ''
}

watch(
  () => props.files,
  async () => {
    cur.value = pickFirst()
    await nextTick()
    sync()
  }
)
</script>

<style scoped>
.cv {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 10px;
  height: 100%;
  min-height: 0;
}

.cvl {
  background: #fbfcff;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  overflow: auto;
  padding: 4px 0;
}

.cvitem {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: none;
  text-align: left;
  font-size: 12.5px;
  color: var(--text);
  cursor: pointer;
}

.cvitem:hover {
  background: #eef4ff;
}

.cvitem.on {
  background: #e3ecff;
  color: #1d4ed8;
  font-weight: 600;
}

.cve {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: #fff;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  overflow: hidden;
}

.cvhost {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.cvhost :deep(.cm-editor) {
  height: 100%;
}

.cvhost :deep(.cm-scroller) {
  overflow: auto;
}
</style>
