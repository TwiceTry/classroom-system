<template>
  <aside class="files">
    <div class="files-head">
      <span class="mono ellip">{{ dirLabel }}</span>
      <button
        class="addbtn"
        :disabled="!canAdd"
        :title="addHint || '新建一个文件'"
        @click="startAdd"
      >
        +
      </button>
      <label class="eye" title="连页面和入口文件一起显示">
        <input :checked="showAll" type="checkbox" @change="$emit('update:showAll', $event.target.checked)" /> 全部
      </label>
    </div>

    <!-- 新建文件：内联输入，不弹窗（机房机器上弹窗容易点错） -->
    <div v-if="adding" class="addrow">
      <input
        ref="addInput"
        v-model="addName"
        class="addinput"
        placeholder="文件名，如 style.css"
        spellcheck="false"
        @keydown.enter.prevent="commitAdd"
        @keydown.esc.prevent="cancelAdd"
      />
      <button class="addok" @click="commitAdd">建</button>
      <button class="addcancel" @click="cancelAdd">取消</button>
    </div>
    <p v-if="addErr" class="adderr">{{ addErr }}</p>

    <div class="treescroll">
      <div v-for="(g, gi) in tree.groups" :key="gi" class="grp">
        <button
          v-if="g.kind === 'page'"
          class="ghead"
          :class="{ on: g.page === page }"
          :title="g.page"
          @click="$emit('open-group', g)"
        >
          <span v-if="visibleItems(g).length" class="caret" @click.stop="$emit('toggle-group', gi)">{{
            closed[gi] ? '▸' : '▾'
          }}</span>
          <span v-else class="caret none"></span>
          <FileIcon :path="g.page" :size="15" />
          <span class="ellip">{{ shortPage(g.page) }}</span>
          <span v-if="groupDirty(g)" class="dot"></span>
        </button>
        <div v-else class="ghead static">
          <span class="ellip">{{ g.kind === 'shared' ? '多页共用' : '未被页面引用' }} · {{ g.items.length }}</span>
        </div>

        <template v-if="!closed[gi]">
          <button
            v-for="it in visibleItems(g)"
            :key="it.path"
            class="item"
            :class="{ on: it.path === activeFile }"
            :title="it.path"
            @click="$emit('open-file', it.path)"
          >
            <FileIcon :path="it.path" :size="15" />
            <span class="ellip">{{ shortName(g, it.path) }}</span>
            <span v-if="isNewPath(it.path)" class="newtag" title="你新建的文件">新</span>
            <span v-if="isDirty(it.path)" class="dot"></span>
            <span
              v-if="isNewPath(it.path)"
              class="del"
              title="删除这个文件（只删得掉自己新建的）"
              @click.stop="askRemove(it.path)"
            >×</span>
          </button>
        </template>
      </div>
    </div>

    <div class="files-foot" :title="footTitle">
      <span class="dot" :class="{ off: !dirtyCount, fail: storeFail }"></span>
      <span class="ellip">{{ footText }}</span>
      <button v-if="dirtyCount" class="linkbtn" title="清掉本机记住的改动，回到原始示例" @click="$emit('clear-saved')">
        清空
      </button>
    </div>
  </aside>
</template>

<script setup>
/*
 * PgFileTree —— 代码工作台左侧的文件树
 *
 * 纯展示 + 点击：所有状态（改没改、显示全部、哪一组收起）都由父组件持有，
 * 这里只负责按 tree 结构画出来并往外抛事件。
 *
 * 一个容易踩的点：`closed` 是父组件的 reactive 对象，别在这里复制一份，
 * 否则两边的收起状态会各走各的。
 */
import { nextTick, ref } from 'vue'
import { baseOf, visibleItemsOf } from '../../utils/pgTree'
import FileIcon from '../FileIcon.vue'

const props = defineProps({
  dirLabel: { type: String, default: '' },
  tree: { type: Object, default: () => ({ groups: [], byPath: {} }) },
  page: { type: String, default: '' },
  activeFile: { type: String, default: '' },
  /** { [组序号]: true } —— 收起状态，父组件持有 */
  closed: { type: Object, default: () => ({}) },
  showAll: { type: Boolean, default: false },
  bundle: { type: Object, default: null },
  edits: { type: Object, default: () => ({}) },
  dirtyCount: { type: Number, default: 0 },
  storeFail: { type: Boolean, default: false },
  footText: { type: String, default: '' },
  footTitle: { type: String, default: '' },
  /* ---- 新建文件 ---- */
  /** 现在能不能新建（只读 / 老师在推代码时为 false） */
  canAdd: { type: Boolean, default: false },
  /** 「+」的提示，由父组件按身份给不同文案 */
  addHint: { type: String, default: '' },
  /** 学生自己新建的那些路径 */
  newPaths: { type: Array, default: () => [] },
  /**
   * 新建 / 删除的执行函数，由父组件传进来（`(name) => ({ ok, why })`）。
   *
   * 为什么用函数 prop 而不是 emit：执行结果（失败原因）要立刻显示在输入框下面，
   * emit 是单向的、拿不到返回值，只能再加一路事件转发，反而更绕。
   */
  doAdd: { type: Function, default: null },
  doRemove: { type: Function, default: null },
})

defineEmits(['open-group', 'open-file', 'toggle-group', 'update:showAll', 'clear-saved'])

/* ---------------- 新建文件 ---------------- */
const adding = ref(false)
const addName = ref('')
const addErr = ref('')
const addInput = ref(null)

function startAdd() {
  if (!props.canAdd) {
    addErr.value = props.addHint || '现在不能新建'
    return
  }
  adding.value = true
  addErr.value = ''
  addName.value = ''
  nextTick(() => addInput.value && addInput.value.focus())
}

function cancelAdd() {
  adding.value = false
  addName.value = ''
  addErr.value = ''
}

function commitAdd() {
  const r = props.doAdd ? props.doAdd(addName.value) : { ok: false, why: '不支持新建' }
  if (!r || !r.ok) {
    addErr.value = (r && r.why) || '新建失败'
    return
  }
  cancelAdd()
}

function askRemove(p) {
  if (!window.confirm('删除「' + p + '」？这个文件是你自己新建的，删了就没了。')) return
  const r = props.doRemove ? props.doRemove(p) : { ok: false, why: '不支持删除' }
  if (!r || !r.ok) addErr.value = (r && r.why) || '删除失败'
}

function isNewPath(p) {
  return (props.newPaths || []).indexOf(p) >= 0
}

/** 某个文件改过没有（和原始示例比）；学生新建的天然算「改过」 */
function isDirty(p) {
  if (!p) return false
  if (isNewPath(p)) return true
  const files = (props.bundle && props.bundle.files) || []
  const f = files.find((x) => x.path === p)
  if (!f) return false
  return props.edits[p] !== undefined && props.edits[p] !== f.text
}

function groupDirty(g) {
  return g.items.some((it) => isDirty(it.path))
}

/** 组里显示哪些文件（规则在 utils/pgTree.js，和 openGroup 共用） */
function visibleItems(g) {
  return visibleItemsOf(g, props.showAll)
}

function shortName(g, p) {
  return g.dir && p.indexOf(g.dir) === 0 ? p.slice(g.dir.length) : p
}

function shortPage(p) {
  const b = baseOf(p)
  const d = p.slice(0, p.length - b.length)
  return d ? d.replace(/\/$/, '') + '/' + b : b
}
</script>

<style scoped>
.files {
  /* 这一条是布局用的：父容器 .work 是 flex，宽度由这里定 */
  flex: 0 0 206px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 300px;
  border-right: 1px solid #dde5ea;
  background: #fafcfd;
}
.files-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid #e8eef2;
}
.eye {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  font-size: 12px;
  color: #5b7b86;
  cursor: pointer;
  white-space: nowrap;
}
.treescroll {
  flex: 1;
  overflow: auto;
  padding: 6px 4px;
}
.files-foot {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  border-top: 1px solid #e8eef2;
  font-size: 12px;
  color: #5b7b86;
}
.files-foot .dot.off {
  background: #c9d6dd;
}
.files-foot .dot.fail {
  background: #c0392b;
}
.linkbtn {
  border: 0;
  background: none;
  padding: 0 0 0 4px;
  color: #2f7d92;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.linkbtn:hover {
  text-decoration: underline;
}
.grp + .grp {
  margin-top: 2px;
}
.ghead {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  border: 0;
  background: none;
  padding: 4px 5px;
  border-radius: 4px;
  font-size: 12.5px;
  color: #33505c;
  text-align: left;
  cursor: pointer;
}
.ghead:hover {
  background: #eef4f7;
}
.ghead.on {
  background: #e3eef3;
  font-weight: 600;
}
.ghead.static {
  cursor: default;
  color: #7d949e;
}
.caret {
  flex: 0 0 12px;
  width: 12px;
  color: #8aa2ac;
  font-size: 10px;
  line-height: 1;
}
.caret.none {
  opacity: 0;
}
.item {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  border: 0;
  background: none;
  padding: 3px 5px 3px 22px;
  border-radius: 4px;
  font-size: 12.5px;
  color: #3d5763;
  text-align: left;
  cursor: pointer;
}
.item:hover {
  background: #eef4f7;
}
.item.on {
  background: #dcebf2;
  color: #1d5568;
  font-weight: 600;
}
.dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #d08a2c;
  margin-left: auto;
}

/* ---------------- 新建文件 ---------------- */
.addbtn {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  line-height: 1;
  border: 1px solid #d5dbe2;
  background: #fff;
  border-radius: 5px;
  color: #5b7b86;
  font-size: 14px;
  cursor: pointer;
}
.addbtn:hover:not(:disabled) {
  border-color: #9dbcc8;
  color: #2b6cb0;
}
.addbtn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.addrow {
  display: flex;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid #e8eef2;
}
.addinput {
  flex: 1;
  min-width: 0;
  padding: 4px 7px;
  border: 1px solid #d5dbe2;
  border-radius: 5px;
  font-size: 12px;
  font-family: inherit;
}
.addok,
.addcancel {
  flex: none;
  padding: 2px 8px;
  border: 1px solid #d5dbe2;
  background: #fff;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
}
.addok {
  color: #2e7d32;
  border-color: #cfe6cf;
}
.adderr {
  margin: 4px 10px 6px;
  font-size: 12px;
  line-height: 1.4;
  color: #c0392b;
}
.newtag {
  flex: none;
  margin-left: 4px;
  padding: 0 3px;
  border-radius: 3px;
  background: #eef6ff;
  color: #2b6cb0;
  font-size: 10px;
  line-height: 14px;
}
.item .del {
  flex: none;
  margin-left: 4px;
  padding: 0 3px;
  color: #b0b9c2;
  font-size: 13px;
  cursor: pointer;
}
.item .del:hover {
  color: #c0392b;
}
</style>
