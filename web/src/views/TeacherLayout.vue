<template>
  <div class="shell">
    <aside class="side" :class="{ collapsed }">
      <div class="brand">
        <span class="logo"><Icon name="logo" :size="16" /></span>
        <div class="brand-txt">
          <h1>课堂系统</h1>
          <p class="role">教师端</p>
          <!-- 短一行：周几 时间 · 第几节（服务器算，机房机器时间不准也不影响） -->
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
          <div class="group" :title="collapsed ? g.title : ''">{{ g.title }}</div>
          <router-link
            v-for="n in g.items"
            :key="n.to"
            :to="n.to"
            :title="collapsed ? n.label : ''"
            :class="{ on: route.path === n.to || route.path.indexOf(n.to + '/') === 0 }"
          >
            <span class="ico"><Icon :name="n.icon" /></span><span class="lbl">{{ n.label }}</span>
            <!-- 学生端显不显示这个入口：点一下切换（和「考核方案」页里那个眼睛是同一个状态） -->
            <button
              v-if="n.itemKey && n.studentEntry && !collapsed"
              class="eye"
              :class="{ off: isHidden(n.itemKey) }"
              :title="isHidden(n.itemKey) ? '学生端已收起（点一下放出来）' : '学生端可见（点一下收起来）'"
              @click.prevent.stop="onToggleVis(n.itemKey)"
            >
              <Icon :name="isHidden(n.itemKey) ? 'eye-off' : 'eye'" :size="16" />
            </button>
          </router-link>
        </template>
      </nav>

      <div class="foot">
        <!-- 折叠态：课程 / 班级收成两个图标，点一下展开侧栏再切 -->
        <template v-if="collapsed">
          <button class="minibtn" :title="'课程：' + courseName + '（点开切换）'" @click="toggleSide">
            <Icon name="graduation" />
          </button>
          <button class="minibtn" :title="'班级：' + className + '（点开切换）'" @click="toggleSide">
            <Icon name="users" />
          </button>
        </template>

        <template v-else>
          <!-- 课程是最高一级：切了它，讲义 / 材料 / 示例 / 作业 / 计分 / 方案 全跟着换 -->
          <div class="course">
            <span class="course-l">课程</span>
            <select class="course-sel" :value="courseId" @change="onCourse">
              <option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}{{ c.semester ? ' · ' + c.semester : '' }}</option>
              <option v-if="!courses.length" value="">（还没建课程）</option>
            </select>
          </div>

          <!-- 班级是课程下面的第二级：不同课程班级不同，所以跟着课程走 -->
          <div class="course sub">
            <span class="course-l">班级</span>
            <select class="course-sel" :value="classId" @change="onClass">
              <option v-for="c in classes" :key="c.id" :value="c.id">{{ c.name }}（{{ c.count }} 人）</option>
              <option v-if="!classes.length" value="">（这门课还没建班级）</option>
            </select>
          </div>
        </template>

        <!-- 投屏是全站常驻的：切讲义 / 点名 / 计分都不中断 -->
        <div class="cast" :class="{ mini: collapsed }">
          <!-- 状态写在按钮里，鼠标放上去才说明"点一下会怎样" -->
          <button
            class="cast-btn"
            :class="{ live: s.running, warn: !s.running && insecureOrigin, bad: !s.running && (!s.connected || s.msgType === 'err') }"
            :title="castTip"
            @click="toggleCast"
          >
            <i class="dot" :class="{ live: s.running, off: !s.connected }"></i>
            <span v-if="!collapsed">{{ castLabel }}</span>
          </button>
        </div>

        <button v-if="collapsed" class="minibtn" title="退出登录" @click="onLogout"><Icon name="logout" /></button>
        <button v-else @click="onLogout">退出登录</button>
      </div>
    </aside>

    <main class="main">
      <router-view />
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { logout } from '../store'
import { cast } from '../utils/screencast'
import { api, getCourse, setCourse } from '../api'
import { currentClassId, setClassId } from '../utils/classSel'
import { clock, startClock, stopClock } from '../utils/timetable'
import { loadScheme, moduleIcon, scheme } from '../utils/scheme'
import { hasStudentEntry, isHidden, loadStuVis, stuvis, toggleStuVis } from '../utils/stuvis'

const route = useRoute()
const router = useRouter()

/* 学生端显示开关：跟着当前课程走，一次拉齐，菜单项上的小眼睛与方案页共用这份状态 */
function syncStuVis(force) {
  loadStuVis(courseId.value, force)
}

function onToggleVis(key) {
  toggleStuVis(key, isHidden(key)).catch(() => {
    /* 失败时 store 已回滚，界面不会骗人；错误文案在 store.err 里 */
  })
}

/* 当前课程（右上/侧栏切换器）：写在 localStorage，全局请求自动带 courseId */
const courses = ref([])
const courseId = ref(getCourse())

/* 当前班级：跟课程联动（切了课程，班级列表换成那门课的） */
const classes = ref([])
const classId = ref(currentClassId.value)

async function loadClasses() {
  try {
    const res = await api.get('/api/classes') // api.js 自动带 courseId
    classes.value = res.items || []
    const hit = classes.value.some((c) => c.id === classId.value)
    if (!hit) {
      const first = classes.value.length ? classes.value[0].id : ''
      classId.value = first
      setClassId(first)
    }
  } catch (e) {
    /* 拿不到班级不影响页面 */
  }
}

function onClass(e) {
  const id = e.target.value
  classId.value = id
  setClassId(id)
}

// 页面里点了班级 chip，侧栏文字跟着变（不刷新）
watch(currentClassId, (v) => {
  if (v !== classId.value) classId.value = v
})

// 课程变了就重新拉一次「学生端显示」状态（侧栏小眼睛靠它渲染）
watch(courseId, (v) => {
  if (v) syncStuVis(true)
})

onMounted(async () => {
  try {
    const res = await api.get('/api/courses')
    courses.value = (res.items || []).filter((c) => !c.archived)
    // 没选过（或选的课被删了）就落到第一门课
    if (!courseId.value && courses.value.length) {
      courseId.value = courses.value[0].id
      setCourse(courseId.value)
    }
    if (courseId.value && !courses.value.some((c) => c.id === courseId.value) && courses.value.length) {
      courseId.value = courses.value[0].id
      setCourse(courseId.value)
    }
    await loadClasses()
    startClock()
  } catch (e) {
    /* 课程接口失败不阻塞页面 */
  }
})

function onCourse(e) {
  const id = e.target.value
  if (!id || id === courseId.value) return
  setCourse(id)
  courseId.value = id
  // 整页重载最省事：各页都在 onMounted 里按新课程取数据，不用逐页监听
  window.location.reload()
}

const { s } = cast
// 投屏是教师权限，不按地址设卡：任何来源打开教师端都能点。
// 只有 http + 非 localhost 的源会被浏览器收走屏幕接口 —— 那种情况下点下去会给出两条出路
// （改用 localhost，或用「双击打开-教师端.bat」把该地址加进 Chrome 白名单）。
// 这里只留一句轻提示，不拦人。
const insecureOrigin = !window.isSecureContext

/*
 * 导航分三栏，按「上课时手会往哪儿伸」排：
 *   讲课 —— 上课第一件事（讲义、当成黑板用的代码练习、投屏设置）
 *   考核 —— 边上课边记的（模块：考勤点名 / 课堂互动 / 课堂作业 / 机试 / 大作业）+ 计分表 + 方案
 *   管理 —— 课前课后才动的（班级名单、课程与内容）
 * 中间那栏的模块由考核方案决定：方案里把某个模块关掉，入口跟着消失。
 */
const navGroups = computed(() => {
  const mods = scheme.modules.map((m) => ({
    to: m.teacherRoute,
    label: m.title,
    icon: moduleIcon(m),
    itemKey: m.itemKey, // 有它才显示小眼睛（考勤 / 互动没有学生入口，由 hasStudentEntry 过滤）
    studentEntry: hasStudentEntry(m),
  }))
  return [
    {
      title: '讲课',
      items: [
        { to: '/teacher/lecture', label: '讲义', icon: 'book' },
        { to: '/teacher/playground', label: '代码练习', icon: 'code' },
      ],
    },
    {
      title: '考核',
      items: mods,
    },
    {
      title: '管理',
      items: [
        { to: '/teacher/classes', label: '班级管理', icon: 'users' },
        { to: '/teacher/courses', label: '课程管理', icon: 'graduation' },
        { to: '/teacher/scheme', label: '考核方案', icon: 'sliders' },
        { to: '/teacher/screen', label: '投屏设置', icon: 'cast' },
      ],
    },
  ]
})

/* 侧栏折叠：只留图标，把一屏宽度还给内容（讲义 / 计分表都用得上） */
const SIDE_KEY = 'teach-side-collapsed'
const collapsed = ref(readCollapsed())

function readCollapsed() {
  try {
    return localStorage.getItem(SIDE_KEY) === '1'
  } catch (e) {
    return false
  }
}

function toggleSide() {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem(SIDE_KEY, collapsed.value ? '1' : '0')
  } catch (e) {
    /* 隐私模式忽略 */
  }
}

/* 折叠态的两个图标要靠 title 告诉老师「现在切的是哪门课、哪个班」 */
/* 品牌行下面那行时钟：短到 208px 也放得下 */
const clockLine = computed(() => {
  const c = clock.value
  if (!c.ready) return ''
  const p = c.period ? '第' + c.period.no + '节' : c.next ? '下节' + c.next.no + '节' : '已下课'
  return c.week + ' ' + c.clock + ' · ' + p
})

const courseName = computed(() => {
  const hit = courses.value.find((c) => c.id === courseId.value)
  if (!hit) return '（未选课程）'
  return hit.semester ? hit.name + ' · ' + hit.semester : hit.name
})

const className = computed(() => {
  const hit = classes.value.find((c) => c.id === classId.value)
  return hit ? hit.name : '（未选班级）'
})

/* 按钮上写"现在是什么状态" */
const castLabel = computed(() => {
  // 投屏中：按钮只报「现在几人再看」，「停止」这个动作留给悬停提示
  if (s.running) return s.peers + ' 人在看'
  if (s.msg && s.msgType === 'err') return '投屏出错 · 点重试'
  if (!s.connected) return '重连中…'
  if (insecureOrigin) return '抓不到屏幕'
  return '开始投屏'
})

/* 鼠标放上去说"点一下会怎样"，顺带把细节带上 */
const castTip = computed(() => {
  const action = s.running ? '点一下停止投屏（学生端回到占位页）' : '点一下开始投屏（在弹窗里选「整个屏幕」）'
  if (s.running) return action + '　当前 ' + s.peers + ' 人在看 · ' + s.fps + 'fps'
  if (s.msg && s.msgType === 'err') return s.msg + '　' + action
  if (!s.connected) return '投屏连接断开，正在自动重连…　' + action
  if (insecureOrigin) return '这个地址抓不到屏幕 —— 用桌面上的教师端快捷方式重开本页'
  return action
})

function toggleCast() {
  if (s.running) cast.stop('已停止投屏')
  else cast.start()
}

// 推流跟着「教师端」这个布局走，不跟着某个页面走
onMounted(async () => {
  cast.mount()
  await loadScheme(true) // 每次进教师端都按最新方案渲染导航
  syncStuVis(true) // 菜单项上的小眼睛 = 学生端可见状态
})
onUnmounted(() => {
  cast.unmount()
  stopClock()
})

async function onLogout() {
  cast.unmount()
  await logout()
  router.replace('/login')
}
</script>

<style scoped>
/* 菜单项右边的「学生端可见」小眼睛：平时淡、悬停变深，收起时（.off）一直是虚的 */
.eye {
  flex: 0 0 auto;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: none;
  color: #8b98a6;
  cursor: pointer;
  transition: color 0.12s, background 0.12s;
}

.nav a:hover .eye {
  color: #b8c4cf;
}

.eye:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #e6edf3 !important;
}

/* 已收起：琥珀色，跟「可见」的灰蓝拉开距离（侧栏是深底，这里要亮一档才看得清） */
.eye.off {
  color: #d9a441;
}

.eye.off:hover {
  background: rgba(217, 164, 65, 0.14);
  color: #f0be5c !important;
}

/* 让菜单项的 label 能撑开、把眼睛顶到最右 */
.nav a .lbl {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 课程切换器：放在侧栏底部第一位，跟投屏同一组「常驻开关」 */
.course {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  margin-bottom: 8px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  background: #fbfcff;
}

.course-l {
  font-size: 12px;
  color: var(--dim);
  flex: 0 0 auto;
}

.course-sel {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  font-size: 12.5px;
  color: var(--ink);
  padding: 2px 0;
  outline: none;
}

/* 班级那一行：视觉上缩进一级，表示它挂在课程下面 */
.course.sub {
  margin-top: -4px;
  background: #f7f9fc;
}

.course.sub .course-l {
  padding-left: 2px;
  color: #94a3b8;
}

.course.sub .course-sel {
  font-size: 12px;
}

.cast {
  padding-bottom: 12px;
  margin-bottom: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.cast .cast-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 8px 10px;
  border-radius: 4px;
  border: 1px solid #4a515c;
  background: #2b3037;
  color: #fff;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.cast .cast-btn:hover {
  background: rgba(255, 255, 255, 0.18);
}

.cast .cast-btn.live {
  background: #b3342c;
  border-color: #b3342c;
}

.cast .cast-btn.live:hover {
  background: #9d2b24;
}

/* 抓不到屏幕（地址不是安全上下文）：琥珀色，点也没用，靠 title 给出解法 */
.cast .cast-btn.warn,
.cast .cast-btn.warn:hover {
  background: #3a3325;
  border-color: #8a6d2f;
  color: #f0d9a8;
}

/* 投屏出错 / 连接断了：暗红，文字直接说「点重试」「重连中」 */
.cast .cast-btn.bad,
.cast .cast-btn.bad:hover {
  background: #3a2523;
  border-color: #8c3b34;
  color: #f3bdb8;
}

.cast .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #94a3b8;
}

.cast .dot.live {
  background: #fff;
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.25);
  animation: pulse 1.6s ease-in-out infinite;
}

.cast .dot.off {
  background: #fbbf24;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.cast-meta {
  margin: 6px 0 4px;
  font-size: 11.5px;
  color: var(--side-dim);
  line-height: 1.5;
  word-break: break-all;
}

.cast-meta.err {
  color: #d99a93;
}

.cast-link {
  font-size: 12px;
  color: #a8b6c2;
}

.cast-link:hover {
  color: #fff;
  text-decoration: underline;
}

.me {
  margin-bottom: 8px;
}
</style>
