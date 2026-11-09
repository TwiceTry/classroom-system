# tools —— 体检、打包、真机核对

四个脚本，都不是服务运行时要的东西，跑一次给人看的。

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

## `coursepack/build-pack.mjs` —— 打课程包

```powershell
node tools/coursepack/build-pack.mjs <课程源目录> [输出目录]
```

做四件事：

1. 只取白名单内的顶层目录（`lecture` / `materials` / `代码示例` / `exams` / `assets`）
2. 复制 `course.json` / `scheme.json` / `classes/`
3. 生成 `pack.json`（每个文件的 sha256 + size）
4. 用系统自己的 `api/src/lib/zip.js` 压成 zip（同一个实现，压缩方式和中文文件名才对得上）

源目录**只读**，不会被改动。输出目录不存在会自动建。

## `coursepack/check-pack.mjs` —— 按规范检查课程目录

```powershell
node tools/coursepack/check-pack.mjs [课程目录]
```

检查项：`pack.json` 格式与 `files[]` 登记、`course.json` 的 `id`/`name`、`scheme.json` 各段合计与 `totalFull`、
`content/` 白名单、`classes/index.json` 名单人数、体积上限（整包 ≤500MB、单文件 ≤100MB）、路径穿越。

**改完课程内容先跑这个**，比打完包再发现问题快。

## `kg-live-check.mjs` —— 青果账号密码真机验证

```powershell
node tools/kg-live-check.mjs
```

拿几组真实学号去问上游接口，确认「密码对/错/未入班」三种回答的样子没变。
学生登录支持两种方式（学号姓名 / 青果账号密码），后者依赖上游，**上游改了字段这里会先发现**。

---

> 原来还有四个 `audit-*.mjs`（Chrome 78 可行性、flex gap 分布、mermaid、vendor 运行时），
> 都是一次性审计，结论已经落进 `vite.config.js` 的注释和 `docs/` 里，2026-11 删了。
> 需要时从 git 历史取回。
