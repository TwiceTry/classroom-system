<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>考核方案
          <span v-if="courseName" class="cchip" :title="'当前课程：' + courseName + '（修改只影响这门课）'">
            课程：{{ courseName }}
          </span></template>
        <template #sub>有哪些考核项、各占多少分、用哪条规则、哪个模块开着，都在这里改；保存后全站生效（导航、评分表、入口一起变）。
          方案跟着课程走 —— 换课程请用左下角的「课程」切换器</template>
        <template #right>
          <span v-if="raw" class="tag" :class="raw.version > 1 ? 'ok' : 'mute'">v{{ raw.version }}</span>
          <button class="btn mini" :disabled="loading || !dirty" @click="revert">还原改动</button>
          <button class="btn mini" :disabled="loading || previewing" @click="openPreview">试算对比</button>
          <button class="btn mini" @click="downloadScheme" title="下载当前方案（scheme.json，可跨机器 / 跨课程复用）">
            下载方案
          </button>
          <button class="btn mini" @click="openIO" title="导入一份 scheme.json：先看差异，再决定覆盖 / 保留 / 另存">
            导入方案
          </button>
          <button class="btn primary" :disabled="loading || saving || !dirty" @click="save">
            {{ saving ? '保存中…' : '保存方案' }}
          </button>
        </template>
      </PageHead>
    </template>
    <p v-if="error" class="hint err">{{ error }}</p>
    <div v-if="errors.length" class="hint err">
      <b>方案有问题，先改完再保存：</b>
      <ul>
        <li v-for="e in errors" :key="e">{{ e }}</li>
      </ul>
    </div>
    <div v-if="warnings.length" class="hint warn">
      <b>提示：</b>
      <ul>
        <li v-for="w in warnings" :key="w">{{ w }}</li>
      </ul>
    </div>

    <div v-if="!raw" class="card empty">正在读取方案…</div>

    <div v-else class="editor">
      <!-- 左：考核项 -->
      <section class="card list">
        <CardHead>
          <template #title>考核项 · {{ raw.items.length }}</template>
          <template #meta><span class="mini" :class="{ off: Math.abs(mainSum - raw.totalFull) > 0.01 }">合计 {{ mainSum }} / {{ raw.totalFull }}</span></template>
        </CardHead>

        <ul class="items">
          <li
          v-for="(it, i) in raw.items"
          :key="it.key"
          :class="{ on: it.key === curKey }"
          @click="curKey = it.key"
          >
          <div class="itop">
            <b class="ellip">{{ it.name }}</b>
            <span class="tag" :class="it.extra ? 'mute' : ''">{{ it.full }} 分</span>
            <span v-if="it.module && it.module.enabled" class="tag ok">模块</span>
          </div>
          <div class="isub">
            <span class="dim mini">{{ ruleName(it.rule.type) }}</span>
            <span class="spacer"></span>
            <!-- 学生端可见性：占一个固定宽度的槽（没有学生入口的项留空），
                 所以右边这组按钮在所有行里都对齐，不会因为有没有眼睛而左右漂 -->
            <span class="eye-slot">
              <button
                v-if="showEye(it)"
                class="eye"
                :class="{ off: isHidden(it.key) }"
                :title="isHidden(it.key) ? '学生端已收起（点一下放出来）' : '学生端可见（点一下收起来）'"
                @click.stop="onToggleEye(it.key)"
              >
                <Icon :name="isHidden(it.key) ? 'eye-off' : 'eye'" :size="16" />
              </button>
            </span>
            <button class="mini-btn" title="上移" :disabled="i === 0" @click.stop="move(i, -1)">↑</button>
            <button class="mini-btn" title="下移" :disabled="i === raw.items.length - 1" @click.stop="move(i, 1)">↓</button>
            <button class="mini-btn danger" title="删除" @click.stop="removeItem(i)">×</button>
          </div>
        </li>
      </ul>

      <div class="addrow">
        <button class="btn mini" @click="addItem">＋ 加一项</button>
        <span class="dim mini">key 一旦有分数就不能改</span>
      </div>

      <div class="globals">
        <label class="field inline">
          <span>方案名</span>
          <input v-model="raw.name" class="input" />
        </label>
        <label class="field inline">
          <span>总满分</span>
          <input v-model.number="raw.totalFull" class="input" type="number" min="1" style="width: 78px" />
        </label>
        <label class="field inline">
          <span>及格线</span>
          <input v-model.number="raw.passLine" class="input" type="number" min="0" style="width: 78px" />
        </label>
        <label class="field inline">
          <span>总评封顶</span>
          <input v-model.number="raw.cap" class="input" type="number" min="1" style="width: 78px" />
        </label>
      </div>
    </section>

    <!-- 右：选中项 -->
    <section v-if="cur" class="card detail">
      <CardHead>
        <template #title>{{ cur.name || '（未命名）' }}</template>
        <template #meta><span class="dim mini mono">{{ cur.key }}</span></template>
      </CardHead>

      <div class="grid2">
        <label class="field">
          <span>名称（评分表列头）</span>
          <input v-model="cur.name" class="input" />
        </label>
        <label class="field">
          <span>简称（流水里显示）</span>
          <input v-model="cur.short" class="input" placeholder="留空 = 用名称" />
        </label>
        <label class="field">
          <span>满分</span>
          <input v-model.number="cur.full" class="input" type="number" min="0" step="0.5" />
        </label>
        <label class="field">
          <span>采集形态（决定模块长什么样）</span>
          <select v-model="cur.form" class="select">
            <option v-for="f in forms" :key="f.key" :value="f.key">{{ f.name }}</option>
          </select>
        </label>
      </div>

      <label class="check">
        <input v-model="cur.extra" type="checkbox" />
        这是加分项（计入总分，但不参与总满分合计、总评封顶）
      </label>

      <!-- 规则 + 参数 -->
      <h4>计分规则</h4>
      <div class="grid2">
        <label class="field">
          <span>规则</span>
          <select v-model="cur.rule.type" class="select" @change="onRuleChange">
            <option v-for="r in rules" :key="r.type" :value="r.type">{{ r.name }}</option>
          </select>
        </label>
        <p class="rulehint dim mini">{{ ruleDesc }}</p>
      </div>

      <div v-if="ruleSchema.length" class="params">
        <div v-for="f in ruleSchema" :key="f.key" class="pf">
          <label class="field">
            <span>{{ f.label || f.key }}<em v-if="f.hint" class="dim"> · {{ f.hint }}</em></span>

            <input
            v-if="f.type === 'number'"
            v-model.number="params[f.key]"
            class="input"
            type="number"
            :min="f.min"
            :max="f.max"
            />
            <input v-else-if="f.type === 'string'" v-model="params[f.key]" class="input" />

            <!-- 嵌套对象（考勤的归零规则） -->
            <div v-else-if="f.type === 'object'" class="subfields">
              <label v-for="sf in f.fields" :key="sf.key" class="field inline">
                <span>{{ sf.label }}</span>
                <input
                v-model="params[f.key][sf.key]"
                class="input"
                :type="sf.type === 'number' ? 'number' : 'text'"
                style="width: 110px"
                />
              </label>
              <button class="btn mini" @click="params[f.key] = undefined">清空（不需要这条规则）</button>
            </div>

            <!-- 等级表 -->
            <div v-else-if="f.type === 'grades'" class="tbl">
              <div v-for="(g, gi) in params[f.key]" :key="gi" class="trow">
                <input v-model="g.key" class="input" placeholder="A" style="width: 58px" />
                <input v-model="g.label" class="input" placeholder="A（100）" />
                <input v-model.number="g.factor" class="input" type="number" step="0.05" min="0" max="1" style="width: 84px" />
                <button class="mini-btn danger" @click="params[f.key].splice(gi, 1)">×</button>
              </div>
              <button class="btn mini" @click="params[f.key].push({ key: '', label: '', factor: 0.8 })">＋ 加等级</button>
            </div>

            <!-- 量规维度 -->
            <div v-else-if="f.type === 'dims'" class="tbl">
              <div v-for="(d, di) in params[f.key]" :key="di" class="trow">
                <input v-model="d.key" class="input" placeholder="func" style="width: 84px" />
                <input v-model="d.name" class="input" placeholder="功能完整" />
                <input v-model.number="d.full" class="input" type="number" min="0" step="0.5" style="width: 84px" />
                <button class="mini-btn danger" @click="params[f.key].splice(di, 1)">×</button>
              </div>
              <div class="trow">
                <button class="btn mini" @click="params[f.key].push({ key: '', name: '', full: 5 })">＋ 加维度</button>
                <span class="dim mini">维度合计 {{ dimSum }}</span>
              </div>
            </div>
          </label>
        </div>
      </div>

      <label class="field" style="margin-top: 10px">
        <span>
          说明（学生/老师在表单里看到的提示）
          <em class="mini hint-tip">可以用变量，改分值 / 改参数时说明会自动跟着变</em>
        </span>
        <textarea v-model="cur.hint" class="textarea" rows="2" placeholder="例：默认全勤 {start} 分；缺勤每次扣 {perAbsent} 分"></textarea>
      </label>
      <p class="dim mini hint-preview">
        预览：<b>{{ hintPreview || '（空）' }}</b>
      </p>
      <p class="dim mini hint-vars">
        可用变量：<code v-for="v in hintVars" :key="v" @click="insertVar(v)">{{ '{' + v + '}' }}</code>
      </p>

      <!-- 模块 -->
      <h4>模块（学生端入口）</h4>
      <label class="check">
        <input v-model="cur.module.enabled" type="checkbox" />
        启用这个模块（关掉后：导航、抽屉入口、接口同时消失）
      </label>
      <p
        v-if="cur.module.enabled && cur.form !== 'attendance' && cur.form !== 'manual'"
        class="dim mini"
        style="margin-top: 6px"
      >
        学生端要不要看到这个入口，点这一项右边的小眼睛就能切（左侧栏菜单项上的小眼睛是同一个状态）；
        它不写进方案，所以不动方案版本、也不影响计分。
      </p>
      <div v-if="cur.module.enabled" class="grid2" style="margin-top: 8px">
        <label class="field">
          <span>模块名称（导航文字）</span>
          <input v-model="cur.module.title" class="input" :placeholder="cur.name" />
        </label>
        <label class="field">
          <span>学生交什么</span>
          <select v-model="cur.module.submit" class="select">
            <option value="code">改代码 + 跑渲染（代码练习那套）</option>
            <option value="files">说明 + 链接 + 附件</option>
          </select>
        </label>
      </div>

      <details class="adv">
        <summary>高级：快捷按钮（presets，JSON）</summary>
        <textarea v-model="presetText" class="textarea" rows="6" spellcheck="false" @change="applyPresets"></textarea>
      </details>
    </section>

    <section v-else class="card detail empty">左边选一个考核项来改。</section>
    </div>

    <!-- 变更日志 -->
    <div v-if="raw && raw.changes && raw.changes.length" class="card">
    <CardHead>
      <template #title>变更日志</template>
      <template #meta><span class="dim mini">最近 {{ raw.changes.length }} 次（保存时自动记）</span></template>
    </CardHead>
    <ul class="log">
      <li v-for="(c, i) in raw.changes.slice().reverse()" :key="i">
        <span class="when">{{ when(c.at) }}</span>
        <b>{{ c.by }}</b>
        <span v-if="c.note" class="note">{{ c.note }}</span>
        <span class="dim mini">{{ (c.summary || []).join('；') || '（无分值变化）' }}</span>
      </li>
    </ul>
    </div>


    <!-- 试算对比 -->
    <div v-if="previewing" class="mask" @click.self="previewing = false">
    <div class="modal wide">
      <div class="modal-head">
        <h3>试算对比 · 用现有数据跑一遍</h3>
        <button class="btn mini" style="margin-left: auto" @click="previewing = false">关闭</button>
      </div>
      <div class="modal-body">
        <div class="row">
          <select v-model="previewClass" class="select" @change="runPreview">
            <option value="">选一个班级</option>
            <option v-for="c in classes" :key="c.id" :value="c.id">{{ c.name }}（{{ c.count }} 人）</option>
          </select>
          <span v-if="previewData" class="dim mini">{{ previewData.className }} · {{ previewData.count }} 人</span>
        </div>

        <div v-if="previewLoading" class="empty">正在算…</div>
        <template v-else-if="previewData">
          <div class="cmp">
            <div class="cmpcol">
              <span class="dim mini">改动前（当前方案 v{{ raw.version }}）</span>
              <b>{{ previewData.before.avg }}</b>
              <span class="dim mini">及格率 {{ previewData.before.passRate }}%</span>
            </div>
            <div class="arrow">→</div>
            <div class="cmpcol after">
              <span class="dim mini">改动后</span>
              <b>{{ previewData.after.avg }}</b>
              <span class="dim mini">及格率 {{ previewData.after.passRate }}%</span>
            </div>
          </div>

          <p class="dim mini" style="margin: 10px 0 4px">变化最大的人（前 12）</p>
          <DataTable
            :columns="moveCols"
            :rows="previewData.moves"
            row-key="sid"
            max-height="34vh"
            :empty="'没人变化（这次改动不影响现有数据）'"
          >
            <template #cell-sid="{ row }"><span class="mono">{{ row.sid }}</span></template>
            <template #cell-delta="{ row }">
              <span :class="row.delta > 0 ? 'ok' : 'bad'">{{ row.delta > 0 ? '+' : '' }}{{ row.delta }}</span>
            </template>
          </DataTable>
        </template>
      </div>
      <div class="modal-foot">
        <span class="spacer"></span>
        <button class="btn" @click="previewing = false">再改改</button>
        <button class="btn primary" :disabled="saving" @click="save">保存方案</button>
      </div>
    </div>
    </div>

    <!-- 导入方案：先看差异，再决定怎么用 -->
    <div v-if="io.open" class="mask" @click.self="io.open = false">
    <div class="modal wide">
      <div class="modal-head">
        <h3>导入方案</h3>
        <button class="btn mini" style="margin-left: auto" @click="io.open = false">关闭</button>
      </div>
      <div class="modal-body">
        <div class="row">
          <button class="btn mini" @click="ioPick.click()">选择 scheme.json</button>
          <input ref="ioPick" type="file" accept=".json" style="display: none" @change="onIOFile" />
          <span class="dim mini">只导方案，不动讲义 / 名单 / 记分</span>
        </div>

        <p v-if="io.err" class="hint err">{{ io.err }}</p>

        <div v-if="io.report" class="sio">
          <div class="sio-row">
            <span class="sio-k">本机</span>
            <span><b>{{ io.report.current.name }}</b> · v{{ io.report.current.version }} · {{ io.report.current.totalFull }} 分 · {{ io.report.current.items }} 项</span>
          </div>
          <div class="sio-row">
            <span class="sio-k">文件</span>
            <span><b>{{ io.report.incoming.name || '(未命名)' }}</b> · {{ io.report.incoming.totalFull }} 分 · {{ io.report.incoming.items }} 项</span>
          </div>

          <div v-if="io.report.diff.same" class="hint ok" style="margin-top: 8px">两份方案完全一致，不需要导入。</div>
          <template v-else>
            <div class="sio-list">
              <div v-for="c in io.report.diff.changed" :key="'c' + c.key" class="sio-item">
                <span class="tag mute">改</span>
                <span>{{ c.name }}</span>
                <span class="dim mini">{{ c.fields.map((f) => sioFieldText(f)).join('、') }}</span>
              </div>
              <div v-for="a in io.report.diff.added" :key="'a' + a.key" class="sio-item">
                <span class="tag ok">增</span>
                <span>{{ a.name }}</span>
                <span class="dim mini">{{ a.full }} 分</span>
              </div>
              <div v-for="r in io.report.diff.removed" :key="'r' + r.key" class="sio-item">
                <span class="tag mute">删</span>
                <span>{{ r.name }}</span>
                <span class="dim mini">{{ r.full }} 分</span>
              </div>
              <div v-for="t in io.report.diff.top" :key="'t' + t.field" class="sio-item">
                <span class="tag mute">改</span>
                <span>{{ sioTopText(t.field) }}</span>
                <span class="dim mini">{{ t.from }} → {{ t.to }}</span>
              </div>
            </div>

            <div v-if="io.report.warnings.length" class="hint warn" style="margin-top: 8px">
              <b>注意：</b>
              <ul><li v-for="w in io.report.warnings" :key="w">{{ w }}</li></ul>
            </div>

            <div v-if="io.report.errors.length" class="hint err" style="margin-top: 8px">
              <b>这份方案校验不过，不能导入：</b>
              <ul><li v-for="e in io.report.errors" :key="e">{{ e }}</li></ul>
            </div>

            <div class="row" style="margin-top: 10px">
              <label class="check"><input v-model="io.mode" type="radio" value="use" /> 用文件里的（覆盖本机，版本 +1）</label>
              <label class="check"><input v-model="io.mode" type="radio" value="keep" /> 保留本机（不导入）</label>
              <label class="check"><input v-model="io.mode" type="radio" value="copy" /> 另存为新方案（两套并存）</label>
            </div>
          </template>
        </div>
      </div>
      <div class="modal-foot">
        <span class="spacer"></span>
        <button class="btn" @click="io.open = false">取消</button>
        <button
          class="btn primary"
          :disabled="!io.report || io.report.diff.same || io.busy || !io.report.ok"
          @click="applyIO"
        >
          {{ io.busy ? '导入中…' : io.mode === 'keep' ? '仍然关闭' : '确认导入' }}
        </button>
      </div>
    </div>
    </div>

    <Toast :text="toast" @close="toast = ''" />
  </PageShell>
</template>

<script setup>
/*
 * 教师端「考核方案」编辑器
 *
 * 设计取舍：
 *   · 规则只让老师调参数（表单按 RULES 的 schema 自动渲染），不给写公式 ——
 *     成绩要能被解释、能被单测，自定义表达式做不到这两点；
 *   · 保存前可以「试算对比」：用当前班级的真实数据把改动前后各算一遍，
 *     平均分、及格率、变化最大的人一目了然，改错了当场看得见；
 *   · 每次保存自动 +1 版本并追加变更日志（谁、何时、改了哪几项）；
 *   · 分值随时能改（不锁时间），要留档就点「结课归档」（还是回 http 接口）。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { api, download, getCourse } from '../../api'
import Toast from '../../components/Toast.vue'
import { loadScheme, scheme } from '../../utils/scheme'
import { when } from '../../utils/time'
import PageHead from '../../components/PageHead.vue'
import DataTable from '../../components/DataTable.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'
import Icon from '../../components/Icon.vue'
import { isHidden, loadStuVis, toggleStuVis } from '../../utils/stuvis'

const raw = ref(null)
const savedRaw = ref('')
const rules = ref([])
const forms = ref([])
const errors = ref([])
const warnings = ref([])
const error = ref('')
const toast = ref('')
const loading = ref(false)
const saving = ref(false)
const curKey = ref('')
const courseName = ref('')
const presetText = ref('')

const classes = ref([])
const previewing = ref(false)

/* ---------------- 方案单独导入 / 导出 ---------------- */
const ioPick = ref(null)
const io = reactive({ open: false, mode: 'use', file: '', raw: null, report: null, err: '', busy: false })

const SIO_FIELD = { name: '名称', full: '满分', form: '交什么', rule: '计分规则', module: '模块', order: '顺序' }
const SIO_TOP = { name: '方案名称', totalFull: '总满分', passLine: '及格线', cap: '封顶' }

function sioFieldText(f) {
  const label = SIO_FIELD[f.field] || f.field
  if (f.field === 'full') return label + ' ' + f.from + ' → ' + f.to
  if (f.field === 'order') return '顺序 ' + f.from + ' → ' + f.to
  return label + '变了'
}

function sioTopText(field) {
  return SIO_TOP[field] || field
}

/** 下载当前方案（原样 scheme.json） */
function downloadScheme() {
  download('/api/teacher/scheme/export.json', 'scheme.json')
}

function openIO() {
  io.open = true
  io.mode = 'use'
  io.file = ''
  io.raw = null
  io.report = null
  io.err = ''
  if (ioPick.value) ioPick.value.value = ''
}

/** 选文件 → 干跑（只算差异，不写盘） */
async function onIOFile(e) {
  const f = e.target.files && e.target.files[0]
  if (!f) return
  io.err = ''
  io.report = null
  let parsed = null
  try {
    parsed = JSON.parse(await f.text())
  } catch (err) {
    io.err = '这不是合法 JSON：' + err.message
    return
  }
  io.file = f.name
  io.raw = parsed
  io.busy = true
  try {
    const res = await api.post('/api/teacher/scheme/inspect', { raw: parsed })
    io.report = res
    if (!res.ok) io.mode = 'keep'
  } catch (err) {
    io.err = err.message
  } finally {
    io.busy = false
  }
}

/** 确认导入 */
async function applyIO() {
  if (!io.report || !io.raw) return
  io.busy = true
  io.err = ''
  try {
    const res = await api.post('/api/teacher/scheme/apply?mode=' + io.mode, { raw: io.raw })
    if (res.mode === 'keep') toast.value = '已保留本机方案，没有改动'
    else if (res.mode === 'copy') toast.value = '已另存为新方案 ' + res.savedId + '（v' + res.version + '）'
    else toast.value = '方案已导入 · v' + res.version
    io.open = false
    await load()
  } catch (err) {
    io.err = err.message
  } finally {
    io.busy = false
  }
}

/* 试算对比表 */
const moveCols = [
  { key: 'sid', label: '学号' },
  { key: 'name', label: '姓名' },
  { key: 'before', label: '改动前', num: true },
  { key: 'after', label: '改动后', num: true },
  { key: 'delta', label: '变化', num: true },
]
const previewClass = ref('')
const previewData = ref(null)
const previewLoading = ref(false)

const dirty = computed(() => !!raw.value && JSON.stringify(raw.value) !== savedRaw.value)

const cur = computed(() => (raw.value ? raw.value.items.find((i) => i.key === curKey.value) || null : null))
const params = computed(() => (cur.value ? cur.value.rule.params || (cur.value.rule.params = {}) : {}))

const ruleSchema = computed(() => {
  const r = rules.value.find((x) => x.type === (cur.value && cur.value.rule.type))
  return (r && r.schema) || []
})
const ruleDesc = computed(() => {
  const r = rules.value.find((x) => x.type === (cur.value && cur.value.rule.type))
  return r ? r.desc : ''
})
const mainSum = computed(() =>
  raw.value ? raw.value.items.filter((i) => !i.extra).reduce((s, i) => s + (Number(i.full) || 0), 0) : 0
)
/* ---------- 说明模板：{full} {perAbsent} {zeroRule.count} … ---------- */

/** 与服务端 scheme.hintContext 同口径：把「考核项 + 当前参数」摊成上下文 */
function hintCtx(item, p, totalFull) {
  const n = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v) || 0)
  const dims = Array.isArray(p.dims) ? p.dims : []
  const grades = Array.isArray(p.grades) ? p.grades : []
  const rawFull = n(p.rawFull, 100) || 100
  const factor = p.factor === undefined ? (Number(item.full) || 0) / rawFull : Number(p.factor) || 0
  const lateFactor = p.lateFactor === undefined ? 1 : Number(p.lateFactor)
  return Object.assign({}, p, {
    key: item.key,
    name: item.name,
    short: item.short || item.name,
    full: item.full,
    start: p.start === undefined ? item.full : n(p.start, 0),
    perAbsent: n(p.perAbsent, 2),
    perLate: n(p.perLate, 1),
    gradesText: grades.map((g) => g.label || g.name || g.key).join(' / ') || 'A / B / C',
    latePercent: Math.round(lateFactor * 100),
    skipText: n(p.skipWorst, 0) > 0 ? '，去掉最差 ' + n(p.skipWorst, 0) + ' 次' : '',
    dimsText: dims.map((d) => (d.name || d.key) + ' ' + (d.full === undefined ? '' : d.full)).join(' + '),
    dimsSum: dims.reduce((s2, d) => s2 + (Number(d.full) || 0), 0),
    rawFull,
    factorPercent: Math.round(factor * 1000) / 10,
    hitText: p.perHitMax ? '（单次最多 ' + n(p.perHitMax, 0) + ' 分）' : '',
    cap: raw.value ? raw.value.cap : 100,
  })
}

/** 把模板里的 {变量} 换掉；不认识的变量原样留着，好看出写错 */
function fillHint(text, ctx) {
  if (!text) return ''
  return String(text).replace(/\{([A-Za-z0-9_.]+)\}/g, (m, key) => {
    let cur2 = ctx
    for (const seg of String(key).split('.')) {
      if (cur2 === undefined || cur2 === null) return m
      cur2 = cur2[seg]
    }
    return cur2 === undefined || cur2 === null ? m : String(cur2)
  })
}

const hintPreview = computed(() => {
  if (!cur.value || !raw.value) return ''
  return fillHint(cur.value.hint, hintCtx(cur.value, params.value, raw.value.totalFull))
})

/** 这个考核项当前能用哪些变量（参数名 + 常用派生值） */
const hintVars = computed(() => {
  if (!cur.value) return []
  const base = ['full', 'name', 'start', 'cap']
  // 只列「标量」参数：数组（等级表 / 量规）和对象（归零规则）单独处理或跳过
  const extra = Object.keys(params.value || {}).filter((k) => {
    const v = params.value[k]
    return v !== null && typeof v !== 'object'
  })
  const derived = ['perAbsent', 'perLate', 'gradesText', 'latePercent', 'skipText', 'dimsText', 'dimsSum', 'rawFull', 'factorPercent', 'hitText']
  const nest = []
  if (params.value && params.value.zeroRule && typeof params.value.zeroRule === 'object') {
    for (const k of Object.keys(params.value.zeroRule)) nest.push('zeroRule.' + k)
  }
  return Array.from(new Set([].concat(base, extra, derived, nest))).slice(0, 14)
})

/** 点变量就插到光标处 */
function insertVar(name) {
  if (!cur.value) return
  cur.value.hint = (cur.value.hint || '') + '{' + name + '}'
}

const dimSum = computed(() => {
  const d = params.value.dims || []
  return d.reduce((s, x) => s + (Number(x.full) || 0), 0)
})

onMounted(async () => {
  await load()
  loadStuVis(getCourse(), true) // 小眼睛的状态（学生端可见性）
})

/* ---- 考核项上的小眼睛：学生端菜单显不显示这一项 ---- */

/** 只有「模块开着、而且学生端有入口」的项才给眼睛（考勤 / 互动只有教师端） */
function showEye(it) {
  if (!it || !it.module || !it.module.enabled) return false
  return it.form !== 'attendance' && it.form !== 'manual'
}

function onToggleEye(key) {
  toggleStuVis(key, isHidden(key)).catch(() => {
    /* store 已回滚，错误在 stuvis.err */
  })
}

watch(cur, (v) => {
  if (v) presetText.value = JSON.stringify(v.presets || [], null, 0)
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    // 先认一下「当前是哪门课的方案」，避免改错课还不知道
    try {
      const cs = await api.get('/api/teacher/courses')
      const want = getCourse()
      const hit = (cs.courses || []).find((c) => c.id === want) || (cs.courses || []).find((c) => !c.archived)
      courseName.value = hit ? hit.name : ''
    } catch (e) {
      courseName.value = ''
    }
    const res = await api.get('/api/teacher/scheme')
    if (!res.raw) throw new Error('方案文件读不出来，请检查 data/schemes/')
    raw.value = normalize(res.raw)
    savedRaw.value = JSON.stringify(res.raw)
    rules.value = res.rules || []
    forms.value = res.forms || []
    errors.value = res.errors || []
    warnings.value = res.warnings || []
    curKey.value = (raw.value.items[0] || {}).key || ''
    const boot = await api.get('/api/teacher/classes')
    classes.value = (boot.classes || []).map((c) => ({ id: c.id, name: c.name, count: c.count || 0 }))
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

/** 补全缺省字段，保证编辑器里 v-model 不会碰到 undefined */
function normalize(r) {
  const out = JSON.parse(JSON.stringify(r))
  out.items = (out.items || []).map((it, i) => {
    it.rule = it.rule || { type: 'acc', params: {} }
    it.rule.params = it.rule.params || {}
    it.module = it.module || { enabled: false, title: '', submit: 'files' }
    it.order = it.order === undefined ? i + 1 : it.order
    it.extra = !!it.extra
    it.form = it.form || 'manual'
    if (it.rule.type === 'avg' && !Array.isArray(it.rule.params.grades)) it.rule.params.grades = []
    if (it.rule.type === 'rubric' && !Array.isArray(it.rule.params.dims)) it.rule.params.dims = []
    return it
  })
  return out
}

function ruleName(type) {
  const r = rules.value.find((x) => x.type === type)
  return r ? r.name : type
}

function onRuleChange() {
  // 换规则就重置参数，免得带着上一条规则的字段（服务端也会校验）
  if (!cur.value) return
  cur.value.rule.params = {}
  if (cur.value.rule.type === 'avg') cur.value.rule.params.grades = [{ key: 'A', label: 'A（100）', factor: 1 }]
  if (cur.value.rule.type === 'rubric') cur.value.rule.params.dims = [{ key: 'd1', name: '维度一', full: cur.value.full }]
  if (cur.value.rule.type === 'raw') cur.value.rule.params.rawFull = 100
  if (cur.value.rule.type === 'base' || cur.value.rule.type === 'acc') cur.value.rule.params.start = cur.value.full
}

function move(i, d) {
  const list = raw.value.items
  const j = i + d
  if (j < 0 || j >= list.length) return
  const tmp = list[i]
  list[i] = list[j]
  list[j] = tmp
  list.forEach((it, k) => (it.order = k + 1))
}

function addItem() {
  const n = raw.value.items.length + 1
  const key = 'item' + n
  raw.value.items.push({
    key,
    name: '新考核项',
    short: '',
    full: 10,
    order: n,
    form: 'graded',
    extra: false,
    rule: { type: 'avg', params: { grades: [{ key: 'A', label: 'A（100）', factor: 1 }, { key: 'B', label: 'B（80）', factor: 0.8 }], lateFactor: 1 } },
    hint: '',
    presets: [],
    reasonRequired: true,
    reasonLabel: '原因 / 说明',
    module: { enabled: false, title: '', submit: 'files' },
  })
  curKey.value = key
}

function removeItem(i) {
  const it = raw.value.items[i]
  if (!window.confirm('删掉「' + it.name + '」？\n\n已记的分不会消失，但这一项不再计入总分（想临时停用可以只关模块）。')) return
  raw.value.items.splice(i, 1)
  raw.value.items.forEach((x, k) => (x.order = k + 1))
  if (curKey.value === it.key) curKey.value = (raw.value.items[0] || {}).key || ''
}

function applyPresets() {
  if (!cur.value) return
  try {
    const v = presetText.value.trim() ? JSON.parse(presetText.value) : []
    if (!Array.isArray(v)) throw new Error('应该是数组')
    cur.value.presets = v
    toast.value = '快捷按钮已更新'
  } catch (e) {
    toast.value = '快捷按钮 JSON 不合法：' + e.message
  }
}

function revert() {
  if (!window.confirm('放弃这次改动，回到已保存的版本？')) return
  load()
}

async function save() {
  if (!raw.value) return
  saving.value = true
  try {
    const res = await api.patch('/api/teacher/scheme', { raw: raw.value })
    errors.value = []
    warnings.value = res.warnings || []
    // PATCH 只回版本号与这一条变更：把它们就地合进来（否则页头的 v 号不刷新）
    raw.value.version = res.version
    if (res.change) raw.value.changes = (raw.value.changes || []).concat([res.change])
    savedRaw.value = JSON.stringify(raw.value)
    await loadScheme(true) // 导航、评分表立刻按新方案
    toast.value = '已保存 · v' + res.version + '（导航与评分表已同步）'
    previewing.value = false
  } catch (e) {
    error.value = e.message
    toast.value = '保存失败：' + e.message
  } finally {
    saving.value = false
  }
}

async function openPreview() {
  previewing.value = true
  if (!previewClass.value && classes.value.length) previewClass.value = classes.value[0].id
  if (previewClass.value) await runPreview()
}

async function runPreview() {
  if (!previewClass.value || !raw.value) return
  previewLoading.value = true
  previewData.value = null
  try {
    previewData.value = await api.post('/api/teacher/scheme/preview', { classId: previewClass.value, raw: raw.value })
  } catch (e) {
    toast.value = e.message
  } finally {
    previewLoading.value = false
  }
}
</script>

<style scoped>
/* 考核项右边的「学生端可见」小眼睛 */
/* 眼睛的固定槽：有眼睛没眼睛都占同样宽，保证右边那组按钮每行都对齐 */
.eye-slot {
  flex: 0 0 22px;
  width: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: 1px;
}

/* 和 ↑ ↓ × 同一套外观（边框 / 圆角 / 高度一致），一眼看出它也是按钮 */
.eye {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: #fff;
  color: #55636f;
  cursor: pointer;
}

.eye:hover {
  border-color: #93b4f7;
  background: #f2f6ff;
  color: #1f2a33;
}

/* 已收起：琥珀描边 + 淡黄底 —— 和「可见」的灰蓝拉开距离，扫一眼就知道哪几项被收了 */
.eye.off {
  border-color: #e6cf9a;
  background: #fff8e9;
  color: #a5670a;
}

.eye.off:hover {
  border-color: #d9a441;
  background: #fff3dd;
  color: #8a5306;
}

/* 方案导入报告 */
.sio {
  border: 1px solid var(--line);
  border-left: 3px solid #2f7d92;
  border-radius: 4px;
  background: #f8fbfd;
  padding: 8px 10px;
  margin-top: 10px;
}

.sio-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 2px 0;
}

.sio-k {
  flex: 0 0 42px;
  color: #6b7785;
  font-size: 12px;
}

.sio-list {
  margin-top: 8px;
  border-top: 1px dashed var(--line);
  padding-top: 6px;
}

.sio-item {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 3px 0;
  flex-wrap: wrap;
}

.hint-tip {
  margin-left: 6px;
  color: #1d4ed8;
  font-style: normal;
}

.hint-preview {
  margin: 4px 0 0;
  padding: 4px 8px;
  background: #f8fafc;
  border-left: 3px solid #cbd5e1;
  line-height: 1.7;
}

.hint-vars {
  margin: 4px 0 0;
  line-height: 2;
}

.hint-vars code {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 5px;
  background: #eef2ff;
  border: 1px solid #dbe2f5;
  border-radius: 3px;
  color: #3730a3;
  cursor: pointer;
  font-size: 11.5px;
}

.hint-vars code:hover {
  background: #e0e7ff;
}

.cchip {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 500;
  color: #1d4ed8;
  background: #eef4ff;
  border: 1px solid #cddffb;
  border-radius: 3px;
  padding: 2px 7px;
  vertical-align: middle;
}

.editor {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

@media (max-width: 1080px) {
  .editor {
    grid-template-columns: 1fr;
  }
}

.list,
.detail {
  padding: 12px 14px;
}

.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.items li {
  padding: 7px 9px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  cursor: pointer;
  background: #fff;
}

.items li:hover {
  background: #f6f8fd;
}

.items li.on {
  border-color: #93b4f7;
  background: #eef4ff;
}

.itop {
  display: flex;
  align-items: center;
  gap: 6px;
}

.itop b {
  font-size: 13.5px;
  min-width: 0;
}

.isub {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

.mini-btn {
  border: 1px solid var(--line);
  background: #fff;
  border-radius: 3px;
  padding: 0 5px;
  font-size: 12px;
  line-height: 18px;
  color: #4a525a;
  cursor: pointer;
}

.mini-btn:hover {
  background: #eef1f5;
}

.mini-btn.danger {
  color: #b91c1c;
}

.mini-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.addrow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.mini.off {
  color: var(--err);
}

.globals {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line-soft);
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.detail h4 {
  margin: 16px 0 8px;
  font-size: 13.5px;
  color: #374151;
  padding-top: 10px;
  border-top: 1px dashed var(--line-soft);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field > span {
  font-size: 12.5px;
  color: #4a525a;
}

.field.inline {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

.params {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
}

.subfields {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.tbl {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.trow {
  display: flex;
  align-items: center;
  gap: 6px;
}

.rulehint {
  margin: 18px 0 0;
  line-height: 1.6;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #475569;
  margin-top: 10px;
}

.adv {
  margin-top: 14px;
}

.adv summary {
  cursor: pointer;
  font-size: 12.5px;
  color: #64748b;
}

.adv textarea {
  margin-top: 6px;
  font-family: Consolas, monospace;
  font-size: 12px;
}

.log {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.log li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: 12.5px;
  padding: 5px 0;
  border-top: 1px solid var(--line-soft);
}

.log li:first-child {
  border-top: none;
}

.log .when {
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

.log .note {
  color: #7a5a20;
  background: #fbf7ef;
  border-radius: 3px;
  padding: 0 5px;
}

.cmp {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 14px 4px;
}

.cmpcol {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cmpcol b {
  font-size: 24px;
  font-variant-numeric: tabular-nums;
}

.cmpcol.after b {
  color: var(--ok);
}

.arrow {
  color: var(--dim);
  font-size: 18px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.spacer {
  flex: 1;
}

.ellip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.mono {
  font-family: Consolas, monospace;
}

.ok {
  color: var(--ok);
}

.bad {
  color: var(--err);
}

.hint ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
</style>
