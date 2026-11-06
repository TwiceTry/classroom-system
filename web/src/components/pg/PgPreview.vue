<template>
  <section class="preview">
    <div class="ed-head">
      <FileIcon :path="page" :size="14" />
      <span class="mono ellip">{{ page || '（选一个页面）' }}</span>
      <span class="spacer"></span>
      <span v-if="npmPage" class="tag warn">npm 工程</span>
      <span v-else-if="running" class="tag ok">已渲染</span>
      <a v-if="page" :href="'/api/example-files/' + encodeURI(dir) + '/' + page" target="_blank" rel="noopener" class="btn mini">
        新窗口
      </a>
    </div>

    <div v-if="npmPage" class="npmcard">
      <div class="npmicon">⚙</div>
      <h3>这一课是 npm 工程，浏览器里预览不了</h3>
      <p>
        它的入口是 <code>{{ npmEntry }}</code>，代码靠 Vite 打包、裸模块（<code>vue</code> /
        <code>vue-router</code> / <code>pinia</code>）由 node_modules 解析。
        这里没有打包器，也没有 node_modules，所以给不出画面——不是坏了。
      </p>
      <ol>
        <li>在<code>代码示例/{{ dir }}</code> 里打开终端</li>
        <li><code>npm install</code>（第一次，要联网）</li>
        <li><code>npm run dev</code>，照着终端给的地址打开</li>
      </ol>
      <p class="dim">左边的源码仍然可以看、可以改，改完在真实工程里对照。</p>
    </div>

    <template v-else>
      <iframe ref="frameEl" class="frame" title="preview" @load="$emit('load')"></iframe>

      <div v-if="pageErrors.length" class="perr">
        <div class="perr-head">
          <span class="perr-badge" :class="{ soft: !codeErrors.length }">{{ pageErrors.length }}</span>
          <b>页面报错</b>
          <span class="dim">改完会自动重跑；有行号的能点「跳到第 N 行」</span>
          <span class="spacer"></span>
          <button class="perr-mini" title="把全部报错复制到剪贴板" @click="$emit('copy')">
            {{ copied ? '已复制' : '复制' }}
          </button>
          <button class="perr-mini" @click="$emit('clear')">清空</button>
          <button class="perr-x" title="收起报错" @click="$emit('clear')">×</button>
        </div>
        <ol class="perr-list">
          <li v-for="e in codeErrors" :key="e.id" :class="'k-' + e.kind">
            <div class="perr-line">
              <span class="perr-tag">{{ kindLabel(e) }}</span>
              <span class="perr-msg">{{ e.msg }}</span>
              <button v-if="e.line" class="perr-jump" @click="$emit('jump', e)">跳到第 {{ e.line }} 行</button>
            </div>
            <div v-if="e.loc" class="perr-loc">{{ e.loc }}</div>
            <pre v-if="e.frames.length" class="perr-stack">{{ e.frames.join('\n') }}</pre>
          </li>
          <li v-if="resErrors.length" class="res-sum">
            <button class="perr-jump" @click="$emit('update:resOpen', !resOpen)">
              {{ resOpen ? '收起' : '展开' }} {{ resErrors.length }} 个资源加载失败
            </button>
            <span class="dim">（多半是示例图片路径，不影响代码；点开可看具体是哪个文件）</span>
          </li>
          <template v-if="resOpen">
            <li v-for="e in resErrors" :key="e.id" :class="'k-' + e.kind">
              <div class="perr-line">
                <span class="perr-tag">{{ kindLabel(e) }}</span>
                <span class="perr-msg">{{ e.msg }}</span>
              </div>
            </li>
          </template>
        </ol>
      </div>
    </template>
  </section>
</template>

<script setup>
/*
 * PgPreview —— 代码工作台右侧的预览区
 *
 * 只负责「把 iframe 和报错面板画出来」，不含任何预览逻辑：
 * 拼 srcdoc、抓报错、保滚动位置都在 composables/usePgPreview.js。
 *
 * iframe 元素要交给父组件（usePgPreview 要往 srcdoc 里塞文档），
 * 所以用 defineExpose 把元素本身暴露出去，父组件 watch 到之后再赋给自己的 ref。
 */
import { ref } from 'vue'
import FileIcon from '../FileIcon.vue'

defineProps({
  page: { type: String, default: '' },
  dir: { type: String, default: '' },
  npmPage: { type: Boolean, default: false },
  npmEntry: { type: String, default: '' },
  running: { type: Boolean, default: false },
  pageErrors: { type: Array, default: () => [] },
  codeErrors: { type: Array, default: () => [] },
  resErrors: { type: Array, default: () => [] },
  resOpen: { type: Boolean, default: false },
  copied: { type: Boolean, default: false },
  kindLabel: { type: Function, required: true },
})

defineEmits(['load', 'copy', 'clear', 'jump', 'update:resOpen'])

const frameEl = ref(null)

/** 把 iframe 元素本身交给父组件（它要写 srcdoc） */
defineExpose({ frameEl })
</script>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  background: #fff;
}
.frame {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  border: 0;
  background: #fff;
}
.npmcard {
  margin: 14px;
  padding: 16px 18px;
  border: 1px solid #e2dcc6;
  border-radius: 6px;
  background: #fdfaf1;
  color: #5b4c22;
  font-size: 13px;
  line-height: 1.7;
}
.npmicon {
  font-size: 22px;
  line-height: 1;
  margin-bottom: 6px;
}
.npmcard h3 {
  margin: 0 0 6px;
  font-size: 14px;
  color: #4a3d16;
}
.npmcard p {
  margin: 6px 0;
}
.npmcard ol {
  margin: 6px 0 6px 18px;
  padding: 0;
}
.npmcard li {
  margin: 2px 0;
}
.perr {
  max-height: 42%;
  overflow: auto;
  border-top: 1px solid #f0d9d5;
  background: #fff8f7;
}
.perr-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 9px;
  border-bottom: 1px solid #f6e2de;
  font-size: 12.5px;
  color: #8a3a2c;
  position: sticky;
  top: 0;
  background: #fff8f7;
  z-index: 1;
}
.perr-head b {
  font-weight: 600;
}
.perr-head .dim {
  color: #a8786f;
  font-size: 12px;
}
.perr-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: #c0392b;
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
.perr-badge.soft {
  background: #c9a227;
}
.perr-mini,
.perr-x {
  border: 1px solid #e6c8c2;
  background: #fff;
  border-radius: 4px;
  padding: 1px 7px;
  font-size: 12px;
  color: #8a3a2c;
  cursor: pointer;
}
.perr-mini:hover,
.perr-x:hover {
  background: #fdeeea;
}
.perr-list {
  margin: 0;
  padding: 4px 9px 8px 26px;
  font-size: 12.5px;
  color: #5a3b34;
}
.perr-list li {
  margin: 5px 0;
}
.perr-list li::marker {
  color: #c9a227;
}
.perr-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}
.perr-tag {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 3px;
  background: #f3e2de;
  color: #8a3a2c;
  font-size: 11px;
}
.perr-list .k-reject .perr-tag {
  background: #e8e0f5;
  color: #5b3f8a;
}
.perr-list .k-console .perr-tag {
  background: #e2eef5;
  color: #2f5f7d;
}
.perr-list .k-compile .perr-tag {
  background: #fbedd9;
  color: #8a5a1c;
}
.perr-list .k-resource .perr-tag {
  background: #eceff1;
  color: #5c6b73;
}
.perr-msg {
  font-family: Consolas, 'Cascadia Mono', monospace;
  word-break: break-word;
}
.perr-list .k-resource .perr-msg {
  color: #6b7a82;
}
.perr-list .k-console .perr-msg {
  color: #2f5f7d;
}
.perr-jump {
  border: 0;
  background: none;
  padding: 0;
  color: #2f7d92;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}
.perr-jump:hover {
  color: #1d5568;
}
.perr-loc {
  color: #8a6a62;
  font-size: 11.5px;
  margin-left: 2px;
}
.perr-stack {
  margin: 4px 0 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: #fbf3f1;
  color: #6b4a43;
  font-size: 11.5px;
  line-height: 1.6;
  overflow: auto;
}
.perr-list .res-sum {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.perr-list .res-sum .dim {
  color: #8b7a75;
  font-size: 12px;
}
</style>
