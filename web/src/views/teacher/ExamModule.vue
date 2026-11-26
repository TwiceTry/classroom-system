<template>
  <PageShell>
    <template #head>
      <PageHead @reload="loadAll">
        <template #title>{{ moduleTitle }}</template>
        <!--
          副标题放**现状**，不放流程说明。
          「导入 → 开始 → 作答 → 判分 → 出文件」是第一次用才需要看的，
          第 100 次它就是噪音 —— 而这里本该说「现在几场在考、收了多少」。
          说明挪进 title，鼠标停一下能看到。
        -->
        <template #sub>
          <span :title="'导入试卷 / 题库 → 分批开考 → 学生限时作答 → 客观题自动判、主观题你判 → 自动出答卷文件'">
            {{ pageSub }}
          </span>
        </template>
        <!--
          专属区。label 用「试卷库」而不是「试卷」：这里是**整个 content/exams 目录**
          的搬运（批量搬走/搬入试卷库），而列表里每个机试还有「导入这份卷子」的按钮
          （只给那一个作业装卷子）—— 两个都叫「导入试卷」会点错。
          刷新走通用区的「↻」。
        -->
        <template #right>
          <DirIO dir="exams" label="试卷库" />
          <button class="btn primary" @click="openEditor">＋ 新建机试</button>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>

    <div class="card hwbar">
      <button
      v-for="a in list"
      :key="a.id"
      class="pill hwpill"
      :class="{ on: a.id === curId }"
      @click="select(a.id)"
      >
      <!-- 状态读 collecting（实际还收不收），不读 status —— 到期不用老师手动点结束 -->
      <i class="led" :class="ledOf(a)"></i>
      {{ a.title }}
      <span class="dim">{{ stateOf(a).text }}</span>
    </button>
    <span v-if="!list.length && !loading" class="dim" style="font-size: var(--fs-md)">还没建过机试，点右上角「＋ 新建机试」。</span>
    </div>

    <template v-if="d">
    <div class="card ctrl">
      <div class="ctrl-l">
        <h3>
          {{ d.assignment.title }}
          <span class="tag" :class="stateOf(d.assignment).tone">{{ stateOf(d.assignment).text }}</span>
        </h3>
        <!--
          卷面摘要只留四个数：卷型 / 总分 / 限时 / 几段几题。
          原来把四段标题全铺开（「一、单项与多项选择（每题 4 分）(10题)、二、判断…」），
          一行挤成两行，读的人其实只想知道「100 分、45 分钟、22 题」。
          分段详情挪进 title，要细看的人鼠标一停就有。
        -->
        <p class="dim mini" v-if="d.paper" :title="paperDetail">
          {{ d.paper.kind === 'bank' ? '题库随机卷（每人一份）' : '统一卷（全班同一份）' }} ·
          {{ d.paper.fullScore }} 分
          <template v-if="d.paper.duration"> · {{ d.paper.duration }} 分钟</template>
          <template v-if="d.paper.sections.length">
            · {{ d.paper.sections.length }} 段 {{ paperQuestionCount }} 题
          </template>
        </p>
        <p class="dim mini" v-else>还没装卷子。点下面的「导入这份卷子」，或先用右上角的「⤒ 导入试卷库」批量搬。</p>
      </div>
      <div class="ctrl-r">
        <input ref="fileInput" type="file" accept=".json" style="display: none" @change="onFile" />
        <button
          class="btn mini"
          title="只给这一个机试装卷子：支持试卷 JSON 或题库 JSON"
          @click="fileInput.click()"
        >
          {{ d.paper ? '换卷子' : '导入卷子' }}
        </button>
        <!--
          改时长。已经开始考的人也会立刻生效 ——
          后端会把他们的答卷 state 里那份 paper 快照一起改掉，不然改源文件对他们无效。
        -->
        <button
          v-if="d.paper"
          class="btn mini"
          :title="'现在是 ' + (d.paper.duration || 0) + ' 分钟。改完正在考的人也会立刻按新时长走'"
          @click="changeDuration"
        >
          时长 {{ d.paper.duration || 0 }} 分
        </button>
        <!--
          两个按钮去掉了一个半：
            · 「答案卷」直接去掉 —— 答案本来就在卷子 JSON 里，判分页每道题
              都写着「参考答案」，再单独印一份答案卷是重复的。
            · 「试卷」（空白卷，打印用）只给**固定卷**留。
              题库卷每人抽到的题不一样，印出来的只是一份「样例」，
              拿它发下去学生会对不上题号 —— 那种场景该用投影或平台作答。
        -->
        <button
          v-if="d.paper && d.paper.kind !== 'bank'"
          class="btn mini"
          title="排好版的空白卷，打印或存 PDF"
          @click="openPaper(false)"
        >
          试卷
        </button>
        <!--
          这里原来有「▶ 开始考试 / ■ 结束」，**去掉了** ——
          唯一入口是下面的「分批开考」：勾人 → 开始这一批，全选就是全班。
          只留一个入口，学生端的「能不能考」就只有一个来源（他在哪一批）。
        -->
        <button class="btn mini danger" @click="remove">删除</button>
      </div>
    </div>

    <div v-if="!d.paper" class="card empty">
      还没有试卷。按 <code>data/exams/_template.json</code> 的格式写一份 JSON（支持统一卷 / 题库随机卷），
      点上面「导入试卷 / 题库」。
    </div>

    <!--
      分批开考：机器不够的时候只能一批一批来。
      和「▶ 开始考试」的分工 ——
        开始考试   全班同时
        分批       一次放几个人，这批交完点「结束这批」，再放下一批
      两者不冲突：整场开着全班都能考；整场关着时只有批次放的人能考。
    -->
    <div class="card batchcard">
      <CardHead>
        <template #title>分批开考</template>
        <!--
          这里原来写「勾几个人 → 开始这一批；这批做完点「结束这批」，再放下一批」。
          按钮上就写着「开始这一批」「结束这批」，再说一遍等于把人当不会点。
          换成进度：放了几批、还有几人没排 —— 这才是老师每次都要看一眼的数。
        -->
        <template #meta><span class="dim mini">{{ batchSummary }}</span></template>
      </CardHead>

      <!-- 有批次在放人时给一个「全部结束」—— 原来那个「■ 结束」的替代 -->
      <div v-if="openBatchCount" class="ball">
        <span class="dim mini">正在放 {{ openBatchCount }} 个批次</span>
        <span class="spacer"></span>
        <button class="btn mini danger" @click="stopAllBatches">■ 全部结束</button>
      </div>

      <div v-if="d.batches && d.batches.length" class="blist">
        <div
          v-for="b in d.batches"
          :key="b.id"
          class="brow"
          :class="{ live: b.status === 'open' && !b.overDue, timeup: b.status === 'open' && b.overDue }"
        >
          <span class="bseq">第 {{ b.seq }} 批</span>
          <span class="bstat">{{ b.status === 'open' ? (b.overDue ? '时间到' : '进行中') : '已结束' }}</span>
          <span class="dim mini">{{ b.count }} 人 · 已开考 {{ b.started }} · 已交 {{ b.submitted }}</span>
          <span v-if="b.status === 'open' && b.leftMin" class="bleft">还剩 {{ b.leftMin }} 分钟</span>
          <span v-else-if="b.status === 'open' && b.overDue" class="bleft over">已到时间</span>
          <span v-if="b.note" class="dim mini">· {{ b.note }}</span>
          <span class="spacer"></span>
          <button v-if="b.status === 'open'" class="btn mini" @click="stopBatch(b)">结束这批</button>
        </div>
      </div>

      <div class="pickbar">
        <button class="btn mini" @click="pickRest">勾剩下的 {{ unbatchedLeft }} 人</button>
        <button class="btn mini" @click="pickAll">全选</button>
        <button class="btn mini" @click="picked = []">清空</button>
        <!-- 按班快速选：一批通常就是一个班 -->
        <span v-if="classGroups.length > 1" class="clgroup">
          <button
            v-for="g in classGroups"
            :key="g.id"
            class="btn mini clbtn"
            :disabled="!g.left"
            :title="g.name + '：共 ' + g.total + ' 人，还有 ' + g.left + ' 人没排过批'"
            @click="pickClass(g.id)"
          >
            {{ shortClass(g.name) }}<em v-if="g.left">{{ g.left }}</em><em v-else class="done">✓</em>
          </button>
        </span>
        <span class="dim mini">已勾 {{ picked.length }} 人</span>
        <label class="minbox" title="这一批每人限时多少分钟（从他点「开考」那刻算）。留空 = 用试卷上的时长">
          限时
          <!-- placeholder 原来是「试卷」，看着像输入框里要填卷子。留空 = 按卷面时长 -->
          <input v-model="batchMin" type="number" min="0" max="300" placeholder="按卷面" />
          分钟
        </label>
        <span class="spacer"></span>
        <button class="btn primary" :disabled="!picked.length || busy" @click="startBatch">
          ▶ 开始这一批
        </button>
      </div>

      <!--
        名单默认收起（和课堂作业页一致）。
        117 个名字铺开是 9 行、约 190px，而老师真正要挑人只有开始一批那十几秒。
      -->
      <button class="btn mini toggle-pickers" @click="showPickers = !showPickers">
        {{ showPickers ? '▾ 收起名单' : '▸ 选人（' + (d.roster || []).length + ' 人）' }}
      </button>

      <div v-show="showPickers" class="pickers">
        <label
          v-for="s in d.roster || []"
          :key="s.sid"
          class="pk"
          :class="{ on: picked.includes(s.sid), done: s.submitted }"
        >
          <input type="checkbox" :checked="picked.includes(s.sid)" @change="togglePick(s.sid)" />
          <span class="pkn">{{ s.name }}</span>
          <em v-if="s.submitted">已交</em>
          <em v-else-if="s.started">在考</em>
          <em v-else-if="s.batchSeq" class="bq">第{{ s.batchSeq }}批</em>
        </label>
      </div>
    </div>

    <div class="card">
      <CardHead>
        <template #title>学生答卷 · {{ d.rows.length }} 人开考</template>
        <template #meta><span class="dim mini">每 8 秒刷新 · 客观题交卷即得分，主观题等你判</span></template>
      </CardHead>
      <!--
        「补考放行名单」没有了。
        重考改成「把人从批次里剔回去」，他会出现在分批面板的「剩下的 N 人」里，
        不需要另开一个名单来兜。
      -->
      <DataTable
        :columns="rowCols"
        :rows="d.rows"
        row-key="id"
        clickable
        :empty="'还没有学生开考。'"
        @row-click="open"
      >
        <template #cell-no="{ index }">{{ index + 1 }}</template>
        <!-- 学号不占一列了，挂在姓名上：要核对身份时鼠标停一下 -->
        <template #cell-name="{ row }">
          <span :title="'学号 ' + (row.sid || '—')">{{ row.name || row.sid }}</span>
        </template>
        <template #cell-answered="{ row }">{{ row.answered }} / {{ row.itemCount }}</template>
        <template #cell-total="{ row }"><b>{{ row.total === null ? '—' : row.total }}</b></template>
        <template #cell-score="{ row }">
          <span :class="{ ok: row.score !== null }">{{ row.score === null ? '—' : row.score }}</span>
        </template>
        <template #cell-actions="{ row }">
          <button class="btn mini" :title="row.submittedAt ? '看他的答卷并判主观题' : '看进度'" @click.stop="open(row)">
            {{ row.submittedAt ? '判分' : '看进度' }}
          </button>
          <!--
            立即交卷：只给「开考了还没交」的人。
            设备坏了、违纪、卡住的时候用 —— 把他已经答的收上来正常判分。
            注意它和「重考」是两回事：这个是收卷（分数算数），重考是清空重来。
          -->
          <button
            v-if="!row.submittedAt"
            class="btn mini"
            :title="'把 ' + (row.name || row.sid) + ' 现在答的收上来并判分（不是重考，分数算数）'"
            @click.stop="forceSubmit(row)"
          >
            立即交卷
          </button>
          <!--
            重考：清掉这次的答卷和分，让他重新开考（重新计时）。
            题库卷会换一套题 —— 不然重考就是背答案。
          -->
          <button
            class="btn mini danger"
            :title="'清掉 ' + (row.name || row.sid) + ' 这次交的答卷和分数，让他重新开考'"
            @click.stop="resetOne(row)"
          >
            重考
          </button>
        </template>
      </DataTable>
    </div>
    </template>


    <!-- 判卷 -->
    <div v-if="viewing" class="mask" @click.self="viewing = null">
    <div class="modal wide">
      <div class="modal-head">
        <h3>
          {{ viewing.name }} <span class="dim mono">{{ viewing.sid }}</span>
          <span class="tag" style="margin-left: 6px">{{ viewing.submittedAt ? '已交卷' : '作答中' }}</span>
        </h3>
        <button v-if="viewing && viewing.submittedAt" class="btn mini" style="margin-left: 8px" @click="openSheet(viewing.submissionId)">
          打印答卷
        </button>
        <button class="btn mini" style="margin-left: auto" @click="viewing = null">关闭</button>
      </div>

      <div class="modal-body">
        <div v-if="detail.loading" class="empty">正在读取答卷…</div>
        <template v-else-if="detail.paper">
          <div class="scorebar">
            <span>客观题 <b>{{ detail.graded ? detail.graded.autoScore : '—' }}</b></span>
            <span>主观题
              <input v-for="q in subjective" :key="q.id" v-model="manual[q.id]" class="input" type="number" min="0" :max="q.score" :title="q.id" style="width: 58px; margin: var(--sp-2)" />
            </span>
            <span>总分 <b class="total">{{ totalPreview }}</b> / {{ detail.paper.fullScore }}</span>
            <span class="spacer"></span>
            <input v-model="comment" class="input" placeholder="评语（学生看得到）" style="width: 240px" />
            <button class="btn primary" :disabled="saving" @click="saveGrade">{{ saving ? '保存中…' : '判分并记账' }}</button>
          </div>

          <section v-for="s in detail.paper.sections" :key="s.id" class="sec">
            <h4>{{ s.title }}（{{ s.score }} 分 / 题）</h4>
            <article v-for="q in s.questions" :key="q.id" class="q">
              <p class="stem"><b>{{ q.id }}</b> {{ q.stem }}</p>
              <ul v-if="q.options && q.options.length" class="opts">
                <li v-for="(o, oi) in q.options" :key="oi">{{ o }}</li>
              </ul>
              <p class="ans">
                学生：<b :class="markOf(q, s.type)">{{ detail.answers[q.id] || '（未作答）' }}</b>
                <span v-if="s.type !== 'short'" class="dim"> · 参考答案：{{ q.answer }}</span>
                <span v-if="s.type === 'short'" class="dim"> · 满分 {{ q.score }}</span>
              </p>
            </article>
          </section>
        </template>
        <div v-else class="empty">这个学生还没开始作答。</div>
      </div>
    </div>
    </div>

    <!-- 新建 -->
    <div v-if="editing" class="mask" @click.self="editing = false">
    <div class="modal">
      <div class="modal-head">
        <h3>新建机试</h3>
        <button class="btn mini" @click="editing = false">×</button>
      </div>
      <div class="modal-body form">
        <label class="field">
          <span>标题</span>
          <input v-model="form.title" class="input" placeholder="期末机试" />
        </label>
        <!--
          二选一：固定试卷 / 题库随机卷。
          这两样在老师脑子里是两件事 ——「我就出这一份」和「我出一批让人抽」，
          所以要让他先点选，而不是传个文件让我们猜。
        -->
        <div class="field">
          <span>试卷类型</span>
          <div class="kindpick">
            <button
              type="button"
              class="kp"
              :class="{ on: form.paperKind === 'paper' }"
              @click="setPaperKind('paper')"
            >
              <b>固定试卷</b>
              <em>全班同一份，一起对答案</em>
            </button>
            <button
              type="button"
              class="kp"
              :class="{ on: form.paperKind === 'bank' }"
              @click="setPaperKind('bank')"
            >
              <b>题库随机卷</b>
              <em>每人从题库里抽题，抽到的不同</em>
            </button>
          </div>
        </div>

        <label class="field">
          <span>{{ form.paperKind === 'bank' ? '题库（JSON）' : '试卷（JSON）' }}</span>
          <!-- 点的时候清空 value：同一个文件重选也能触发 change -->
          <input
            type="file"
            accept=".json,application/json"
            class="input file"
            @click="(e) => (e.target.value = '')"
            @change="pickPaper"
          />
        </label>
        <p v-if="paperReadErr" class="mini err">{{ paperReadErr }}</p>
        <p v-else-if="form.paper" class="mini picked">
          <b>{{ form.paperName }}</b>
          <span>{{ paperHint }}</span>
        </p>
        <p v-else-if="form.paperKind === 'bank'" class="dim mini">
          还没有题库。文件里每段要有 <code>pick</code>（抽几道）—— 可以先建，之后再导，但没有卷子开不了批。
        </p>
        <p v-else class="dim mini">
          还没有卷子。可以先建，之后再「导入卷子」—— 但没有卷子开不了批。
        </p>

        <label class="field">
          <span>说明（学生端显示）</span>
          <textarea v-model="form.note" class="textarea" rows="3" placeholder="闭卷，交卷后不能再改。"></textarea>
        </label>
      </div>
      <div class="modal-foot">
        <span class="spacer"></span>
        <button class="btn" @click="editing = false">取消</button>
        <button class="btn primary" :disabled="saving" @click="create">保存</button>
      </div>
    </div>
    </div>

    <Toast :text="toast" @close="toast = ''" />
  </PageShell>
</template>

<script setup>
/*
 * 教师端「机试」模块
 *
 * 卷子格式见 server/lib/exam.js 顶部（模板 data/exams/_template.json）：
 *   统一卷 kind=paper / 题库随机卷 kind=bank，四种题型（选择 / 判断 / 填空 / 简答）。
 * 判卷：客观题自动算，主观题在这里给分，点「判分并记账」→ 总分落进计分表 + 出答卷文件。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { api, openDoc } from '../../api'
import Toast from '../../components/Toast.vue'
import { clock, when } from '../../utils/time'
/* 状态是算出来的 —— 和课堂作业页共用**教师口径**那份，避免两个页面各写一套又分叉。
 * 注意别引 assignmentState 里的 stateOf / collectingOf：那是学生口径（按人算），
 * 教师端会显示成「还没轮到你」这类对学生说的话。 */
import { assertTeacherState, teacherCollectingOf, teacherStateOf } from '../../utils/assignmentState'
import { loadScheme, scheme } from '../../utils/scheme'
import PageHead from '../../components/PageHead.vue'
import DirIO from '../../components/DirIO.vue'
import DataTable from '../../components/DataTable.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'

const props = defineProps({ itemKey: { type: String, default: 'exam' } })

const moduleTitle = computed(() => {
  const it = scheme.items.find((i) => i.key === props.itemKey)
  return it ? it.name : '机试'
})

const list = ref([])
const curId = ref('')
const d = ref(null)
const err = ref('')
const toast = ref('')

/* 学生答卷表 */
const rowCols = [
  { key: 'no', label: '#', num: true, width: '42px' },
  /*
   * 去掉「学号」列：姓名 + 班级已经够定位，一个班内不会重名。
   * 学号放 name 那格的 title 里，要核对身份时鼠标一停就有。
   */
  { key: 'name', label: '姓名' },
  { key: 'startedAt', label: '开考', value: (r) => (r.startedAt ? clock(r.startedAt) : '—') },
  { key: 'answered', label: '作答' },
  { key: 'autoScore', label: '客观', num: true },
  { key: 'manualScore', label: '主观', num: true },
  { key: 'total', label: '总分', num: true },
  /* 「总分」是卷面分（80/100），「计入」是折算后进计分表的分数 —— 一眼看出区别 */
  { key: 'score', label: '计入', num: true, width: '64px' },
  /* 三个按钮（看进度 / 立即交卷 / 重考）—— 132px 装不下，会挤成两行 */
  { key: 'actions', label: '', width: '214px' },
]
const loading = ref(false)
const saving = ref(false)
const fileInput = ref(null)
let timer = null

const viewing = ref(null)
const detail = reactive({ loading: false, paper: null, answers: {}, graded: null })
const manual = reactive({})
const comment = ref('')

const editing = ref(false)
/**
 * 新建表单。
 *
 * paperKind 是**老师选的类型**（固定试卷 / 题库随机卷），
 * paper 是**解析后的卷子 JSON**。
 *
 * 为什么要有 paperKind，而不是靠文件内容自动识别：
 *   这两样东西在老师脑子里是两件事 ——「我就出这一份」和「我出一批让人抽」。
 *   只给一个「上传JSON」的框、靠 kind 字段猜，老师没法确认自己传对了没有；
 *   而且他手上可能同时有两种文件，选错了要等到学生抽题才发现。
 *   先让他选「这是哪种」，再用文件里的 kind 对一下，对不上就直接说。
 */
const form = reactive({ title: '', note: '', paperKind: 'paper', paper: null, paperName: '' })
/** 选文件时的解析错误（格式不对 / 读不出来） */
const paperReadErr = ref('')

/** 选的是哪一种（文案用） */
const kindName = (k) => (k === 'bank' ? '题库随机卷' : '固定试卷')

/** 卷子摘要（给弹窗里那行提示用） */
const paperHint = computed(() => {
  const p = form.paper
  if (!p) return ''
  const isBank = p.kind === 'bank'
  const parts = []
  if (p.duration) parts.push('限时 ' + p.duration + ' 分钟')

  /*
   * 卷面分：
   *   固定卷  → 用 JSON 里写的（老师可能故意出 80 分小卷）
   *   题库卷  → **自己按 pick 算**。JSON 里通常不写（写了也不算数，
   *             后端 normalize 会按 pick 重算），所以不能照抄 p.fullScore。
   */
  const secs = p.sections || []
  const computed = secs.reduce((sum, sec) => {
    const n = isBank ? (sec.pick || (sec.questions || []).length) : (sec.questions || []).length
    return sum + n * (Number(sec.score) || 0)
  }, 0)
  const full = isBank ? computed : Number(p.fullScore) || computed
  if (full) parts.push('卷面 ' + full + ' 分')

  const pool = secs.reduce((s, sec) => s + ((sec.questions || []).length), 0)
  if (isBank) {
    const willPick = secs.reduce((s, sec) => s + (sec.pick || (sec.questions || []).length), 0)
    parts.push('题库 ' + pool + ' 题 · 每人抽 ' + willPick + ' 题')
  } else if (pool) {
    parts.push(pool + ' 题')
  }
  return parts.join(' · ')
})

/**
 * 选文件：就地读成 JSON 放进 form.paper，并且**核对类型和上面选的一致**。
 *
 * 不一致不直接拒 —— 只是把 selection 纠正到文件实际的类型，并提示一句。
 * 因为老师很可能只是忘了点上面那一栏，文件本身是对的；
 * 让他再选一遍文件比再点一下类型按钮更烦。
 */
async function pickPaper(e) {
  const file = e.target.files && e.target.files[0]
  paperReadErr.value = ''
  form.paper = null
  form.paperName = ''
  if (!file) return
  try {
    const text = await file.text()
    const json = JSON.parse(text)
    const src = json.source && typeof json.source === 'object' ? json.source : json
    if (!src || !Array.isArray(src.sections) || !src.sections.length) {
      throw new Error('里面没有 sections（卷子至少要有一段题）')
    }
    const realKind = src.kind === 'bank' ? 'bank' : 'paper'
    form.paper = src
    form.paperName = file.name
    /* 标题没填就用卷子的标题，省一次输入 */
    if (!form.title.trim() && src.title) form.title = String(src.title).slice(0, 60)

    if (realKind !== form.paperKind) {
      /* 以文件为准：它里面写着 kind，那才是真的 */
      form.paperKind = realKind
      paperReadErr.value =
        '这个文件是「' + kindName(realKind) + '」，已经按它改了上面的类型（原来选的是「' + kindName(realKind === 'bank' ? 'paper' : 'bank') + '」）。'
    }
  } catch (err) {
    paperReadErr.value = '这个文件不是有效的试卷 JSON：' + err.message
  }
}

/** 换类型时把已选的文件清掉 —— 免得「选了固定卷、传的是题库」这种错配残留 */
function setPaperKind(k) {
  if (form.paperKind === k) return
  form.paperKind = k
  form.paper = null
  form.paperName = ''
  paperReadErr.value = ''
}

const subjective = computed(() => {
  if (!detail.paper) return []
  const out = []
  for (const s of detail.paper.sections) if (s.type === 'short') for (const q of s.questions) out.push(q)
  return out
})

const totalPreview = computed(() => {
  const auto = detail.graded ? Number(detail.graded.autoScore) || 0 : 0
  let manualSum = 0
  for (const q of subjective.value) manualSum += Number(manual[q.id]) || 0
  return Math.round((auto + manualSum) * 10) / 10
})

/*
 * 时钟 tick：让「到点自动结束」不依赖数据新鲜度。
 * Vue 追踪不到 Date.now()，必须有个 ref 在推，依赖它的地方才会重算。
 */
const nowTick = ref(Date.now())

/** 这场考试还收不收 —— 包一层只是把 nowTick 带上（教师口径，整场视角） */
function collectingOf(x) {
  return teacherCollectingOf(x, nowTick.value)
}

/**
 * 页头副标题：现在什么情况。
 *
 * 例：`3 场机试 · 1 场在放人 · 选中这场 12 人开考 · 已交 9`
 *
 * 老师打开这一页想知道的是「有没有人在考、还差几份没交」，
 * 而不是「导入 → 开始 → 作答」这个流程怎么走。
 */
/**
 * 分批进度：开了几批、还有几人没排过。
 * 比「勾几个人 → 开始这一批」那句说明有用得多。
 */
const batchSummary = computed(() => {
  const bs = (d.value && d.value.batches) || []
  const rosterArr = (d.value && d.value.roster) || []
  const total = rosterArr.length
  if (!total) return ''
  const done = rosterArr.filter((s) => s.submitted).length
  const left = unbatchedLeft.value
  const parts = []
  parts.push(bs.length ? '已开 ' + bs.length + ' 批' : '还没开过批')
  if (done) parts.push('已交 ' + done)
  if (left) parts.push('还有 ' + left + ' 人没排')
  else parts.push('全都排过了')
  return parts.join(' · ')
})

/** 卷面总题数（题库卷按抽题数算，不是题池大小） */
const paperQuestionCount = computed(() => {
  const p = d.value && d.value.paper
  if (!p || !p.sections) return 0
  return p.sections.reduce((n, s) => n + (s.pick || s.count || (s.questions || []).length), 0)
})

/** 分段详情（鼠标停在卷面摘要上才看到） */
const paperDetail = computed(() => {
  const p = d.value && d.value.paper
  if (!p || !p.sections) return ''
  return p.sections.map((s) => s.title + ' ' + (s.pick || s.count) + ' 题 × ' + s.score + ' 分').join('\n')
})

const pageSub = computed(() => {
  const n = list.value.length
  if (!n) return '还没有机试，点右上角「＋ 新建机试」'
  const live = list.value.filter((a) => Number(a.openBatches) > 0).length
  const parts = [n + ' 场机试']
  if (live) parts.push(live + ' 场在放人')
  const rows = (d.value && d.value.rows) || []
  if (rows.length) {
    const done = rows.filter((r) => r.submittedAt).length
    parts.push('选中这场 ' + rows.length + ' 人开考 · 已交 ' + done)
  }
  return parts.join(' · ')
})

/**
 * 教师端看到的状态：分批进行中 / 考试中 / 已截止 / 已结束 / 未开始。
 *
 * 判据全在 utils/assignmentState 的 teacherStateOf 里（和课堂作业页同一份），
 * 这里只补一个「机试」的用词。它不会返回「还没轮到你」这类第二人称的话 ——
 * 那是学生口径 stateOf 的产物，教师页面用错就会显示成对学生说的话。
 */
function stateOf(x) {
  return assertTeacherState(teacherStateOf(x, nowTick.value, '考试中'), 'ExamModule')
}

/** 胶囊上的小灯：有批在放人就亮 */
function ledOf(x) {
  if (!x) return ''
  if (Number(x.openBatches) > 0) return 'on'
  if (teacherCollectingOf(x, nowTick.value)) return 'on'
  return x.started ? 'off' : ''
}

/** 这场现在「活着」吗（有批在放人，或整场开着）—— 默认选中用 */
function liveOf(x) {
  if (!x) return false
  return Number(x.openBatches) > 0 || teacherCollectingOf(x, nowTick.value)
}

onMounted(async () => {
  await loadAll()
  timer = setInterval(() => {
    /* 先推时钟（纯本地、不发请求），所以放在 hidden 判断之前 ——
       后台标签页切回来那一刻状态也是对的 */
    nowTick.value = Date.now()
    if (document.hidden) return
    /* 列表也要刷：胶囊和小灯读的是它，到期得自己翻过去 */
    loadList()
    if (curId.value && !viewing.value) loadDetail(true)
  }, 8000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

/** 只刷列表（不重拉方案），轮询用 */
async function loadList() {
  try {
    const res = await api.get('/api/assignments?itemKey=' + encodeURIComponent(props.itemKey))
    list.value = res.items || []
  } catch (e) {
    /* 轮询失败下一轮再试 */
  }
}

async function loadAll() {
  loading.value = true
  err.value = ''
  try {
    await loadScheme()
    const res = await api.get('/api/assignments?itemKey=' + encodeURIComponent(props.itemKey))
    list.value = res.items || []
    if (!curId.value) {
      /* 默认选中「还在收」的那场（到期的不算 —— 那场已经开不了考了） */
      const openOne = list.value.filter((a) => liveOf(a))
      curId.value = (openOne.length ? openOne[openOne.length - 1] : list.value[list.value.length - 1] || {}).id || ''
    }
    if (curId.value) await loadDetail()
    else d.value = null
  } catch (e) {
    err.value = e.message
  } finally {
    loading.value = false
  }
}

async function loadDetail(quiet) {
  if (!curId.value) return
  try {
    d.value = await api.get('/api/exams/' + encodeURIComponent(curId.value))
  } catch (e) {
    if (!quiet) err.value = e.message
  }
}

/** 打开排好版的卷子（HTML，A4 打印版）：answers=true 是答案卷 */
function openPaper(answers) {
  if (!curId.value) return
  openDoc('/api/exams/' + encodeURIComponent(curId.value) + '/paper-file/html' + (answers ? '?answers=1' : ''))
}

/** 打开某个学生的答卷（判完才有） */
function openSheet(submissionId) {
  if (!curId.value) return
  openDoc(
    '/api/exams/' + encodeURIComponent(curId.value) + '/submissions/' + encodeURIComponent(submissionId) + '/paper-file/html'
  )
}

function select(id) {
  if (curId.value === id) return
  curId.value = id
  d.value = null
  loadDetail()
}

function openEditor() {
  form.title = moduleTitle.value
  form.note = ''
  form.paperKind = 'paper'
  form.paper = null
  form.paperName = ''
  paperReadErr.value = ''
  editing.value = true
}

async function create() {
  /*
   * 走之前再对一次类型。
   * 正常流程下 pickPaper 已经纠正过了，但老师可能是「先传文件、再点类型」——
   * 那一下 setPaperKind 会把文件清掉，这里兜底说清楚为什么保存不了。
   */
  if (form.paper && form.paper.kind !== form.paperKind) {
    form.paper = null
    form.paperName = ''
    paperReadErr.value = '类型和文件对不上，请重新选一次' + kindName(form.paperKind) + '的文件'
    return
  }
  saving.value = true
  try {
    const res = await api.post('/api/assignments', {
      itemKey: props.itemKey,
      title: form.title,
      note: form.note,
      /* 有卷子就一起交；没有就建个空的，之后再导 */
      paper: form.paper || undefined,
    })
    curId.value = res.assignment.id
    editing.value = false
    await loadAll()
    /*
     * 卷子没被收下时（格式过不了后端校验）作业已经建好了 ——
     * 说清楚「建好了，但卷子没收下 + 原因」，老师重导一次就行，不用重建。
     */
    if (res.paperError) {
      toast.value = '考试建好了，但卷子没收下：' + res.paperError
    } else if (res.paper) {
      toast.value =
        '已建好并装上卷子（' +
        (res.paper.kind === 'bank' ? '题库卷，每人随机抽题' : '固定卷，全班同一份') +
        '）。勾几个人就能开始第一批'
    } else {
      toast.value = '建好了，接着导入试卷 / 题库'
    }
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}

async function onFile(e) {
  const file = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!file) return
  try {
    const text = await file.text()
    const source = JSON.parse(text)
    const res = await api.post('/api/exams/' + encodeURIComponent(curId.value) + '/paper', { source })
    await loadDetail()
    toast.value = '导入成功：' + res.summary.title + '（' + res.summary.fullScore + ' 分' + (res.warnings && res.warnings.length ? '，有提示见控制台' : '') + '）'
    if (res.warnings && res.warnings.length) console.warn('[exam] 导入提示：', res.warnings)
  } catch (e2) {
    toast.value = '导入失败：' + (e2 && e2.message ? e2.message : e2)
  }
}

/**
 * 改这场考试的时长。
 *
 * 用 prompt 而不是弹窗表单：这是低频、单字段的操作，
 * 为它做一个弹窗反而多两次点击。改完立刻广播，正在考的学生倒计时会当场变。
 */
async function changeDuration() {
  if (!d.value || !d.value.paper) return
  const cur = d.value.paper.duration || 45
  const input = window.prompt('这场考试限时多少分钟？', String(cur))
  if (input === null) return
  const mins = Math.floor(Number(input))
  if (!(mins > 0)) {
    toast.value = '要填大于 0 的分钟数'
    return
  }
  try {
    const res = await api.patch('/api/exams/' + encodeURIComponent(curId.value) + '/duration', { minutes: mins })
    toast.value =
      '已改成 ' + mins + ' 分钟' +
      (res.inProgress ? '（' + res.inProgress + ' 个正在考的人立刻生效）' : '')
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  }
}

/**
 * 让单个学生重考 —— 把他从批次里剔回去。
 *
 * 清掉：这次交的答卷（答案 + 那份 md）、记在计分表里的分，
 * 并**把他从所有批次移除**。于是他回到「还没排过批」，
 * 老师下一批勾人时他就在「剩下的 N 人」里（题库卷会抽另一套）。
 *
 * 这里不做「单独给他开门」：
 * 放人只有批次一条通道，补考就是「开一批只放他」。
 * 多一套后门就多一套状态要维护 —— 那正是之前状态乱成一团的来源。
 */
async function resetOne(row) {
  /* 答卷 id 在 row.id —— 后端 submissionView 给的就是 id，没有 submissionId 这个字段 */
  if (!row || !row.id) return
  const who = row.name || row.sid
  const ok = window.confirm(
    '把 ' + who + ' 退回重考？\n\n' +
      '· 这次交的答卷和记的分会被清掉，找不回来\n' +
      '· 他会从当前批次里移除，回到「还没排过批」\n' +
      '· 下一批勾人时他就在「剩下的」名单里（题库卷会抽另一套题）'
  )
  if (!ok) return
  try {
    const res = await api.post(
      '/api/exams/' + encodeURIComponent(curId.value) + '/submissions/' + encodeURIComponent(row.id) + '/reset'
    )
    toast.value = res.message || who + ' 已退回'
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  }
}

/**
 * 强制收某个人的卷（立即交卷）。
 *
 * 和 resetOne 的区别要在确认框里说清楚 —— 两个按钮挨着，
 * 一个「收卷、分数算数」，一个「清空重来」，点错后果完全不同。
 */
async function forceSubmit(row) {
  if (!row || !row.id) return
  const who = row.name || row.sid
  const ok = window.confirm(
    '立即收 ' + who + ' 的卷？\n\n' +
      '· 他**现在答的**会被收上来，客观题立刻判分，分数算数\n' +
      '· 收完他就不能再改了（页面会自己变成「已交卷」）\n' +
      '· 这**不是**重考：要清空重来请点「重考」'
  )
  if (!ok) return
  try {
    const res = await api.post(
      '/api/exams/' + encodeURIComponent(curId.value) + '/submissions/' + encodeURIComponent(row.id) + '/force-submit'
    )
    toast.value = res.message || who + ' 的卷子已收'
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  }
}

/* ---------------- 分批开考 ---------------- */

/** 这一批勾了谁 / 限时几分钟 / 防连点 */
const picked = ref([])
const batchMin = ref('')
const busy = ref(false)
/** 名单展开状态。默认收起 —— 117 个名字铺开占 190px */
const showPickers = ref(false)

function togglePick(sid) {
  const i = picked.value.indexOf(sid)
  picked.value = i >= 0 ? picked.value.filter((x) => x !== sid) : picked.value.concat([sid])
}

/**
 * 勾上「还没排过批、也没开考」的人 —— 分批最常用的那一手。
 * 口径是「上批剩下的人」：进过批的不再重复勾。
 */
function pickRest() {
  const r = (d.value && d.value.roster) || []
  picked.value = r.filter((s) => !s.submitted && !s.batched).map((s) => s.sid)
}

/**
 * 班级简称：`25级软件技术1班` → `1班`。
 *
 * 全名前缀都一样（同一门课），一排按钮把选人条挤得没有地方放「开始这一批」。
 * 鼠标停上去看得到全名。
 */
function shortClass(n) {
  const m = /(\d+)\s*班/.exec(String(n || ''))
  return m ? m[1] + '班' : String(n || '')
}

/** 按班快速选：只勾这个班里还没排过批的人 */
function pickClass(classId) {
  const r = (d.value && d.value.roster) || []
  picked.value = r.filter((s) => s.classId === classId && !s.submitted && !s.batched).map((s) => s.sid)
}

/** 每个班还剩多少人没排过 */
const classGroups = computed(() => {
  const r = (d.value && d.value.roster) || []
  const m = new Map()
  for (const s of r) {
    if (!m.has(s.classId)) m.set(s.classId, { id: s.classId, name: s.className || '未分班', total: 0, left: 0 })
    const g = m.get(s.classId)
    g.total++
    if (!s.submitted && !s.batched) g.left++
  }
  return Array.from(m.values())
})

const unbatchedLeft = computed(() => {
  const r = (d.value && d.value.roster) || []
  return r.filter((s) => !s.submitted && !s.batched).length
})

/** 有几个批次正在放人（没过时间的才算） */
const openBatchCount = computed(() => {
  const bs = (d.value && d.value.batches) || []
  return bs.filter((b) => b.status === 'open' && !b.overDue).length
})

/** 一键结束所有还在放的批次（替代原来的「结束」） */
async function stopAllBatches() {
  const n = openBatchCount.value
  if (!n) return
  if (!window.confirm('结束全部 ' + n + ' 个批次？\n\n这些批次里的人都不能再作答了（已交的照样留着）。')) return
  try {
    const res = await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/batches/stop-all')
    toast.value = res.message || '已全部结束'
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  }
}

function pickAll() {
  picked.value = ((d.value && d.value.roster) || []).map((s) => s.sid)
}

/** 开始这一批：只放这几个人进来，整场状态不动 */
async function startBatch() {
  if (!picked.value.length || busy.value) return
  const n = picked.value.length
  const mins = Math.max(0, Math.floor(Number(batchMin.value) || 0))
  if (
    !window.confirm(
      '开始新的一批？\n\n这一批 ' + n + ' 个人可以开考，其他人还是进不来。\n' +
        (mins > 0 ? '每人限时 ' + mins + ' 分钟（从他自己点「开考」那刻算）。\n' : '') +
        '做完之后点「结束这批」，再放下一批。'
    )
  )
    return
  busy.value = true
  try {
    const res = await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/start', {
      sids: picked.value.slice(),
      minutes: mins,
    })
    toast.value = (res.message || n + ' 人已放行') + '。已勾上剩下没排的人'
    await loadAll()
    /* 开完一批，下一批默认就是「上批剩下的人」 */
    pickRest()
    /* 名单收起来：接下来要看的是进度 */
    showPickers.value = false
  } catch (e) {
    toast.value = e.message
  } finally {
    busy.value = false
  }
}

async function stopBatch(b) {
  if (!b) return
  if (!window.confirm('结束第 ' + b.seq + ' 批？\n\n这批 ' + b.count + ' 人就不能再作答了（已交的照样留着）。\n整场不受影响，你可以接着放下一批。')) return
  try {
    const res = await api.post(
      '/api/assignments/' + encodeURIComponent(curId.value) + '/batches/' + encodeURIComponent(b.id) + '/stop'
    )
    toast.value = res.message || '第 ' + b.seq + ' 批已结束'
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  }
}

/*
 * 这里原来有 unpass()（取消某人的补考放行）。
 * 放行机制已经去掉，函数一并删掉 —— 留着会让人以为还有这么个入口。
 */

async function start() {
  if (!d.value) return
  const a = d.value.assignment
  /*
   * 截止时间已经过了、而且不收迟交 —— 光点开始没用：
   * status 本来就是 open，collecting 仍然算 false，学生还是开不了考。
   * 与其让他点完看不出变化，不如直接说清楚要先改时间。
   */
  if (stateOf(a).key === 'overdue') {
    toast.value = '截止时间已经过了，先把这场机试的截止时间往后调，再开始'
    return
  }
  if (!window.confirm('开始考试？学生端立刻能开考并开始计时。')) return
  try {
    const res = await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/start')
    toast.value = res.delivered ? '已开始，' + res.delivered + ' 个学生端已收到' : '已开始'
    await loadAll()
  } catch (e) {
    toast.value = e.message
  }
}

async function stop() {
  if (!d.value) return
  if (!window.confirm('结束这场机试？结束后学生不能再作答（已交的照样能判）。')) return
  try {
    await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/stop')
    toast.value = '已结束'
    await loadAll()
  } catch (e) {
    toast.value = e.message
  }
}

async function remove() {
  if (!d.value) return
  if (!window.confirm('删除这场机试？连同学生答卷一起删。')) return
  try {
    await api.del('/api/assignments/' + encodeURIComponent(curId.value))
    curId.value = ''
    d.value = null
    await loadAll()
    toast.value = '已删除'
  } catch (e) {
    toast.value = e.message
  }
}

async function open(r) {
  viewing.value = r
  detail.loading = true
  detail.paper = null
  for (const k of Object.keys(manual)) delete manual[k]
  comment.value = r.comment || ''
  try {
    /* 答卷 id 在 r.id —— 后端 submissionView 给的就是 id，没有 submissionId 这个字段 */
    const res = await api.get(
      '/api/exams/' + encodeURIComponent(curId.value) + '/submissions/' + encodeURIComponent(r.id)
    )
    /*
     * 接口返回的是 { submission, state: { answers, startedAt, submittedAt, graded }, paper }。
     * 原来读 res.answers / res.graded 直接是 undefined ——
     * 一个答了 20/22、自动判 80 分的学生，判分面板显示「这个学生还没开始作答」。
     */
    const st = res.state || {}
    detail.paper = res.paper
    detail.answers = st.answers || {}
    detail.graded = st.graded || null
    if (st.graded && st.graded.items) {
      for (const it of st.graded.items) if (it.type === 'short') manual[it.qid] = it.got
    }
  } catch (e) {
    toast.value = e.message
  } finally {
    detail.loading = false
  }
}

function markOf(q, type) {
  if (type === 'short') return ''
  return ''
}

async function saveGrade() {
  if (!viewing.value) return
  saving.value = true
  try {
    const res = await api.post(
      '/api/exams/' + encodeURIComponent(curId.value) + '/submissions/' + encodeURIComponent(viewing.value.submissionId) + '/grade',
      { scores: Object.assign({}, manual), comment: comment.value }
    )
    detail.graded = res.graded
    toast.value = '已判分：' + res.graded.total + ' / ' + res.fullScore + '，已记进计分表'
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>

/* 试卷类型二选一：两张小卡，选中的描蓝边 */
.kindpick {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-2);
}
.kindpick .kp {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px var(--sp-3);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--card);
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.kindpick .kp b {
  font-size: var(--fs-md);
  font-weight: 600;
  color: #1f2937;
}
.kindpick .kp em {
  font-style: normal;
  font-size: var(--fs-xs);
  color: #8b95a1;
  line-height: 1.4;
}
.kindpick .kp:hover { border-color: #b9c6d3; }
.kindpick .kp.on {
  border-color: var(--brand);
  background: #eef4f9;
  box-shadow: inset 0 0 0 1px rgba(44, 95, 132, 0.2);
}
.kindpick .kp.on b { color: var(--brand); }
.kindpick .kp.on em { color: #4a6b85; }

/* 选了卷子之后那行摘要：文件名 + 类型/分值/题量 */
.modal .picked {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  background: #eef7ef;
  font-size: var(--fs-sm);
  color: #2f6b3a;
}
.modal .picked b { font-weight: 600; }
.modal .picked span { color: #4a7a55; }
/* 文件选择框：不用 .input 那套边框（它会和原生按钮打架） */
.modal .input.file {
  height: auto;
  padding: 6px var(--sp-2);
  font-size: var(--fs-sm);
  background: var(--bg-sub);
}
.modal .mini.err { color: var(--err); margin: 0; }

/* 操作列里几个按钮挨着时给点间隙（不然「判分」「重考」挤成一坨） */
.grid tbody td .btn + .btn {
  margin-left: 6px;
}

/* 「正在放 N 个批次 + 全部结束」那条 */
.ball {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px var(--sp-3);
  margin-bottom: var(--sp-2);
  border-radius: var(--r-sm);
  background: #fdf6ec;
  border: 1px solid #f0dcc0;
}

/* ---------------- 分批开考（和课堂作业那份是同一套形状） ---------------- */

.blist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--sp-3);
}
.brow {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px var(--sp-2) 6px var(--sp-3);
  border-left: 2px solid transparent;
  border-radius: var(--r-sm);
  background: var(--bg-sub);
  font-size: var(--fs-md);
}
.brow.live {
  border-left-color: var(--brand);
  background: #eef4f9;
}
.brow.timeup {
  border-left-color: #d08a2e;
  background: #fdf6ec;
}
.brow .bseq {
  font-weight: 600;
  color: #1f2937;
}
.brow .bstat {
  font-size: var(--fs-sm);
  color: #8b95a1;
}
.brow.live .bstat {
  color: var(--brand);
}
.brow .bleft {
  font-size: var(--fs-sm);
  color: #a15c00;
  font-variant-numeric: tabular-nums;
}
.brow .bleft.over {
  color: var(--err);
  font-weight: 600;
}

/* 「▸ 选人（117 人）」开关 */
.toggle-pickers {
  margin-bottom: var(--sp-2);
  color: #5b6673;
}

.pickbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--line-soft);
  margin-bottom: var(--sp-2);
}
.minbox {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-sm);
  color: #5b6673;
}
.minbox input {
  width: 58px;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  font: inherit;
  text-align: center;
}

.pickers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 190px;
  overflow: auto;
}
.pk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px 3px 6px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  background: #fff;
  font-size: var(--fs-sm);
  color: #3c4650;
  cursor: pointer;
  user-select: none;
}
.pk:hover {
  border-color: #b9c6d3;
}
.pk.on {
  background: #e8f1f8;
  border-color: var(--brand);
  font-weight: 600;
}
.pk.done {
  opacity: 0.5;
}
.pk input {
  margin: 0;
  accent-color: var(--brand);
}
.pk em {
  font-style: normal;
  font-size: 10.5px;
  color: #8b95a1;
}
.pk em.bq {
  color: #7b8794;
}

/* 按班选：按钮上带一个数字（还剩几人） */
.clgroup {
  display: inline-flex;
  gap: 4px;
  padding-left: var(--sp-2);
  border-left: 1px solid var(--line-soft);
}
.clbtn em {
  font-style: normal;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 999px;
  background: #eef4f9;
  color: var(--brand);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.clbtn em.done {
  background: #eef7ef;
  color: var(--ok);
}


.hwbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.hwpill {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}

.led {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #cbd5e1;
}

.led.on {
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.16);
}

.led.off {
  background: #94a3b8;
}

.ctrl {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 12px var(--sp-3);
  margin-bottom: 12px;
}

.ctrl-l h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 15.5px;
}

.ctrl-r {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.scorebar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
  padding: 8px 0 12px;
  border-bottom: 1px solid var(--line-soft);
}

.scorebar b {
  font-size: var(--fs-lg);
  font-variant-numeric: tabular-nums;
}

.scorebar .total {
  color: var(--ok);
  font-size: 18px;
}

.sec {
  margin: var(--sp-3);
}

.sec h4 {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-md);
  color: #374151;
}

.q {
  padding: 8px 0;
  border-top: 1px solid var(--line-soft);
}

.q:first-of-type {
  border-top: none;
}

.stem {
  margin: 0 0 4px;
  font-size: var(--fs-md);
  line-height: 1.7;
}

.opts {
  margin: 0 0 4px;
  padding: var(--sp-4);
  font-size: var(--fs-sm);
  color: #475569;
}

.ans {
  margin: 2px 0 0;
  font-size: var(--fs-sm);
}

.spacer {
  flex: 1;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
