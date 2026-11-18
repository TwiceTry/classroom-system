<template>
  <PageShell body-class="ws">
    <PageHead @reload="load">
      <template #title>系统日志</template>
      <template #sub>只记「出问题」的那些：青果登录失败、未捕获异常、慢请求。正常访问不记 —— 40 个学生的心跳一天能写几万条，淹掉真正要看的。</template>
      <template #right>
        <input v-model="q" class="input" placeholder="搜学号 / 关键词" style="width: 180px" @keyup.enter="load" />
        <select class="select" :value="day" style="width: 130px" @change="onDay">
          <option value="">最近 7 天</option>
          <option v-for="d in days" :key="d" :value="d">{{ d }}</option>
        </select>
        <button class="btn mini" @click="load">查询</button>
      </template>
    </PageHead>

    <section class="card">
      <!-- 类型筛选：用 tab 而不是下拉，一眼看到有哪几类、各自多少条 -->
      <div class="lgtabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="lgtab"
          :class="{ on: kind === t.key }"
          @click="pickKind(t.key)"
        >
          {{ t.label }}
          <span v-if="counts[t.key]" class="n">{{ counts[t.key] }}</span>
        </button>
        <span class="grow"></span>
        <span v-if="size" class="dim mini">共 {{ size.files }} 个文件 · {{ sizeText }} · 保留 {{ size.keepDays }} 天</span>
      </div>

      <div class="table-wrap logwrap">
        <table class="grid lgtbl">
          <thead>
            <tr>
              <th style="width: 92px">时间</th>
              <th style="width: 84px">类型</th>
              <th>发生了什么</th>
              <th style="width: 108px">学号</th>
              <th class="num" style="width: 76px">耗时</th>
              <th style="width: 30px"></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(row, i) in rows" :key="i">
              <!--
                类名带 log- 前缀是必须的：全局 .row 是 `display: flex`（表单行用的），
                叫 row 会让 <tr> 变成 flex 容器 —— 每个 td 变成 flex 子项，
                整行看上去是竖排的。和讲义那边 .side 撞侧栏是同一类坑。
              -->
              <tr class="logrow" :class="{ open: opened.has(i) }" @click="toggle(i)">
                <td class="mono dim">{{ hhmmss(row.t) }}</td>
                <td><span class="tag" :class="tagOf(row.kind)">{{ textOf(row.kind) }}</span></td>
                <td class="msg">{{ row.msg }}</td>
                <td class="mono dim">{{ row.sid || '—' }}</td>
                <td class="num dim">{{ row.ms ? row.ms + 'ms' : '—' }}</td>
                <td class="dim">{{ opened.has(i) ? '▾' : '▸' }}</td>
              </tr>
              <!-- 展开：目标主机返回的原文 / 堆栈 / 请求路径 —— 排查就看这一块 -->
              <tr v-if="opened.has(i)" class="detail">
                <td colspan="6">
                  <dl>
                    <template v-for="f in detailOf(row)" :key="f.k">
                      <dt>{{ f.k }}</dt>
                      <dd :class="{ stack: f.k === '堆栈' }">{{ f.v }}</dd>
                    </template>
                  </dl>
                </td>
              </tr>
            </template>

            <tr v-if="!rows.length && !loading">
              <td colspan="6" class="log-empty">
                <b>{{ isEmptyBecauseNoData ? '还没有任何异常记录' : '这个筛选条件下没有记录' }}</b>
                <span v-if="isEmptyBecauseNoData">
                  这是好事 —— 说明青果登录、接口调用都正常。真出问题时，失败的原文会记在这里。
                </span>
                <span v-else>换个类型或日期试试。</span>
              </td>
            </tr>
            <tr v-if="loading">
              <td colspan="6" class="dim" style="text-align: center; padding: 24px">读取中…</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </PageShell>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from '../../api'
import PageShell from '../../components/PageShell.vue'
import PageHead from '../../components/PageHead.vue'

/*
 * 系统日志（教师端）
 *
 * 只展示「异常行为」：青果登录失败、未捕获异常、慢请求、5xx。
 * 不展示正常访问 —— 那个量级（40 人 × 10 秒心跳）除了淹掉有用信息没别的用。
 *
 * 每条都能展开看原文：青果回的「您24小时内已输错1次密码…」这种话
 * 才是判断「密码错」还是「账号被锁」的依据，光看我们翻译的那句不够。
 */

const TABS = [
  { key: '', label: '全部' },
  { key: 'kg-login', label: '青果登录' },
  { key: 'uncaught', label: '异常' },
  { key: 'fail', label: '接口失败' },
  { key: 'slow', label: '慢请求' },
]

const rows = ref([])
const days = ref([])
const size = ref(null)
const kind = ref('')
const day = ref('')
const q = ref('')
const loading = ref(false)
const opened = ref(new Set())
/** 有没有过任何记录（用来区分「一条都没有」和「筛没了」） */
const everHad = ref(false)

const sizeText = computed(() => {
  const b = (size.value && size.value.bytes) || 0
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB'
  return (b / 1048576).toFixed(1) + ' MB'
})

/** 各类型的条数（当前这批数据里），给 tab 上的小数字 */
const counts = computed(() => {
  const m = {}
  for (const r of rows.value) m[r.kind] = (m[r.kind] || 0) + 1
  return m
})

const isEmptyBecauseNoData = computed(() => !everHad.value && !q.value && !day.value)

const textOf = (k) =>
  ({ 'kg-login': '青果登录', uncaught: '异常', fail: '接口失败', slow: '慢请求', net: '网络', edge: '上报' }[k] || k || '其它')

const tagOf = (k) =>
  ({ 'kg-login': 'warn', uncaught: 'err', fail: 'err', slow: 'mute', net: 'err', edge: 'warn' }[k] || 'mute')

function hhmmss(t) {
  if (!t) return ''
  try {
    return new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
  } catch (e) {
    return String(t).slice(11, 19)
  }
}

/** 展开区的字段：只列有值的，省得一片「—」 */
function detailOf(row) {
  const out = []
  const push = (k, v) => {
    if (v !== undefined && v !== null && String(v).trim() !== '') out.push({ k, v: String(v) })
  }
  push('目标主机', row.target)
  push('目标返回', row.remote)
  push('状态', row.status)
  push('失败计数', row.counter)
  push('需要验证码', row.needCaptcha ? '是' : '')
  push('请求', row.method && row.url ? row.method + ' ' + row.url : row.url)
  push('身份', row.role ? row.role + (row.sid ? ' · ' + row.sid : '') : '')
  push('错误码', row.code)
  push('堆栈', row.stack)
  return out
}

function toggle(i) {
  const s = new Set(opened.value)
  if (s.has(i)) s.delete(i)
  else s.add(i)
  opened.value = s
}

function pickKind(k) {
  kind.value = k
  load()
}

function onDay(e) {
  day.value = e.target.value
  load()
}

async function load() {
  loading.value = true
  opened.value = new Set()
  try {
    const p =
      '/api/logs?limit=300' +
      (kind.value ? '&kind=' + encodeURIComponent(kind.value) : '') +
      (day.value ? '&day=' + encodeURIComponent(day.value) : '') +
      (q.value.trim() ? '&q=' + encodeURIComponent(q.value.trim()) : '')
    const r = await api.get(p)
    rows.value = r.items || []
    days.value = r.days || []
    size.value = r.size || null
    if (rows.value.length) everHad.value = true
  } catch (e) {
    rows.value = []
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
/* 类型筛选：和班级管理那边内层 tab 同一套「文件夹标签」的观感 */
.lgtabs {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 0 var(--sp-1) var(--sp-2);
  border-bottom: 1px solid var(--line);
  margin-bottom: var(--sp-2);
}
.lgtab {
  padding: 6px 12px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--r-md) var(--r-md) 0 0;
  background: transparent;
  color: #5b6673;
  cursor: pointer;
  font-size: var(--fs-md);
  margin-bottom: -1px;
}
.lgtab:hover {
  background: var(--bg-sub);
  color: var(--ink);
}
.lgtab.on {
  background: var(--card);
  color: var(--brand-ink);
  font-weight: 600;
  border-color: var(--line);
  border-bottom-color: var(--card);
}
.lgtab .n {
  margin-left: 5px;
  font-size: var(--fs-xs);
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}
.grow {
  flex: 1;
}

.logwrap {
  max-height: calc(100vh - 260px);
}

/*
 * 这张表必须用 fixed 布局。
 *
 * 用 auto 时浏览器按内容分宽度：错误消息又长又不带空格（URL、英文栈），
 * 它算出来的「最小内容宽度」是个位数，于是那一列被压成一条竖缝，
 * 中文逐字往下掉 —— 实测出来是一行一个字。
 * fixed + 其余列定宽之后，「发生了什么」稳定吃掉剩下的全部宽度。
 */
.lgtbl {
  table-layout: fixed;
  width: 100%;
}

.lgtbl tbody tr.logrow {
  cursor: pointer;
}
.lgtbl tbody tr.logrow:hover {
  background: var(--bg-sub);
}
.lgtbl tbody tr.logrow.open {
  background: var(--bg-sub);
}
/*
 * 主内容列：正常换行，长串（URL / 英文栈）用 anywhere 兜底。
 * 不用 break-word —— 它会把中文也按字符断开，配合窄列就是竖排。
 */
.lgtbl .msg {
  line-height: 1.55;
  word-break: normal;
  overflow-wrap: anywhere;
  padding-right: var(--sp-3);
}

/* 展开区：深一点的底 + 两列（字段名 / 值） */
.lgtbl tbody tr.detail > td {
  background: #fafbfc;
  padding: 0;
}
.lgtbl tbody tr.detail dl {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 4px var(--sp-3);
  margin: 0;
  padding: var(--sp-3) var(--sp-4);
  border-left: 3px solid var(--line-strong);
  margin-left: 2px;
}
.lgtbl tbody tr.detail dt {
  color: var(--dim);
  font-size: var(--fs-sm);
}
.lgtbl tbody tr.detail dd {
  margin: 0;
  font-size: var(--fs-sm);
  color: #33414d;
  word-break: break-word;
  white-space: pre-wrap;
}
/* 堆栈用等宽，不然一坨中文斜体很难读 */
.lgtbl tbody tr.detail dd.stack {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: #6b7480;
  max-height: 220px;
  overflow: auto;
}

.log-empty {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-5) var(--sp-4);
  text-align: center;
  line-height: 1.6;
}
.log-empty b {
  font-weight: 600;
  color: var(--ink);
  font-size: var(--fs-md);
}
.log-empty span {
  font-size: var(--fs-sm);
  color: var(--dim);
}
</style>
