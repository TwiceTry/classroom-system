<template>
  <div class="aw">
    <!-- 老师开着：直接进工作台，跟 Playground 一模一样，只是右上多一个「提交」 -->
    <PgWorkbench
      v-if="a && a.status === 'open'"
      :key="'hw-' + a.id"
      :title="a.title"
      :sub="subText"
      :fixed-dir="a.dir"
      :bucket="'hw-' + a.id"
    >
      <template #banner>
        <div class="bar" :class="{ done: mine.length }">
          <span class="tag ok">进行中</span>
          <span v-if="dueText" class="dim">截止 {{ dueText }}<template v-if="a.allowLate === false">（过了就不能交了）</template></span>
          <span v-if="!mine.length">
            还没交。改完代码点右上角 <b>提交</b>（整份交上去，老师能直接跑起来看效果）。
          </span>
          <span v-else>
            已交，最近一次：{{ when(mine[mine.length - 1].createdAt) }}
            <template v-if="mine[mine.length - 1].late"> · <b class="score">迟交</b></template>
            <template v-if="mine[mine.length - 1].score !== null">
              · 得分 <b class="score">{{ mine[mine.length - 1].score }}</b>
            </template>
            <template v-else>· 等老师批</template>
            <span class="dim">　再交会覆盖上一次（只保留最新）</span>
          </span>
        </div>
      </template>

      <template #actions="{ files, allFiles }">
        <router-link class="btn mini" to="/student/assignments">← 列表</router-link>
        <button class="btn mini primary" :disabled="busy" @click="submit(files, allFiles)">
          {{ busy ? '提交中…' : mine.length ? '重新提交（覆盖上一次）' : '提交' }}
        </button>
      </template>
    </PgWorkbench>

    <!-- 没开始 / 已结束：不给编辑器，只交代状态 + 我交过什么 -->
    <template v-else-if="a">
      <PageHead>
        <template #title>{{ a.title }}</template>
        <template #sub>{{ a.note || '这次作业有自己的起手代码' }}<template v-if="dueText"> · 截止 {{ dueText }}</template></template>
        <template #right>
          <span class="tag" :class="a.started ? 'mute' : 'warn'">{{ a.started ? '已结束' : '未开始' }}</span>
          <router-link class="btn mini" to="/student/assignments">← 列表</router-link>
        </template>
      </PageHead>

      <div class="content">
        <div class="card lock">
          <h3>{{ a.started ? '这次课堂作业已经结束了' : '老师还没开始这次课堂作业' }}</h3>
          <p class="dim">
            <template v-if="a.started">
              结束于 {{ when(a.closedAt) }}。交上去的作业还在，下面可以翻回自己写过的代码；
              老师批完之后这里会显示分数。
            </template>
            <template v-else>等老师在教师端点「开始」，这里就会出现编辑器和提交按钮。</template>
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
              <span :class="{ ok: row.score !== null }">{{ row.score === null ? '—' : row.score }}</span>
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

const subText = computed(() => {
  const x = a.value || {}
  const parts = []
  if (x.overDue) parts.push(x.allowLate === false ? '已截止（不再收）' : '已过截止时间（可以交，算迟交）')
  parts.push('改完点右上角「提交」：整份交上去，只保留最新一次')
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
})

onUnmounted(() => {
  if (off) off()
})

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
      '\n\n整份一起交上去，老师那边能直接跑起来看效果。重交不会覆盖上一次，老师能看到每一次。'
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
.aw {
  /* 工作台的高度是按「视口 - 顶栏」算的，这里多了一条状态栏，把它扣掉 */
  --pg-extra: 48px;
}

.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 7px 11px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: #f8fafc;
  font-size: 13px;
  color: #3b434b;
}

.bar.done {
  background: #f3f8f4;
  border-color: #cfe2d6;
}

.score {
  color: var(--ok);
  font-size: 14px;
}

.lock {
  padding: 18px 20px;
}

.lock h3 {
  margin: 0 0 6px;
  font-size: 15px;
}

.lock p {
  margin: 0;
  font-size: 13px;
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
  font-size: 13px;
}

.empty {
  padding: 20px;
  text-align: center;
  color: var(--dim);
  font-size: 13px;
}
</style>
