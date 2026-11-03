/*
 * classSel —— 全局「当前班级」
 *
 * 课程是最高一级（api.js 的 courseId），班级挂在课程下面。
 * 侧栏的班级下拉和各页面（计分 / 考勤 / 互动 / 班级管理）共用这一个值：
 *   · 侧栏切班级 → 页面上如果已经打开，靠同一个 ref 同步（不用刷新）
 *   · 页面里点班级 chip → 写回这里，侧栏跟着变
 * 存 localStorage，刷新/换页都记得；课程换了以后由侧栏校验「这个班还属不属于这门课」。
 */
import { ref } from 'vue'

const KEY = 'teach-system-class'

function read() {
  try {
    return localStorage.getItem(KEY) || ''
  } catch (e) {
    return ''
  }
}

export const currentClassId = ref(read())

export function getClassId() {
  return currentClassId.value || read()
}

export function setClassId(id) {
  const v = String(id || '')
  currentClassId.value = v
  try {
    if (v) localStorage.setItem(KEY, v)
    else localStorage.removeItem(KEY)
  } catch (e) {
    /* 隐私模式忽略 */
  }
}
