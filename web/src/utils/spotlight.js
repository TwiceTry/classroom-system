/*
 * spotlight.js —— 点名浮层的教师端偏好
 *
 * 只有一个开关：点名时是否「锁定」学生端浮层（学生点不掉，等老师结束这次点名）。
 *   · 默认锁定：点名的意义就是让那个人应一声，学生自己关掉就没意义了；
 *   · 允许关闭：随堂小提问、或者老师只是随手抽一个时，学生看完可以自己收。
 * 放在 localStorage 里，全站（考勤页 / 课堂互动页）共用一个值。
 */
import { ref } from 'vue'

const KEY = 'teach-spot-lock'

function read() {
  try {
    return localStorage.getItem(KEY) !== '0' // 没设过 = 默认锁定
  } catch (e) {
    return true
  }
}

export const spotLock = ref(read())

export function setSpotLock(on) {
  spotLock.value = !!on
  try {
    localStorage.setItem(KEY, spotLock.value ? '1' : '0')
  } catch (e) {
    /* 隐私模式忽略 */
  }
}
