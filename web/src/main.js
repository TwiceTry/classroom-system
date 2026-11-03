import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './styles/app.css'
import { pushError } from './utils/errorBus'

/*
 * 浏览器太旧：index.html 里的兼容性检测已经把兜底提示页画出来了，
 * 这里就不再挂载应用（否则半成品界面会盖住提示页，反而看不清该干什么）。
 * 检测结果见 index.html 顶部那段 ES5 脚本，全部通过时 level = 'ok'。
 */
const compat = window.__compat || { level: 'ok' }
if (compat.level === 'block') {
  console.warn('[兼容性] 浏览器不满足要求，已跳过挂载：', compat.reasons)
} else {
  if (compat.degraded && compat.degraded.length) {
    console.warn('[兼容性] 以下能力不可用，相关功能会降级：', compat.degraded)
  }

  const app = createApp(App)

/*
 * 全局兜底：事件处理、异步回调里没 catch 的异常会走到这里。
 * 不吞掉（照样打控制台），同时记进 errorBus —— 界面上不至于一片白。
 */
  app.config.errorHandler = (err, instance, info) => {
    const text = [err && err.message ? err.message : String(err), info].filter(Boolean).join('　·　')
    console.error('[界面异常]', err, info)
    pushError(text)
  }

  app.use(router).mount('#app')

  /* 浏览器版本偏低（但能力齐全）：顶部挂一条提示，给下载链接，可以关掉 */
  if (compat.level === 'warn') showCompatBar(compat)
}

/** 版本偏低时的一条提示条（写死样式，避免依赖主题变量） */
function showCompatBar(c) {
  try {
    if (sessionStorage.getItem('compat-bar-closed') === '1') return
  } catch (e) {
    /* 隐私模式：不记就不记 */
  }
  const bar = document.createElement('div')
  bar.id = 'compat-bar'
  bar.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;align-items:center;gap:10px;flex-wrap:wrap;' +
    'padding:8px 14px;background:#fff8e6;border-top:1px solid #e6d5a8;color:#5a4a1f;font-size:12.5px;' +
    'font-family:"Microsoft YaHei",Arial,sans-serif;box-shadow:0 -2px 10px rgba(0,0,0,.05)'
  bar.innerHTML =
    '<span>当前浏览器 <b>' +
    (c.browser || '') +
    '</b> 低于课堂基线 <b>Chrome ' +
    (c.minChrome || 109) +
    '</b>，个别功能可能显示异常。</span>' +
    '<a href="/download/chrome109" style="color:#8a5c05;font-weight:600">下载 Chrome ' +
    (c.minChrome || 109) +
    ' 绿色版</a>' +
    '<span style="flex:1"></span>' +
    '<button type="button" id="compat-bar-x" style="border:none;background:none;cursor:pointer;color:#8a7a4a;font-size:12.5px">仍然使用</button>'
  document.body.appendChild(bar)
  const x = document.getElementById('compat-bar-x')
  if (x) {
    x.onclick = function () {
      bar.parentNode && bar.parentNode.removeChild(bar)
      try {
        sessionStorage.setItem('compat-bar-closed', '1')
      } catch (e) {}
    }
  }
}
