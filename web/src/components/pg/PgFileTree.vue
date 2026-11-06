<template>
  <aside class="files">
    <div class="files-head">
      <span class="mono ellip">{{ dirLabel }}</span>
      <label class="eye" title="连页面和入口文件一起显示">
        <input :checked="showAll" type="checkbox" @change="$emit('update:showAll', $event.target.checked)" /> 全部
      </label>
    </div>

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
            <span v-if="isDirty(it.path)" class="dot"></span>
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
})

defineEmits(['open-group', 'open-file', 'toggle-group', 'update:showAll', 'clear-saved'])

/** 某个文件改过没有（和原始示例比） */
function isDirty(p) {
  if (!p) return false
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
</style>
