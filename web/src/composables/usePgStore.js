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
import { isLegalNewName, NEW_FILE_MAX_COUNT, NEW_FILES_TOTAL_MAX } from '../utils/pgFile'

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
    /*
     * 用 saved.dir 记账（它记的是「当前 edits 属于哪个目录」，切目录时才对得上）。
     * 但新建文件可能发生在 saved.dir 还没赋值之前（bundle 刚加载完那一刻），
     * 早先这里直接 return，结果就是「刚新建的文件没存上，刷新就没了」。
     * 用 dir.value 兜底：两者都空才真的放弃。
     */
    const d = saved.dir || dir.value
    if (!d) return
    try {
      const key = storeKey(d)
      if (!Object.keys(edits).length) {
        /*
         * 只有「目录已经确认」时才允许删键。
         *
         * 因为 loadDir() 的顺序是：flushEdits() → 清空 edits → restoreEdits()，
         * 刷新页面时第一次进来 edits 是空的，如果这时就删键，
         * 上一次存的东西会在恢复之前被整条清掉 —— 表现是「改了/新建的东西
         * 刷新一下全没了」，而且刷新越勤丢得越干净。
         */
        if (saved.dir) localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, JSON.stringify(edits))
      }
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
      /*
       * 除了「包里真有的文件」，还要恢复**学生自己新建的那些** ——
       * 否则新建一个 style.css，关掉浏览器再打开就没了，比不给新建更伤。
       *
       * 但不能照单全收：edits 存在 localStorage 里，F12 就能改，
       * 可能被塞进 '../../xxx' 或者 50MB 的字符串。所以：
       *   · 名字必须合法（一级、白名单扩展名、非 Windows 保留名）
       *   · 数量与总量有上限，超出的直接不恢复，并把 storeFail 打开
       *     （界面上会显示「本机存不下」，比静默丢一部分更诚实）
       */
      let newCount = 0
      let newBytes = 0
      for (const p in got) {
        if (typeof got[p] !== 'string') continue
        const known = files.some((f) => f.path === p)
        if (!known) {
          if (!isLegalNewName(p)) continue
          if (newCount >= NEW_FILE_MAX_COUNT || newBytes + got[p].length > NEW_FILES_TOTAL_MAX) {
            storeFail.value = true
            continue
          }
          newCount++
          newBytes += got[p].length
        }
        edits[p] = got[p]
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
