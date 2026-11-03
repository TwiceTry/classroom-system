/*
 * store.js —— 全局会话与启动数据
 *
 * 只有这里存「跨页共享」的东西：身份、课程清单、班级清单、计分项定义。
 * 页面内的一次性数据（某班流水、某次抽取结果）留在各自组件里，避免越滚越大。
 */
import { reactive } from 'vue'
import { api, getToken, setToken, unauthorized } from './api'

// 角色另存一份在 localStorage：路由守卫要同步判断，不能等接口回来
const ROLE_KEY = 'teach-system-role'

function saveRole(role) {
  try {
    if (role) localStorage.setItem(ROLE_KEY, role)
    else localStorage.removeItem(ROLE_KEY)
  } catch (e) {
    /* ignore */
  }
}

export const state = reactive({
  ready: false,
  bootError: '',
  role: '', // 'teacher' | 'student'
  student: null, // { sid, name, classId, className }
  lessons: [],
  classes: [],
  items: [],
  passwordIsDefault: false,
  cast: null,
})

export async function bootstrap() {
  if (!getToken()) {
    state.ready = true
    return
  }
  try {
    const me = await api.get('/api/me')
    const data = await api.get('/api/bootstrap')
    state.role = me.role
    saveRole(me.role)
    // 课程名：接口优先，其次本地上次登录时存的（老数据 / 接口没带时兜一下）
    if (me.student && !me.student.courseName) {
      try {
        const cached = localStorage.getItem('teach-system-course-name')
        if (cached) me.student.courseName = cached
      } catch (e) {
        /* 隐私模式忽略 */
      }
    }
    state.student = me.student || null
    state.lessons = data.lessons || []
    state.classes = data.classes || []
    state.items = data.items || []
    state.passwordIsDefault = !!data.passwordIsDefault
    state.cast = data.cast || null
    state.ready = true
  } catch (e) {
    // 令牌过期 / 服务没起：清掉令牌回登录页，别把用户卡在转圈上
    setToken('')
    saveRole('')
    state.role = ''
    state.student = null
    state.bootError = e.message
    state.ready = true
  }
}

/** 登录成功后刷新全量启动数据 */
export async function refresh() {
  const data = await api.get('/api/bootstrap')
  state.lessons = data.lessons || []
  state.classes = data.classes || []
  state.items = data.items || []
  state.passwordIsDefault = !!data.passwordIsDefault
  state.cast = data.cast || null
}

export function applyLogin(res) {
  setToken(res.token)
  saveRole(res.role)
  state.role = res.role
  state.student = res.student || null
  // 学生一登录就锁定到自己那门课：之后所有 /api 请求都带这个 courseId
  if (res.role === 'student' && res.student && res.student.courseId) {
    try {
      localStorage.setItem('teach-system-course', res.student.courseId)
      localStorage.setItem('teach-system-course-name', res.student.courseName || '')
    } catch (e) {
      /* 隐私模式忽略 */
    }
  }
}

export async function logout() {
  try {
    await api.post('/api/logout')
  } catch (e) {
    /* 尽力而为 */
  }
  setToken('')
  saveRole('')
  state.role = ''
  state.student = null
}

unauthorized.handler = () => {
  setToken('')
  saveRole('')
  state.role = ''
  state.student = null
}

/** 班级名（用于教师端顶栏） */
export function className(id) {
  const c = state.classes.find((x) => x.id === id)
  return c ? c.name : ''
}

const HOME = { teacher: '/teacher/lecture', student: '/student/materials' }
export function homeOf(role) {
  return HOME[role] || '/login'
}
