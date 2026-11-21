<template>
  <div class="aw">
    <!--
      能交就直接进工作台（和 Playground 一模一样，只是右上多一个「提交」）。
      v-if 用 canStillSubmit 而不是 status === 'open'：
      分批模式下整场是 closed、只有批次在放人，用户在某一批里就该进来。
    -->
    <PgWorkbench
      v-if="a && canStillSubmit"
      ref="wb"
      :key="'hw-' + a.id"
      :title="a.title"
      :source="a.dir ? 'example' : 'assignment'"
      :assignment-id="a.id"
      :fixed-dir="a.dir"
      :bucket="'hw-' + a.id"
    >
      <!--
        状态放在页头副标题里，不再单独占一条横幅。

        原来的横幅要 54px（margin 8 + padding 16 + 一行字 + 边框），
        而它说的正是「现在什么情况」—— 页头副标题本来就是干这个的。
        挪上来之后正文多出 54px，编辑器和预览都能长高一点。

        「进行中 / 已截止」用标签，是因为它需要颜色：一眼扫到绿还是灰，
        比读一个词快。后面的「已交 · 等老师批 · 截止 …」是补充，走灰字。
      -->
      <template #sub>
        <span class="tag" :class="canStillSubmit ? 'ok' : 'mute'">
          {{ canStillSubmit ? '进行中' : '已截止' }}
        </span>
        <span v-if="subText" class="sub-rest">{{ subText }}</span>
      </template>

      <template #actions="{ files, allFiles }">
        <router-link class="btn mini" to="/student/assignments">← 列表</router-link>
        <!-- 像做题一样：随时可以退回老师给的初始代码，但不影响已提交的那份和分数 -->
        <button
          v-if="!a.dir"
          class="btn mini"
          :title="'把编辑器恢复成老师给的初始代码（不会删除你已经提交的那份）'"
          @click="resetToStarter"
        >
          恢复最初状态
        </button>
        <!--
          文案只留「重新提交」。原来写「重新提交（覆盖上一次）」，
          括号那半句把页头这一排挤得很紧（右边还有运行/还原/自动运行/排版/代码…）。
          「会覆盖」写进 title，鼠标停一下能看，不占宽度。
        -->
        <button
          class="btn mini primary"
          :disabled="busy || !canStillSubmit"
          :title="
            !canStillSubmit
              ? '这次作业已经不再接收提交了'
              : mine.length
                ? '再交一次会覆盖上一次的提交（只保留最新）'
                : '整份交上去，老师能直接跑起来看效果'
          "
          @click="submit(files, allFiles)"
        >
          {{ busy ? '提交中…' : !canStillSubmit ? '已停止接收' : mine.length ? '重新提交' : '提交' }}
        </button>
      </template>
    </PgWorkbench>

    <!-- 没开始 / 已结束：不给编辑器，只交代状态 + 我交过什么 -->
    <template v-else-if="a">
      <PageHead>
        <template #title>{{ a.title }}</template>
        <template #sub>{{ a.note || '这次作业有自己的起手代码' }}<template v-if="dueText"> · 截止 {{ dueText }}</template></template>
        <template #right>
          <span class="tag" :class="a.myBatch || a.started ? 'mute' : 'warn'">
            {{ a.myBatch && a.myBatch.overDue ? '时间到' : a.myBatch ? '这一批结束' : a.started ? '已结束' : '未开始' }}
          </span>
          <router-link class="btn mini" to="/student/assignments">← 列表</router-link>
        </template>
      </PageHead>

      <div class="content">
        <div class="card lock">
          <!--
            进不来有四种原因，分开说。
            原来只有「已结束 / 还没开始」两种，分批模式下会说错 ——
            老师明明已经开始了，只是还没轮到这个人。
          -->
          <h3>{{ lockTitle }}</h3>
          <p class="dim">
            <template v-if="a.myBatch && a.myBatch.overDue">
              这一批的限时到了，不能再提交。老师会在下一批/补考时安排你，或者直接找老师说明情况。
            </template>
            <template v-else-if="a.myBatch">这一批已经收了。等老师放下一批，或者找老师安排补交。</template>
            <template v-else-if="a.started">
              结束于 {{ when(a.closedAt) }}。交上去的作业还在，下面可以翻回自己写过的代码；
              老师批完之后这里会显示分数。
            </template>
            <template v-else-if="Number(a.openBatches) > 0">
              老师在分批放人，还没轮到你。轮到你这一批时这里会出现编辑器和提交按钮（不用刷新）。
            </template>
            <template v-else>
              老师还没放开。等老师点「开始」，这里就会出现编辑器和提交按钮。
            </template>
          </p>
        </div>

        <div v-if="mine.length" class="card">
          <CardHead>
            <template #title>我的提交（{{ mine.length }} 次）</template>
            <div class="right dim mini">点一行看当时交上去的代码</div>
          </CardHead>
          <DataTable
            :columns="mineCols"
            :rows="mine.slice().reverse()"
            row-key="id"
            clickable
            :row-class="(row) => ({ pick: picked && picked.id === row.id })"
            :empty="'还没交过'"
            @row-click="peek"
          >
            <template #cell-no="{ index }">{{ mine.length - index }}</template>
            <template #cell-when="{ row }">{{ when(row.createdAt) }}</template>
            <template #cell-files="{ row }">{{ row.changedCount }} / {{ row.fileCount }}</template>
            <template #cell-score="{ row }">
              <span :class="{ ok: row.graded }">{{ !row.graded ? '—' : row.score }}</span>
            </template>
            <template #cell-comment="{ row }">{{ row.comment || '—' }}</template>
          </DataTable>

          <div v-if="picked" class="peek">
            <div class="peekhead">
              <b>第 {{ mine.length - mine.slice().reverse().findIndex((x) => x.id === picked.id) }} 次提交</b>
              <span class="dim mini">{{ when(picked.createdAt) }} · {{ picked.fileCount }} 个文件</span>
              <span class="spacer"></span>
              <button class="btn mini" @click="picked = null">收起</button>
            </div>
            <div v-if="loadingFiles" class="empty">正在读取…</div>
            <CodeViewer v-else :files="files" :marked="picked.changed" :font-size="12.5" />
          </div>
        </div>
      </div>
    </template>

    <div v-else-if="err" class="content">
      <p class="hint err">{{ err }}</p>
    </div>
    <div v-else class="content">
      <div class="card empty">正在读取作业…</div>
    </div>

    <Toast :text="toast" @close="toast = ''" />
  </div>
</template>

<script setup>
/*
 * 学生端「做这次课堂作业」
 *
 * 编辑器本体用的是和 Playground 同一个组件（components/PgWorkbench.vue），
 * 这里只多三件事：锁死目录、按作业分桶存改动、把「改过的文件」POST 给老师。
 *
 * 提交只带改过的文件，不带整包：老师看到的就是「你动了哪几个文件、动成了什么样」，
 * 没动过的文件他那边用原始示例补齐上下文，一眼能看出改动范围。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../../api'
import PgWorkbench from '../../components/PgWorkbench.vue'
import CodeViewer from '../../components/CodeViewer.vue'
import Toast from '../../components/Toast.vue'
import { when } from '../../utils/time'
import { onPresenceMessage } from '../../utils/presence'
import PageHead from '../../components/PageHead.vue'
import DataTable from '../../components/DataTable.vue'
import CardHead from '../../components/CardHead.vue'

const route = useRoute()
const id = route.params.id

const a = ref(null)
const mine = ref([])
/* 工作台实例：「恢复最初状态」要让它重新拉起手代码 */
const wb = ref(null)

/*
 * 编辑器这次加载的是哪一份：起手代码 / 我上次提交的 / 空。
 * 由工作台的 loaded 事件告知 —— 不要用 mine.length 去猜，
 * 因为点过「恢复最初状态」之后，明明有提交，编辑器里却是起手代码。
 */
/*
 * 这里原来有 editorSource + onLoaded + editorLabel（把 loaded 事件里的 source
 * 翻成「课程示例 / 老师给的初始代码」），只给那条状态横幅用。
 *
 * 横幅挪进页头副标题之后没人读了，一并删掉 ——
 * 「编辑器里是哪一份」由工作台自己的文件头和「恢复最初状态」按钮交代，
 * 编辑区顶部本来就写着当前文件名。
 */
const err = ref('')
const toast = ref('')
const busy = ref(false)
const picked = ref(null)

/* 我的提交表 */
const mineCols = [
  { key: 'no', label: '#', num: true, width: '46px' },
  { key: 'when', label: '提交时间' },
  { key: 'files', label: '改动 / 文件' },
  { key: 'score', label: '分数', num: true },
  { key: 'comment', label: '老师评语', tdClass: 'cmt' },
]
const files = ref([])
const loadingFiles = ref(false)
let off = null

/**
 * 还能不能交 —— 界面口径，和后端那条拦截完全一致：
 *
 *   status 不是 open          → 老师没开始 / 已经停止
 *   过了截止 且 不收迟交       → 时间到了
 *
 * **这只是让按钮先说话**，不是安全边界：学生刷新页面、或者直接调接口都能绕。
 * 真正的拦截在后端 submit 里（status + isLate && !allowLate，且都在动磁盘之前）。
 */
const canStillSubmit = computed(() => {
  const x = a.value || {}
  /*
   * 判据是后端算好的 **collecting**，不是 status。
   *
   * status 只表示「整场开没开」。分批模式下整场是 closed、只有批次在放人，
   * 所以他在某一批里时 status 依然是 closed —— 只看 status 的话，
   * 学生点进来会是「老师还没开始」的锁定页，分批等于白做。
   * collecting = 整场开着 **或** 他在某一批里（后端 gateOf 算的）。
   */
  if (!x.collecting) return false
  if (x.overDue && x.allowLate === false) return false
  return true
})

/** 锁定页的标题：到底为什么不让你交 */
const lockTitle = computed(() => {
  const x = a.value || {}
  if (x.myBatch && x.myBatch.overDue) return '你这一批的时间到了'
  if (x.myBatch) return '你这一批已经结束了'
  /* 老师已经在放别人了，只是没轮到他 —— 说「还没开始」会让他一直等 */
  if (Number(x.openBatches) > 0) return '还没轮到你'
  if (x.started) return '这次课堂作业已经结束了'
  return '老师还没开始这次课堂作业'
})

/**
 * 页头副标题 = 这次作业现在什么情况。
 *
 * 原来这些信息在正文顶上单独占一条横幅（54px：margin 8 + padding 16 + 一行字 + 边框）。
 * 可它说的正是「现在什么状态」—— 而页头副标题本来就是干这个的位置。
 * 挪上来之后正文多出 54px，编辑器和预览都能长高一点。
 *
 * 顺带删掉那句「改完点右上角提交」：提交按钮就在右上方写着「提交」，
 * 一次性的引导放在常驻状态行里，看第二次就是噪音。
 *
 * 四项按老师/学生关心的顺序排：
 *   能不能交 → 交没交/批没批 → 迟没迟 → 什么时候截止
 */
const subText = computed(() => {
  const x = a.value || {}
  const parts = []
  /*
   * ① 「能不能交」不在这一串里 —— 它是个有颜色的标签（见模板 #sub 插槽），
   *    和以前的 .tag 一个意思：绿=进行中、灰=已截止，扫一眼就有。
   * ② 我交没交、老师批没批
   */
  const last = mine.value.length ? mine.value[mine.value.length - 1] : null
  if (!last) parts.push('还没交')
  else if (last.graded) parts.push('已交 · 得分 ' + last.score)
  else parts.push('已交 · 等老师批')
  if (last && last.late) parts.push('迟交')
  /* ③ 截止时间放最后，它是参考不是结论 */
  if (x.dueAt && dueText.value) parts.push('截止 ' + dueText.value)
  return parts.join(' · ')
})

/** 截止那一天的显示（有就提示一句，没有就不提） */
const dueText = computed(() => {
  const x = a.value || {}
  if (!x.dueAt) return ''
  const t = new Date(x.dueAt)
  if (!isFinite(t.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + ' ' + p(t.getHours()) + ':' + p(t.getMinutes())
})

onMounted(async () => {
  await load()
  // 老师中途点「结束」：立刻切到结束态（改动仍在本机，不会丢）
  off = onPresenceMessage((m) => {
    if (m && m.t === 'assignment' && m.id === id) {
      const wasOpen = a.value && a.value.status === 'open'
      load().then(() => {
        if (wasOpen && a.value && a.value.status !== 'open') toast.value = '老师已经结束这次作业，交不上了'
      })
    }
  })

  /*
   * 告诉服务端「我在做作业」。
   *
   * 这是一种**屏幕占用**（优先级 60）：老师翻讲义 / 推代码不该把正在写作业的学生拽走，
   * 但点名(80)、考试(100) 仍然能盖过它。上报失败不影响做作业本身 ——
   * 网络断了也就是老师那边看不到你在写，功能照旧。
   */
  report('homework')
})

onUnmounted(() => {
  if (off) off()
  /* 离开页面：把「在做作业」还回去，否则会一直显示你在写这份 */
  report('idle')
})

let reportTimer = null
function report(kind) {
  const body = { kind }
  if (kind === 'homework') {
    body.assignmentId = String(id || '')
    body.title = (a.value && a.value.title) || ''
  }
  /* 轻量接口，失败无所谓；不 await，别挡页面 */
  api.post('/api/student/activity', body).catch(() => {})
  if (kind === 'homework') {
    /*
     * 每 3 分钟补报一次：服务端的「在做作业」不带过期时间（学生可能写很久），
     * 但如果中途服务重启 / 状态被清，补报能让它回来。
     */
    clearInterval(reportTimer)
    reportTimer = setInterval(() => {
      api.post('/api/student/activity', { kind: 'homework', assignmentId: String(id || '') }).catch(() => {})
    }, 180000)
  } else {
    clearInterval(reportTimer)
  }
}

async function load() {
  err.value = ''
  try {
    const res = await api.get('/api/student/assignments/' + encodeURIComponent(id))
    a.value = res.assignment
    mine.value = res.mine || []
  } catch (e) {
    err.value = e.message
  }
}

/**
 * 「恢复最初状态」：把编辑器退回老师给的起手代码。
 * 具体怎么拉数据、怎么清本地草稿交给工作台（它才知道分桶键）。
 */
function resetToStarter() {
  const ins = wb.value
  if (ins && typeof ins.resetToStarter === 'function') ins.resetToStarter()
}

/**
 * 交作业：files = 整份（老师要跑起来看渲染），changed = 我改过哪几个。
 * 一个都没改就不让交 —— 交一份和示例一模一样的代码没有意义。
 */
async function submit(changed, all) {
  if (!changed || !changed.length) {
    toast.value = '你还没改动任何文件，交上去老师看不到东西'
    return
  }
  const names = changed.map((f) => f.path).join('\n')
  const ok = window.confirm(
    '交这一份给老师？\n\n' +
      '共 ' + all.length + ' 个文件，其中 ' + changed.length + ' 个你改过：\n' + names +
      /*
       * 这里原来写着「重交不会覆盖上一次，老师能看到每一次」—— 与服务端不符：
       * assignments.js 的提交是**覆盖**（旧文件先清掉，只留最新一份，旧的挪进
       * data/.trash）。按旧文案，学生会以为交错了能反悔，实际不能。
       */
      '\n\n整份一起交上去，老师那边能直接跑起来看效果。' +
      '\n注意：重交会覆盖上一次，只保留最新一份。'
  )
  if (!ok) return
  busy.value = true
  try {
    await api.post('/api/student/assignments/' + encodeURIComponent(id) + '/submit', {
      files: all,
      changed: changed.map((f) => f.path),
    })
    await load()
    toast.value = '交上去了，老师那边马上能看到'
  } catch (e) {
    toast.value = e.message
  } finally {
    busy.value = false
  }
}

async function peek(s) {
  if (picked.value && picked.value.id === s.id) {
    picked.value = null
    return
  }
  picked.value = s
  files.value = []
  loadingFiles.value = true
  try {
    const res = await api.get(
      '/api/student/assignments/' + encodeURIComponent(id) + '/submissions/' + encodeURIComponent(s.id)
    )
    files.value = res.files || []
  } catch (e) {
    toast.value = e.message
    picked.value = null
  } finally {
    loadingFiles.value = false
  }
}
</script>

<style scoped>
/*
 * 高度链必须接通，否则工作台整个失效。
 *
 * .aw 是 router-view 的直接子元素（父是 .main 的 flex 列），但它自己不设高度 ——
 * 于是里面的 .pg 写 height: 100% 时「百分比高度没有参照」，退化成 auto，
 * 被代码内容撑到 1669px；而 .pg 又是 overflow: hidden，
 * 结果下半截既看不见也滚不动（代码区滚不了、竖排也够不到下面的渲染块）。
 *
 * 教师端「代码练习」没这个毛病：那里 PgWorkbench 直接当页面根节点，
 * 父级就是 .main，height: 100% 有参照。学生端中间多包了这一层。
 */
.aw {
  /* 工作台的高度是按「视口 - 顶栏」算的，这里多了一条状态栏，把它扣掉 */
  --pg-extra: 48px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/*
 * 这里原来有 .aw > .bar / .bar / .bar.done 三块样式 ——
 * 状态横幅已挪到页头副标题（见 subText），一行 DOM 都不剩，样式跟着删。
 */

/* 副标题里，标签后面那段补充说明（已交 / 等老师批 / 截止 …） */
.sub-rest {
  color: var(--sub);
}

.score {
  color: var(--ok);
  font-size: var(--fs-md);
}

.lock {
  padding: var(--sp-4) var(--sp-4);
}

.lock h3 {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-lg);
}

.lock p {
  margin: 0;
  font-size: var(--fs-md);
  line-height: 1.7;
}

.cmt {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
}

tr.pick {
  background: #eef4ff;
}

.peek {
  margin-top: 12px;
  height: 380px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.peekhead {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-md);
}

.empty {
  padding: var(--sp-4);
  text-align: center;
  color: var(--dim);
  font-size: var(--fs-md);
}
</style>
