/*
 * sfc-boot.js —— 各课 index.html 的「套路代码」启动器（离线，经典脚本）
 *
 * 各课目录的形态与典型 Vue 工程一致（第 12 课起用 Vite 也是这个套路）：
 *   index.html   只留挂载点，各课逐字相同
 *   main.mjs     入口：import { createApp } from 'vue' / import App from './App.vue'
 *                createApp(App).mount('#app')      ← 与 Vite 工程的 main.js 一字不差
 *   App.vue      根组件
 * 唯一区别：浏览器原生不会编译 .vue，这里用 vue3-sfc-loader 在页面内现编译。
 * 入口因此叫 .mjs 而不是 .js —— 加载器按扩展名决定按「模块」还是「普通脚本」解析，
 * .js 里写 import 会报 sourceType: "module" 的错（已实测）。
 * 同一个坑还埋在「组合式函数」这类 .js 模块上（useMouse.js / useLocalStorage.js …）：
 * 它们同样是 .js + import/export。本文件在 getFile 里按内容兜住 —— 有 import / export 的 .js
 * 就返回 { type: '.mjs' } 让加载器按模块解析，于是各课可以保留真实工程里常见的 useXxx.js 命名
 * （见下面的 asFile）。加载器源码里的分派：case ".js" → script，case ".mjs" → module。
 *
 * 源码从哪来（自动二选一）：
 *   1) 内存字典 window.__SFC_FILES__ —— Playground 预览用（源码来自编辑器，不在磁盘上）
 *   2) 磁盘真实文件 —— 用 XMLHttpRequest 读。这里必须用 XHR：Chrome 的 fetch
 *      不支持 file:// 协议（实测带参数也不支持）；且浏览器要带
 *      --allow-file-access-from-files 启动（见 代码示例/双击打开-*.bat）。
 *
 * 依赖：vue.global.js（全局 Vue）+ vue3-sfc-loader.js（官方运行时 SFC 加载器 0.9.5）
 *
 * 可覆盖项（优先级由高到低）：
 *   window.__SFC_ENTRY__   入口文件；Playground 预览会显式设置
 *   data-entry="xxx"       写在引入本文件的标签上：
 *                          <script src="../playground/sfc-boot.js" data-entry="watch.mjs"></script>
 *   window.__SFC_TARGET__  挂载点选择器，默认 '#app'
 * 入口默认：'main.mjs'；若内存字典里没有 main.mjs 但有 App.vue，自动回落到 'App.vue'。
 */
(function (global) {
  'use strict';

  var SELF = document.currentScript;   // 记下自己的标签，便于读 data-entry

  function fail(title, detail) {
    // 报给父页面（Playground 的报错面板）：.vue 编译 / 取文件失败也能在右侧看到原因，
    // 否则学生只看到一片空白，完全不知道哪里写错了。
    try {
      var detailText = detail ? String(detail) : '';
      if (detailText.length > 1600) detailText = detailText.slice(0, 1600) + '…';
      parent.postMessage(
        {
          __pg: 1,
          kind: 'compile',
          m: detailText ? detailText.split('\n')[0] : String(title || '编译失败'),
          name: '',
          stack: detailText,
          f: '',
          l: 0,
          c: 0
        },
        '*'
      );
    } catch (e) {
      /* 跨域 / 被拦就算了，页面里的红字还在 */
    }
    var box = document.getElementById('app') || document.body;
    if (!box) return;
    var pre = document.createElement('pre');
    pre.style.cssText = 'color:#c00;white-space:pre-wrap;padding:16px;font-family:monospace';
    pre.textContent = title + (detail ? '\n\n' + detail : '');
    box.appendChild(pre);
  }

  // './a.vue' | 'a/../b.vue' | '/b.vue' | 'b.vue'  ->  'b.vue'
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

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // 加载器按「扩展名」决定解析方式（源码里写死：.js → script、.mjs → module）。
  // 组合式函数这类 .js 文件本身就是 ES 模块，按 script 解析会报
  // 「'import' and 'export' may appear only with sourceType: "module"」。
  // 这里按内容判断：是模块就返回 { type: '.mjs', getContentData }，
  // 让加载器按模块解析（加载器的 getResource 允许 getFile 用 type 覆盖扩展名）。
  function asFile(key, src) {
    if (!/\.js$/i.test(key)) return src;
    return /^[ \t]*(import|export)\b/m.test(src)
      ? { type: '.mjs', getContentData: function () { return src; } }
      : src;
  }

  // ---- 模式 1：内存字典（Playground 预览）。返回字符串即可 ----
  function makeDictGetFile(files) {
    return function (url) {
      var key = normalizeKey(url);
      if (hasOwn(files, key)) return Promise.resolve(asFile(key, files[key]));
      // 退化：按文件名匹配（兼容加载器传入带前缀路径的情况）
      var base = key.split('/').pop();
      for (var p in files) {
        if (!hasOwn(files, p)) continue;
        if (p.split('/').pop() === base) return Promise.resolve(asFile(p, files[p]));
      }
      return Promise.reject(new Error('getFile 未找到 "' + url + '"（key=' + key + '）'));
    };
  }

  // ---- 模式 2：磁盘真实文件。必须用 XHR，fetch 不支持 file:// ----
  function makeDiskGetFile() {
    return function (url) {
      var key = normalizeKey(url);
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', key, true);
        xhr.onload = function () {
          if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 400)) resolve(asFile(key, xhr.responseText));
          else reject(new Error('HTTP ' + xhr.status + '：' + key));
        };
        xhr.onerror = function () { reject(new Error('读不到 ' + key)); };
        xhr.send();
      });
    };
  }

  // 让加载器在「本课目录」内解析相对路径：'./Child.vue' -> 'Child.vue'
  function pathResolve(e) {
    var rel = String((e && e.relPath) || '');
    var ref = e && e.refPath;
    if (!ref || rel.charAt(0) !== '.') return rel;
    var dir = ref.indexOf('/') >= 0 ? ref.slice(0, ref.lastIndexOf('/')) : '';
    return normalizeKey(dir ? dir + '/' + rel : rel);
  }

  // 判断加载结果算不算「组件」，决定要不要由本文件挂载：
  //   .vue 入口        → loadModule 直接返回组件对象（实测 keys: __name / setup / render，没有 default）
  //   main.mjs 入口    → 返回普通模块命名空间对象，没有组件特征 → 它 import 时就自己挂载了，别再挂一次
  // 注意：同一容器挂两遍会让 Vue 内部 vnode 记账错乱（nextSibling of null），所以判定必须准。
  function asComponent(mod) {
    if (!mod) return null;
    var cand = mod['default'] || mod;
    if (typeof cand === 'function') return cand;
    if (cand && (cand.render || cand.setup || cand.template || cand.__name)) return cand;
    return null;
  }

  function pickEntry(files) {
    if (global.__SFC_ENTRY__) return global.__SFC_ENTRY__;
    if (SELF && SELF.getAttribute) {
      var attr = SELF.getAttribute('data-entry');
      if (attr) return attr;
    }
    // 兼容旧形态：内存字典里只有 App.vue 时仍按 App.vue 启动
    if (files && !hasOwn(files, 'main.mjs') && hasOwn(files, 'App.vue')) return 'App.vue';
    return 'main.mjs';
  }

  function boot() {
    if (!global.Vue) { fail('[启动失败] 缺少 vue.global.js —— 应在上级目录（代码示例/）。'); return; }
    if (!global['vue3-sfc-loader']) { fail('[启动失败] 缺少 vue3-sfc-loader.js —— 应在上级目录（代码示例/）。'); return; }

    var files = global.__SFC_FILES__;
    var useDict = !!(files && Object.keys(files).length);
    var entry = pickEntry(useDict ? files : null);
    var target = global.__SFC_TARGET__ || '#app';

    var options = {
      moduleCache: { vue: global.Vue },
      getFile: useDict ? makeDictGetFile(files) : makeDiskGetFile(),
      pathResolve: pathResolve,
      addStyle: function (textContent) {
        var s = document.createElement('style');
        s.textContent = textContent;
        document.head.appendChild(s);
      },
      log: function (type, msg) {
        if (type === 'error' || type === 'warn') {
          try { console[type]('[sfc-loader] ' + msg); } catch (e) {}
        }
      }
    };

    global['vue3-sfc-loader'].loadModule(entry, options).then(function (mod) {
      var comp = asComponent(mod);
      if (comp) global.Vue.createApp(comp).mount(target);
    }).catch(function (e) {
      var detail = e && e.stack ? e.stack : String(e);
      if (!useDict) {
        detail += '\n\n提示：本页要读取磁盘上的 ' + entry + ' 等源码文件，必须带 --allow-file-access-from-files 启动。\n' +
          '1) 请双击本页所在目录配套的「双击打开-*.bat」（代码示例/ 与 课堂工具/ 下的工具各有一个），不要直接双击 index.html；\n' +
          '2) 若同一个浏览器已经开着，新一次的启动参数会被忽略 —— 先完全退出它（所有窗口），再双击 bat。';
      }
      fail('[编译/加载失败]', detail);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
