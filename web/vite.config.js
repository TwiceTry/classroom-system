import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/*
 * 构建目标：chrome109 / firefox115 / safari16 —— 与浏览器基线一致。
 *
 * 历史：这里曾经是 chrome78（从仓库第一个提交就在），理由是「Chrome 80 才有 ?. 和 ??，
 * 钉在 78 能多覆盖一批老机器」。但那个理由已经失效：
 *
 *   1) 放弃 Win7 之后，机房的下限就是 Chrome 109；
 *   2) 更关键 —— **CSS 早就把下限推到 108/84 了**，target 定 78 是自欺：
 *      全站 163 处 flex 容器里的 gap 要 Chrome 84，2 处 height:100dvh 要 Chrome 108
 *      （详见 docs/前端浏览器基线分析.md）。产物语法能跑 78，但页面布局跑不了。
 *      拿 78 打开会「JS 不报错、布局全乱」，比白屏更难排查。
 *
 * 体积代价实测（同一份代码各构建一次）：
 *   chrome78    合计 4364.4 KB · index.js 119.0 · pgPreview 543.7
 *   chrome109   合计 4363.8 KB · index.js 118.9 · pgPreview 543.3
 *   → 差 0.6KB。抬上去不但不吃亏，产物还略小。
 *
 * **这三处必须同步**，只改一处会出现「产物白屏但兜底页认为浏览器合格」，
 * 老师看到的就是一片空白、没有任何提示：
 *   1) 这里 build.target
 *   2) web/index.html 的 MIN_CHROME
 *   3) tools/check-compat.mjs 的 CHROME_TOO_NEW 基线
 */
export default defineConfig({
  plugins: [vue()],
  base: '/',
  build: {
    target: ['chrome109', 'firefox115', 'safari16'],
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    // host: true = 监听 0.0.0.0：localhost / 127.0.0.1 / 局域网 IP 都能开
    // （默认只绑 ::1，浏览器敲 127.0.0.1:5173 会连不上，容易被当成"服务没起"）
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:18730',
      '/examples': 'http://localhost:18730',
      '/uploads': 'http://localhost:18730',
      '/ws': { target: 'ws://localhost:18730', ws: true },
    },
  },
})
