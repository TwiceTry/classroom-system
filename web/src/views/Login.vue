<template>
  <div class="login">
    <div class="box">
      <header class="head">
        <h1>示例课程</h1>
        <p>课堂系统 · 讲义、计分、点名与投屏</p>
      </header>

      <div class="tabs">
        <button :class="{ on: tab === 'student' }" @click="switchTab('student')">学生</button>
        <button :class="{ on: tab === 'teacher' }" @click="switchTab('teacher')">教师</button>
      </div>

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
        <label class="field">
          <span>姓名</span>
          <input v-model.trim="form.name" class="input" placeholder="名单上的姓名" autocomplete="off" />
        </label>
        <p class="note">学号和姓名要和名单一致。登录后只能看到自己的分数。</p>
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
        <p v-if="passwordIsDefault" class="note warn">当前是初始口令，课后记得改掉。</p>
        <button class="btn primary" :disabled="busy || !form.password">
          {{ busy ? '正在登录…' : '进入教师端' }}
        </button>
        <p v-if="err" class="note err">{{ err }}</p>
      </form>

      <footer class="foot">
        <span>{{ studentCount }}</span>
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
const passwordIsDefault = computed(() => state.passwordIsDefault)

// 课程清单走公开接口：登录页还没令牌，但学生得先选课程
const courses = ref([])

async function loadCourses() {
  try {
    const res = await api.get('/api/courses/public')
    courses.value = res.courses || []
    if (courses.value.length && !form.courseId) form.courseId = courses.value[0].id
  } catch (e) {
    courses.value = []
  }
}

// 页脚只报一个总数，不列班级明细：这是公共页面，人来人往
const studentCount = computed(() => {
  const n = courses.value.reduce((s, c) => s + (c.students || 0), 0)
  return n ? courses.value.length + ' 门课，' + n + ' 人次' : ''
})

const form = reactive({ courseId: '', sid: '', name: '', password: '' })

const canSubmit = computed(() => !!(form.courseId && form.sid && form.name))

onMounted(async () => {
  // 已登录就直接进对应的家
  if (state.role === 'teacher') router.replace('/teacher/lecture')
  else if (state.role === 'student') router.replace('/student/materials')
  if (!courses.value.length) await loadCourses()
  if (!state.classes.length) {
    try {
      await refresh()
    } catch (e) {
      /* 服务没起时留空，表单下方会提示 */
    }
  }
  if (courses.value.length && !form.courseId) form.courseId = courses.value[0].id
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
    const res = await api.post('/api/login/student', {
      courseId: form.courseId,
      sid: form.sid,
      name: form.name,
    })
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
    const res = await api.post('/api/login/teacher', { password: form.password })
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
