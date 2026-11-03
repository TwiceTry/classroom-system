/*
 * pgEditor.js —— 把 CodeMirror 6 包成一个最小的「创建/换语言/换字号/换文档」接口
 *
 * 之前 Playground 用的是 <textarea> + 一个 <pre> 假行号：没有语法高亮、没有括号匹配、
 * 没有自动缩进、没有折叠、不能搜索——和 代码示例/playground 那份独立版比是倒退。
 * 独立版的高亮是自己写的正则着色，够用但只有 4 种 token 色；这里换成 CodeMirror 6。
 *
 * 只用 CM6 的官方包，全部走 npm 装进 bundle：运行时仍然零网络请求，
 * 断网的机房也能用（这是这个项目的硬约束，不能用任何 CDN）。
 */
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, rectangularSelection, crosshairCursor, placeholder } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { oneDark } from '@codemirror/theme-one-dark'

const EXT_LANG = (path) => {
  const p = String(path || '')
  const i = p.lastIndexOf('.')
  return i < 0 ? '' : p.slice(i).toLowerCase()
}

/** 按扩展名挑语言；.vue 用 html 语言，它内置了 <script>/<style> 的嵌套着色 */
function languageFor(path) {
  const e = EXT_LANG(path)
  if (e === '.vue') return html({ matchClosingTags: true, autoCloseTags: true })
  if (e === '.html' || e === '.htm') return html({ matchClosingTags: true, autoCloseTags: true })
  if (e === '.css') return css()
  if (e === '.md') return []
  return javascript()
}

export function langNameFor(path) {
  const e = EXT_LANG(path)
  if (e === '.vue') return 'Vue SFC'
  if (e === '.html' || e === '.htm') return 'HTML'
  if (e === '.css') return 'CSS'
  if (e === '.json') return 'JSON'
  if (e === '.md') return 'Markdown'
  return 'JavaScript'
}

function fontTheme(px) {
  return EditorView.theme({
    '&': { fontSize: px + 'px' },
    '.cm-content': { fontFamily: 'Consolas, "Cascadia Mono", "JetBrains Mono", monospace' },
    '.cm-gutters': { fontFamily: 'Consolas, "Cascadia Mono", monospace' },
    '.cm-scroller': { lineHeight: '1.6' },
  })
}

/**
 * @param {HTMLElement} parent
 * @param {Object} opts
 *   opts.fontSize   初始字号
 *   opts.onChange   (text) => void    用户编辑时回调（程序 setDoc 不触发）
 *   opts.onCaret    ({line, col, chars}) => void
 *   opts.onRun      () => void        Ctrl+S / Ctrl+Enter
 *   opts.readOnly   只读（教师看学生提交的代码时用：能选中能搜索，改不动）
 * @returns {{ view, setDoc, setLanguage, setFontSize, setReadOnly, focus, destroy }}
 */
export function createEditor(parent, opts) {
  const o = opts || {}
  const langComp = new Compartment()
  const fontComp = new Compartment()
  const roComp = new Compartment()
  const RO_EXTS = [EditorState.readOnly.of(true), EditorView.editable.of(false)]
  let applying = false
  let fontPx = o.fontSize || 13

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: false }),
        foldGutter(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorState.tabSize.of(2),
        indentUnit.of('  '),
        oneDark,
        fontComp.of(fontTheme(fontPx)),
        roComp.of(o.readOnly ? RO_EXTS : []),
        langComp.of([]),
        placeholder('这里还没有文件'),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (o.onRun ? (o.onRun(), true) : false) },
          { key: 'Mod-Enter', preventDefault: true, run: () => (o.onRun ? (o.onRun(), true) : false) },
          { key: 'Mod-/', run: toggleComment },
          indentWithTab,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !applying && o.onChange) o.onChange(u.state.doc.toString())
          if ((u.selectionSet || u.docChanged) && o.onCaret) {
            const pos = u.state.selection.main.head
            const line = u.state.doc.lineAt(pos)
            o.onCaret({
              line: line.number,
              col: pos - line.from + 1,
              chars: u.state.doc.length,
              pos, // 字符偏移：同步给别人时用这个，比「第几行第几列」稳
            })
          }
        }),
      ],
    }),
  })

  // Ctrl + 滚轮调字号：独立版有这手感，习惯了的老师会一直用
  view.scrollDOM.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const next = Math.min(24, Math.max(11, fontPx + (e.deltaY < 0 ? 1 : -1)))
      if (next !== fontPx) api.setFontSize(next)
    },
    { passive: false }
  )

  const api = {
    view,
    /** 整篇替换；给了 caret 就把光标放到那个位置（老师同步过来时用） */
    setDoc(text, caret) {
      const cur = view.state.doc.toString()
      const hasCaret = typeof caret === 'number' && caret >= 0
      if (cur === text) {
        if (hasCaret) api.setCaret(caret)
        return
      }
      applying = true
      const pos = hasCaret ? Math.min(caret, String(text || '').length) : 0
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text || '' },
        selection: { anchor: pos },
        effects: hasCaret ? EditorView.scrollIntoView(pos, { y: 'center' }) : [],
      })
      if (!hasCaret) view.scrollDOM.scrollTop = 0
      applying = false
    },

    /** 跳到第 n 行开头并滚到视野中间（报错面板「跳到第 N 行」用） */
    gotoLine(n) {
      const line = Math.max(1, Math.min(Math.round(Number(n) || 1), view.state.doc.lines))
      const at = view.state.doc.line(line).from
      view.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: 'center' }),
      })
      view.focus()
    },

    /** 把光标移到 pos 并滚到视野中间（不触发 onChange） */
    setCaret(pos) {
      const max = view.state.doc.length
      const at = Math.max(0, Math.min(Number(pos) || 0, max))
      view.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: 'center' }),
      })
    },
    setLanguage(path) {
      view.dispatch({ effects: langComp.reconfigure(languageFor(path)) })
    },
    setFontSize(px) {
      fontPx = px
      view.dispatch({ effects: fontComp.reconfigure(fontTheme(px)) })
      view.requestMeasure()
    },
    setReadOnly(v) {
      view.dispatch({ effects: roComp.reconfigure(v ? RO_EXTS : []) })
    },
    focus() {
      view.focus()
    },
    destroy() {
      view.destroy()
    },
  }
  return api
}
