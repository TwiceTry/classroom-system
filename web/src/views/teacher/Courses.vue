<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>课程管理</template>
        <template #sub>一门课 = 自己的讲义 / 材料 / 代码示例 / 试卷 + 自己的考核方案 + 若干班级。可以手工建壳，也可以上传课程包一次配好</template>
        <template #right>
          <!--
            「下载模板」不放在这一层：它只在「要导入」时才有意义，
            摆在页头和「导出课程包」并排会让人以为是个独立的导出功能。
            挪到导入弹窗里（模板就在导入按钮旁边）。
          -->
          <button class="btn mini" :disabled="loading" @click="load">刷新</button>
          <button class="btn mini" @click="openImport">导入课程包</button>
          <button class="btn primary" @click="openNew">＋ 新建课程</button>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>

    <div v-if="!loading && !list.length" class="card empty">
      还没有课程。点右上角「＋ 新建课程」建一个空的，或者用「导入课程包」把配好的一门课整体装进来。
    </div>

    <div v-else class="sgroups">
      <section v-for="g in groups" :key="g.key" class="sgroup">
        <p class="sgroup-h">
          <b>{{ g.label }}</b>
          <span class="dim mini">{{ g.items.length }} 门</span>
        </p>
        <div class="grid">
      <article v-for="c in g.items" :key="c.id" class="card co" :class="{ off: c.archived }">
        <div class="cotop">
          <b class="ellip">{{ c.name }}</b>
          <span v-if="c.semester" class="tag">{{ c.semester }}</span>
          <span v-if="c.archived" class="tag mute">已归档</span>
          <span class="spacer"></span>
          <span class="dim mono mini">{{ c.id }}</span>
        </div>
        <p v-if="c.note" class="note">{{ c.note }}</p>

        <dl class="meta">
          <div>
            <dt>班级</dt>
            <dd>{{ c.classes }} 个 · {{ c.students }} 人</dd>
          </div>
          <div>
            <dt>考核方案</dt>
            <dd>
              <template v-if="c.scheme">{{ c.scheme.name }} v{{ c.scheme.version }} · {{ c.scheme.items }} 项</template>
              <template v-else><span class="warn">未绑定</span></template>
            </dd>
          </div>
          <div class="wide">
            <dt>内容</dt>
            <dd class="dirs">
              <span v-for="d in c.content" :key="d.dir" class="dchip" :class="{ empty: !d.files }">
                {{ d.dir }} <b>{{ d.files }}</b>
              </span>
            </dd>
          </div>
        </dl>

        <p class="path mono mini" :title="c.contentDir">{{ c.contentDir }}</p>

        <div class="cofoot">
          <button class="btn mini" @click="openEdit(c)">编辑</button>
          <button class="btn mini" @click="openCopy(c)" title="本地复制一份（下学期复用），不用打包">复制</button>
          <button class="btn mini" @click="openExport(c)" title="可以只导出其中几块：方案 / 名单 / 内容">导出课程包</button>
          <button class="btn mini" @click="toggleArchive(c)">{{ c.archived ? '取消归档' : '归档' }}</button>
        </div>
      </article>
        </div>
      </section>
    </div>

    <!--
      学生登录方式：全局开关（不属于某一门课），改完立即生效。
      默认「学号+姓名」不联网；切到青果后，学生要能登上智慧校园才能进课堂。
    -->
    <div class="card">
      <CardHead>
        <template #title>学生登录方式</template>
        <div class="right dim mini">改完立即生效，学生下次登录就用新的</div>
      </CardHead>
      <div class="authrow">
        <label class="authopt">
          <input v-model="auth.mode" type="radio" value="local" @change="saveAuth" />
          <span>
            <b>学号 + 姓名</b>
            <em class="dim mini">和班级名单比对，不联网、瞬时；学生只要知道学号就能进</em>
          </span>
        </label>
        <label class="authopt">
          <input v-model="auth.mode" type="radio" value="kg" @change="saveAuth" />
          <span>
            <b>学号 + 智慧校园密码</b>
            <em class="dim mini">能登上青果智慧校园才放行；学生账号即学号</em>
          </span>
        </label>
      </div>

      <p v-if="auth.mode === 'kg'" class="note warn mini">
        注意：青果按 24 小时计失败次数，<b>满 5 次锁号</b>。所以课程系统<strong>不会自动重试</strong> ——
        一次不过就直接告诉学生「学号或密码不对」，绝不拿学生账号去赌验证码识别。
      </p>
      <p v-else class="dim mini">学生输错姓名不会有任何惩罚，可以随时重试。</p>

      <div v-if="auth.mode === 'kg'" class="bases">
        <label v-for="(b, i) in auth.kgBases" :key="i" class="field inline">
          <span>入口 {{ i + 1 }}</span>
          <input v-model="auth.kgBases[i]" class="input wide" placeholder="http://ip:port" @blur="saveAuth" />
        </label>
        <p class="dim mini">两个入口内容一样，按请求轮询分流。失败不会换另一个再试（换了也只是多消耗一次失败次数）。</p>

        <div class="creds">
          <p class="dim mini">
            已记住 <b>{{ auth.rememberedCount || 0 }}</b> 个学生的密码（存的是不可逆的派生值，不是明文）。
            第一次登录问青果，通过后就记住 —— 之后本地比对，不再打青果。
            学生改过智慧校园密码时本地会对不上，这时让他点登录页的「用青果再验一次」，
            或者在这里清空，下次重新验证。
          </p>
          <button class="btn mini" :disabled="!auth.rememberedCount" @click="clearCreds">
            清空全部记住的密码
          </button>
        </div>
      </div>
    </div>

    <div class="card tips">
      <CardHead>
        <template #title>怎么往里放内容</template>
      </CardHead>
      <p class="dim mini">
        「内容」那一行是这个课程目录下的四个文件夹：<code>lecture/</code>（讲义）、<code>materials/</code>（学生材料）、
        <code>代码示例/</code>（代码练习与课堂作业用）、<code>exams/</code>（试卷库）。
        新建课程时系统已经把空目录建好，把文件拷进对应文件夹，刷新即可。
        要整门课打包带走/分发，用「导出课程包」得到一个 zip（course / scheme / classes / content 分开，见「课程包格式规范」），到别的机器上「导入课程包」。
      </p>
    </div>


    <!-- 新建 / 编辑 -->
    <div v-if="editing" class="mask" @click.self="editing = false">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ form.isNew ? '新建课程' : '编辑课程' }}</h3>
          <button class="btn mini" @click="editing = false">×</button>
        </div>
        <div class="modal-body form">
          <label class="field">
            <span>课程名</span>
            <input v-model="form.name" class="input" placeholder="示例课程" @input="onNameInput" />
          </label>
          <label v-if="form.isNew" class="field">
            <span>课程 id（文件名/目录名，字母数字短横线）</span>
            <input v-model="form.id" class="input mono" placeholder="example-course" />
          </label>
          <label class="field">
            <span>学期（用来分组，可留空）</span>
            <input v-model="form.semester" class="input" list="sem-list" placeholder="2026秋" maxlength="20" />
            <datalist id="sem-list">
              <option v-for="v in semesterOptions" :key="v" :value="v" />
            </datalist>
          </label>
          <label class="field">
            <span>备注</span>
            <input v-model="form.note" class="input" placeholder="54 学时 · 周一 1-2 节" />
          </label>
          <label v-if="form.isNew" class="field">
            <span>考核方案</span>
            <select v-model="form.copySchemeFrom" class="select">
              <option value="">先不绑（之后在「考核方案」页选）</option>
              <option v-for="s in schemes" :key="s.id" :value="s.id">复制现有方案：{{ s.name }}（v{{ s.version }}）</option>
            </select>
          </label>
          <p class="dim mini">
            保存后会自动建好 <code>data/courses/&lt;id&gt;/content/{{ '{lecture, materials, 代码示例, exams, assets}' }}</code> 五类内容目录（讲义 / 材料 / 代码示例 / 试卷 / 图片素材）。
          </p>
        </div>
        <div class="modal-foot">
          <span class="spacer"></span>
          <button class="btn" @click="editing = false">取消</button>
          <button class="btn primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- 导出课程包：选部件 -->
    <div v-if="exporting" class="mask" @click.self="exporting = false">
      <div class="modal">
        <div class="modal-head">
          <h3>导出课程包：{{ exportFrom && exportFrom.name }}</h3>
          <button class="btn mini" @click="exporting = false">×</button>
        </div>
        <div class="modal-body form">
          <p class="peer-line"><b>课程信息</b>（course.json）—— 一定在包里，导入时靠它认课</p>
          <label class="check">
            <input v-model="exportParts.scheme" type="checkbox" />
            考核方案（scheme.json）
          </label>
          <label class="check">
            <input v-model="exportParts.classes" type="checkbox" />
            班级与名单（classes/）
          </label>
          <label class="check">
            <input v-model="exportParts.content" type="checkbox" />
            内容文件（content/ 讲义 / 材料 / 示例 / 试卷）
          </label>
          <p class="dim mini">
            只勾一部分时，包里就只有这几块；对方导入时也只会更新这几块，其余不受影响。
            只想导其中一块（比如只导名单），把另外两个勾掉即可 —— 学期初把名单给同事、只想换内容时，都用得上。
          </p>
        </div>
        <div class="modal-foot">
          <span class="spacer"></span>
          <button class="btn" @click="exporting = false">取消</button>
          <button class="btn primary" :disabled="exportBusy" @click="doExport">
            {{ exportBusy ? '打包中…' : '导出' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 复制课程（本地 fork，不走 zip） -->
    <div v-if="copying" class="mask" @click.self="copying = false">
      <div class="modal">
        <div class="modal-head">
          <h3>复制课程：{{ copyFrom && copyFrom.name }}</h3>
          <button class="btn mini" @click="copying = false">×</button>
        </div>
        <div class="modal-body form">
          <label class="field">
            <span>新课程名</span>
            <input v-model="copyForm.name" class="input" placeholder="示例课程（2026秋）" />
          </label>
          <label class="field">
            <span>新课程 id（留空自动用 <code>{{ copyFrom && copyFrom.id }}-2</code>）</span>
            <input v-model="copyForm.id" class="input mono" placeholder="留空即可" />
          </label>
          <label class="field">
            <span>学期</span>
            <input v-model="copyForm.semester" class="input" list="sem-list" placeholder="2027春" maxlength="20" />
          </label>
          <label class="check">
            <input v-model="copyForm.withClasses" type="checkbox" />
            连班级与名单一起复制（成绩、作业提交不会带过去）
          </label>
          <p class="dim mini">
            会复制：课程信息、考核方案（另存一份，源方案不动）、整棵 <code>content/</code> 目录。
            不复制：班级 / 学生 / 记分 / 作业提交。
          </p>
        </div>
        <div class="modal-foot">
          <span class="spacer"></span>
          <button class="btn" @click="copying = false">取消</button>
          <button class="btn primary" :disabled="copyingBusy" @click="doCopy">
            {{ copyingBusy ? '复制中…' : '复制' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 导入课程包（zip）：先只读解析给差异报告，确认后才落盘 -->
    <ImportDialog
      v-model="importing"
      title="导入课程包"
      :file-name="packFile"
      accept=".zip"
      :busy="saving || uploading"
      :error="packErr"
      :errors="packErrList"
      :has-report="!!report"
      pick-text="⤒ 选择课程包 zip"
      template-label="⤓ 没有包？下载空模板"
      template-hint="模板里有 course.json、名单目录、content/ 四类空目录与说明。"
      wide
      @pick="onFile"
      @template="downloadTemplate"
      @close="closeImport"
    >
      <template #hint>
        <p class="dim mini" style="margin-top: 0">
          选一个 <code>*.coursepack.zip</code>（「导出课程包」得到的那个）。系统会先只读解析出一份差异报告：
          哪些新建、哪些更新、多少文件没变 —— 你看过再决定怎么导。
        </p>
      </template>

      <template #progress>
        <div v-if="uploading" class="up">
          <div class="up-track"><div class="up-bar" :style="{ width: uploadPct + '%' }"></div></div>
          <span class="dim mini">{{ uploadPct < 100 ? '上传中 ' + uploadPct + '%' : '正在解析…' }}</span>
          <button class="btn mini" @click="cancelUpload">取消</button>
        </div>
      </template>

      <template #report>
          <!-- 干跑报告 -->
          <div v-if="report" class="pk">
            <p v-if="report.parts" class="hint" style="margin-bottom: 8px">
              本次只更新：<b>{{ report.parts.map(partLabel).join(' / ') }}</b>
              <span class="dim">（包里没带的部件不会被改动）</span>
            </p>

            <div class="pk-row">
              <span class="pk-k">课程</span>
              <b>{{ report.course.name }}</b>
              <code class="dim mini">{{ report.course.id }}</code>
              <span class="tag" :class="report.course.action === 'create' ? 'ok' : 'mute'">
                {{ report.course.action === 'create' ? '新建' : '已存在 · 覆盖信息' }}
              </span>
            </div>

            <div class="pk-row">
              <span class="pk-k">方案</span>
              <span class="mono">{{ report.scheme.id }}</span>
              <span class="tag" :class="report.scheme.action === 'update' ? 'warn' : 'mute'">
                {{ schemeLabel }}
              </span>
            </div>
            <div v-if="report.scheme.action === 'update'" class="pk-row">
              <span class="pk-k"></span>
              <span class="row" style="gap: 10px">
                <label class="check"><input v-model="schemeMode" type="radio" value="use" /> 用包里的方案</label>
                <label class="check"><input v-model="schemeMode" type="radio" value="keep" /> 保留本机方案</label>
                <label class="check"><input v-model="schemeMode" type="radio" value="copy" /> 另存为新方案</label>
              </span>
            </div>

            <div class="pk-row">
              <span class="pk-k">班级</span>
              <div class="pk-list">
                <div v-for="c in report.classes" :key="c.name" class="pk-item">
                  <span>{{ c.name }}</span>
                  <span class="tag" :class="c.action === 'create' ? 'ok' : 'mute'">
                    {{ c.action === 'create' ? '新建' : '更新' }}
                  </span>
                  <span class="dim mini">
                    名单 {{ c.students.package }} 人（本地 {{ c.students.local }}）·
                    新增 {{ c.students.added }}
                    <template v-if="c.students.removed">· 包里没有 {{ c.students.removed }}（replace 才移出）</template>
                  </span>
                </div>
                <div v-if="!report.classes.length" class="dim mini">包里没有班级（本次不动班级与名单）</div>
              </div>
            </div>

            <div class="pk-row">
              <span class="pk-k">内容</span>
              <span v-if="report.content.included === false" class="dim">包里没带内容文件（本次不动内容）</span>
              <span v-else>
                共 {{ report.content.total }} 个文件 ·
                <b class="ok-c">新增 {{ report.content.added }}</b> ·
                更新 {{ report.content.updated }} ·
                未变 {{ report.content.unchanged }}
                <template v-if="report.content.extra">
                  ·
                  <button class="linkish" @click="showExtra = !showExtra">
                    本地多出 {{ report.content.extra }} 个{{ showExtra ? '（收起）' : '（整体替换会移走）' }}
                  </button>
                </template>
              </span>
            </div>
            <div v-if="report.content.extra && showExtra" class="pk-samples mono">
              <div v-for="p in report.content.extraList || []" :key="p">− {{ p }}</div>
              <div v-if="report.content.extraTruncated" class="dim">…（只列前 500 个）</div>
              <div class="dim">
                整体替换时这些文件会被移到 data/.trash/&lt;时间戳&gt;/{{ report.course && report.course.id }}/
                —— 不是直接删除，误操作还能捞回来
              </div>
            </div>
            <div v-if="report.content.samples.length" class="pk-samples mono">
              {{ report.content.samples.join('、') }}
            </div>

            <div v-if="report.warnings.length" class="hint warn">
              <b>提示：</b>
              <ul><li v-for="w in report.warnings" :key="w">{{ w }}</li></ul>
            </div>
          </div>

          <!-- 导入完成 -->
          <div v-if="applied" class="hint ok">
            <b>导入完成：</b>{{ applied.courseName }}（{{ applied.courseId }}）·
            方案 {{ applied.scheme || '未绑定' }} ·
            {{ applied.classes.length }} 个班（新增学生 {{ appliedAdded }} 人）·
            写入 {{ applied.files.written }} 个文件<template v-if="applied.files.removed">
              ，移走 {{ applied.files.removed }} 个（在 data/{{ applied.files.trash ? applied.files.trash.dir : '.trash/' }}，可随时捞回）</template>
          </div>
      </template>

      <!-- 课程包有三种导入策略，底部不是普通「取消 / 确认」，用 actions 插槽覆盖 -->
      <template #actions>
        <button v-if="!report" class="btn" @click="closeImport">关闭</button>
        <template v-else>
          <button class="btn" :disabled="saving" title="换一个新 id 另建一份，不动现有课程" @click="doApply('fork')">
            另建一份
          </button>
          <button class="btn" :disabled="saving" title="内容整体替换（包里没有的会删掉），名单同步成包里的" @click="doApply('replace')">
            整体替换
          </button>
          <button class="btn primary" :disabled="saving" title="覆盖同名文件，名单只增不减（推荐）" @click="doApply('merge')">
            {{ saving ? '导入中…' : '按此导入' }}
          </button>
        </template>
      </template>
    </ImportDialog>
    <Toast :text="toast" @close="toast = ''" />
  </PageShell>
</template>

<script setup>
/*
 * 课程管理
 *
 * 两种建课方式：
 *   A 表单 —— 建壳（课程记录 + 内容目录骨架 + 可选复制一份方案），内容自己拷进目录
 *   B 课程包 —— 一个 zip：course.json / scheme.json / classes/*.roster.csv / content/ 分开装，
 *      导入前先给差异报告（dry-run），三种策略可选（merge / replace / fork）
 * 课程是最高一级：讲义、材料、示例、作业、机试、大作业、计分、方案都挂在课程下面。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { api, download, getToken } from '../../api'
import Toast from '../../components/Toast.vue'
import PageHead from '../../components/PageHead.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'
import ImportDialog from '../../components/ImportDialog.vue'

const list = ref([])
const schemes = ref([])
const err = ref('')
const toast = ref('')

/* 学生登录方式（全局配置，不属于某一门课） */
const auth = reactive({ mode: 'local', kgBases: [], rememberedCount: 0 })

async function loadAuth() {
  try {
    const r = await api.get('/api/settings/student-auth')
    auth.mode = r.mode === 'kg' ? 'kg' : 'local'
    auth.kgBases = Array.isArray(r.kgBases) ? r.kgBases : []
    auth.rememberedCount = Number(r.rememberedCount || 0)
  } catch (e) {
    toast.value = '读不到学生登录设置：' + e.message
  }
}

/** 清空所有「记住的密码」（学生改过青果密码、或怀疑泄露时用） */
async function clearCreds() {
  if (!window.confirm('清空所有学生记住的密码？\n\n学生下次登录会重新去青果验证一次，不会影响成绩。')) return
  try {
    const r = await api.del('/api/settings/student-auth/creds')
    auth.rememberedCount = 0
    toast.value = '已清空 ' + (r.removed || 0) + ' 条记住的密码'
  } catch (e) {
    toast.value = '清空失败：' + e.message
  }
}

async function saveAuth() {
  try {
    const r = await api.patch('/api/settings/student-auth', { mode: auth.mode, kgBases: auth.kgBases })
    auth.mode = r.mode === 'kg' ? 'kg' : 'local'
    auth.kgBases = Array.isArray(r.kgBases) ? r.kgBases : []
    toast.value =
      '已保存：学生现在用' + (auth.mode === 'kg' ? '学号 + 智慧校园密码' : '学号 + 姓名') + '登录'
  } catch (e) {
    toast.value = '保存失败：' + e.message
    await loadAuth() // 回到服务端的真实值，别让界面显示假的
  }
}
const loading = ref(false)
const saving = ref(false)

const editing = ref(false)
const form = reactive({ isNew: true, id: '', name: '', note: '', semester: '', copySchemeFrom: '' })

const importing = ref(false)

const packErr = ref('')
const packErrList = ref([])
const zipBuf = ref(null) // 选中的 zip 原始字节
const packFile = ref('') // 选中的 zip 文件名（标题上要显示）
const report = ref(null) // 干跑报告（服务端算出来的差异）
const applied = ref(null)
const showExtra = ref(false) // 导入报告里「本地多出」的完整清单是否展开

/* 导出范围（部件级） */
const exporting = ref(false)
const exportBusy = ref(false)
const exportFrom = ref(null)
const exportParts = reactive({ scheme: true, classes: true, content: true })

/** 部件 key → 中文名 */
function partLabel(k) {
  return { course: '课程信息', scheme: '考核方案', classes: '班级名单', content: '内容文件' }[k] || k
}

function openExport(c) {
  exportFrom.value = c
  exportParts.scheme = true
  exportParts.classes = true
  exportParts.content = true
  exporting.value = true
}

function chosenParts() {
  return ['scheme', 'classes', 'content'].filter((k) => exportParts[k])
}

async function doExport() {
  if (!exportFrom.value) return
  exportBusy.value = true
  const parts = chosenParts()
  try {
    await exportPack(exportFrom.value, parts)
    exporting.value = false
  } finally {
    exportBusy.value = false
  }
}

/* 复制课程（本地 fork） */
const copying = ref(false)
const copyingBusy = ref(false)
const copyFrom = ref(null)
const copyForm = reactive({ name: '', id: '', semester: '', withClasses: false })

/** 按学期分组（新的在前；没标学期的排最后） */
const groups = computed(() => {
  const map = new Map()
  for (const c of list.value) {
    const key = (c.semester || '').trim() || ''
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(c)
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (!a) return 1
    if (!b) return -1
    return b.localeCompare(a, 'zh') // 2027春 排 2026秋 前面
  })
  return keys.map((k) => ({ key: k || '__none__', label: k || '未标学期', items: map.get(k) }))
})

/** 学期候选（给 datalist 用） */
const semesterOptions = computed(() => {
  const set = new Set()
  for (const c of list.value) if (c.semester) set.add(c.semester)
  return [...set]
})
const schemeMode = ref('use') // 方案冲突时怎么处理：use / keep / copy
const uploading = ref(false) // 正在上传（进度条）
const uploadPct = ref(0)
let currentXhr = null // 用于「取消上传」
const appliedAdded = computed(() => (applied.value ? applied.value.classes.reduce((n, c) => n + (c.added || 0), 0) : 0))
/** 方案那一行的人话：同版本跳过 / 新建 / 会覆盖 */
const schemeLabel = computed(() => {
  const a = report.value && report.value.scheme
  if (!a) return ''
  if (a.action === 'create') return '新建'
  if (a.action === 'same') return '与本机一致 · 跳过（v' + a.localVersion + '）'
  return '将覆盖本机 v' + a.localVersion
})

onMounted(() => {
  load()
  loadAuth()
})

async function load() {
  loading.value = true
  err.value = ''
  try {
    const res = await api.get('/api/courses')
    list.value = res.items || []
    const s = await api.get('/api/scheme').catch(() => null)
    schemes.value = s && s.raw ? [{ id: s.raw.id, name: s.raw.name, version: s.raw.version }] : []
  } catch (e) {
    err.value = e.message
  } finally {
    loading.value = false
  }
}

function openNew() {
  form.isNew = true
  form.id = ''
  form.name = ''
  form.note = ''
  form.semester = guessSemester()
  form.copySchemeFrom = ''
  editing.value = true
}

function openEdit(c) {
  form.isNew = false
  form.id = c.id
  form.name = c.name
  form.note = c.note || ''
  form.semester = c.semester || ''
  form.copySchemeFrom = ''
  editing.value = true
}

/** 按当前月份猜学期：2–7 月算「春」，8–1 月算「秋」 */
function guessSemester() {
  const d = new Date()
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  return m >= 2 && m <= 7 ? y + '春' : (m >= 8 ? y : y - 1) + '秋'
}

function openCopy(c) {
  copyFrom.value = c
  copyForm.name = c.name + '（副本）'
  copyForm.id = ''
  copyForm.semester = guessSemester()
  copyForm.withClasses = false
  copying.value = true
}

async function doCopy() {
  if (!copyFrom.value) return
  copyingBusy.value = true
  try {
    const r = await api.post('/api/courses/' + encodeURIComponent(copyFrom.value.id) + '/duplicate', {
      name: copyForm.name.trim() || undefined,
      id: copyForm.id.trim() || undefined,
      semester: copyForm.semester || '',
      withClasses: copyForm.withClasses,
    })
    copying.value = false
    toast.value =
      '已复制为 ' +
      r.course.name +
      '（' +
      r.course.id +
      '）：' +
      r.files +
      ' 个文件' +
      (r.classes ? '，' + r.classes + ' 个班 / ' + r.students + ' 人' : '，未复制班级')
    await load()
  } catch (e) {
    toast.value = e.message
  } finally {
    copyingBusy.value = false
  }
}

/** 中文课程名自动给一个拼音无关的 id 建议（用现有课程数兜底） */
function onNameInput() {
  if (!form.isNew || form.id) return
  const slug = form.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug && slug.length > 1) form.id = slug.slice(0, 40)
}

async function save() {
  if (!form.name.trim()) {
    toast.value = '课程名不能为空'
    return
  }
  saving.value = true
  try {
    if (form.isNew) {
      const id = form.id.trim() || 'course-' + Math.random().toString(16).slice(2, 6)
      await api.post('/api/courses', {
        id,
        name: form.name.trim(),
        note: form.note,
        semester: form.semester || '',
        copySchemeFrom: form.copySchemeFrom || undefined,
      })
      toast.value = '课程建好了，把讲义/材料/示例拷进它的内容目录即可'
    } else {
      await api.patch('/api/courses/' + encodeURIComponent(form.id), {
        name: form.name.trim(),
        note: form.note,
        semester: form.semester || '',
      })
      toast.value = '已保存'
    }
    editing.value = false
    await load()
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}

/** 空壳课程包模板（后端现打的 zip） */
function downloadTemplate() {
  download('/api/courses/template.zip', 'coursepack-template.zip')
}

function openImport() {
  importing.value = true
  showExtra.value = false
  packErr.value = ''
  packErrList.value = []
  zipBuf.value = null
  report.value = null
  applied.value = null
  schemeMode.value = 'use'
}

function closeImport() {
  importing.value = false
}

/**
 * 把 zip 发给服务端「只读解析」，拿回差异报告；一个字节都不落盘。
 * 文件由 ImportDialog 的隐藏 input 选好后 emit 过来。
 */
async function onFile(f) {
  packErr.value = ''
  packErrList.value = []
  report.value = null
  applied.value = null
  packFile.value = f ? f.name : ''
  if (!f) return
  if (f.size > 500 * 1024 * 1024) {
    packErr.value = '文件太大（' + Math.round(f.size / 1024 / 1024) + 'MB），单包上限 500MB'
    return
  }
  if (!/\.zip$/i.test(f.name)) {
    packErr.value = '请选课程包 zip（文件名应以 .coursepack.zip 结尾）'
    return
  }
  const buf = await f.arrayBuffer()
  zipBuf.value = buf
  saving.value = true
  try {
    const res = await postZip('/api/courses/import/inspect', buf)
    report.value = res
  } catch (e2) {
    if (!e2.aborted) {
      packErr.value = e2.message
      packErrList.value = e2.errors || []
    }
    zipBuf.value = null
  } finally {
    saving.value = false
  }
}

/**
 * 带令牌 POST 二进制（zip 不能走 api.post 的 JSON 包装）。
 * 用 XHR 而不是 fetch：fetch 拿不到上传进度，几百 MB 的包会让人以为卡死。
 */
function postZip(path, buf) {
  return new Promise((resolve, reject) => {
    const token = getToken()
    const xhr = new XMLHttpRequest()
    currentXhr = xhr
    xhr.open('POST', path, true)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token)

    uploading.value = true
    uploadPct.value = 0

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) uploadPct.value = Math.min(99, Math.round((e.loaded / e.total) * 100))
    }
    xhr.upload.onload = () => {
      uploadPct.value = 100 // 传完了，等服务器解析
    }

    xhr.onload = () => {
      uploading.value = false
      currentXhr = null
      let data = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch (e) {
        data = null
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const err = new Error((data && data.error) || '导入失败（' + xhr.status + '）')
        err.errors = (data && data.errors) || []
        return reject(err)
      }
      resolve(data)
    }
    xhr.onerror = () => {
      uploading.value = false
      currentXhr = null
      reject(new Error('连不上服务器，请确认课堂系统还在运行'))
    }
    xhr.onabort = () => {
      uploading.value = false
      currentXhr = null
      const err = new Error('已取消上传')
      err.aborted = true
      reject(err)
    }
    xhr.send(buf)
  })
}

/** 取消上传（断了连接，服务器那边的临时文件也会被清掉） */
function cancelUpload() {
  if (currentXhr) {
    currentXhr.abort()
    currentXhr = null
  }
  uploading.value = false
}

async function doApply(strategy) {
  if (!zipBuf.value) return
  saving.value = true
  packErr.value = ''
  packErrList.value = []
  try {
    const res = await postZip(
      '/api/courses/import/apply?strategy=' + strategy + '&schemeMode=' + schemeMode.value,
      zipBuf.value
    )
    applied.value = res.report
    report.value = null
    zipBuf.value = null
    toast.value = '导入完成：' + res.course.name
    await load()
  } catch (e2) {
    packErr.value = e2.message
    packErrList.value = e2.errors || []
  } finally {
    saving.value = false
  }
}

async function toggleArchive(c) {
  if (!window.confirm((c.archived ? '取消归档' : '归档') + '「' + c.name + '」？归档只是不在默认列表里出现，数据都保留。')) return
  try {
    await api.patch('/api/courses/' + encodeURIComponent(c.id), { archived: !c.archived })
    await load()
  } catch (e) {
    toast.value = e.message
  }
}

async function exportPack(c, parts) {
  const want = Array.isArray(parts) ? parts : ['scheme', 'classes', 'content']
  const qs = want.length === 3 ? '' : '?parts=' + want.join(',')
  const path = '/api/courses/' + encodeURIComponent(c.id) + '/package.zip' + qs
  const token = getToken()
  try {
    // 先问服务端「这门课多大、有没有文件超限」——一次 stat，不打包
    let sum = null
    try {
      sum = await api.get(
        '/api/courses/' +
          encodeURIComponent(c.id) +
          '/package/summary' +
          (want.length === 3 ? '' : '?parts=' + want.join(','))
      )
    } catch (e) {
      sum = null // 拿不到就照常导出，不挡路
    }
    if (sum && sum.overLimit) {
      const big = (sum.skipped || [])
        .slice(0, 5)
        .map((f) => '· ' + f.path + '（' + Math.round(f.size / 1024 / 1024) + 'MB）')
        .join('\n')
      const ok = window.confirm(
        '这门课的内容一共 ' +
          sum.mb +
          'MB，超过单包上限 ' +
          Math.round(sum.limits.pack / 1024 / 1024) +
          'MB，导不出来。\n\n建议先把大文件移出内容目录，或压小一点。' +
          (big ? '\n\n最大的几个：\n' + big : '')
      )
      if (!ok) return
      return
    }
    if (sum && sum.skipped && sum.skipped.length) {
      const list = sum.skipped
        .slice(0, 8)
        .map((f) => '· ' + f.path + '（' + Math.round(f.size / 1024 / 1024) + 'MB）')
        .join('\n')
      const ok = window.confirm(
        '有 ' +
          sum.skipped.length +
          ' 个文件超过单文件上限 ' +
          Math.round(sum.limits.file / 1024 / 1024) +
          'MB，不会进包：\n\n' +
          list +
          (sum.skipped.length > 8 ? '\n…还有 ' + (sum.skipped.length - 8) + ' 个' : '') +
          '\n\n其余文件照常导出，继续吗？'
      )
      if (!ok) return
    }
    toast.value = '正在打包 ' + c.name + '…'
    const res = await fetch(path, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
    if (!res.ok) {
      let msg = '导出失败（' + res.status + '）'
      try {
        const j = await res.json()
        if (j && j.error) msg = j.error
      } catch (e) {
        /* 不是 JSON 就算了 */
      }
      throw new Error(msg)
    }
    // 文件名从 Content-Disposition 里取（服务端给的是 <课程id>_<日期>.coursepack.zip）
    let fname = c.id + '.coursepack.zip'
    const cd = res.headers.get('content-disposition') || ''
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd)
    if (m) {
      try {
        fname = decodeURIComponent(m[1])
      } catch (e) {
        /* 解不出来就用默认名 */
      }
    }
    const blob = await res.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = fname
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
    toast.value = '已导出 ' + fname
  } catch (e) {
    toast.value = e.message
  }
}
</script>

<style scoped>
/* 导出弹层里「必带」的那一行（不是复选框，避免看起来像没勾上） */
.peer-line {
  margin: 0 0 6px;
  font-size: 13px;
  color: #40505f;
}

/* 按学期分组：每组一个小标题，下面照旧是卡片网格 */
.sgroups {
  display: flex;
  flex-direction: column;
}

.sgroup-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 12px 2px 6px;
  font-size: 13px;
  color: #40505f;
}

.sgroup-h b {
  font-size: 13.5px;
}

.sgroup:first-child .sgroup-h {
  margin-top: 0;
}
/* 报告里的小链接式按钮（展开「本地多出」清单） */
.linkish {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: #1f6feb;
  cursor: pointer;
  text-decoration: underline dotted;
}

.linkish:hover {
  text-decoration: underline;
}
/* 上传进度 */
.up {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

.up-track {
  flex: 1 1 auto;
  height: 6px;
  border-radius: 3px;
  background: #e8edf3;
  overflow: hidden;
}

.up-bar {
  height: 100%;
  background: #2f7d92;
  transition: width 0.15s linear;
}

/* 课程内容浏览器 */

.authrow {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 6px 0 4px;
}
.authopt {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  cursor: pointer;
  flex: 1 1 260px;
}
.authopt span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.authopt em {
  font-style: normal;
}
.bases {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
}
.input.wide {
  width: 220px;
}
</style>
