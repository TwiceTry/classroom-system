/*
 * scheme.js（前端）—— 当前考核方案 + 可用模块
 *
 * 服务端 /api/scheme 把「方案」解析成界面要的东西：考核项、可用模块（含路由）、总分及格线。
 * 导航、抽屉里的「去模块评分」、页面守卫都读这一份 —— 方案里关掉一个模块，
 * 三处同时消失，不会出现「按钮没了但地址还能进」。
 *
 * 只读缓存：进布局时 force 拉一次（老师刚改完方案刷新页面就能看到）。
 */
import { reactive } from 'vue'
import { api } from '../api'

export const scheme = reactive({
  loaded: false,
  loading: false,
  error: '',
  id: '',
  name: '',
  version: 0,
  totalFull: 100,
  passLine: 60,
  cap: 100,
  items: [],
  modules: [],
})

let inflight = null

export async function loadScheme(force) {
  if (scheme.loaded && !force) return scheme
  if (inflight) return inflight
  inflight = (async () => {
    scheme.loading = true
    try {
      const res = await api.get('/api/scheme')
      const s = res.scheme || {}
      scheme.id = s.id || ''
      scheme.name = s.name || ''
      scheme.version = s.version || 0
      scheme.totalFull = s.totalFull || 100
      scheme.passLine = s.passLine || 60
      scheme.cap = s.cap || 100
      scheme.items = res.items || []
      scheme.modules = res.modules || []
      scheme.loaded = true
      scheme.error = ''
    } catch (e) {
      scheme.error = e.message
    } finally {
      scheme.loading = false
      inflight = null
    }
  })()
  return inflight
}

/** 某个考核项有没有模块（抽屉里决定显示「记分」还是「去模块评分」） */
export function moduleForItem(itemKey) {
  return scheme.modules.find((m) => m.itemKey === itemKey) || null
}

/** 某个 kind（work / project）的模块在不在 */
export function moduleForKind(kind) {
  return scheme.modules.find((m) => m.kind === kind) || null
}

/** 模块图标：交代码的用「夹板」，交材料的用「箱子」 */
/*
 * 模块图标按「采集形态」给，别按交什么东西给 ——
 * 都是交文件的作业/机试/大作业，图标却应该是作业本、试卷、文件夹。
 */
const ICON_BY_FORM = {
  attendance: 'clipboard-check',
  manual: 'chat',
  graded: 'file-code',
  rubric: 'folder-star',
  paper: 'paper',
}

export function moduleIcon(m) {
  if (!m) return 'box'
  if (ICON_BY_FORM[m.form]) return ICON_BY_FORM[m.form]
  return m.submit === 'code' ? 'file-code' : 'box'
}
