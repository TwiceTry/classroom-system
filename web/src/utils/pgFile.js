/*
 * utils/pgFile.js —— 代码工作台「新建文件」的规则
 *
 * 为什么单独一个文件：这条规则有两个消费方（PgWorkbench 新建时校验、
 * usePgStore 从 localStorage 恢复时校验），两边必须完全一致 ——
 * 否则会出现「能新建但刷新后丢失」或者反过来的怪现象。
 *
 * 只允许**一级文件名**，原因在服务端：
 *   lib/submitstore.js 的 safeName() 会把 / \ : * ? " < > | 全换成 _，
 * 所以提交 "sub/App.vue" 会落盘成 "sub_App.vue" —— 学生那边名字就变了，
 * 老师端看到的文件对不上。与其让它在提交时悄悄改名，不如在输入时就拦住。
 */

/*
 * 一级文件名：中文 / 字母 / 数字 / _ / - 开头，之后允许 . 总长 ≤ 60。
 *
 * 允许中文是因为服务端 safeName() 只替换 \ / : * ? " < > |，中文名一路到底都正常；
 * 学生建「笔记.md」「组件.vue」是自然的事，禁掉反而别扭。
 * （唯一要留意的是中文名参与 import 时浏览器会 URL 编码 —— 那是写法问题，不是规则问题。）
 */
const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-][\u4e00-\u9fa5A-Za-z0-9._-]{0,59}$/

/** Windows 保留名：这些名字写文件会失败或行为诡异（机房全是 Windows） */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** 允许新建的扩展名（只收文本，避免二进制塞进 localStorage） */
const TEXT_EXT = ['.js', '.mjs', '.vue', '.css', '.html', '.htm', '.json', '.md', '.txt', '.svg']

/** 单个新文件上限（字符数，1 个字符≈1 字节 UTF-8 起步） */
export const NEW_FILE_MAX_BYTES = 200 * 1024
/** 一次作业/一课最多新建几个 */
export const NEW_FILE_MAX_COUNT = 20
/** 一个存档桶的总上限 —— localStorage 一个域 5MB，留足余量给别的键 */
export const NEW_FILES_TOTAL_MAX = 1.5 * 1024 * 1024

/** 校验新建的文件名，返回 { ok, why } */
export function checkNewName(name, existingPaths) {
  const p = String(name || '').trim()
  if (!p) return { ok: false, why: '文件名不能为空' }
  if (p.indexOf('/') >= 0 || p.indexOf('\\') >= 0) {
    return { ok: false, why: '只能一级文件名，不能带目录（提交时会变成下划线）' }
  }
  if (p.length > 60) return { ok: false, why: '文件名太长（上限 60 个字符）' }
  if (!NAME_RE.test(p)) return { ok: false, why: '只能字母、数字、点、下划线、短横线，且不能以点开头' }
  if (WIN_RESERVED.test(p)) return { ok: false, why: '这是 Windows 的保留名，换个名字' }
  const dot = p.lastIndexOf('.')
  if (dot <= 0) return { ok: false, why: '要有扩展名，比如 index.js' }
  const ext = p.slice(dot).toLowerCase()
  if (TEXT_EXT.indexOf(ext) < 0) {
    return { ok: false, why: '只能建文本文件：' + TEXT_EXT.join(' ') }
  }
  /* 判重忽略大小写：Windows 上 A.js 与 a.js 是同一个文件 */
  const low = p.toLowerCase()
  if ((existingPaths || []).some((x) => String(x).toLowerCase() === low)) {
    return { ok: false, why: '已经有同名文件了' }
  }
  return { ok: true, why: '' }
}

/** 从 localStorage 恢复时用：这个名字像不像"学生新建的合法文件" */
export function isLegalNewName(p) {
  const s = String(p || '')
  if (s.indexOf('/') >= 0 || s.indexOf('\\') >= 0) return false
  if (!NAME_RE.test(s) || WIN_RESERVED.test(s)) return false
  const dot = s.lastIndexOf('.')
  if (dot <= 0) return false
  return TEXT_EXT.indexOf(s.slice(dot).toLowerCase()) >= 0
}

/** 新建 html 时给个最小骨架 —— 空文件会让预览白屏且报错看不懂 */
export function skeletonFor(name) {
  const ext = String(name).slice(String(name).lastIndexOf('.')).toLowerCase()
  if (ext === '.html' || ext === '.htm') {
    return '<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8" />\n  <title>' +
      String(name).replace(/\.[^.]+$/, '') +
      '</title>\n</head>\n<body>\n  <p>在这里开始写。</p>\n</body>\n</html>\n'
  }
  if (ext === '.vue') {
    return '<template>\n  <div>在这里开始写。</div>\n</template>\n\n<script setup>\n</script>\n'
  }
  if (ext === '.css') return '/* ' + name + ' */\n'
  if (ext === '.md') return '# ' + String(name).replace(/\.md$/i, '') + '\n'
  if (ext === '.json') return '{\n}\n'
  return ''
}
