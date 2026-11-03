import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/*
 * 构建目标定在 chrome78 / firefox78 这一档：
 *   - 机房基准是 Win7 + Chrome 109（Win7 官方最后支持版），79 档一定够用；
 *   - 顺带把可选链、空值合并降级掉，万一个别机器还是 Chrome 78 也不会白屏。
 * 代价只是几 KB 的 helper，值得。
 */
export default defineConfig({
  plugins: [vue()],
  base: '/',
  build: {
    target: ['chrome78', 'firefox78', 'safari13'],
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
