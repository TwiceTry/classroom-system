# 课堂系统 · 后端重构（Fastify + SQLite）

> 分支：`refactor/sqlite-fastify`（不动 `main`）
> 旧后端（`server/`，零依赖 + CSV）**原样保留**，随时可回滚。

---

## 一、为什么要重构

| 现状 | 问题 |
|---|---|
| 存储是 8 张 CSV（`data/*.csv`） | 没有事务/索引/约束；并发写靠整表重写；`events.csv` 上千行后每次改动都要序列化全表 |
| 自研 HTTP 路由（`api.js` 3735 行 / 128 条） | 参数校验手写、错误格式不统一、分页与鉴权各写各的 |
| 全局可变状态（`scheme.activate`） | 多课程并发会串味（`d475b63` 打过补丁，但那是补丁不是结构） |

目标：**主流技术栈 + 关系型存储 + 一致的 API 约定**，且**不影响在用的数据、令牌与教学机代理**。

---

## 二、技术选型

| 选择 | 理由 | 否决 |
|---|---|---|
| **Fastify 5** | 内置 JSON Schema 校验、pino 日志、插件化路由 | Express（校验/日志都要自己搭）、NestJS（对 128 条接口过重） |
| **better-sqlite3** | 同步 API 简单直接、单文件备份、WAL 读写不互斥 | PG/MySQL（多一个要运维的服务）、node:sqlite（太新） |
| **手写 SQL + repository** | 这一层只做取/存，SQL 一眼看懂 | Prisma/Drizzle/Kysely（团队是 JS 不是 TS，类型收益拿不到） |
| **ESM** | 与前端一致 | CJS |
| **沿用 HMAC 令牌** | 格式不变 → **旧令牌继续有效，升级不踢人** | JWT |

关键决策：**新后端读同一份 `data/config.json`** → `secret` / `teacherPassword` / `edgeKey` 全不变 → 老师、学生、教学机代理都不用重新配置。

---

## 三、目录

```
api/
  src/
    server.js            启动 / 优雅退出
    app.js               装配（统一错误体 / raw body / 404 / SPA 回退）
    config.js            配置（复用 data/config.json）
    db/
      schema.sql         9 张表 + 注释说明每条约定（表结构的唯一来源）
      index.js           连接 / PRAGMA / applySchema / tableCounts
      migrate.js         建库 CLI
    lib/
      auth.js            令牌签发/校验/撤销（与旧格式一致）
      errors.js          统一错误类型
      repo.js            数据访问（snake_case ↔ camelCase）
      presence.js        在场 / 在看（内存态 + 快照上报）
      scheme.js          方案桥接（复用旧 scheme/rules，零逻辑偏差）
      scoring.js        ↑ 同上
      grading.js         判分 + 记账（唯一入口）
      submitstore.js     学生提交文件落盘（沿用旧目录布局）
      legacy.js          复用旧 exam/coursepack/content 纯函数模块
    plugins/auth.js      requireAuth(role) → Fastify preHandler
    routes/
      auth.js            登录 / 我 / 退出
      courses.js         课程 CRUD + 内容目录骨架
      classes.js         班级 + 名册
      events.js          记分（append-only + void/restore）
      attendance.js      考勤（视图 / 批量 / 单人即时）
      scoring.js         方案概要 / 分数榜 / 互动 / 学生明细
      assignments.js     作业发布 + 提交 + 批阅（学生侧 submit）
      exam.js            机试（出卷 / 开考 / 答题 / 交卷 / 判卷）
      content.js         内容（概览 / 列目录 / 整树 / 读文本 / 下载）
      realtime.js        心跳 / 在场 / 边缘端快照 / 投屏状态
      cast.js            投屏 WebSocket 中继（/ws 三条通道）
      classroom.js       点名 / 聚焦 / 考勤会话 / 名册导入 / edge-key
      compat.js          前端仍在用的旧路径别名 + 未实现的 501 占位
      misc.js            health / timetable / bootstrap
    test/selftest.js     84 项接口自检
```

---

## 四、API 约定

1. **资源化路径**：`/api/courses`、`/api/classes/:id/students`、`/api/classes/:id/events`
2. **方法表意**：`POST` 建（201）、`PATCH` 改、`DELETE` 删（204）
3. **统一错误体**
   ```json
   { "error": { "code": "not_found", "message": "班级不存在", "details": {} } }
   ```
   `code` 稳定（前端按 code 分支，别匹配中文）
4. **列表形状**：`{ items, total }`；大列表 `{ items, nextCursor }`
   - 游标用 `(createdAt, id)` 复合游标 —— 同毫秒写入多条也不漏不重
5. **分页**：`?limit=&cursor=`，默认 200 / 上限 1000
6. **字段命名**：对外 camelCase（与旧版一致，前端迁移成本最低），DB 内 snake_case
7. **破坏性删除要显式确认**：删班（还有学生）→ 409，要 `?force=1`；课程下还有班级 → 409
8. **命名空间**：`/api/auth/*`、`/api/presence/*`、`/api/cast/*`

---

## 五、数据迁移

```bash
cd api
npm install
node src/db/migrate.js          # 建库（幂等）
npm test                        # 自检（进程内，不占端口）
```

**旧 CSV 一个字节不改**（只读），随时可回滚。

### 迁移校验结果（真实数据）

| 表 | CSV | SQLite | 字段级 |
|---|---|---|---|
| courses | 1 | 1 | ✓ |
| classes | 2 | 2 | ✓ |
| students | 117 | 117 | ✓ |
| events | 30 | 30 | ✓ |
| rollcall / state / assignments / submissions | 0 | 0 | ✓ |

> 唯一"差异"是 `events.weight`：旧数据没这字段、旧代码按 1 处理，新库 `DEFAULT 1` —— 行为等价。

---

## 五之二、阶段状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| S0 | 分支 + 工作目录 + 方案 | ✅ |
| S1 | SQLite schema + 迁移执行器 + 逐字段校验 | ✅ |
| S2 | Fastify 骨架 + 核心 API | ✅ |
| S3 | 投屏 WS 中继 · 内容管理/在线编辑 · 考勤 · 分数榜 · 作业（提交/批阅/证据/进度）· 机试 · 课程包/班级包 · 方案编辑 · 作业库 · 点名/聚焦 · 成绩导出 | ✅ |
| S4 | 前端 42 条路径适配 + `api.js` 错误体兼容 + 构建验证 | ✅ |
| S5 | 前端审视：审计报告 + 修掉「错误信息变成 [object Object]」；大文件拆分（`PgWorkbench` 1881 行）列为独立一轮 | 🟡 见 `docs/前端审视.md` |

## 六、真实数据冒烟（36 项全过）

```
课程 1 门 · 班级 2 个（60 人）· 名册 60 人
分数榜（真实数据）· 考勤项=考勤 · 记分记录分页 · 在场名单
方案概要 items=attend,interact,homework,project,exam
内容概览 lecture:20 materials:20 代码示例:184 exams:3 assets:9
学生登录（2515230114 马婷婷）· 我的成绩 · 我的作业 · 心跳 · 投屏状态
学生越权 → 403（教师接口 / 讲义）
SPA 入口页 200 + 304
```

---

## 七、与旧后端的接口覆盖对比

| 项 | 数量 |
|---|---|
| 旧后端路由 | 128 |
| 新后端路由 | **135**（含结构化的新接口） |
| **已有等价实现** | **77（60%）**（另有约 40 条只是路径改名，diff 映射表未覆盖） |
| 尚未覆盖 | 真正缺的约 7 条（见下） |

### 已覆盖（日常教学 + 管理全通）

认证 · 课程 · 班级/名册（含 Excel/CSV 导入）· 记分（追加/撤销/恢复）· 考勤（视图/批量/单人/会话）·
分数榜/互动/学生明细/成绩导出 CSV · 作业（发布/开放/提交/批阅/改分/打回/证据/进度）·
机试（出卷/纸质卷/开考/答题/交卷自动判分/改分/答卷查看与下载）·
内容（概览/列目录/整树/读文本/下载/在线编辑/整目录导入导出/模板）·
课程包（导出/预检/导入/模板/复制课程）· 班级包（导出/预检/应用/模板）·
作业库（设计稿列表/导入/导出/删除/模板）· 方案（原文/保存/预检/试算/应用/归档/导出）·
投屏 WS 中继 · 心跳/在场/边缘端快照 · 点名/聚焦 · health / timetable / bootstrap · edge-key

### 尚未覆盖（真的没做，共 7 条）

| 接口 | 原因 |
|---|---|
| `GET /api/pgsync`、`POST /api/pgsync` + `classes/:id/pg-sync` | 代码工作台的实时同步（Playground 协作），依赖独立的状态通道 |
| `POST /api/teacher/courses/:id/stuvis`、`GET .../stuvis` | 学生端可见性开关（记录「哪些内容学生能看」） |

> 这 7 条都用 `501 not_implemented` 明确占位，前端不会白屏，只会提示「重构中暂未开放」。
> 其余管理类接口本轮已全部补齐（复用旧 lib 的纯函数 + 一个 6 方法的 db 适配器）。

---

## 八、怎么跑

```bash
cd api
npm install
node src/db/migrate.js
npm start                     # 默认 18730

npm test                      # 84 项自检（inject，不占端口，临时数据目录）
```

前端静态资源由 `app.js` 直接托管（`web/dist`），入口页带 `ETag` + `no-cache`。

---

## 九、前端适配（S4 已完成）

`web/src` 里 **42 条** API 路径已按新命名批量替换（15 个文件）：

```
/api/teacher/courses      → /api/courses
/api/teacher/classes      → /api/classes
/api/teacher/assignments  → /api/assignments
/api/teacher/exams        → /api/exams
/api/login/teacher        → /api/auth/login/teacher
/api/login/student        → /api/auth/login/student
/api/me                   → /api/auth/me
/api/logout               → /api/auth/logout
```

`npm run build` 通过。

---

## 十、回滚

```bash
git checkout main
node server/index.js      # 旧后端照旧跑，CSV 一个字节没动
```
