/*
 * usePgEditor —— CodeMirror 实例的生命周期
 *
 * 这个 composable **不认识存档、预览、同步**：
 * 它只在「内容变了」「光标动了」「该跑了」这三个时机调外部传进来的回调。
 * 谁要听谁自己接（组件里三行说清楚），编辑器和那三块因此可以分开改。
 *
 * 两个容易踩的点：
 *   1) 换课时包时宿主 DOM 会被 v-if 拆掉重建，老实例必须销毁，否则文本区是空的；
 *   2) 编辑器还没建好就 setDoc（宿主刚渲染）要下一帧补一次。
 */
import { reactive, ref, shallowRef, watch, nextTick } from 'vue'
import { createEditor } from '../utils/pgEditor'

export function usePgEditor(opts) {
  const {
    cmHost, // ref<HTMLElement>
    fontPx,
    activeFile, // ref<string>
    bundle, // ref<{files:[{path,text}]}>
    edits, // reactive<Record<string,string>>
    readonly,
    /** 取某个文件的正文（原文件 + 未保存的改动） */
    getText,
    /** 内容变了（打字 / 粘贴） */
    onChange,
    /** 光标动了 */
    onCaret,
    /** 编辑器里按了运行 */
    onRun,
    /** 实例建好之后（换课时包会重建，跟随中要把只读补回去） */
    afterCreate,
  } = opts

  const ed = shallowRef(null)
  const caret = reactive({ line: 1, col: 1 })

  function ensureEditor() {
    if (!cmHost.value) return
    // 宿主换了（换课时包时 v-if 把工作区拆了重建）：老编辑器不能再复用
    if (ed.value && !cmHost.value.contains(ed.value.view.dom)) {
      try {
        ed.value.destroy()
      } catch (e) {
        /* 已经被拆掉也无所谓 */
      }
      ed.value = null
    }
    if (ed.value) return

    ed.value = createEditor(cmHost.value, {
      fontSize: fontPx.value,
      readOnly: readonly,
      onChange(text) {
        // 记「哪个文件被改成了什么」是编辑器自己的账（存档/预览/同步都读 edits）
        if (!activeFile.value) return
        const f = bundle.value && bundle.value.files.find((x) => x.path === activeFile.value)
        // 改回原样＝不算改过，别占存档
        if (f && text === f.text) delete edits[activeFile.value]
        else edits[activeFile.value] = text
        if (onChange) onChange(text)
      },
      onCaret(c) {
        caret.line = c.line
        caret.col = c.col
        if (onCaret) onCaret(c)
      },
      onRun() {
        if (onRun) onRun()
      },
    })

    // 换课时包会重建编辑器：跟随中的话把只读补回去
    if (afterCreate) afterCreate(ed.value)
  }

  function syncDoc() {
    // 编辑器还没建好（宿主刚渲染、或换课时包时工作区被重建）：下一帧补一次，
    // 否则会出现「点了文件但代码块里是空的」
    if (!ed.value) {
      nextTick(() => {
        ensureEditor()
        if (ed.value) syncDoc()
      })
      return
    }
    const text = getText ? getText(activeFile.value) : ''
    ed.value.setDoc(text)
    ed.value.setLanguage(activeFile.value)
    // 兜底：该有内容却是空的（刚重建 / 还没量过），下一帧再设一次
    if (text && ed.value.view.state.doc.length === 0) {
      requestAnimationFrame(() => {
        if (ed.value && ed.value.view.state.doc.length === 0) ed.value.setDoc(text)
      })
    }
  }

  /** 只读开关（跟随老师代码时锁定；停止跟随后放开） */
  function setReadOnly(v) {
    if (ed.value) ed.value.setReadOnly(!!v)
  }

  /** 直接换正文（同步老师代码时用；caret 可选） */
  function setDocText(text, caretPos) {
    if (!ed.value) return
    const cv = ed.value.view
    // 内容没变（只是老师挪了光标）：不要整篇重设，否则学生那边会闪、滚动位置也会跳回顶部
    if (cv && cv.state.doc.toString() === String(text)) {
      if (typeof caretPos === 'number') ed.value.setCaret(caretPos)
      return
    }
    ed.value.setDoc(String(text), typeof caretPos === 'number' ? caretPos : undefined)
    ed.value.setLanguage(activeFile.value)
  }

  function setCaret(pos) {
    if (ed.value && typeof pos === 'number') ed.value.setCaret(pos)
  }

  function gotoLine(n) {
    if (ed.value && ed.value.gotoLine) ed.value.gotoLine(n)
  }

  /** 当前编辑器里的正文（不是 bundle 里的） */
  function currentText() {
    return ed.value ? ed.value.view.state.doc.toString() : ''
  }

  function adjustFont(d) {
    fontPx.value = Math.min(24, Math.max(11, fontPx.value + d))
    try {
      localStorage.setItem('pg-font', String(fontPx.value))
    } catch (e) {
      /* ignore */
    }
    if (ed.value) ed.value.setFontSize(fontPx.value)
  }

  function destroy() {
    if (ed.value) {
      try {
        ed.value.destroy()
      } catch (e) {
        /* ignore */
      }
      ed.value = null
    }
  }

  watch(activeFile, async () => {
    await nextTick()
    syncDoc()
  })

  return {
    ed,
    caret,
    ensureEditor,
    syncDoc,
    setReadOnly,
    setDocText,
    setCaret,
    gotoLine,
    currentText,
    adjustFont,
    destroy,
  }
}
