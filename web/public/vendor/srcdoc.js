/*
 * srcdoc.js —— 生成 Playground 预览 iframe 的 srcdoc（无 DOM 依赖，便于单测）
 *
 * 做法：**直接拿该课的 HTML 页面源码当 srcdoc**（index.html / watch.html / …），
 *       只在 <body> 开头注入一份内存文件字典 window.__SFC_FILES__。
 *
 * 于是：
 *   页面里的 <script src="../playground/sfc-boot.js"> 会自动改从内存字典取源码
 *   → 预览 = 「真实页面」，唯一区别是源码来自编辑器（可能是学生改过的）。
 *   页面上的 data-entry（如 watch.html 的 data-entry="watch.mjs"）也照常生效，
 *   Playground 不需要自己猜入口。
 *
 * 相对路径为何能对上：Playground 与各课目录**同级**（同在 代码示例/ 下），
 *   页面里的 ../vue.global.js、../playground/sfc-boot.js 从 srcdoc 解析结果一致。
 *
 * 额外一步：本课自己的样式表 <link rel="stylesheet" href="X.css">，若 X.css 在内存字典里，
 *   就地内联成 <style> —— 这样「改 .css → 预览立刻生效」，也不必依赖 srcdoc 的基准路径。
 *   （外链 CSS 与不在内存里的 CSS 都原样保留，不受影响。）
 *
 * 关键：内联的 __SFC_FILES__ 里可能出现源码自带的 </script>，必须转义成 <\/script>，
 *       否则会提前闭合 <script> 标签。
 */
(function (global) {
  'use strict';

  function escapeForInlineScript(data) {
    return String(data)
      .replace(/<\/script>/gi, '<\\/script>')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  // './a.css' | 'a/../b.css' | 'b.css' -> 'b.css'（与 sfc-boot.js 的归一规则一致）
  function normalizeKey(p) {
    var s = String(p).split('?')[0].split('#')[0].replace(/\\/g, '/');
    var parts = s.split('/'), out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { out.pop(); continue; }
      out.push(seg);
    }
    return out.join('/');
  }

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function inlineLocalStyles(src, files) {
    return String(src).replace(/<link\b[^>]*>/gi, function (tag) {
      if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
      var m = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (!m) return tag;
      if (/^(https?:)?\/\//i.test(m[1])) return tag;                    // 外链不动
      var key = normalizeKey(m[1]);
      var css = has(files, key) ? files[key] : files[key.split('/').pop()];
      if (typeof css !== 'string') return tag;                          // 不在内存里 → 原样保留
      return '<style>\n' + String(css).replace(/<\/style>/gi, '<\\/style>') + '\n</style>';
    });
  }

  // pageSource：该课 HTML 页面源码；files：{ 'App.vue': '源码', 'main.mjs': '源码', 'style.css': '…' }
  function buildFromPage(pageSource, files) {
    var map = files || {};
    var src = inlineLocalStyles(pageSource == null ? '' : pageSource, map);
    var data = escapeForInlineScript(JSON.stringify(map));
    var inject = '<script>window.__SFC_FILES__=' + data + ';<\/script>\n';

    // 1) 有 <body>：紧跟其后注入（此时后面的 script 都还没执行，最稳）
    var m = /<body[^>]*>/i.exec(src);
    if (m) {
      var at = m.index + m[0].length;
      return src.slice(0, at) + '\n' + inject + src.slice(at);
    }
    // 2) 没写 <body>：插到第一个 <script> 之前（别插到 <!doctype> 前面，会变怪异模式）
    var s = src.search(/<script/i);
    if (s >= 0) return src.slice(0, s) + inject + src.slice(s);
    // 3) 极端情况：直接追加
    return src + '\n' + inject;
  }

  global.SfcSrcdoc = {
    buildFromPage: buildFromPage,
    inlineLocalStyles: inlineLocalStyles,
    escapeForInlineScript: escapeForInlineScript
  };
})(typeof window !== 'undefined' ? window : globalThis);
