/*
 * errorBus —— 把「界面异常」集中记一份，方便老师截图/发我时一次说清
 *
 * main.js 的 app.config.errorHandler 会往这里塞（事件处理、异步里没 catch 的异常），
 * ErrorBoundary 也会塞（渲染期异常）。控制台里用 __uiErrors 就能看到最近 10 条。
 */
import { ref } from 'vue'

export const uiErrors = ref([])

export function pushError(text) {
  const s = String(text || '').trim()
  if (!s) return
  uiErrors.value = [s].concat(uiErrors.value).slice(0, 10)
  try {
    window.__uiErrors = uiErrors.value
  } catch (e) {
    /* 忽略 */
  }
}
