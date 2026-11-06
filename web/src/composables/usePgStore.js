/*
 * usePgStore —— 代码工作台的「本机存档」
 *
 * 同学的代码只存在自己这台机器的浏览器里：刷新、关掉浏览器、晚上关机，再打开还在。
 * 按「身份 + 目录」分桶存：谁登录谁的那一份，机房共用一台机器也不串。
 *
 * 两条容易踩的规矩：
 *   1) 跟随时（屏幕上是老师的代码）**不能落盘**，否则学生自己那一课被覆盖；
 *   2) 切目录要先把上一目录存回去，再把新目录读回来 —— 顺序反了会丢改动。
 */
import { ref } from 'vue'
import { state } from '../store'

export function usePgStore(opts) {
  const { bucket, edits, dir, bundle, isFrozen } = opts

  const storeFail = ref(false) // 存不下（配额满 / 浏览器禁了 localStorage）

  // 这两个是「记账」用的普通对象，不需要响应式
  const saved = {
    dir: '', // 当前 edits 属于哪个目录（切目录时要存回原来那个桶）
    scope: '', // 当前 edits 属于谁：进页面时定下来，退出登录把 state 清空了也不影响落盘
  }

  let saveTimer = null

  function scopeOf() {
    const s = state.student
    const raw =
      state.role === 'student' && s && s.sid
        ? 's-' + (s.classId || 'c') + '-' + s.sid
        : state.role === 'teacher'
          ? 't'
          : 'guest'
    return raw.replace(/[^0-9a-zA-Z_-]/g, '_')
  }

  function storeKey(d) {
    return bucket() + '-edits:' + (saved.scope || scopeOf()) + ':' + d
  }

  /** 记住「上次在看哪个页面」：键名同样带 bucket，作业之间不串 */
  function pageKey(d) {
    return bucket() + '-page-' + d
  }

  /** 把当前 edits 写回 localStorage（空表就删键，别留垃圾） */
  function flushEdits() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    // 跟随时屏幕上是老师的代码：不能写进学生自己的存档桶
    if (isFrozen && isFrozen()) return
    if (!saved.dir) return
    try {
      const key = storeKey(saved.dir)
      if (!Object.keys(edits).length) localStorage.removeItem(key)
      else localStorage.setItem(key, JSON.stringify(edits))
      storeFail.value = false
    } catch (e) {
      storeFail.value = true // 配额满了：内存里照常编辑，只是这次存不下
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushEdits, 400)
  }

  /** 切目录时把上一目录的存档读回来（只认当前包里真有的文件，防止旧存档串进新版本） */
  function restoreEdits() {
    storeFail.value = false
    try {
      const raw = localStorage.getItem(storeKey(dir.value))
      if (!raw) return
      const got = JSON.parse(raw)
      if (!got || typeof got !== 'object') return
      const files = (bundle.value && bundle.value.files) || []
      for (const p in got) {
        if (typeof got[p] !== 'string') continue
        if (files.some((f) => f.path === p)) edits[p] = got[p]
      }
    } catch (e) {
      storeFail.value = true
    }
  }

  /** 清空某个目录的存档 */
  function clearSaved(d) {
    try {
      localStorage.removeItem(storeKey(d || dir.value))
    } catch (e) {
      /* ignore */
    }
  }

  return { storeFail, saved, scopeOf, storeKey, pageKey, flushEdits, scheduleSave, restoreEdits, clearSaved }
}
