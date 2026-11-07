/*
 * pgPreview.js —— 把「一堆文件 + 选中的页面」变成 iframe 能渲染的 srcdoc
 *
 * Playground 和教师端的「看学生提交」用的是同一套渲染方式：
 *   · 页面里的 <script src> / <link href> / .vue 单文件组件由 /vendor/srcdoc.js 就地内联，
 *     所以学生改过的内容不需要服务器有一份对应的文件；
 *   · 剩下的东西（图片、被多个课共用的 vue.global.js 之类）靠注入 <base> 指回
 *     /examples/<课目录>/ 去取 —— 那些文件本来就没交上来，也不该交；
 *   · 入口（data-entry / main.mjs / App.vue）从页面自身的写法推断，再塞进 __SFC_ENTRY__。
 *
 * 为什么要拆出来：教师在审阅弹层里也要「运行看渲染结果」，两处逻辑必须一模一样，
 * 不然学生看到的样子和老师看到的不一样，评语就站不住脚了。
 */

let sfcReady = null

/** 懒加载 srcdoc.js（本地文件，不走 CDN），加载一次就复用 */
export function ensureSfcSrcdoc() {
  if (window.SfcSrcdoc) return Promise.resolve(window.SfcSrcdoc)
  if (!sfcReady) {
    sfcReady = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = '/vendor/srcdoc.js'
      s.onload = () => resolve(window.SfcSrcdoc)
      s.onerror = () => reject(new Error('srcdoc.js 加载失败'))
      document.head.appendChild(s)
    })
  }
  return sfcReady
}

/*
 * 预览里的错误回传：srcdoc 是隔离子文档，不接这个就完全是黑箱。
 * 回传的东西越全，学生越能自己排错，所以这里连「类型 / 行列 / 调用栈 / console.error」一起带父页面：
 *   kind: error（运行时/语法）| reject（Promise 未捕获）| console（console.error）
 */
export const ERROR_BRIDGE =
  '<script>(function(){' +
  'function send(o){try{o.__pg=1;parent.postMessage(o,"*")}catch(_){}}' +
  'window.addEventListener("error",function(e){' +
  // 捕获阶段也会收到 <img>/<script> 加载失败的 error（target 是元素，message 为空）
  'var t=e.target;' +
  'if(t&&t!==window&&t.tagName){' +
    // 重跑时旧文档里的图片/脚本被中断也会触发 error，元素已经不在文档里就忽略
    'if(t.isConnected===false)return;' +
  'var u=t.src||t.href||"";' +
  'send({kind:"resource",m:"资源加载失败：<"+String(t.tagName).toLowerCase()+">"+(u?" "+u:""),name:"",stack:"",f:String(u),l:0,c:0});' +
  'return}' +
  'var er=e.error||{};' +
  'send({kind:"error",m:String(e.message||er.message||e.type||"未知错误"),name:String(er.name||""),' +
  'stack:String(er.stack||""),f:String(e.filename||""),l:e.lineno||0,c:e.colno||0})' +
  '},true);' +
  'window.addEventListener("unhandledrejection",function(e){' +
  'var r=e.reason||{};' +
  'send({kind:"reject",m:String(r.message||r),name:String(r.name||""),stack:String(r.stack||""),f:"",l:0,c:0})' +
  '});' +
  'var ce=console.error&&console.error.bind(console);' +
  'console.error=function(){' +
  'var a=[].slice.call(arguments).map(function(x){try{return typeof x==="string"?x:JSON.stringify(x)}catch(_){return String(x)}});' +
  'send({kind:"console",m:a.join(" "),name:"",stack:"",f:"",l:0,c:0});' +
  'if(ce)try{ce.apply(null,arguments)}catch(_){}}' +
  '})();</' +
  'script>'

/** 文件清单里的页面（.html / .htm），按路径排 */
export function pagesOf(files) {
  return files
    .map((f) => f.path)
    .filter((p) => /\.html?$/i.test(p))
    .sort((a, b) => a.localeCompare(b, 'zh'))
}

/** 入口文件：优先页面上的 data-entry，否则按本目录的 main.mjs / main.js / App.vue 猜 */
export function pickEntry(paths, pageDir, pageSrc) {
  const attrs = /<script[^>]+src=["'][^"']*sfc-boot\.js["'][^>]*>/i.exec(pageSrc || '')
  if (attrs) {
    const m = /data-entry=["']([^"']+)["']/i.exec(attrs[0])
    if (m) return m[1]
  }
  if (paths.indexOf(pageDir + 'main.mjs') >= 0) return pageDir + 'main.mjs'
  if (paths.indexOf(pageDir + 'main.js') >= 0) return pageDir + 'main.js'
  if (paths.indexOf(pageDir + 'App.vue') >= 0) return pageDir + 'App.vue'
  return ''
}

/** 这一页是不是 npm 工程（有 package.json 却没用 sfc-boot，或者入口指向 /src/） */
export function isNpmProject(files, page) {
  const hit = files.find((f) => f.path === page)
  const text = hit ? hit.text : ''
  if (!text) return false
  if (/<script\b[^>]*\bsrc\s*=\s*["']\/?[^"']*\bsrc\//i.test(text)) return true
  const hasPackage = files.some((f) => f.path === 'package.json')
  return hasPackage && !/sfc-boot\.js/i.test(text)
}

/**
 * 拼出预览用的 srcdoc。
 * files: [{ path, text }]（学生提交的那一套，或示例 + 本机改动）
 * page: 要渲染的页面相对路径
 * basePath: <base href> 的前缀，形如 '/examples/第01课-课程导览/'
 */
export function buildPreviewDoc(files, page, basePath) {
  const sfc = window.SfcSrcdoc
  if (!sfc) throw new Error('预览引擎还没加载好')
  const map = {}
  for (const f of files) map[f.path] = f.text

  const pageSrc = map[page] || ''
  const pageDir = page.indexOf('/') >= 0 ? page.slice(0, page.lastIndexOf('/') + 1) : ''

  // 1) <base>：让页面里的相对路径（./App.vue、main.mjs、图片）按真实目录解析
  //    /lib/xxx 这类绝对路径不受 base 影响，运行时库走那条
  let src = pageSrc
  const inject = '<base href="' + basePath + encodeURI(pageDir) + '">' + ERROR_BRIDGE
  if (/<head[^>]*>/i.test(src)) src = src.replace(/<head[^>]*>/i, (m) => m + inject)
  else src = inject + src

  // 2) 入口：交给 srcdoc.js 去挂载
  const entry = pickEntry(Object.keys(map), pageDir, pageSrc)
  if (entry) src = '<script>window.__SFC_ENTRY__=' + JSON.stringify(entry) + ';</' + 'script>' + src

  return sfc.buildFromPage(src, map)
}
