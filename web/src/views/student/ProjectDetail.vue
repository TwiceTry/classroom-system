<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>{{ a ? a.title : '大作业' }}</template>
        <template #sub>说明 + 链接 + 附件，交到你自己名下（换台机器登进来也还是你的）</template>
        <template #right>
          <span v-if="a" class="tag" :class="a.status === 'open' ? 'ok' : a.started ? 'mute' : 'warn'">
            {{ a.status === 'open' ? '收作业中' : a.started ? '已截止' : '未开始' }}
          </span>
          <router-link class="btn mini" to="/student/projects">← 列表</router-link>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>
    <div v-if="!a && !err" class="card empty">正在读取…</div>

    <template v-if="a">
      <!-- 要求 -->
      <div class="card brief">
        <h3>{{ a.title }}</h3>
        <p v-if="a.note" class="note">{{ a.note }}</p>
        <p v-else class="dim">老师没有写额外要求。</p>
        <p class="dim mini">
          <span v-if="a.openedAt">开始：{{ when(a.openedAt) }}</span>
          <span v-else>还没开始收</span>
          <span v-if="a.closedAt"> · 截止：{{ when(a.closedAt) }}</span>
          <span v-if="mine.length"> · 已交 {{ mine.length }} 次</span>
        </p>
      </div>

      <!-- 交：只在收作业期间给表单 -->
      <div v-if="a.status === 'open'" class="card">
        <CardHead>
          <template #title>{{ mine.length ? '再交一次' : '提交大作业' }}</template>
          <div class="right dim mini">
            再交会覆盖上一次（只保留最新）<template v-if="dueText"> · 截止 {{ dueText }}</template>
          </div>
        </CardHead>

        <div class="form">
          <label class="field">
            <span>说明（做了什么、怎么跑起来、有什么没做完）</span>
            <textarea
            v-model="form.note"
            class="textarea"
            rows="5"
            maxlength="2000"
            placeholder="例如：用 Vue3 + vue-router 做了个图书管理，数据存 localStorage；启动：npm install && npm run dev"
            ></textarea>
        </label>

        <label class="field">
          <span>部署地址 / 仓库地址（{{ a.requireUrl ? '这次必须填' : '可留空' }}）</span>
          <input v-model="form.url" class="input" maxlength="500" placeholder="https://gitee.com/xxx/my-project" />
        </label>

        <div class="field">
          <span>
            附件（{{ a.requireFile === false ? '可选' : '必须交一个' }} · 收 {{ allowText }} · 最多 10 个）
          </span>
          <div class="picker">
            <input ref="fileInput" type="file" multiple style="display: none" @change="onPick" />
            <button class="btn mini" :disabled="busy" @click="fileInput.click()">选择文件</button>
            <span class="dim mini">{{ picked.length ? picked.length + ' 个已选' : (a.requireFile === false ? '可以不交附件' : '源码包建议压成 .zip') }}</span>
          </div>
          <ul v-if="picked.length" class="files">
            <li v-for="(f, i) in picked" :key="f.name + i">
              <span class="ellip">{{ f.name }}</span>
              <span class="dim mini">{{ kb(f.size) }}</span>
              <button class="btn mini danger" @click="picked.splice(i, 1)">移除</button>
            </li>
          </ul>
        </div>

        <div class="actions">
          <button class="btn primary" :disabled="busy" @click="submit">
            {{ busy ? '提交中…' : mine.length ? '再交一次（覆盖上一次）' : '提交' }}
          </button>
          <span v-if="err2" class="hint err">{{ err2 }}</span>
        </div>
      </div>
    </div>

    <div v-else class="card lock">
      <h3>{{ a.started ? '这次大作业已经截止了' : '老师还没开始收这次大作业' }}</h3>
      <p class="dim">
        <template v-if="a.started">截止于 {{ when(a.closedAt) }}。已经交过的材料还在下面，可以下载回看。</template>
        <template v-else>等老师点「开始」，这里就会出现提交表单。</template>
      </p>
    </div>

    <!-- 我的提交 -->
    <div v-if="mine.length" class="card">
      <CardHead>
        <template #title>我的提交（{{ mine.length }} 次）</template>
        <div class="right dim mini">老师批完会显示分数和评语</div>
      </CardHead>

      <article v-for="(s, i) in mine.slice().reverse()" :key="s.id" class="sub">
        <div class="subhead">
          <b>第 {{ mine.length - i }} 次</b>
          <span class="dim mini">{{ when(s.createdAt) }}</span>
          <span class="spacer"></span>
          <span v-if="s.graded" class="tag ok">{{ s.score }} 分</span>
          <span v-else class="tag mute">待批</span>
        </div>

        <p v-if="s.note" class="subnote">{{ s.note }}</p>
        <p v-if="s.url" class="suburl">
          <a :href="s.url" target="_blank" rel="noopener noreferrer">{{ s.url }}</a>
        </p>
        <p v-if="s.comment" class="subcmt"><b>老师评语：</b>{{ s.comment }}</p>

        <ul v-if="s.files.length" class="files">
          <li v-for="f in s.files" :key="f">
            <span class="ellip">{{ f }}</span>
            <button class="btn mini" @click="grab(s, f)">下载</button>
          </li>
        </ul>
      </article>
    </div>
    </template>


    <Toast :text="toast" @close="toast = ''" />
  </PageShell>
</template>

<script setup>
/*
 * 学生端「大作业」提交页
 *
 * 跟课堂作业的区别：这里不编辑代码，交的是「说明 + 链接 + 附件（源码包/截图）」。
 * 附件走 dataURL 上传，服务端落在 data/students/<班级>/<学号>/大作业/<作业>/<提交>/ 下，
 * 学生自己可以随时下载回看，老师那边也一样。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api, download } from '../../api'
import Toast from '../../components/Toast.vue'
import { when } from '../../utils/time'
import PageHead from '../../components/PageHead.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'

const route = useRoute()
const id = route.params.id

const a = ref(null)

/** 这次收哪些附件类型（服务端以设计包为准；这里只做提示） */
const allowText = computed(() => {
  const list = (a.value && a.value.attachments) || ['zip', 'pdf', 'md', 'png', 'mp4', 'pptx']
  return list.map((x) => '.' + x).join(' ')
})

const dueText = computed(() => {
  const x = a.value || {}
  if (!x.dueAt) return ''
  const t = new Date(x.dueAt)
  if (!isFinite(t.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + ' ' + p(t.getHours()) + ':' + p(t.getMinutes())
})
const mine = ref([])
const err = ref('')
const err2 = ref('')
const toast = ref('')
const busy = ref(false)
const picked = ref([])
const fileInput = ref(null)

const form = ref({ note: '', url: '' })

onMounted(load)

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

function kb(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function onPick(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  err2.value = ''
  for (const f of files) {
    if (f.size > 6 * 1024 * 1024) {
      err2.value = f.name + ' 超过 6MB，没加进来'
      continue
    }
    if (picked.value.length >= 6) {
      err2.value = '最多 6 个文件'
      break
    }
    if (!picked.value.some((x) => x.name === f.name && x.size === f.size)) picked.value.push(f)
  }
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error('读取文件失败：' + file.name))
    r.readAsDataURL(file)
  })
}

async function submit() {
  err2.value = ''
  if (!form.value.note.trim() && !form.value.url.trim() && !picked.value.length) {
    err2.value = '说明、链接、附件至少要有一项'
    return
  }
  busy.value = true
  try {
    const files = []
    for (const f of picked.value) files.push({ name: f.name, dataUrl: await readAsDataURL(f) })
    await api.post('/api/student/projects/' + encodeURIComponent(id) + '/submit', {
      note: form.value.note,
      url: form.value.url,
      files,
    })
    picked.value = []
    form.value = { note: '', url: '' }
    await load()
    toast.value = '交上去了，老师那边马上能看到'
  } catch (e) {
    err2.value = e.message
  } finally {
    busy.value = false
  }
}

/** 下载自己交过的附件（<a href> 带不上令牌，走 fetch + blob） */
function grab(s, name) {
  // 第二段是**学号**（后端按 students 目录找文件），不是提交记录 id —— 原来传 s.id 一律 404
  download('/api/files/assignments/' + encodeURIComponent(id) + '/' + encodeURIComponent(s.sid) + '/' + encodeURIComponent(name))
}
</script>

<style scoped>
.brief {
  padding: 14px 16px;
}

.brief h3 {
  margin: 0 0 6px;
  font-size: 15.5px;
}

.brief .note {
  margin: 6px 0 8px;
  font-size: 13.5px;
  line-height: 1.75;
  color: #3b434b;
  white-space: pre-wrap;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field > span {
  font-size: 12.5px;
  color: #4a525a;
}

.picker {
  display: flex;
  align-items: center;
  gap: 10px;
}

.files {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.files li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: 1px solid var(--line-soft);
  border-radius: 3px;
  background: #fbfcff;
  font-size: 12.5px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.lock {
  padding: 16px 18px;
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

.sub {
  padding: 10px 0;
  border-top: 1px solid var(--line-soft);
}

.sub:first-of-type {
  border-top: none;
}

.subhead {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.subnote {
  margin: 6px 0 4px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  color: #3b434b;
}

.suburl {
  margin: 2px 0 6px;
  font-size: 12.5px;
  word-break: break-all;
}

.subcmt {
  margin: 4px 0 6px;
  font-size: 13px;
  color: #7a5a20;
  background: #fbf7ef;
  border: 1px solid #ece0c8;
  border-radius: 3px;
  padding: 6px 9px;
}

.ellip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.spacer {
  flex: 1;
}
</style>
