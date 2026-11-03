import { createRouter, createWebHistory } from 'vue-router'
import { getToken } from './api'

const routes = [
  { path: '/login', component: () => import('./views/Login.vue'), meta: { public: true } },
  // 投屏观看页：不套布局（kiosk 全屏用），但必须已登录 —— 否则教师端的「在看」统计没法对上人
  { path: '/watch', component: () => import('./views/Watch.vue'), meta: { bare: true } },

  {
    path: '/teacher',
    component: () => import('./views/TeacherLayout.vue'),
    meta: { role: 'teacher' },
    children: [
      { path: '', redirect: '/teacher/lecture' },
      { path: 'lecture', component: () => import('./views/teacher/Lecture.vue') },
      { path: 'screen', component: () => import('./views/teacher/Screen.vue') },
      { path: 'scores', redirect: { path: '/teacher/classes' } },
      // 点名已并入计分管理，老链接直接跳过去
      { path: 'rollcall', redirect: { path: '/teacher/classes' } },
      { path: 'courses', component: () => import('./views/teacher/Courses.vue') },
      { path: 'classes', component: () => import('./views/teacher/Classes.vue') },
      { path: 'attendance', redirect: '/teacher/modules/attend' },
      // 模块入口：一个模块 = 考核方案里的一个考核项（课堂作业 / 大作业 / 机试 / 以后新加的）
      { path: 'modules/:itemKey', component: () => import('./views/teacher/ModuleHost.vue') },
      // 老地址留着重定向，书签和已经发出去的链接不会失效
      { path: 'assignments', redirect: '/teacher/modules/homework' },
      { path: 'projects', redirect: '/teacher/modules/project' },
      { path: 'scheme', component: () => import('./views/teacher/Scheme.vue') },
      { path: 'playground', component: () => import('./views/Playground.vue') },
    ],
  },
  {
    path: '/student',
    component: () => import('./views/StudentLayout.vue'),
    meta: { role: 'student' },
    children: [
      { path: '', redirect: '/student/materials' },
      { path: 'materials', component: () => import('./views/student/Materials.vue') },
      { path: 'score', component: () => import('./views/student/MyScore.vue') },
      // 模块入口（跟教师端同构：由考核方案决定有哪些模块）
      { path: 'modules/:itemKey', component: () => import('./views/student/ModuleHost.vue') },
      { path: 'modules/:itemKey/:id', component: () => import('./views/student/ModuleWorkHost.vue') },
      { path: 'assignments', redirect: '/student/modules/homework' },
      { path: 'projects', redirect: '/student/modules/project' },
      // 老地址：做题页 / 提交页也按模块走（/:id 是作业 id）
      { path: 'assignments/:id', redirect: (to) => '/student/modules/homework/' + to.params.id },
      { path: 'projects/:id', redirect: (to) => '/student/modules/project/' + to.params.id },
      { path: 'playground', component: () => import('./views/Playground.vue') },
      // 课堂投屏：放在应用里（同标签页），页内有「全屏 / 新标签页打开」
      { path: 'watch', component: () => import('./views/student/ClassWatch.vue') },
    ],
  },

  { path: '/', redirect: '/login' },
  { path: '/:pathMatch(.*)*', redirect: '/login' },
]

const router = createRouter({ history: createWebHistory(), routes })

// 身份校验放在前端只为体验（不让人误入别人的页），真正的权限在服务端按令牌判
router.beforeEach((to) => {
  const token = getToken()
  const role = localStorage.getItem('teach-system-role') || ''

  if (to.meta.public) return true
  if (!token) return { path: '/login', query: { next: to.fullPath } }
  if (to.meta.role && role && to.meta.role !== role) {
    return role === 'teacher' ? '/teacher/lecture' : '/student/materials'
  }
  return true
})

export default router
