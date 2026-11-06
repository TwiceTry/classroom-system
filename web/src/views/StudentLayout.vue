<template>
  <div class="shell">
    <!-- 老师一开播：浏览器放行就自动开了投屏页，被拦就靠这条横幅点一下 -->
    <div
      v-if="castWatch.banner"
      class="cast-call"
      title="点一下浏览器才会打开投屏页"
    >
      <i class="rec"></i>
      <b>老师开始投屏了</b>
      <span class="hint">{{ castWatch.hint }}</span>
      <button class="go" @click="onOpenCast()">打开投屏页</button>
      <button class="skip" @click="dismissCastWatch()">先不看</button>
    </div>

    <aside class="side" :class="{ collapsed }">
      <div class="brand">
        <span class="logo"><Icon name="logo" :size="16" /></span>
        <!-- 头部放课程（学生姓名/班级在脚部已经有了，不重复） -->
        <div class="who">
          <h1>
            <span class="cname" :title="courseLabel">{{ courseLabel }}</span>
          </h1>
          <p
            class="now-line"
            :title="clock.ready ? clock.date + ' ' + clock.week + ' · ' + clock.seasonName + ' · ' + clock.text : ''"
          >
            {{ clockLine }}
          </p>
        </div>
        <button class="fold" :title="collapsed ? '展开侧栏' : '收起侧栏（只留图标）'" @click="toggleSide">
          <Icon :name="collapsed ? 'chevron-right' : 'chevron-left'" />
        </button>
      </div>

      <nav class="nav">
        <template v-for="g in navGroups" :key="g.title">
          <div v-if="g.items.length" class="group" :title="collapsed ? g.title : ''">{{ g.title }}</div>
          <template v-for="n in g.items" :key="n.to || n.href">
            <a
              v-if="n.href"
              :href="n.href"
              target="_blank"
              rel="noopener"
              :title="collapsed ? n.label : ''"
              @click.prevent="onOpenCast()"
            >
              <span class="ico"><Icon :name="n.icon" /></span><span class="lbl">{{ n.label }}</span>
            </a>
            <router-link
              v-else
              :to="n.to"
              :title="collapsed ? n.label : ''"
              :class="{ on: route.path === n.to || route.path.indexOf(n.to + '/') === 0 }"
            >
              <span class="ico"><Icon :name="n.icon" /></span><span class="lbl">{{ n.label }}</span>
            </router-link>
          </template>
        </template>
      </nav>

      <div class="foot">
        <template v-if="collapsed">
          <button class="minibtn" :title="whoLine" @click="toggleSide"><Icon name="users" /></button>
          <p class="live" title="在线"><i class="dot"></i></p>
          <button v-if="!isGuest" class="minibtn" title="退出登录" @click="onLogout"><Icon name="logout" /></button>
          <button v-else class="minibtn" title="登录" @click="onLogin"><Icon name="user" /></button>
        </template>
        <template v-else-if="isGuest">
          <b>{{ state.tokenExpired ? '登录已失效' : '游客浏览' }}</b>
          <span>{{ state.tokenExpired ? '请重新登录后继续' : '课程材料公开可看' }}</span>
          <p class="live"><i class="dot"></i>{{ state.tokenExpired ? '未登录' : '未登录' }}</p>
          <button @click="onLogin">登录</button>
        </template>
        <template v-else>
          <b>{{ student ? student.name : '' }}</b>
          <span>{{ student ? student.className : '' }} · {{ student ? student.sid : '' }}</span>
          <p class="live"><i class="dot"></i>在线</p>
          <button @click="onLogout">退出登录</button>
        </template>
      </div>
    </aside>

    <main class="main">
      <p v-if="state.tokenExpired" class="vis-notice">
        登录已失效，请重新登录。
        <button class="btn mini" @click="onLogin">去登录</button>
      </p>
      <p v-if="visNotice" class="vis-notice">{{ visNotice }}</p>
      <router-view />
    </main>

    <!-- 老师点名时全屏显示「现在点的是谁」（考勤核对 / 请回答） -->
    <Spotlight />
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import Spotlight from '../components/Spotlight.vue'
import { api } from '../api'
import { logout, state } from '../store'
import { onPresenceMessage, startPresence, stopPresence } from '../utils/presence'
import { castWatch, startCastWatch, stopCastWatch, dismissCastWatch } from '../utils/castWatch'
import { loadScheme, moduleIcon, scheme } from '../utils/scheme'
import { clock, startClock, stopClock } from '../utils/timetable'

const route = useRoute()
const router = useRouter()
const student = computed(() => state.student)

/* 侧栏折叠：只留图标，把宽度还给内容（讲义正文、材料都吃宽度）。
 * 学生端的偏好单独存一个 key，跟教师端互不影响。 */
const SIDE_KEY = 'teach-student-side-collapsed'

function readCollapsed() {
  try {
    return localStorage.getItem(SIDE_KEY) === '1'
  } catch (e) {
    return false
  }
}

const collapsed = ref(readCollapsed())

function toggleSide() {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem(SIDE_KEY, collapsed.value ? '1' : '0')
  } catch (e) {
    /* 隐私模式忽略 */
  }
}

/* 折叠时脚部只剩图标，靠 title 告诉学生「现在是谁」 */
const whoLine = computed(() => {
  const s = state.student
  if (!s) return '学生'
  return [s.name, s.className, s.sid].filter(Boolean).join(' · ') + '（点一下展开侧栏）'
})

/* 课程名：登录时记在 state 里；刷新页面后从本地存的 courseId 兜一下 */
const courseName = computed(() => {
  if (state.student && state.student.courseName) return state.student.courseName
  // 游客：课程名从公开接口拿
  return state.courseName || ''
})

/* 游客浏览：没登录也能看课程材料（教学公开）。只留「课程材料」一个入口。 */
const isGuest = computed(() => !state.role && !state.student)
/* 名称下面那行时钟：周几 时间 · 第几节 */
const clockLine = computed(() => {
  const c = clock.value
  if (!c.ready) return ''
  const p = c.period ? '第' + c.period.no + '节' : c.next ? '下节' + c.next.no : '已下课'
  return c.week + ' ' + c.clock + ' · ' + p
})

// 方案里带了课程名（/api/scheme 返回的 scheme.name 是方案名，不一定等于课程名），所以优先用登录信息
// 头部显示的是课程名，取不到时给个中性文案（右边 chip 已经写明是「学生端」）
const courseLabel = computed(() => courseName.value || '未选课程')

/*
 * 分组与顺序跟教师端对齐（讲课 → 考核 → 管理），学生没有的项直接跳过：
 *   讲课 —— 课程材料（对应老师的讲义）、代码练习
 *   考核 —— 方案里启用的模块（考勤 / 互动只有老师端，studentRoute 为空，自动跳过）
 *   管理 —— 我的分数（对应老师那栏的班级管理看分）、课堂投屏（对应投屏设置）
 * 入口显不显示由老师在侧栏的「学生端显示」开关决定（课堂开关，与考核方案无关）：
 * 老师一改，服务端广播 stuvis，这里立刻重新取一遍，菜单随之增减。
 */
const navGroups = computed(() => {
  // 游客：只有课程材料能看（其它都要登录）
  if (isGuest.value) {
    return [{ title: '讲课', items: [{ to: '/student/materials', label: '课程材料', icon: 'book' }] }]
  }
  const mods = scheme.modules
    .filter((m) => m.studentRoute && m.studentVisible !== false)
    .map((m) => ({ to: m.studentRoute, label: m.title, icon: moduleIcon(m) }))
  return [
    {
      title: '讲课',
      items: [
        { to: '/student/materials', label: '课程材料', icon: 'book' },
        { to: '/student/playground', label: '代码练习', icon: 'code' },
      ],
    },
    { title: '考核', items: mods },
    {
      title: '管理',
      items: [
        { to: '/student/score', label: '我的分数', icon: 'chart' },
        { to: '/student/watch', label: '课堂投屏', icon: 'watch' },
      ],
    },
  ]
})

/* ---------------- 学生端显示开关（老师随时收 / 放） ---------------- */
const visNotice = ref('') // 被收起时的临时提示

function isModulePath(p) {
  return p.indexOf('/student/modules/') === 0
}

function currentModuleHidden() {
  const path = route.path
  if (!isModulePath(path)) return false
  const hit = scheme.modules.find((m) => m.studentRoute && path.indexOf(m.studentRoute) === 0)
  // 找不到说明这个入口已经不在列表里了（被收起或被关掉）
  return !hit || hit.studentVisible === false
}

let offVis = null

/* ---------------- 老师同步练习：把全班切到「代码练习」 ----------------
 * 以前只有「学生正好停在代码练习页」时才会跟随（PgWorkbench 里收 pgsync），
 * 停在课程材料 / 作业页的学生根本不知道老师开始了。这里在布局层兜住。
 */
const PG_PATH = '/student/playground'

/** 正在写代码的页面（从这些页被拉走，才需要提醒「你的内容已保存」） */
function isWorkPage(p) {
  return p.indexOf(PG_PATH) === 0 || p.indexOf('/student/modules/homework/') === 0
}

function jumpToPlayground(opts) {
  const o = opts || {}
  if (route.path === PG_PATH || route.path.indexOf(PG_PATH + '/') === 0) return false
  const leavingWork = isWorkPage(route.path)
  router.push(PG_PATH)
  visNotice.value =
    (o.already ? '老师正在同步练习' : '老师开始同步练习') +
    '，已切到「代码练习」' +
    (leavingWork ? '（你刚写的内容已保存，老师讲完回去接着写）' : '')
  setTimeout(() => (visNotice.value = ''), 6000)
  return true
}

function onPgSync(msg) {
  if (!msg) return
  if (msg.active === true) {
    jumpToPlayground()
    return
  }
  // 停止同步：不把人拽走；只在练习页说一句「恢复了」，别在别的页面瞎弹
  if (route.path.indexOf(PG_PATH) === 0) {
    visNotice.value = '老师结束了同步，已恢复你自己的代码'
    setTimeout(() => (visNotice.value = ''), 5000)
  }
}

function onPresenceMsg(msg) {
  if (!msg) return
  if (msg.t === 'stuvis') onVisMessage(msg)
  else if (msg.t === 'pgsync') onPgSync(msg)
}

function onVisMessage(msg) {
  if (!msg || msg.t !== 'stuvis') return
  // 服务端按「这个学生自己的课程」算可见性，所以直接重取即可，不用自己比对 courseId
  loadScheme(true, { brief: true }).then(() => {
    if (!currentModuleHidden()) return
    router.replace('/student/materials')
    visNotice.value = '老师暂时收起了这个入口'
    setTimeout(() => (visNotice.value = ''), 4000)
  })
}

// 进入学生端 = 到场：开始心跳；离开这个布局（退出/关页）自动报离
onMounted(async () => {
  // 游客：只看看课程材料（下面那些都要登录）
  if (isGuest.value) return
  startClock()
  startPresence()
  startCastWatch()
  await loadScheme(true, { brief: true }) // 学生端只要导航：省掉 raw/rules/forms（8.3KB → 1.1KB）
  offVis = onPresenceMessage(onPresenceMsg)
  // 学生中途才打开应用（老师早就在同步了）：广播不会重发，主动问一次。
  // 字段是 sync（不是 pg）—— 原来读 r.pg 恒为 undefined，这条从来没生效过。
  try {
    const r = await api.get('/api/pgsync')
    if (r && r.sync) jumpToPlayground({ already: true })
  } catch (e) {
    /* 没登录 / 接口不通就忽略 */
  }
})
onUnmounted(() => {
  if (offVis) offVis()
  stopClock()
  stopPresence()
  stopCastWatch()
})

/** 横幅上的「打开投屏页」：在应用内跳过去（同标签页，不再弹新窗口） */
function onOpenCast() {
  router.push('/student/watch')
}

async function onLogout() {
  stopPresence()
  await logout()
  router.replace('/login')
}

/** 游客点「登录」→ 去登录页（登录完还能回来继续看材料） */
function onLogin() {
  router.push({ path: '/login', query: { next: route.fullPath } })
}
</script>

<style scoped>
/* 老师把当前入口收起来时的一句提示（4 秒后自动消失） */
.vis-notice {
  margin: 0 0 10px;
  padding: 6px 12px;
  border-radius: 4px;
  background: #fff8e6;
  border-left: 3px solid #e0a300;
  color: #6b5320;
  font-size: 12.5px;
}
/* ---------------- 折叠态 ---------------- */
/* 学生端品牌行里那块信息叫 .who（教师端叫 .brand-txt），折叠时一起收掉 */
.side.collapsed .who {
  display: none;
}

.side.collapsed .foot .minibtn:last-child {
  margin-bottom: 0;
}

/* 折叠时脚部的在线小圆点单独占一行，居中 */
.side.collapsed .foot .live {
  margin: 2px 0 8px;
}

/* 学生端左上角：课程名 + 「学生端」+ 时钟（姓名/班级在脚部，头部不重复） */
.who {
  flex: 1 1 auto;
  min-width: 0;
}

/* 品牌行把边距收紧一点，把省下的 14px 给课程名：208px 的侧栏里一门课名
 * 常常要 12 个字，差几个像素就变成「Web 前端框…」 */
.side .brand {
  padding-left: 12px;
  padding-right: 10px;
  gap: 7px;
}

.who h1 {
  display: block;
  min-width: 0;
}

/* 一行放得下就整名显示，放不下才省略（悬停 title 看全称） */
.who .cname {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 1.35;
}
/* 贴在底部：不压住顶部的搜索框 / 字号按钮，也不影响页面布局，点「先不看」就消失 */
.cast-call {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 80;
  display: flex;
  align-items: center;
  gap: 10px;
  width: max-content; /* 否则 left:50% 会把可用宽度压到半屏，文案被提前省略 */
  max-width: min(920px, calc(100vw - 28px));
  padding: 9px 12px 9px 14px;
  border-radius: 4px;
  background: #23272c;
  color: #f8fafc;
  font-size: 13px;
  box-shadow: 0 8px 22px rgba(20, 24, 28, 0.28);
  animation: castrise 0.22s ease-out;
}

.rec {
  flex: 0 0 9px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #ef4444;
  animation: castpulse 1.3s infinite;
}

.cast-call b {
  font-weight: 600;
  white-space: nowrap;
}

.hint {
  color: #cbd5e1;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.go {
  flex: 0 0 auto;
  border: 0;
  border-radius: 4px;
  padding: 5px 11px;
  background: #d9a03c;
  color: #23272c;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}

.go:hover {
  background: #e2ae4f;
}

.skip {
  flex: 0 0 auto;
  border: 0;
  padding: 6px 4px;
  background: transparent;
  color: #94a3b8;
  font-size: 12.5px;
  cursor: pointer;
}

.skip:hover {
  color: #e2e8f0;
}

@keyframes castpulse {
  0% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.55);
  }
  70% {
    box-shadow: 0 0 0 7px rgba(239, 68, 68, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0);
  }
}

@keyframes castrise {
  from {
    opacity: 0;
    transform: translate(-50%, 8px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

@media (max-width: 720px) {
  .hint {
    display: none;
  }
}

.live {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 12px;
  color: #6ee7b7;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.18);
}
</style>
