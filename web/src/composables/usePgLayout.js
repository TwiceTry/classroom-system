/*
 * usePgLayout —— 代码工作台的「分栏排版」
 *
 * 只管三件事：左右/上下排、代码块占多少、代码收不收起。
 * 加上拖动分栏条的交互（拖到两端会自动切布局，这是上课时最常用的手势）。
 *
 * 这三个值**故意不记忆**：学生把分栏拖乱了，刷新就回默认，不用教怎么拖回来。
 */
import { ref, nextTick } from 'vue'

/* 档位少一点：20% 一挡，20 / 40 / 60 / 80 四档 */
const PCT_MIN = 20
const PCT_MAX = 80
const PCT_STEP = 20
const DEFAULT_PCT = 60

/* 老版本把这三项存在本机，现在不记了：进页面顺手清掉，免得旧值留在那儿 */
const LEGACY_KEYS = ['pg-layout', 'pg-code-pct', 'pg-code-hidden']

export function clampPct(v) {
  const n = Number(v)
  if (!isFinite(n)) return 40
  return Math.max(PCT_MIN, Math.min(PCT_MAX, Math.round(n / PCT_STEP) * PCT_STEP))
}

/**
 * @param {object} opts
 * @param {() => any} opts.getEditor 取 CodeMirror 实例（尺寸变了要重新量）
 */
export function usePgLayout(opts = {}) {
  const getEditor = opts.getEditor || (() => null)

  // 上课是「看代码」为主：默认代码块比预览宽一点（60 / 40）
  const layout = ref('row') // row = 左右排；col = 上下排
  const codePct = ref(DEFAULT_PCT)
  const codeHidden = ref(false)

  /** CodeMirror 在容器尺寸变化后要重新量一次，否则会出现「滚动区高度不对 / 空白」 */
  function requestMeasure() {
    const ed = getEditor()
    if (ed && ed.view) ed.view.requestMeasure()
  }

  /** 清掉老版本留下的三个键（只跑一次，失败无所谓） */
  function clearLegacyLayout() {
    try {
      LEGACY_KEYS.forEach((k) => localStorage.removeItem(k))
    } catch (e) {
      /* 隐私模式忽略 */
    }
  }

  function toggleLayout() {
    layout.value = layout.value === 'row' ? 'col' : 'row'
    nextTick(() => requestMeasure())
  }

  function toggleCode() {
    codeHidden.value = !codeHidden.value
    nextTick(() => requestMeasure())
  }

  /**
   * 拖动分栏条（三档行为，全靠横向位移判断）：
   *   代码收起 —— 往右拖 40px 以上：把代码块拉回来
   *   竖排     —— 往左拖 60px 以上：回左右排（「拖到最大变竖排」因此可逆）
   *   左右排   —— 按 20% 一挡改宽度；拖到最宽转竖排，拖到最窄收起
   *
   * 状态完全由「指针在代码区的横向位置」推导，而不是由「走了多少像素」推导：
   * 好处是按住不放一路拖，收起 → 横排 → 竖排 → 再拖回来，全都连续生效。
   */
  function startDrag(e) {
    e.preventDefault()
    const el = e.currentTarget
    const stackEl = el && el.parentElement
    if (!stackEl) return

    const rect = stackEl.getBoundingClientRect()
    const total = rect.width || 1
    const pctAt = (clientX) => ((clientX - rect.left) / total) * 100

    // 用指针捕获：拖动时指针可能跑到 iframe / 别处，收在分栏条上更稳
    try {
      if (el && el.setPointerCapture && e.pointerId !== undefined) el.setPointerCapture(e.pointerId)
    } catch (err) {
      /* 个别浏览器不支持，退回 window 监听 */
    }

    const cleanup = () => {
      el && el.removeEventListener('pointermove', move)
      el && el.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      requestMeasure()
    }

    const move = (ev) => {
      const p = pctAt(ev.clientX)

      // 太靠左：收起代码（继续按住往右拖会自己回来）
      if (p < 8) {
        if (!codeHidden.value) codeHidden.value = true
        return
      }
      // 太靠右：竖排（继续按住往左拖会自己回到横排）
      if (p > 88) {
        if (codeHidden.value) codeHidden.value = false
        if (layout.value !== 'col') layout.value = 'col'
        return
      }

      // 中间：横排 + 挡位
      if (codeHidden.value) codeHidden.value = false
      if (layout.value !== 'row') layout.value = 'row'
      const want = clampPct(p)
      if (codePct.value !== want) codePct.value = want
    }

    if (el) {
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', cleanup)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup)
  }

  return {
    layout,
    codePct,
    codeHidden,
    toggleLayout,
    toggleCode,
    startDrag,
    requestMeasure,
    clearLegacyLayout,
    clampPct,
  }
}
