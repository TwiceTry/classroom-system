# data/ —— 运行数据目录

这个目录**不入版本库**（整目录在 `.gitignore` 里）。

## 一句话：数据在 `teach.db` 里，不在 CSV 里

系统从「CSV 一堆文件」换成了「一个 SQLite 库」，**真源是 `teach.db`**。

| 文件 | 是什么 |
|---|---|
| `teach.db` | **数据库本体**（课程、班级、名单、记分、作业、提交、点名、运行时状态，全在这） |
| `teach.db-wal` / `teach.db-shm` | SQLite 的 WAL 日志与共享内存 —— 运行时一直在变，**别删** |
| `config.json` | 教师口令、令牌密钥、内容目录位置。**绝不入库**（含口令与密钥） |
| `schemes/<id>.json` | 考核方案（每个课程一份，是文件不是表 —— 因为要能手改、能 diff） |
| `students/<班级>/<学号>/` | 每个学生一套：作业正文、大作业附件、机试答卷 + 三张派生的分数表 |
| `uploads/` | 上传的文件本体（附件、评分证据），二进制 |
| `.trash/` | 导入/删除时的回收站（可捞回） |

`teach.db` 里的表：

```
courses        课程
classes        班级
students       名单
events         记分流水（分数的唯一真源）
rollcall       点名台账
state          运行时状态（抽到谁了、投屏同步到哪页、学生端菜单收了哪些）
assignments    作业定义
submissions    提交记录
schema_migrations   schema 版本
```

## `students/<班级>/<学号>/` 里有什么

```
作业/<作业id>/<提交id>/   学生交上来的整份代码（只有磁盘这一份，别删）
大作业/<作业id>/<提交id>/ 学生交的附件（源码包 / 截图 / PDF）
机试/                     期末机试的答卷 + 成绩.xlsx
记分/                     总评.xlsx（各项分数 + 总评）、明细.xlsx（记分流水）
大作业/证据清单.xlsx       老师侧的评分证据索引（文件本体在 uploads/）
```

**`记分/` 和 `成绩.xlsx` 是派生表**：给分或撤分后几百毫秒内自动重写，删掉也会自动重建。
真源仍是 `events` 表。整班的成绩表用教师端「班级管理 → 导出总评 / 导出流水」。

## 关于 CSV：已经全部删掉了

这个系统**曾经**把数据存在 `data/` 下的 8 个 CSV 里
（`courses.csv` / `classes.csv` / `students.csv` / `events.csv` / `rollcall.csv` /
`state.csv` / `assignments.csv` / `submissions.csv`）。

换成 SQLite 之后它们是历史遗留，而且**内容已经过期**
（例如 `events.csv` 停在 30 行，而库里有 37 条记分记录）。
为避免有人把它们当数据源，已经连同迁移工具一起删掉：

- 8 个 CSV 文件
- `src/db/import-csv.js`（CSV → SQLite 的单向迁移工具）
- `src/db/schema.js`、`src/db/csv.js`（CSV 时代的库实现与落盘逻辑）

现在只有一条数据路径：**SQLite（`teach.db`）**。表结构在 `src/db/schema.sql`，
建库用 `node src/db/migrate.js`（幂等，`--drop` 才会删表）。

如果手上还有更早的 CSV 备份需要抢救，用 git 历史里的 `import-csv.js` 配合那份备份即可 ——
但那是应急手段，不是日常路径。

## 备份与迁移

WAL 模式下**不能直接拷 `teach.db` 一个文件**（最新的写入可能还在 `-wal` 里）。
两种稳妥做法：

```bash
# 1) 停服务再整目录拷（最简单）
tar czf classroom-backup-$(date +%F).tar.gz data/

# 2) 不停服务：让 SQLite 自己导一个一致的副本
sqlite3 data/teach.db ".backup 'classroom-backup.db'"
```

换机器：把 `data/` 放到新机器同一位置（或用 `TS_DATA_DIR` 指过去）。

**这个目录就是「课堂的全部数据」**：课程、名单、成绩、学生的每一次提交都在这里。
系统本体（代码）可以随时从镜像拉新的，数据始终是你的。

## 想从零开始

停服务，把 `data/` 整个删掉再启动（会自动建空的 `teach.db` 与目录结构）。
注意：这会丢掉所有课程、名单与成绩。

只要清分数、保留名单？不要删库 —— 用教师端撤销记分，或按班级重建。
