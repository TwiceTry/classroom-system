/*
 * stuvis.js —— 学生端菜单显不显示某个模块（课堂开关）
 *
 * 为什么单独一个 store：这个开关有两处入口——侧栏菜单项右边的小眼睛、考核方案页每个考核项右边的小眼睛，
 * 两处必须**状态同步**（在同一页里点哪边，另一边立刻跟着变）。所以状态放这里，
 * 两个组件都读同一份；改动先落本地（跟手），再提交服务端（失败回滚）。
 *
 * 它不属于考核方案：改它不动方案版本、不写变更日志、不影响计分。
 * 存服务端 state 表的 stuvis:<courseId>，值为「隐藏了哪些 itemKey」。
 */
import { reactive } from 'vue'
import { api } from '../api'

export const stuvis = reactive({
  courseId: '',
  hidden: [],
  modules: [], // [{ itemKey, title, kind }] 服务端给的可显示模块
  loaded: false,
  loading: false,
  err: '',
})

const listeners = new Set()

/** 订阅变化（组件里用来做「另一个入口变了 → 我也刷新」这类事） */
export function onStuVisChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  for (const fn of listeners) {
    try {
      fn()
    } catch (e) {
      /* 订阅方出错不影响别人 */
    }
  }
}

export function isHidden(key) {
  return stuvis.hidden.indexOf(String(key || '')) >= 0
}

/** 拉一次（换课程 / 首次进入时调；同一门课已加载过就不重复拉） */
export async function loadStuVis(courseId, force) {
  const id = String(courseId || '')
  if (!id) {
    stuvis.courseId = ''
    stuvis.hidden = []
    stuvis.modules = []
    stuvis.loaded = false
    emit()
    return
  }
  if (!force && stuvis.courseId === id && stuvis.loaded) return
  stuvis.courseId = id
  stuvis.loading = true
  stuvis.err = ''
  try {
    const r = await api.get('/api/courses/' + encodeURIComponent(id) + '/stuvis')
    stuvis.hidden = r.hidden || []
    stuvis.modules = r.modules || []
    stuvis.loaded = true
  } catch (e) {
    stuvis.err = e.message
  } finally {
    stuvis.loading = false
    emit()
  }
}

/** 整体覆盖隐藏列表 */
export async function setStuVisHidden(list) {
  const before = stuvis.hidden.slice()
  stuvis.hidden = [...new Set(list.map(String))]
  emit()
  try {
    const r = await api.post('/api/courses/' + encodeURIComponent(stuvis.courseId) + '/stuvis', {
      hidden: stuvis.hidden,
    })
    stuvis.hidden = r.hidden || stuvis.hidden
    stuvis.err = ''
    emit()
  } catch (e) {
    stuvis.hidden = before // 失败回滚，别让界面和服务端不一致
    stuvis.err = e.message
    emit()
    throw e
  }
}

/** 切一个模块：show=true 显示，false 收起 */
export function toggleStuVis(key, show) {
  const k = String(key || '')
  if (!k) return Promise.resolve()
  const set = new Set(stuvis.hidden)
  if (show) set.delete(k)
  else set.add(k)
  return setStuVisHidden([...set])
}

/** 这个模块是不是「对学生有入口」的模块（考勤 / 互动只有教师端，没有学生入口） */
export function hasStudentEntry(mod) {
  if (!mod) return false
  const kind = mod.kind || ''
  return kind !== 'attendance' && kind !== 'manual'
}
