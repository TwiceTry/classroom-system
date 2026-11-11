/*
 * useFontSize —— 全站一个字号设置
 *
 * 之前是三套：
 *   Lecture.vue     localStorage['lecture-size']    默认 15.5   **从来没 setItem**
 *   Materials.vue   localStorage['materials-size']  默认 15.5   **从来没 setItem**
 *   PgWorkbench     localStorage['pg-font']         默认 13     有存
 *
 * 前两个只读不写，所以 A+ 点一下只改内存，刷新就回到 15.5 —— 这就是「刷新失效」。
 * 而且三个值互不相干，讲义和材料还得各调一遍。
 *
 * 现在统一成一个 sys-fs（正文基准），代码编辑器固定比它小 2px：
 *   正文 15  →  代码 13   （和原来的默认值一致，不会有视觉跳变）
 *   正文 22  →  代码 20
 *
 * 为什么代码不跟正文完全一样大：等宽字体在相同 px 下看起来更宽，正文 15 配代码 13
 * 是原来调好的比例，直接拉平会让代码行变得更长、更容易换行。
 */

import { computed, ref } from 'vue'

const KEY = 'sys-fs'
const MIN = 13
const MAX = 24
const DEF = 15
/** 代码比正文小几 px（原来 15.5 / 13，约等于 2） */
const CODE_GAP = 2

function clamp(n) {
  const v = Number(n)
  if (!isFinite(v)) return DEF
  return Math.min(MAX, Math.max(MIN, Math.round(v)))
}

function read() {
  try {
    return clamp(localStorage.getItem(KEY) || DEF)
  } catch (e) {
    return DEF
  }
}

/** 正文（讲义 / 材料 / 长文本）的字号 */
export const docPx = ref(read())

/** 代码编辑器的字号：跟着正文走，但保持小 2px */
export const codePx = computed(() => Math.max(11, docPx.value - CODE_GAP))

export function setDocPx(n) {
  docPx.value = clamp(n)
  persist()
}

/** 相对调节（A− / A+ / Ctrl+滚轮 都走这里） */
export function adjustDoc(delta) {
  setDocPx(docPx.value + delta)
}

export function resetDocPx() {
  setDocPx(DEF)
}

function persist() {
  try {
    localStorage.setItem(KEY, String(docPx.value))
  } catch (e) {
    /* 存不下就算了：本页仍然生效，只是下次打开回到默认 */
  }
}

/** 给需要在 CSS 里用 var(--doc-fs) 的地方同步一份（App.vue 里挂一次） */
export function bindDocFsToRoot() {
  const apply = () => document.documentElement.style.setProperty('--doc-fs', docPx.value + 'px')
  apply()
  return { apply }
}

/**
 * 组件里用这个：`const { docPx, adjustDoc } = useFontSize()`
 *
 * 返回的是**模块级同一份 ref**（不是每次新建），所以讲义页调大字号，
 * 材料页、代码页下次进入就是同一个值 —— 这就是「全局」的意思。
 */
export function useFontSize() {
  return { docPx, codePx, adjustDoc, setDocPx, resetDocPx }
}
