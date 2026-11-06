/*
 * usePgSync —— 「老师把代码推给全班」
 *
 * 老师点同步 → 当前文件（含之后每次改动）+ 光标 + 预览页 推到服务端；
 * 服务端存一份、广播给全班；学生端收到后**只读跟随**，自己的代码先暂存，
 * 老师点停止时原样还回去。
 *
 * 三条设计约束（都是踩过坑的）：
 *   1) 推是把「屏幕上的样子」整体推上去（file + content + cursor + page），
 *      不是发增量 diff —— 学生端只读，不需要合并。
 *   2) 服务端分配 seq，学生端只接受更大的：网络乱序时旧代码不会盖回新的。
 *   3) 跟随时**绝不落盘**（isFrozen）：否则老师的代码会写进学生自己的存档桶，
 *      学生之后就"停不下来"——他自己那一课被覆盖了。
 */
import { computed, ref, nextTick } from 'vue'
import { api } from '../api'

export function usePgSync(opts) {
  const {
    /** 当前班级 id（ref 或 computed） */
    classId,
    dir,
    activeFile,
    page,
    bundle,
    edits,
    /** props.fixedDir：作业模式锁死了目录，不能切课 */
    fixedDir,
    role,
    /** 编辑器（usePgEditor 的返回值） */
    editor,
    /** 取某个文件的正文 */
    getText,
    /** 学生端：切课（会把这一课自己的存档读回来） */
    loadDir,
    /** 学生端：重跑预览 */
    runPreview,
    /** 学生端：把跟随期间的改动记进存档（跟随时不落盘，停的时候才写） */
    saveLater,
    error,
    autoRun,
  } = opts

  const syncOn = ref(false) // 老师端：正在推
  const following = ref(false) // 学生端：正在跟
  const followFile = ref('')
  let syncTimer = null
  let caretPos = 0
  let stash = null // 学生端：跟随前自己那份 { dir, file, edits }
  let skipFlush = false // 这一次切课时包不落盘
  let lastSeq = 0 // 学生端：收到过的最大 seq

  const canSync = computed(() => role === 'teacher' && !fixedDir)
  const syncTitle = computed(() =>
    !classId.value
      ? '先在侧栏选一个班级'
      : syncOn.value
        ? '停止同步，学生回到自己的代码'
        : '把你正在写的这个文件同步给学生（学生端只读）'
  )

  function syncUrl() {
    return '/api/classes/' + encodeURIComponent(classId.value) + '/pg-sync'
  }

  /* ---------------- 老师端：推 ---------------- */

  /** 真正发一次（把屏幕上的样子整体推上去） */
  function push() {
    if (!syncOn.value || !classId.value || !bundle.value) return
    api
      .post(syncUrl(), {
        dir: dir.value,
        file: activeFile.value,
        page: page.value,
        cursor: caretPos,
        content: getText(activeFile.value),
      })
      .catch(() => {
        /* 推失败不打扰上课，下一次改动会重推 */
      })
  }

  /** 打字时别每个字符推一次：停手 500ms 再发。没在同步时直接返回，调用方不用判断。 */
  function pushSoon() {
    if (!syncOn.value) return
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      syncTimer = null
      push()
    }, 500)
  }

  /** 光标动了（老师端才推，学生端无副作用） */
  function pushCursor(pos) {
    if (typeof pos !== 'number') return
    caretPos = pos
    if (syncOn.value) pushSoon()
  }

  async function toggle() {
    if (syncOn.value) {
      syncOn.value = false
      if (syncTimer) clearTimeout(syncTimer)
      syncTimer = null
      try {
        await api.del(syncUrl())
      } catch (e) {
        if (error) error.value = e.message
      }
      return
    }
    if (!classId.value) {
      if (error) error.value = '先在侧栏选一个班级，再点同步'
      return
    }
    syncOn.value = true
    push()
  }

  /* ---------------- 学生端：跟随 ---------------- */

  /** 把老师那一段应用过来（只读） */
  async function applySync(sync) {
    if (!sync || !sync.file) return
    if (!following.value) {
      // 连「学生正在看哪个文件」一起记住：恢复时连视图一起回到原处，
      // 否则学生会以为自己写的代码丢了（其实只是还在别的文件里）
      stash = { dir: dir.value, file: activeFile.value, edits: Object.assign({}, edits) }
    }
    // 先置位：即使下面因为 bundle 还没加载而提前返回，只读也得先锁上
    // （watch(following) 会去调 editor.setReadOnly）
    following.value = true

    if (sync.dir && sync.dir !== dir.value && !fixedDir) {
      dir.value = sync.dir
      await loadDir() // 会把学生这一课自己的存档读回来，再被下面的老师版本覆盖
    }
    if (!bundle.value) return

    // ① 老师换文件：编辑器跟着跳
    if (sync.file && bundle.value.files.some((f) => f.path === sync.file)) {
      followFile.value = sync.file
      edits[sync.file] = String(sync.content || '')
      if (activeFile.value !== sync.file) activeFile.value = sync.file
      await nextTick()
      editor.setDocText(String(sync.content || ''), typeof sync.cursor === 'number' ? sync.cursor : undefined)
    }

    // ② 老师换预览页（同一课里点左边目录）：右侧画面也跟着跳
    if (sync.page && sync.page !== page.value && bundle.value.files.some((f) => f.path === sync.page)) {
      page.value = sync.page
      if (autoRun && autoRun.value) runPreview()
    }

    editor.setReadOnly(true)
  }

  /** 停止跟随：把学生自己的代码还回去 */
  async function stopFollow() {
    if (!following.value) return
    following.value = false
    followFile.value = ''
    const s = stash
    stash = null
    editor.setReadOnly(false)
    if (!s) return

    // 老师中途换了课：连课一起回到学生原来那一节（他自己那份从本机存档读回）
    if (!fixedDir && s.dir && s.dir !== dir.value) {
      // 关键：此刻内存里的 edits 还是老师的代码，loadDir 开头会 flushEdits，
      // 不挡住就会把老师的代码写进学生「老师那一节课」的存档桶里 —— 之后就"停不掉了"。
      skipFlush = true
      try {
        dir.value = s.dir
        await loadDir()
      } finally {
        skipFlush = false
      }
      if (s.file && activeFile.value !== s.file) activeFile.value = s.file
      editor.syncDoc()
      return
    }

    if (s.dir === dir.value) {
      Object.keys(edits).forEach((k) => delete edits[k])
      Object.assign(edits, s.edits)
      if (s.file && activeFile.value !== s.file) activeFile.value = s.file
      editor.syncDoc()
      if (saveLater) saveLater()
    }
  }

  /**
   * 收到服务端广播（presence 通道）。
   * sync === null 表示老师停了。
   */
  function onMessage(msg) {
    if (!msg || msg.t !== 'pgsync') return
    if (!msg.sync) {
      stopFollow()
      return
    }
    // 只认更新的：乱序到达的旧包直接丢（否则学生的屏幕会闪回上一版）
    const seq = Number(msg.sync.seq) || 0
    if (seq && seq <= lastSeq) return
    if (seq) lastSeq = seq
    // 老师同步期间学生必须跟着：没有「先不听」，想自己写要等老师点停止
    applySync(msg.sync)
  }

  /** 进页面时接上（老师已经在同步的情况下） */
  async function resumeFrom(remote) {
    if (!remote || !remote.file) return
    lastSeq = Number(remote.seq) || 0
    await applySync(remote)
  }

  /** 存档模块用：跟随时或切课瞬间不能往学生桶里写 */
  function isFrozen() {
    return following.value || skipFlush
  }

  return {
    syncOn,
    following,
    followFile,
    canSync,
    syncTitle,
    toggle,
    push,
    pushSoon,
    pushCursor,
    onMessage,
    stopFollow,
    resumeFrom,
    isFrozen,
  }
}
