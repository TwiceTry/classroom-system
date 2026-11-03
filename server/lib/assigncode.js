'use strict'
/*
 * assigncode.js —— 课堂作业自带的代码（不再借用「代码示例/第NN课」）
 *
 * 为什么要独立：课堂作业是「这一节课的一次练习」，它有自己的起手代码，不该跟讲义那套
 * 示例目录绑在一起（示例是教学示例，作业是作业，改一个不该动另一个）。
 *
 * 存放：data/assignments/<作业 id>/code/…     （课程级，与班级无关）
 * 学生端仍然用同一套工作台（代码编辑 + 实时渲染），只是它读到的是这里，
 * 而不是 content/代码示例/<课>/ —— 对前端来说只是换了一个 dir 名字：
 *
 *    @a:<作业 id>              作业的起手代码（学生编辑的起点）
 *    @s:<作业 id>:<提交 id>    某个学生那次提交的快照（老师审阅 / 学生回看）
 *
 * 这两个「虚拟目录」由 /api/examples/:dir 解析，PgWorkbench 一行都不用改。
 */
const fs = require('fs')
const path = require('path')
const config = require('../config')

const MAX_TEXT = 512 * 1024 // 单个文件读进编辑器的上限
const TEXT_EXT = new Set([
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.css',
  '.json',
  '.vue',
  '.md',
  '.txt',
  '.svg',
])

const BLANK = {
  'index.html': `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>课堂作业</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1>课堂作业</h1>
    <p>改 main.js，让页面按要求显示。</p>
    <div id="app"></div>
    <script src="main.js"></script>
  </body>
</html>
`,
  'main.js': `// 在这里写你的代码
const app = document.getElementById('app')
app.textContent = '还没开始写'
`,
  'style.css': `body {
  font-family: system-ui, 'Microsoft YaHei', sans-serif;
  margin: 32px;
  line-height: 1.7;
}
`,
}

function rootOf(aid) {
  return path.join(config.dataDir, 'assignments', String(aid))
}

function codeDir(aid) {
  return path.join(rootOf(aid), 'code')
}

/** 目录里所有文本文件的相对路径（/ 分隔） */
function walkText(abs, rel, out) {
  let items = []
  try {
    items = fs.readdirSync(abs, { withFileTypes: true })
  } catch (e) {
    return
  }
  for (const it of items) {
    if (it.name === 'node_modules' || it.name.startsWith('.')) continue
    const r = rel ? rel + '/' + it.name : it.name
    const full = path.join(abs, it.name)
    if (it.isDirectory()) walkText(full, r, out)
    else if (it.isFile() && TEXT_EXT.has(path.extname(it.name).toLowerCase())) out.push({ rel: r, full })
  }
}

/** 生成 { dir, files: [{ path, text, size }] }，形状与 content.getExampleBundle 一致 */
function bundleFromDir(abs, dirKey) {
  const list = []
  const found = []
  walkText(abs, '', found)
  for (const f of found) {
    let st
    try {
      st = fs.statSync(f.full)
    } catch (e) {
      continue
    }
    if (st.size > MAX_TEXT) continue
    list.push({ path: f.rel, text: fs.readFileSync(f.full, 'utf8'), size: st.size })
  }
  return { dir: dirKey, files: list.sort((a, b) => a.path.localeCompare(b.path)) }
}

/** 空白起手代码（三件套，双击就能跑） */
function writeBlank(aid) {
  const dir = codeDir(aid)
  for (const [name, text] of Object.entries(BLANK)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text, 'utf8')
  }
  return dir
}

/** 从某个目录整棵拷过来当起手代码（比如「照第 05 课的示例改一版」） */
function copyFrom(aid, srcAbs) {
  const dir = codeDir(aid)
  fs.mkdirSync(dir, { recursive: true })
  const copy = (a, b) => {
    for (const it of fs.readdirSync(a, { withFileTypes: true })) {
      if (it.name === 'node_modules' || it.name.startsWith('.')) continue
      const sa = path.join(a, it.name)
      const sb = path.join(b, it.name)
      if (it.isDirectory()) {
        fs.mkdirSync(sb, { recursive: true })
        copy(sa, sb)
      } else if (it.isFile()) {
        fs.copyFileSync(sa, sb)
      }
    }
  }
  copy(srcAbs, dir)
  return dir
}

/** 作业删掉时连代码一起清 */
function removeCode(aid) {
  try {
    fs.rmSync(rootOf(aid), { recursive: true, force: true })
  } catch (e) {
    /* 删不掉就算了 */
  }
}

module.exports = { codeDir, rootOf, bundleFromDir, writeBlank, copyFrom, removeCode, TEXT_EXT, MAX_TEXT }
