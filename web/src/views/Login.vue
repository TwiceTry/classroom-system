<template>
  <div class="login">
    <div class="box">
      <header class="head">
        <!-- 只有一门课就直接写课程名（老师一眼确认没进错），否则退回系统名 -->
        <h1>{{ courses.length === 1 ? courses[0].name : '课堂系统' }}</h1>
        <p>课堂系统 · 讲义、计分、点名与投屏</p>
      </header>

      <div class="tabs">
        <button :class="{ on: tab === 'student' }" @click="switchTab('student')">学生</button>
        <button :class="{ on: tab === 'teacher' }" @click="switchTab('teacher')">教师</button>
      </div>

      <p v-if="state.tokenExpired" class="note warn">
        登录已失效，请重新登录。登录后会自动回到刚才那一页。
      </p>

      <form v-if="tab === 'student'" class="form" @submit.prevent="loginStudent">
        <label class="field">
          <span>课程</span>
          <select v-model="form.courseId" class="select">
            <option value="" disabled>请选择课程</option>
            <option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <label class="field">
          <span>学号</span>
          <input v-model.trim="form.sid" class="input" placeholder="名单上的学号" autocomplete="off" />
        </label>
        <!--
          两种校验方式由老师在「课程管理 → 学生登录方式」里切换：
          local 用姓名，kg 用青果密码。登录页只按后端给的 mode 显示表单。
        -->
        <label v-if="authMode === 'local'" class="field">
          <span>姓名</span>
          <input v-model.trim="form.name" class="input" placeholder="名单上的姓名" autocomplete="off" />
        </label>
        <label v-else class="field">
          <span>青果密码</span>
          <input
            v-model="form.stuPwd"
            type="password"
            class="input"
            placeholder="智慧校园平台的密码"
            autocomplete="current-password"
          />
        </label>
        <p v-if="authMode === 'local'" class="note">学号和姓名要和名单一致。登录后只能看到自己的分数。</p>
        <p v-else class="note">
          用学校智慧校园平台的账号（学号）和密码登录。输错会累计次数，满 5 次平台会锁号，请确认后再输。
        </p>
        <button class="btn primary" :disabled="busy || !canSubmit">
          {{ busy ? '正在登录…' : '进入课堂' }}
        </button>
        <p v-if="!courses.length" class="note warn">老师还没有建课程。</p>
        <p v-if="err" class="note err">{{ err }}</p>
      </form>

      <form v-else class="form" @submit.prevent="loginTeacher">
        <label class="field">
          <span>口令</span>
          <input v-model="form.password" type="password" class="input" placeholder="教师口令" />
        </label>
        <!--
          「当前是初始口令」的提示移到了教师端（TeacherLayout）。
          原因：登录页是未登录状态，拿不到 passwordIsDefault；
          而这个字段一旦对所有人可见，就等于告诉别人「直接试默认口令」。
        -->
        <button class="btn primary" :disabled="busy || !form.password">
          {{ busy ? '正在登录…' : '进入教师端' }}
        </button>
        <p v-if="err" class="note err">{{ err }}</p>
      </form>

      <footer class="foot">
        <span>{{ courseCountText }}</span>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { applyLogin, refresh, state } from '../store'

const router = useRouter()
const route = useRoute()

const tab = ref('student')
const busy = ref(false)
const err = ref('')

// 课程清单走公开接口：登录页还没令牌，但学生得先选课程
const courses = ref([])

async function loadCourses() {
  try {
    const res = await api.get('/api/courses/public')
    courses.value = res.items || []
    if (courses.value.length && !form.courseId) form.courseId = courses.value[0].id
  } catch (e) {
    courses.value = []
  }
}

/*
 * 页脚只显示「几门课」。
 * 原来还会显示「117 人次」，但那意味着**任何人打开登录页就能知道这个学校有多少学生** ——
 * 而登录页只需要让人选一门课，人数一个用不上。接口那边也不返回它了。
 */
const courseCountText = computed(() => {
  const n = courses.value.length
  return n ? n + ' 门课' : ''
})

const form = reactive({ courseId: '', sid: '', name: '', password: '', stuPwd: '' })

/**
 * 学生登录用哪种校验：local（学号+姓名，默认）/ kg（青果账号密码）。
 * 由老师在课程管理页切换；这里只决定显示哪个输入框。
 * 取不到就按 local 走 —— 宁可退回老方式，也不要让学生卡在登录页。
 */
const authMode = ref('local')

async function loadAuthMode() {
  try {
    const res = await api.get('/api/auth/student-mode')
    authMode.value = res && res.mode === 'kg' ? 'kg' : 'local'
  } catch (e) {
    authMode.value = 'local'
  }
}

const canSubmit = computed(() =>
  authMode.value === 'kg'
    ? !!(form.courseId && form.sid && form.stuPwd)
    : !!(form.courseId && form.sid && form.name)
)

onMounted(async () => {
  // 已登录就直接进对应的家
  if (state.role === 'teacher') router.replace('/teacher/lecture')
  else if (state.role === 'student') router.replace('/student/materials')

  /*
   * 登录页只做一件事：拿课程下拉。
   *
   * 原来这里还有一段 `if (!state.classes.length) await refresh()` ——
   * 它会在**任何人**打开登录页时拉一次 /api/bootstrap（2.48KB），
   * 而登录页的 state.classes 恒为空（游客档本来就不给班级），
   * 于是每次进来都白拉一次、拉完什么也没做。
   */
  if (!courses.value.length) await loadCourses()
  if (courses.value.length && !form.courseId) form.courseId = courses.value[0].id
  // 学生该用哪种校验方式，由后端说了算（老师随时可切）
  await loadAuthMode()
})

function switchTab(t) {
  tab.value = t
  err.value = ''
}

async function loginStudent() {
  if (!canSubmit.value) return
  busy.value = true
  err.value = ''
  try {
    // 按当前模式带上对应凭据：local 要姓名，kg 要密码
    const payload =
      authMode.value === 'kg'
        ? { sid: form.sid, password: form.stuPwd }
        : { sid: form.sid, name: form.name }
    const res = await api.post('/api/auth/login/student', payload)
    applyLogin(res)
    await refresh()
    router.replace(route.query.next || '/student/materials')
  } catch (e) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}

async function loginTeacher() {
  busy.value = true
  err.value = ''
  try {
    const res = await api.post('/api/auth/login/teacher', { password: form.password })
    applyLogin(res)
    await refresh()
    router.replace(route.query.next || '/teacher/lecture')
  } catch (e) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
  background: var(--bg);
}

.box {
  width: 100%;
  max-width: 392px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 26px 26px 18px;
}

.head h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.head p {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--dim);
}

.tabs {
  display: flex;
  gap: 0;
  margin: 20px 0 16px;
  border-bottom: 1px solid var(--line);
}

.tabs button {
  padding: 7px 14px 8px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--sub);
  cursor: pointer;
  font-size: 13.5px;
  margin-bottom: -1px;
}

.tabs button.on {
  border-bottom-color: var(--brand);
  color: var(--ink);
  font-weight: 600;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form .btn.primary {
  margin-top: 2px;
  width: 100%;
}

.note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--dim);
}

.note.warn {
  color: var(--warn);
}

.note.err {
  color: var(--err);
}

.foot {
  margin-top: 18px;
  padding-top: 10px;
  border-top: 1px solid var(--line-soft);
  font-size: 11.5px;
  color: #a8afb6;
  min-height: 18px;
}
</style>
