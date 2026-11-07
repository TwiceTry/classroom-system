/*
 * usePgPreview —— 代码工作台的「右侧预览」
 *
 * 干三件事：
 *   1) 把当前文件拼成一份 srcdoc 塞进 iframe（改一下就重跑）
 *   2) 把 iframe 里的报错抓回来（脚本错误 / Promise 拒绝 / 资源 404）
 *   3) 重跑时保住滚动位置 —— 否则自动运行一开，学生刚滚到的位置每次都弹回顶部
 *
 * 第 3 条最容易漏：srcdoc 一换 iframe 等于重新加载，滚动必然归零。
 */
import { computed, ref } from 'vue'
import { buildPreviewDoc, ensureSfcSrcdoc } from '../utils/pgPreview'

export function usePgPreview(opts) {
  const {
    frame,
    bundle,
    page,
    dir,
    allFiles,
    npmPage,
    error,
    running,
    activeFile,
    getEditor,
    /** 跳到某个文件（换文件 + 同步编辑器内容） */
    onOpenFile,
  } = opts

  const pageErrors = ref([]) // 一条一个对象 { id, kind, name, msg, loc, line, file, frames }
  const copied = ref(false) // 「复制」按钮的短暂回执
  const resOpen = ref(false)
  let pageErrSeq = 0
  let copyTimer = null
  let runTimer = null

  /*
   * 预览区的滚动位置：srcdoc 一换，iframe 等于重新加载，滚动必然回到顶部。
   * 自动运行是「改一下就重跑」的，所以必须在重载后把位置放回去 ——
   * 只有换页面 / 换课时才从头开始（那是真的换内容了）。
   */
  let pendingScroll = null
  let lastRunPage = ''

  /* ---------------- 运行 ---------------- */

  function scheduleRun() {
    if (runTimer) clearTimeout(runTimer)
    runTimer = setTimeout(run, 700)
  }

  /** 把 iframe 里的路径裁成「本课里的文件名」，一眼看得出是哪个文件 */
  function shortFile(f) {
    const str = String(f || '')
    if (!str || str === 'about:srcdoc' || str === 'srcdoc') return ''
    const m = str.match(/\/([^/]+)$/)
    return m ? decodeURIComponent(m[1]) : str
  }

  /** 调用栈只留「哪个文件第几行」那几行，且把长地址裁短 */
  function tidyStack(stack, fallbackFile) {
    const lines = String(stack || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^at |^\w*Error/.test(l))
    const keep = lines
      .filter((l) => /\/examples\/|srcdoc|:\d+:\d+/.test(l))
      .map((l) => l.replace(/https?:\/\/[^/]+/g, '').replace(/about:srcdoc/gi, fallbackFile || '页面'))
      .slice(0, 4)
    return keep.length ? keep : lines.slice(0, 3)
  }

  function onFrameMessage(e) {
    const d = e.data
    if (!d || !d.__pg) return
    if (e.source !== (frame.value && frame.value.contentWindow)) return

    const kind = d.kind || 'error'
    const msg = String(d.m || '未知错误').trim()
    const file = shortFile(d.f)
    const line = Number(d.l) || 0
    const col = Number(d.c) || 0

    // 同一轮里重复报同一个错（比如每次重跑都报），只留一条
    const dup = pageErrors.value.some((x) => x.msg === msg && x.line === line && x.kind === kind)
    if (dup) return

    const entry = {
      id: ++pageErrSeq,
      kind,
      name: String(d.name || ''),
      msg,
      file,
      line,
      col,
      loc: line
        ? file
          ? file + ' · 第 ' + line + ' 行' + (col ? '，第 ' + col + ' 列' : '')
          : '第 ' + line + ' 行' + (col ? '，第 ' + col + ' 列' : '')
        : '',
      frames: tidyStack(d.stack, file),
    }
    // 代码报错插到最前面（资源类的往后排）
    if (kind !== 'resource') {
      const at = pageErrors.value.findIndex((x) => x.kind === 'resource')
      if (at < 0) pageErrors.value.push(entry)
      else pageErrors.value.splice(at, 0, entry)
    } else {
      pageErrors.value.push(entry)
    }
    // 只留最近 6 条，避免一个循环报错把面板刷爆
    if (pageErrors.value.length > 6) pageErrors.value.splice(0, pageErrors.value.length - 6)
  }

  /* 代码报错（要认真看）与资源报错（示例图片 404，多数与代码无关）分开展示 */
  const codeErrors = computed(() => pageErrors.value.filter((e) => e.kind !== 'resource'))
  const resErrors = computed(() => pageErrors.value.filter((e) => e.kind === 'resource'))

  function kindLabel(e) {
    if (e.kind === 'reject') return 'Promise'
    if (e.kind === 'console') return 'console'
    if (e.kind === 'resource') return '资源'
    return '脚本'
  }

  function clearErrors() {
    pageErrors.value = []
  }

  async function jumpToError(e) {
    if (!e.line) return
    if (e.file && bundle.value && e.file !== activeFile.value) {
      const hit = bundle.value.files.find((f) => f.path === e.file || f.path.endsWith('/' + e.file))
      if (hit) {
        activeFile.value = hit.path
        if (onOpenFile) await onOpenFile()
      }
    }
    const ed = getEditor && getEditor()
    if (ed && ed.gotoLine) ed.gotoLine(e.line)
  }

  function flashCopied() {
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copied.value = false), 1500)
  }

  async function copyErrors() {
    const text = pageErrors.value
      .map(
        (e) =>
          kindLabel(e) + ': ' + e.msg + (e.loc ? '\n  ' + e.loc : '') + (e.frames.length ? '\n  ' + e.frames.join('\n  ') : '')
      )
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      flashCopied()
    } catch (err) {
      /* 剪贴板被拒（http 环境）：退回老办法 */
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
        flashCopied()
      } catch (e2) {
        copied.value = false
      }
      ta.remove()
    }
  }

  /** 读预览区当前的滚动位置（滚动元素可能是 body / documentElement） */
  function readFrameScroll() {
    try {
      const w = frame.value && frame.value.contentWindow
      if (!w) return null
      const d = w.document
      const se = d.scrollingElement || d.documentElement || d.body
      return { x: se ? se.scrollLeft : 0, y: se ? se.scrollTop : 0 }
    } catch (e) {
      return null
    }
  }

  /** 把滚动位置放回去（布局可能还在变，隔一帧再补一次） */
  function applyFrameScroll(pos) {
    if (!pos) return
    const put = () => {
      try {
        const w = frame.value && frame.value.contentWindow
        if (!w) return
        const d = w.document
        const se = d.scrollingElement || d.documentElement || d.body
        if (se) {
          se.scrollLeft = pos.x
          se.scrollTop = pos.y
        }
        if (typeof w.scrollTo === 'function') w.scrollTo(pos.x, pos.y)
      } catch (e) {
        /* 拿不到就算了 */
      }
    }
    put()
    requestAnimationFrame(put)
  }

  function onFrameLoad() {
    if (!pendingScroll) return
    applyFrameScroll(pendingScroll)
    pendingScroll = null
  }

  async function run() {
    if (!bundle.value || !page.value) return
    error.value = ''
    pageErrors.value = []
    if (npmPage.value) {
      running.value = false
      return
    }
    if (!frame.value) return
    // 同一个页面重跑（打字自动运行）：记住当前位置，加载完放回去；换页面则从顶部开始
    pendingScroll = page.value === lastRunPage ? readFrameScroll() : null
    lastRunPage = page.value
    try {
      await ensureSfcSrcdoc()
      /*
       * base 指向 /api/example-files/ 而不是 /examples/：
     * （运行时库已搬到 /lib/，绝对路径，不走 base）
       * 示例页面里的 `../vue.global.js`、`../playground/sfc-boot.js` 是**共享运行时**
       * （放在「代码示例/」根目录，不在每个示例目录里）。
       * base 指错地方，这些 script 会落到 SPA 兜底拿回 index.html，
       * 浏览器报 `Unexpected token '<'`，所有 Vue 示例都渲染成空白。
       * 内存文件字典仍然优先（学生改动走内存），没命中的才走这个接口。
       */
      frame.value.srcdoc = buildPreviewDoc(allFiles.value, page.value, '/api/example-files/' + encodeURI(dir.value) + '/')
      running.value = true
    } catch (e) {
      error.value = '预览失败：' + e.message
      running.value = false
    }
  }

  /** 卸载时清掉待触发的定时器（否则组件销毁后还会跑一次 run） */
  function dispose() {
    if (runTimer) {
      clearTimeout(runTimer)
      runTimer = null
    }
    if (copyTimer) {
      clearTimeout(copyTimer)
      copyTimer = null
    }
  }

  return {
    pageErrors,
    copied,
    resOpen,
    codeErrors,
    resErrors,
    kindLabel,
    clearErrors,
    jumpToError,
    copyErrors,
    readFrameScroll,
    applyFrameScroll,
    onFrameLoad,
    onFrameMessage,
    scheduleRun,
    run,
    dispose,
  }
}
