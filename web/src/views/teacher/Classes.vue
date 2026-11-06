<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>班级管理 · 名单与分数</template>
        <template #sub>{{ itemsLine }}；这一页只看分，记分在各模块页 / 考勤页里做</template>
        <template #right>
          <button class="btn mini" @click="openIO" title="整门课的班级与名单打成一个 zip：导出、导入、下载模板">班级与名单</button>
    <button class="btn mini" :disabled="!active" @click="openImport">导入名单</button>
          <button class="btn mini" @click="newClass">＋ 新建班级</button>
        </template>
      </PageHead>
    </template>
    <p v-if="error" class="hint err" style="margin-bottom:12px">{{ error }}</p>

    <div v-if="!classes.length" class="card">
      <div class="empty">
        还没有班级。点右上角「＋ 新建班级」，再「导入名单」（支持 .xlsx / .csv，也可直接粘贴）。
      </div>
    </div>

    <template v-else>
      <div class="card classbar">
        <button
        v-for="c in classes"
        :key="c.id"
        class="pill"
        :class="{ on: c.id === activeId }"
        @click="switchClass(c.id)"
        >
        {{ c.name }}<em>{{ c.count }}</em>
      </button>
      <span class="spacer"></span>
      <button v-if="active" class="btn mini" @click="renameClass">重命名</button>
      <button v-if="active" class="btn mini danger" @click="removeClass">删除班级</button>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ on: tab === 'board' }" @click="tab = 'board'">班级名单</button>
      <button class="tab" :class="{ on: tab === 'log' }" @click="tab = 'log'">
        全班流水 <span class="dim">{{ events.length }}</span>
      </button>
    </div>

    <section v-show="tab === 'board'" class="card">
      <CardHead>
        <template #title>{{ active ? active.name : '' }}</template>
        <template #meta><span class="dim">
            {{ students.length }} 人 · 在线 {{ presence.onlineCount }} · 在看投屏 {{ presence.castingCount }} · 平均
            {{ board.totalAvg || 0 }} · 及格率 {{ board.passRate || 0 }}%
          </span></template>
        <template #right>
          <button class="btn mini" :disabled="!active" @click="openStudent(null)">＋ 添加学生</button>
          <button class="btn mini" :disabled="!active" @click="exportCsv('total')">导出总评</button>
          <span class="dim">点一行看明细 · 在线状态每 8 秒刷新</span>
        </template>
      </CardHead>

      <!-- 筛选条：关键字 + 几个常用的「只看…」，跟排序互不影响 -->
      <FilterBar>
        <input v-model.trim="q" class="input" placeholder="搜姓名 / 学号" style="width: 150px" />
        <select v-model="fStatus" class="select">
          <option value="">状态：全部</option>
          <option value="online">只看在线</option>
          <option value="offline">只看离线</option>
        </select>
        <select v-model="fCast" class="select">
          <option value="">投屏：全部</option>
          <option value="on">只看在看</option>
        </select>
        <select v-model="fTotal" class="select">
          <option value="">总评：全部</option>
          <option value="pass">及格（≥60）</option>
          <option value="fail">不及格（&lt;60）</option>
        </select>
        <select v-model="fBonus" class="select">
          <option value="">加分：全部</option>
          <option value="has">只看有加分</option>
        </select>
        <span class="dim">{{ filtered.length }} / {{ boardList.length }} 人</span>
        <span class="spacer"></span>
        <button v-if="hasFilter" class="btn mini" @click="clearFilter">清除筛选</button>
        <span class="dim">点表头排序 · 课堂作业 / 大作业的分在各模块里打，这里只显示</span>
      </FilterBar>

      <DataTable
        :columns="cols"
        :rows="filtered"
        :row-key="(r) => r.student.sid"
        clickable
        max-height="62vh"
        :sort-key="sortKey"
        :sort-dir="sortDir"
        :empty="students.length ? '没有匹配的学生，换个筛选条件或点「清除筛选」' : '还没有名单，先「导入名单」'"
        @sort="sortBy"
        @row-click="(r) => (pickedSid = r.student.sid)"
      >
        <template #cell="{ row, index, column }">
          <template v-if="column.key === 'no'">{{ index + 1 }}</template>
          <template v-else-if="column.key === 'sid'">{{ row.student.sid }}</template>
          <template v-else-if="column.key === 'name'"><b style="font-weight: 500">{{ row.student.name }}</b></template>
          <template v-else-if="column.key === 'status'">
            <span class="tag" :class="presenceSet.has(row.student.sid) ? 'ok' : 'mute'">
              {{ presenceSet.has(row.student.sid) ? '在线' : '离线' }}
            </span>
          </template>
          <template v-else-if="column.key === 'cast'">
            <span class="tag" :class="castingSet.has(row.student.sid) ? 'ok' : 'mute'">
              {{ castingSet.has(row.student.sid) ? '在看' : '—' }}
            </span>
          </template>
          <template v-else-if="column.key === 'total'"><b>{{ row.total }}</b></template>
          <template v-else-if="column.key === 'actions'">
            <button class="btn mini" title="改姓名 / 学号" @click.stop="openStudent(row.student)">编辑</button>
            <button class="btn mini danger" title="从名单里移除（记录保留）" @click.stop="removeStudent(row.student)">删除</button>
          </template>
          <template v-else>{{ column.value ? column.value(row) : row[column.key] }}</template>
        </template>
      </DataTable>
    </section>

    <section v-show="tab === 'log'" class="card">
    <CardHead>
    <template #title>全班流水</template>
    <template #right>
      <select v-model="logItem" class="select">
        <option value="">全部计分项</option>
        <option v-for="it in items" :key="it.key" :value="it.key">{{ it.name }}</option>
      </select>
      <input v-model.trim="logQ" class="input" placeholder="搜姓名 / 学号 / 原因" style="width: 200px" />
      <button class="btn mini" :disabled="!active" @click="exportCsv('events')">导出流水</button>
      <span class="dim">有效 {{ liveCount }} 条</span>
    </template>
    </CardHead>

    <ul class="log">
    <li v-for="e in filteredEvents" :key="e.id" :class="{ voided: e.voided }">
      <div class="lhead">
        <span class="when">{{ fmt(e.createdAt) }}</span>
        <b class="who">{{ nameOf(e.sid) }}</b>
        <span class="tag" :class="'tag-' + e.item">{{ itemName(e.item) }}</span>
        <b class="delta">{{ summary(e) }}</b>
        <span v-if="e.voided" class="tag mute">已撤销</span>
        <span class="spacer"></span>
      </div>
      <p class="reason">{{ e.reason }}</p>
      <div class="lf">
        <span class="dim">{{ e.operator }}</span>
        <a v-for="f in e.evidence || []" :key="f.url" :href="f.url" target="_blank" rel="noopener">{{ f.name }}</a>
      </div>
    </li>
    <li v-if="!filteredEvents.length" class="empty">没有符合条件记录</li>
    </ul>
    </section>

    <!-- 点名：并进这里，不再单开一个页面 -->
    </template>


    <!-- 学生明细 -->
    <StudentDrawer
    v-if="pickedRow"
    :student="pickedRow.student"
    :row="pickedRow"
    :items="items"
    readonly
    @close="pickedSid = ''"
    />

    <!-- 添加 / 编辑学生 -->
    <div v-if="editingStudent" class="mask" @click.self="editingStudent = null">
    <div class="modal">
    <div class="modal-head">
    <h3>{{ editingStudent.isNew ? '添加学生' : '编辑学生' }} · {{ active ? active.name : '' }}</h3>
    <button class="btn mini" style="margin-left: auto" @click="editingStudent = null">关闭</button>
    </div>
    <div class="modal-body">
    <label class="field">
      <span>学号</span>
      <input
      v-model.trim="studentForm.sid"
      class="input"
      placeholder="如 2025010102"
      :disabled="!editingStudent.isNew && studentForm.hasRecords"
      />
    </label>
    <p v-if="!editingStudent.isNew && studentForm.hasRecords" class="hint warn" style="margin: -2px 0 10px">
      这个学生已有记分 / 作业记录，学号不能改（姓名可以改）。
    </p>
    <label class="field">
      <span>姓名</span>
      <input v-model.trim="studentForm.name" class="input" placeholder="如 李四" @keyup.enter="saveStudent" />
    </label>
    </div>
    <div class="modal-foot">
    <span class="dim">只改名单，不动已有的记分与作业</span>
    <span class="spacer"></span>
    <button class="btn ghost" @click="editingStudent = null">取消</button>
    <button class="btn primary" :disabled="studentBusy || !studentForm.sid || !studentForm.name" @click="saveStudent">
      {{ studentBusy ? '保存中…' : '保存' }}
    </button>
    </div>
    </div>
    </div>

    <!-- 班级与名单：整门课一起搬（导出 / 导入 / 模板） -->
    <div v-if="cio.open" class="mask" @click.self="closeIO">
      <div class="modal wide">
        <div class="modal-head">
          <h3>班级与名单 · {{ courseName }}</h3>
          <button class="btn mini" style="margin-left: auto" @click="closeIO">关闭</button>
        </div>
        <div class="modal-body">
          <p class="dim mini" style="margin-top: 0">
            一个 csv = 一个班，<b>文件名就是班名</b>（如 <code>示例1班.roster.csv</code>），三列「学号,姓名,备注」。
            新部署时先「下载模板」，照格式填好各班名单，压缩成 zip 再导进来 —— 一次把整门课配齐。
          </p>

          <div class="row" style="margin-bottom: 12px">
            <button class="btn mini" :disabled="cio.busy || !hasClasses" @click="ioExport" title="把当前所有班级与名单打成一个 zip">⤓ 导出全部班级与名单</button>
            <button class="btn mini" :disabled="cio.busy" @click="ioTemplate" title="空模板：一个示例班 + 命名与格式说明">⤓ 下载模板</button>
            <button class="btn mini primary" :disabled="cio.busy" @click="ioPick.click()">⤒ 选择 zip 导入</button>
            <input ref="ioPick" type="file" accept=".zip" style="display: none" @change="ioFile" />
          </div>

          <div v-if="cio.err" class="hint err">{{ cio.err }}</div>
          <div v-if="cio.busy" class="hint">正在解析…</div>

          <div v-if="cio.report">
            <p class="hint" style="margin: 0 0 6px">
              {{ cio.name }}：新建 <b class="add">{{ cio.report.totals.create }}</b> 个班 ·
              更新 {{ cio.report.totals.update }} 个班 ·
              新增 {{ cio.report.totals.added }} 人 · 改名 {{ cio.report.totals.renamed }} 人
              <template v-if="cio.report.totals.removed">· <b class="del">移出 {{ cio.report.totals.removed }}</b> 人</template>
            </p>
            <div class="cio-list">
              <div v-for="c in cio.report.classes" :key="c.name" class="cio-row">
                <span class="cio-name">{{ c.name }}</span>
                <span class="cio-act" :class="{ add: c.action === 'create' }">{{ c.action === 'create' ? '新建' : '已有' }}</span>
                <span class="dim">
                  {{ c.before }} → <b>{{ c.after }}</b> 人 ·
                  新增 {{ c.added }} · 改名 {{ c.updated }}<template v-if="c.removed"> · 移出 {{ c.removed }}</template>
                </span>
              </div>
            </div>
            <div v-if="cio.report.issues.length" class="hint warn" style="margin-top: 8px">
              <b>有 {{ cio.report.issues.length }} 处有问题（相关班可能少人）：</b>
              <ul class="iss">
                <li v-for="(it, i) in cio.report.issues.slice(0, 8)" :key="i">{{ it.cls }}：<template v-if="it.line">第 {{ it.line }} 行 </template>{{ it.msg }}</li>
              </ul>
            </div>
            <p v-if="cio.report.notInPack && cio.report.notInPack.length" class="dim mini">
              包里没有这些班，本地保留不动：{{ cio.report.notInPack.join('、') }}
            </p>

            <div class="row" style="margin-top: 10px">
              <label class="check"><input v-model="cio.mode" type="radio" value="merge" /> 合并（名单只增不减，推荐）</label>
              <label class="check"><input v-model="cio.mode" type="radio" value="replace" /> 整体替换（名单同步成包里的）</label>
            </div>
            <p class="dim mini">这一步之前一个字节都没写。整体替换只换名单，已有记分记录不删。</p>
          </div>
        </div>
        <div class="modal-foot">
          <span class="spacer"></span>
          <button class="btn ghost" @click="closeIO">取消</button>
          <button class="btn primary" :disabled="!cio.report || cio.busy" @click="ioApply">
            {{ cio.busy ? '导入中…' : '确认导入' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 导入名单 -->
    <div v-if="importing" class="mask" @click.self="importing = false">
    <div class="modal">
    <div class="modal-head">
    <h3>导入名单 · {{ active ? active.name : '' }}</h3>
    <button class="btn mini" style="margin-left: auto" @click="importing = false">关闭</button>
    </div>
    <div class="modal-body">
    <div class="row" style="margin-bottom: 10px">
      <button class="btn mini" @click="downloadTemplate" title="3 列：学号,姓名,备注（UTF-8 CSV，Excel 能直接打开）">
        下载空模板
      </button>
      <button class="btn mini" @click="downloadCurrent" :disabled="!(active && active.students && active.students.length)" title="导出本班现有名单，改完再传回来">
        下载当前名单
      </button>
      <span class="dim">表格按「学号,姓名,备注」填，存成 .xlsx 或 .csv 都行</span>
    </div>
    <div class="row" style="margin-bottom: 12px">
      <button class="btn mini" @click="fileInput.click()">选择 .xlsx / .csv</button>
      <input ref="fileInput" type="file" accept=".xlsx,.csv,.txt" style="display: none" @change="onFile" />
      <span class="dim">也可以把名单直接粘到下面</span>
    </div>
    <textarea
    v-model="pasteText"
    class="textarea"
    style="width: 100%; box-sizing: border-box"
    rows="7"
    placeholder="每行一条：学号 姓名（或 1,2025010101,张三 / 表格里直接复制粘贴）"
    @input="parsePaste"
    ></textarea>

    <div class="row" style="margin-top: 12px">
    <label class="check"><input v-model="importMode" type="radio" value="merge" /> 追加（保留原有同学）</label>
    <label class="check"><input v-model="importMode" type="radio" value="replace" /> 覆盖本班名单</label>
    </div>

    <p v-if="parsed.length || (report && report.parsed)" class="hint" style="margin-top: 10px">
    解析到 <b>{{ report && report.parsed ? report.parsed : parsed.length }}</b> 人<template v-if="sheetName">（{{ sheetName }}）</template><template v-if="parsed.length">：{{ previewNames }}</template>}
    </p>

    <!-- 服务端干跑：这一步只算不写 -->
    <div v-if="checking" class="hint" style="margin-top: 8px">正在核对名单…</div>
    <div v-if="report" class="import-plan" style="margin-top: 8px">
      <div class="ip-row">
        <span class="ip-k">变更</span>
        <span>
          新增 <b class="add">{{ report.added }}</b> 人 ·
          改名 {{ report.updated }} 人 ·
          不变 {{ report.unchanged }} 人
          <template v-if="report.removed">· <b class="del">移出 {{ report.removed }}</b> 人</template>
        </span>
      </div>
      <div class="ip-row">
        <span class="ip-k">班级人数</span>
        <span>{{ report.before }} → <b>{{ report.after }}</b> 人</span>
      </div>
      <div v-if="report.renamed.length" class="ip-row">
        <span class="ip-k">改名</span>
        <span class="dim">{{ report.renamed.map((r) => r.sid + '：' + r.from + ' → ' + r.to).join('、') }}</span>
      </div>
      <div v-if="report.removedSids.length" class="ip-row">
        <span class="ip-k">移出</span>
        <span class="del">{{ report.removedSids.join('、') }}<template v-if="report.removed > report.removedSids.length"> …</template></span>
      </div>
      <div class="ip-tip dim">核对无误再点右下角「确认导入」——这一步之前一个字节都没写。</div>
    </div>

    <div v-if="issues.length" class="hint warn" style="margin-top: 8px">
    <b>有 {{ issues.length }} 行没被采纳（不会导入，改好再传）：</b>
    <ul class="iss">
      <li v-for="(it, i) in issues.slice(0, 8)" :key="i">
        第 {{ it.line }} 行：{{ it.msg }}<span v-if="it.raw" class="dim">（{{ it.raw }}）</span>
      </li>
    </ul>
    <span v-if="issues.length > 8" class="dim">…… 还有 {{ issues.length - 8 }} 行</span>
    </div>
    <p v-if="!parsed.length && !issues.length" class="hint warn" style="margin-top: 10px">还没解析到学生：选一个表格文件，或粘贴「学号 姓名」列表。</p>
    <p v-if="importError" class="hint err" style="margin-top: 8px">{{ importError }}</p>
    </div>
    <div class="modal-foot">
    <span class="dim">覆盖只换名单，不删已有记分记录</span>
    <span class="spacer"></span>
    <button class="btn ghost" @click="importing = false">取消</button>
    <button
      class="btn primary"
      :disabled="!report || checking || importingBusy || (!parsed.length && !sheetFile)"
      @click="doImport"
    >
      {{
        importingBusy
          ? '导入中…'
          : report
            ? '确认导入（' + (report.incoming || report.parsed || parsed.length) + ' 人）'
            : '先选名单'
      }}
    </button>
    </div>
    </div>
    </div>

    <Toast :text="toast" @close="toast = ''" />
  </PageShell>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import StudentDrawer from '../../components/StudentDrawer.vue'
import Toast from '../../components/Toast.vue'
import { currentClassId, setClassId } from '../../utils/classSel'
import { api, download, getCourse, getToken } from '../../api'
import { refresh, state } from '../../store'
import { rowsToRosterDetailed, textToRows } from '../../utils/roster'
import { loadScheme } from '../../utils/scheme'
import PageHead from '../../components/PageHead.vue'
import CardHead from '../../components/CardHead.vue'
import FilterBar from '../../components/FilterBar.vue'
import PageShell from '../../components/PageShell.vue'
import DataTable from '../../components/DataTable.vue'

const classes = computed(() => state.classes)
const courseId = computed(() => getCourse())
const hasClasses = computed(() => classes.value.length > 0)
const courseName = ref('') // 当前课程名（打开「班级与名单」时顺手取一次）
const items = computed(() => state.items)
const mainItems = computed(() => state.items.filter((i) => !i.extra))

/* 顶部的「考勤 10 + 互动 10 + …」按当前方案现算，改分值不用改代码 */
const itemsLine = computed(() => {
  const parts = state.items.map((i) => (i.short || i.name) + ' ' + i.full)
  return parts.length ? parts.join(' + ') : '还没有考核项'
})

const route = useRoute()
const activeId = ref(localStorage.getItem('scores-class') || '')
// 老链接 /teacher/rollcall 会重定向到这里并带上 ?tab=rollcall
const tab = ref(['board', 'log'].indexOf(route.query.tab) >= 0 ? route.query.tab : 'board')
const q = ref('')
const error = ref('')
const toast = ref('')
const data = ref({ class: {}, students: [], board: { list: [] }, events: [] })

const pickedSid = ref('')


// 学生在场状态：只用于「班级里谁现在开着页面」的显示，不参与任何计分/考勤逻辑
const presence = ref({ onlineCount: 0, castingCount: 0, online: [], casting: [] })
const presenceSet = computed(() => new Set((presence.value.online || []).map((s) => s.sid)))
const castingSet = computed(() => new Set((presence.value.casting || []).map((s) => s.sid)))
let presenceTimer = null

const active = computed(() => classes.value.find((c) => c.id === activeId.value) || classes.value[0] || null)
const students = computed(() => data.value.students || [])
const board = computed(() => data.value.board || { list: [], totalAvg: 0, passRate: 0 })
const events = computed(() =>
  (data.value.events || []).map((e) => Object.assign({ summaryText: e.summary || '' }, e))
)


/* ---------------- 评分表的排序 / 筛选 ----------------
 * 排序只在浏览器里做（服务端给的还是按学号排的那一份），所以切换列不会多发请求；
 * 默认「学号升序」，点表头换方向，再点同一列反过来，并列时固定按学号收尾，
 * 免得分数一样的人每 8 秒刷新一次就换位置。
 */

const boardList = computed(() => board.value.list || [])

/* 评分表的列：前几列固定，中间是方案里的各项（动态），最后加分 / 总评 / 操作 */
const cols = computed(() => [
  { key: 'no', label: '#', width: '42px', num: true, tdClass: 'dim' },
  { key: 'sid', label: '学号', width: '110px', sortable: true, tdClass: 'dim' },
  { key: 'name', label: '姓名', width: '90px', sortable: true },
  { key: 'status', label: '状态', hint: '登录中', width: '78px', sortable: true },
  { key: 'cast', label: '投屏', hint: '在看', width: '78px', sortable: true },
  ...mainItems.value.map((it) => ({
    key: it.key,
    label: it.short,
    hint: String(it.full),
    num: true,
    sortable: true,
    value: (r) => scoreOf(r, it.key),
    tdClass: (r) => ({ none: !scoreOf(r, it.key) }),
  })),
  { key: 'bonus', label: '加分', hint: '5', num: true, sortable: true, value: (r) => scoreOf(r, 'bonus'), tdClass: (r) => ({ none: !scoreOf(r, 'bonus') }) },
  { key: 'total', label: '总评', hint: '100', num: true, sortable: true, value: (r) => r.total, tdClass: (r) => ['big', r.total >= 60 ? 'ok' : 'bad'] },
  { key: 'actions', label: '', width: '116px', tdClass: 'rowact' },
])

const sortKey = ref('sid')
const sortDir = ref('asc')

const fStatus = ref('') // '' | online | offline
const fCast = ref('') // '' | on
const fTotal = ref('') // '' | pass | fail
const fBonus = ref('') // '' | has

const hasFilter = computed(
  () => !!(q.value.trim() || fStatus.value || fCast.value || fTotal.value || fBonus.value)
)

// 学号里有数字，用 numeric 比较才不会被字符串序坑（2025010102 排在 20250101010 前）
const collator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' })

function sortBy(key) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else {
    sortKey.value = key
    sortDir.value = 'asc'
  }
}

function clearFilter() {
  q.value = ''
  fStatus.value = ''
  fCast.value = ''
  fTotal.value = ''
  fBonus.value = ''
}

/** 一行在某列上的排序值：数字列给数字（按大小比），其余给字符串（按拼音比） */
function sortVal(r, key) {
  const sid = r.student.sid
  if (key === 'sid') return sid
  if (key === 'name') return r.student.name || ''
  if (key === 'status') return presenceSet.value.has(sid) ? '在线' : '离线'
  if (key === 'cast') return castingSet.value.has(sid) ? '在看' : ''
  if (key === 'total') return Number(r.total) || 0
  return Number(scoreOf(r, key)) || 0 // 各计分项 + 加分
}

const filtered = computed(() => {
  const kw = q.value.trim()
  const list = boardList.value.filter((r) => {
    const sid = r.student.sid
    if (kw && r.student.name.indexOf(kw) < 0 && sid.indexOf(kw) < 0) return false
    const online = presenceSet.value.has(sid)
    if (fStatus.value === 'online' && !online) return false
    if (fStatus.value === 'offline' && online) return false
    if (fCast.value === 'on' && !castingSet.value.has(sid)) return false
    const total = Number(r.total) || 0
    if (fTotal.value === 'pass' && total < 60) return false
    if (fTotal.value === 'fail' && total >= 60) return false
    if (fBonus.value === 'has' && !(Number(scoreOf(r, 'bonus')) > 0)) return false
    return true
  })
  const dir = sortDir.value === 'desc' ? -1 : 1
  const key = sortKey.value
  return list.sort((a, b) => {
    const va = sortVal(a, key)
    const vb = sortVal(b, key)
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : collator.compare(String(va), String(vb))
    if (c !== 0) return c * dir
    return collator.compare(a.student.sid, b.student.sid)
  })
})

const liveCount = computed(() => events.value.filter((e) => !e.voided).length)

const logItem = ref('')
const logQ = ref('')
const filteredEvents = computed(() => {
  const kw = logQ.value.trim()
  return events.value.filter((e) => {
    if (logItem.value && e.item !== logItem.value) return false
    if (!kw) return true
    return nameOf(e.sid).indexOf(kw) >= 0 || e.sid.indexOf(kw) >= 0 || (e.reason || '').indexOf(kw) >= 0
  })
})

const pickedRow = computed(() => (board.value.list || []).find((r) => r.student.sid === pickedSid.value) || null)

onMounted(async () => {
  loadScheme() // 抽屉里的「去模块评分」要按方案来，深链进来也不会错
  // 跟着侧栏选的班走（属于当前课程才用），否则落第一个
  if (currentClassId.value && classes.value.some((c) => c.id === currentClassId.value)) {
    activeId.value = currentClassId.value
  }
  if (!activeId.value && classes.value.length) activeId.value = classes.value[0].id
  if (activeId.value) setClassId(activeId.value)
  if (activeId.value) await load()
  document.addEventListener('keydown', onKey)
  document.addEventListener('visibilitychange', onVisible)
  presenceTimer = setInterval(() => {
    if (!document.hidden) loadPresence()
  }, 8000)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('visibilitychange', onVisible)
  if (presenceTimer) clearInterval(presenceTimer)
})

function onVisible() {
  if (!document.hidden) loadPresence()
}

async function loadPresence() {
  if (!activeId.value) return
  try {
    presence.value = await api.get('/api/classes/' + activeId.value + '/presence')
  } catch (e) {
    /* 状态显示失败不打扰记分，等下一轮 */
  }
}

/* ---------------- 读 ---------------- */

async function load() {
  if (!activeId.value) return
  error.value = ''
  try {
    const res = await api.get('/api/classes/' + activeId.value + '/scores')
    // 服务端返回的 events 只有原始字段，摘要在这里按需算
    data.value = res
    loadPresence()
  } catch (e) {
    error.value = e.message
  }
}

function switchClass(id) {
  activeId.value = id
  localStorage.setItem('scores-class', id)
  setClassId(id) // 侧栏的班级跟着变
  pickedSid.value = ''
  load()
}

async function newClass() {
  const name = window.prompt('新班级名称：', '示例' + (classes.value.length + 1) + '班')
  if (name === null) return
  try {
    const res = await api.post('/api/classes', { name })
    await refresh()
    switchClass(res.class.id)
    toast.value = '已新建班级：' + res.class.name
  } catch (e) {
    alert(e.message)
  }
}

async function renameClass() {
  if (!active.value) return
  const name = window.prompt('新的班级名称：', active.value.name)
  if (!name || name === active.value.name) return
  try {
    await api.patch('/api/classes/' + active.value.id, { name })
    await refresh()
    toast.value = '已改名'
  } catch (e) {
    alert(e.message)
  }
}

async function removeClass() {
  if (!active.value) return
  if (!window.confirm('删除「' + active.value.name + '」？该班的记分记录会一起删除，且不可恢复。')) return
  try {
    await api.del('/api/classes/' + active.value.id)
    const gone = activeId.value
    await refresh()
    activeId.value = classes.value.length ? classes.value[0].id : ''
    localStorage.setItem('scores-class', activeId.value)
    data.value = { class: {}, students: [], board: { list: [] }, events: [] }
    if (activeId.value) await load()
    toast.value = '已删除班级'
  } catch (e) {
    alert(e.message)
  }
}

/* ---------------- 记分 ---------------- */

/* ---------- 名单增删改：这一页就是班级管理，名单直接在这儿维护 ---------- */
const editingStudent = ref(null) // { isNew }
const studentBusy = ref(false)
const studentForm = reactive({ sid: '', name: '', hasRecords: false, origin: '' })

function openStudent(stu) {
  if (!active.value) return
  const isNew = !stu
  editingStudent.value = { isNew }
  studentForm.sid = isNew ? '' : stu.sid
  studentForm.name = isNew ? '' : stu.name
  studentForm.origin = isNew ? '' : stu.sid
  studentForm.hasRecords = isNew ? false : events.value.some((e) => e.sid === stu.sid)
}

async function saveStudent() {
  if (!active.value || !editingStudent.value) return
  studentBusy.value = true
  error.value = ''
  try {
    if (editingStudent.value.isNew) {
      const res = await api.post('/api/classes/' + activeId.value + '/roster', {
        mode: 'merge',
        students: [{ sid: studentForm.sid, name: studentForm.name }],
      })
      toast.value = '已添加 ' + studentForm.name + '（本班 ' + res.total + ' 人）'
    } else {
      const res = await api.patch(
        '/api/classes/' + activeId.value + '/students/' + encodeURIComponent(studentForm.origin),
        { sid: studentForm.sid, name: studentForm.name }
      )
      toast.value = res.renamed ? '已把学号改成 ' + res.student.sid : '已更新 ' + res.student.name
    }
    editingStudent.value = null
    await refresh()
    await load()
  } catch (e) {
    error.value = e.message
  } finally {
    studentBusy.value = false
  }
}

async function removeStudent(stu) {
  if (!stu) return
  if (!window.confirm('把 ' + stu.name + '（' + stu.sid + '）从名单里移除？\n\n他的记分记录与目录都会保留，只是不再出现在名单里。')) return
  error.value = ''
  try {
    await api.del('/api/classes/' + activeId.value + '/students/' + encodeURIComponent(stu.sid))
    toast.value = '已移除 ' + stu.name
    await refresh()
    await load()
  } catch (e) {
    error.value = e.message
  }
}

function scoreOf(row, key) {
  const hit = (row.rows || []).find((x) => x.item.key === key)
  return hit ? hit.score : 0
}

function nameOf(sid) {
  const s = students.value.find((x) => x.sid === sid)
  return s ? s.name : sid
}

function itemName(key) {
  const it = items.value.find((x) => x.key === key)
  return it ? it.short : key
}

function summary(e) {
  if (e.summaryText) return e.summaryText
  if (e.item === 'homework') return '等级 ' + e.grade + (e.late ? ' · 迟交' : '')
  if (e.item === 'exam') return '卷面 ' + e.raw
  if (e.item === 'project') {
    const s = Object.keys(e.dims || {}).reduce((a, k) => a + (Number(e.dims[k]) || 0), 0)
    return '量规 ' + Math.round(s * 10) / 10
  }
  return (e.delta > 0 ? '+' : '') + (e.delta || 0) + ' 分' + (e.kind ? '（' + e.kind + '）' : '')
}

function fmt(iso) {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

function exportCsv(kind) {
  if (!active.value) return
  download('/api/classes/' + active.value.id + '/export?kind=' + kind)
}

/* ---------------- 导入名单 ---------------- */

/* 班级与名单（整门课一起搬） */
const cio = reactive({ open: false, busy: false, err: '', name: '', report: null, mode: 'merge' })
const ioPick = ref(null)
let ioBuf = null

async function openIO() {
  cio.open = true
  courseName.value = courseId.value
  try {
    const r = await api.get('/api/courses')
    const hit = (r.items || []).find((c) => c.id === courseId.value)
    if (hit) courseName.value = hit.name + (hit.semester ? ' · ' + hit.semester : '')
  } catch (e) {
    /* 取不到就用课程 id 显示，不影响导入导出 */
  }
  cio.err = ''
  cio.report = null
  cio.name = ''
  cio.mode = 'merge'
  ioBuf = null
}

function closeIO() {
  cio.open = false
  cio.report = null
  cio.err = ''
  ioBuf = null
}

function ioExport() {
  if (!courseId.value) return
  download('/api/courses/' + encodeURIComponent(courseId.value) + '/classes.zip', 'classes.zip')
  toast.value = '正在导出班级与名单…'
}

function ioTemplate() {
  if (!courseId.value) return
  download('/api/courses/' + encodeURIComponent(courseId.value) + '/classes/template.zip', 'classes-template.zip')
  toast.value = '模板已下载：填好各班名单，压缩成 zip 再导进来'
}

async function ioFile(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f || !courseId.value) return
  cio.busy = true
  cio.err = ''
  cio.name = f.name
  try {
    ioBuf = await f.arrayBuffer()
    const res = await fetch('/api/courses/' + encodeURIComponent(courseId.value) + '/classes/inspect', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, getToken() ? { Authorization: 'Bearer ' + getToken() } : {}),
      body: ioBuf,
    })
    const j = await res.json().catch(() => null)
    if (!res.ok) throw new Error((j && j.error) || '解析失败（' + res.status + '）')
    cio.report = j
    cio.mode = 'merge'
  } catch (err) {
    cio.err = err.message
  } finally {
    cio.busy = false
  }
}

async function ioApply() {
  if (!courseId.value || !ioBuf) return
  cio.busy = true
  cio.err = ''
  try {
    const res = await fetch(
      '/api/courses/' + encodeURIComponent(courseId.value) + '/classes/apply?mode=' + cio.mode,
      {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, getToken() ? { Authorization: 'Bearer ' + getToken() } : {}),
        body: ioBuf,
      }
    )
    const j = await res.json().catch(() => null)
    if (!res.ok) throw new Error((j && j.error) || '导入失败（' + res.status + '）')
    closeIO()
    toast.value =
      '导入完成：' +
      j.totals.classes +
      ' 个班（新建 ' +
      j.totals.created +
      '）· 新增 ' +
      j.totals.added +
      ' 人 · 改名 ' +
      j.totals.renamed +
      ' 人' +
      (j.totals.removed ? ' · 移出 ' + j.totals.removed + ' 人' : '')
    await load()
  } catch (err) {
    cio.err = err.message
  } finally {
    cio.busy = false
  }
}

const importing = ref(false)
const importingBusy = ref(false)
const importMode = ref('merge')
const pasteText = ref('')
const parsed = ref([])
const importError = ref('')
const fileInput = ref(null)

const issues = ref([]) // 表格里没被采纳的行（行号 + 原因）
const report = ref(null) // 服务端干跑结果（新增 / 改名 / 移出 / 班级人数）
const sheetFile = ref(null) // 直接从表格（xlsx / csv）导入时，留一份原始文件
const sheetName = ref('')
const checking = ref(false) // 正在问服务端要报告

const previewNames = computed(() => {
  const names = parsed.value.slice(0, 8).map((s) => s.name)
  return names.join('、') + (parsed.value.length > 8 ? ' …' : '')
})

function openImport() {
  importing.value = true
  parsed.value = []
  issues.value = []
  report.value = null
  sheetFile.value = null
  sheetName.value = ''
  pasteText.value = ''
  importError.value = ''
}

/* 按「学号,姓名,备注」拼一份 CSV（带 BOM，Excel 双击不乱码） */
function rosterCsv(students) {
  const head = '学号,姓名,备注'
  const rows = (students || []).map((s) => [s.sid, s.name, ''])
  const body = rows
    .map((r) => r.map((v) => (/[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v)).join(','))
    .join('\r\n')
  return '\ufeff' + head + '\r\n' + body + (body ? '\r\n' : '')
}

function saveText(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

/** 空模板：只有表头 + 两行示例，照着填 */
function downloadTemplate() {
  saveText('名单模板.csv', '\ufeff学号,姓名,备注\r\n2025000001,张三,\r\n2025000002,李四,班长\r\n')
}

/** 当前名单：导出本班的，改完再传回来（改名字、加人、删人） */
function downloadCurrent() {
  if (!active.value) return
  const name = (active.value.name || '班级') + '-名单.csv'
  saveText(name, rosterCsv(active.value.students))
}

function parsePaste() {
  importError.value = ''
  applyRows(textToRows(pasteText.value))
}

/** 统一入口：二维数组 → 名单 + 问题清单 → 再问服务端要干跑报告 */
function applyRows(rows) {
  const res = rowsToRosterDetailed(rows)
  parsed.value = res.list
  issues.value = res.issues || []
  if (!parsed.value.length && !issues.value.length) importError.value = ''
  refreshReport()
}

/** 问服务端「这批名单落下去会变成什么样」，一个字节都不写 */
async function refreshReport() {
  report.value = null
  if (!active.value || !parsed.value.length) return
  checking.value = true
  importError.value = ''
  try {
    report.value = await api.post('/api/classes/' + active.value.id + '/roster/inspect', {
      mode: importMode.value,
      students: parsed.value.map((s) => ({ sid: s.sid, name: s.name })),
    })
  } catch (e) {
    importError.value = e.message
    report.value = null
  } finally {
    checking.value = false
  }
}

/**
 * 选表格文件：直接传给服务端解析（.xlsx 用 exceljs，.csv 按逗号/制表符切），
 * 名单规则只维护一份，前端那份解析器只留给「粘贴文本」用。
 */
async function onFile(e) {
  const file = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!file) return
  importError.value = ''
  packErrLikeIssuesClear()
  sheetFile.value = file
  sheetName.value = file.name
  await uploadSheet()
}

function packErrLikeIssuesClear() {
  issues.value = []
  report.value = null
  parsed.value = []
}

/** 把表格传给服务端：不带 apply=1 就是干跑 */
async function uploadSheet() {
  if (!active.value || !sheetFile.value) return
  checking.value = true
  importError.value = ''
  try {
    const res = await postSheet(false)
    report.value = res
    issues.value = res.issues || []
  } catch (err) {
    importError.value = err.message
    issues.value = (err.errors || []).map((msg, i) => ({ line: i + 1, msg, raw: '' }))
    report.value = null
  } finally {
    checking.value = false
  }
}

/** 传表格（apply=true 时真写） */
async function postSheet(apply) {
  const token = getToken()
  const url =
    '/api/classes/' +
    active.value.id +
    '/roster/sheet?mode=' +
    importMode.value +
    (apply ? '&apply=1' : '')
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: sheetFile.value,
  })
  let data = null
  try {
    data = await res.json()
  } catch (e) {
    data = null
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || '解析失败（' + res.status + '）')
    err.errors = (data && data.errors) || []
    throw err
  }
  return data
}

async function doImport() {
  if (!active.value) return
  if (!sheetFile.value && !parsed.value.length) return
  importingBusy.value = true
  importError.value = ''
  try {
    if (sheetFile.value) {
      const r = await postSheet(true)
      importing.value = false
      const bits = ['新增 ' + r.added + ' 人']
      if (r.updated) bits.push('改名 ' + r.updated + ' 人')
      if (r.removed) bits.push('移出 ' + r.removed + ' 人')
      toast.value = '导入完成：' + bits.join('，') + '，本班共 ' + r.total + ' 人'
      sheetFile.value = null
      sheetName.value = ''
      await refresh()
      await load()
      return
    }
    const body = {
      mode: importMode.value,
      students: parsed.value.map((s) => ({ sid: s.sid, name: s.name })),
    }
    const res = await api.post('/api/classes/' + active.value.id + '/roster/apply', body)
    importing.value = false
    const bits = ['新增 ' + res.added + ' 人']
    if (res.updated) bits.push('改名 ' + res.updated + ' 人')
    if (res.removed) bits.push('移出 ' + res.removed + ' 人')
    toast.value = '导入完成：' + bits.join('，') + '，本班共 ' + res.total + ' 人'
    await refresh()
    await load()
  } catch (e) {
    importError.value = e.message
  } finally {
    importingBusy.value = false
  }
}

/* 切换「追加 / 覆盖」会让「移出」数字变化，重新问一次服务端 */
watch(importMode, () => {
  if (!importing.value) return
  if (sheetFile.value) uploadSheet()
  else if (parsed.value.length) refreshReport()
})

/* ---------------- 快捷键 ---------------- */

function onKey(e) {
  if (e.key !== 'Escape') return
  if (importing.value) importing.value = false
  else pickedSid.value = ''
}
</script>

<style scoped>
/* 名单干跑报告 */
.import-plan {
  border: 1px solid var(--line);
  border-left: 3px solid #2f7d92;
  border-radius: 4px;
  background: #f7fbfd;
  padding: 8px 10px;
}

.ip-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 2px 0;
}

.ip-k {
  flex: 0 0 56px;
  color: #6b7785;
  font-size: 12px;
}

.import-plan .add {
  color: #1f7a55;
}

.import-plan .del {
  color: #b4400f;
}

.ip-tip {
  margin-top: 4px;
  font-size: 11.5px;
}

/* 名单导入：没被采纳的行 */
.iss {
  margin: 6px 0 0 18px;
  max-height: 140px;
  overflow: auto;
}

.iss li {
  margin: 2px 0;
}

/* 筛选条：紧贴表头，压扁一点，别喧宾夺主 */
.fbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.fbar .select {
  padding: 4px 8px;
  font-size: 12.5px;
}

.fbar .input {
  padding: 4px 8px;
  font-size: 12.5px;
}

.fbar .dim {
  font-size: 12px;
}

/* 表头点了就排序：箭头常驻但浅，排序中的那列高亮 */
th.sortable {
  cursor: pointer;
  user-select: none;
}

th.sortable:hover {
  background: #eef2f7;
  color: #1d4ed8;
}

th.sortable.on {
  color: #1d4ed8;
}

th .sortmark {
  margin-left: 3px;
  font-style: normal;
  font-size: 10px;
  color: #c2c8ce;
}

th.on .sortmark {
  color: #1d4ed8;
}

.classbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 16px;
}

.classbar .pill em {
  font-style: normal;
  color: var(--dim);
  margin-left: 6px;
  font-size: 12px;
}

.classbar .pill.on em {
  color: var(--brand);
}

.tabs {
  display: flex;
  gap: 8px;
  margin: 4px 0 0;
}

.tab {
  padding: 8px 18px;
  border: 1px solid var(--line);
  border-bottom: none;
  border-radius: 11px 11px 0 0;
  background: #eef1f7;
  color: #475569;
  cursor: pointer;
  font-size: 14px;
}

.tab.on {
  background: #fff;
  color: var(--brand-ink);
  font-weight: 600;
}

.log {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 62vh;
  overflow: auto;
}

.log > li {
  padding: 10px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  margin-bottom: 8px;
}

.log > li.voided {
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

.who {
  font-size: 14px;
}

.delta {
  font-size: 14px;
  color: var(--brand-ink);
}

.reason {
  margin: 5px 0 2px;
  font-size: 13.8px;
}

.lf {
  display: flex;
  gap: 10px;
  font-size: 12.5px;
  color: var(--dim);
}

.lf a {
  color: var(--brand);
}

.tag-attend {
  background: #eef2ff;
  color: #4338ca;
}
.tag-interact {
  background: #fff7ed;
  color: var(--warn);
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

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
  color: #475569;
}
</style>
