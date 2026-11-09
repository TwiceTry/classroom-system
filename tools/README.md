# tools —— 体检、示例检查、真机核对

三个脚本，都不是服务运行时要的东西，跑一次给人看的。

## `check-compat.mjs` —— 改前端前后各跑一次

```powershell
node tools/check-compat.mjs
```

盯两条基线：

- **服务器 Node ≥ 20**（`better-sqlite3` 的要求，写死在 `api/package.json` 的 `engines`）
- **前端不越 Chrome 109**（`vite.config.js` 的 `build.target`、`web/index.html` 的 `MIN_CHROME`、这个脚本里的基线，**三处要同步改**）

改完前端忘了改其中一处，它会红。

## `check-bat.mjs` —— 批处理体检

```powershell
node tools/check-bat.mjs
```

查 `.bat` 的行尾（CRLF）、括号配对、`chcp 65001`。现在只有 `教学机代理/` 下那几个 bat 还是批处理。

## `audit-examples.mjs` —— 课程示例能不能跑

```powershell
# 在 课堂系统/ 下执行
node tools/audit-examples.mjs
```

默认查两处：`../web前端框架开发/代码示例`（真源）和 `data/courses/<课>/content/代码示例`（导入副本）。

按文件类型分三套规则：

| 文件 | 规则 |
|---|---|
| `.mjs` | 必须 import（它是模块） |
| `.vue` 的 `<script setup>` | 必须 import（`defineProps` / `defineEmits` 等编译器宏除外） |
| `.html` | 允许裸写，但必须先 `const { createApp, ref } = Vue` 解构 |

**为什么要有这个**：2026-11 发现 7 个 `main.mjs` 缺 `import { createApp } from 'vue'`，
代码练习打开整个白屏。文件长得就是标准 Vue 入口的样子，肉眼几乎看不出来：

```js
import App from './App.vue'
createApp(App).mount('#app')      ← createApp 没导入
```

## `kg-live-check.mjs` —— 青果账号密码真机验证

```powershell
node tools/kg-live-check.mjs
```

拿几组真实学号去问上游接口，确认「密码对/错/未入班」三种回答的样子没变。
学生登录支持两种方式（学号姓名 / 青果账号密码），后者依赖上游，**上游改了字段这里会先发现**。

---

> 曾经还有：
> - 四个 `audit-*.mjs`（Chrome 78 可行性、flex gap 分布、mermaid、vendor 运行时）—— 一次性审计，
>   结论已落进 `vite.config.js` 的注释和 `docs/`，2026-11 删了
> - `coursepack/`（`build-pack.mjs` 打课程包、`check-pack.mjs` 按规范检查）—— 2026-11 删了，
>   课程包改由课堂系统页面里导入导出
> 需要时从 git 历史取回。
