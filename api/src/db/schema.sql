-- ---------------------------------------------------------------------------
-- 课堂系统 · SQLite schema（v1）
--
-- 设计约定（写下来，免得以后各写各的）：
--   1) 列名用 snake_case（SQL 惯例）；对外 API 仍然是 camelCase，
--      由 repository 层做映射 —— 前端不用改字段名。
--   2) 时间一律 TEXT，存 ISO 字符串（'2026-11-06T08:12:33.123Z'）。
--      不转成整数时间戳：现有数据、日志、导出全是这个格式，转来转去只会引入时区 bug。
--   3) 布尔用 INTEGER 0/1。
--   4) 结构化的东西（dims 量规、files 文件列表）用 TEXT 存 JSON ——
--      SQLite 的 JSON1 可以对它做查询，又不用为每种形态建一堆表。
--   5) 外键：班级下面的东西（学生/记分/点名）跟着班级级联删除；
--      课程下面的班级**不**级联（删课要先明确处理班级，别一键带走一学期数据）。
-- ---------------------------------------------------------------------------

-- 课程
CREATE TABLE IF NOT EXISTS courses (
  id          TEXT PRIMARY KEY,
  name        TEXT    NOT NULL,
  content_dir TEXT    NOT NULL DEFAULT '',
  scheme_id   TEXT    NOT NULL DEFAULT '',
  note        TEXT    NOT NULL DEFAULT '',
  semester    TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT '',
  archived    INTEGER NOT NULL DEFAULT 0
);

-- 班级
CREATE TABLE IF NOT EXISTS classes (
  id             TEXT PRIMARY KEY,
  course_id      TEXT    NOT NULL DEFAULT '',
  name           TEXT    NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT '',
  rollcall_round INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_classes_course ON classes (course_id);

-- 班级名册
CREATE TABLE IF NOT EXISTS students (
  class_id TEXT NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  sid      TEXT NOT NULL,
  name     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (class_id, sid)
);
CREATE INDEX IF NOT EXISTS idx_students_sid ON students (sid);

-- 记分事件（append-only：撤销只打 voided，不删不改）
CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  class_id       TEXT    NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  sid            TEXT    NOT NULL,
  item           TEXT    NOT NULL,
  delta          REAL    NOT NULL DEFAULT 0,
  kind           TEXT    NOT NULL DEFAULT '',
  grade          TEXT    NOT NULL DEFAULT '',
  late           INTEGER NOT NULL DEFAULT 0,
  raw            REAL,
  dims           TEXT,                    -- JSON: { code: 8, ui: 5, ... }
  weight         REAL    NOT NULL DEFAULT 1,
  slot           TEXT    NOT NULL DEFAULT '',
  reason         TEXT    NOT NULL DEFAULT '',
  operator       TEXT    NOT NULL DEFAULT '',
  created_at     TEXT    NOT NULL DEFAULT '',
  voided         INTEGER NOT NULL DEFAULT 0,
  voided_at      TEXT    NOT NULL DEFAULT '',
  voided_by      TEXT    NOT NULL DEFAULT '',
  evidence       TEXT,                    -- JSON 数组
  scheme_version TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_events_class_time ON events (class_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_class_sid  ON events (class_id, sid);
CREATE INDEX IF NOT EXISTS idx_events_sid        ON events (sid);

-- 点过名的（一轮点名里已经点到的，避免重复抽）
CREATE TABLE IF NOT EXISTS rollcall (
  class_id  TEXT NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  sid       TEXT NOT NULL,
  picked_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (class_id, sid)
);

-- 通用小状态：value 存 JSON 字符串（当前点名、考勤点名会话等）
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- 作业 / 机试（课程级）
CREATE TABLE IF NOT EXISTS assignments (
  id         TEXT PRIMARY KEY,
  kind       TEXT    NOT NULL DEFAULT '',
  item_key   TEXT    NOT NULL DEFAULT '',
  course_id  TEXT    NOT NULL DEFAULT '',
  title      TEXT    NOT NULL DEFAULT '',
  dir        TEXT    NOT NULL DEFAULT '',
  note       TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'closed',
  created_at TEXT    NOT NULL DEFAULT '',
  opened_at  TEXT    NOT NULL DEFAULT '',
  closed_at  TEXT    NOT NULL DEFAULT '',
  updated_at TEXT    NOT NULL DEFAULT '',
  weight     REAL    NOT NULL DEFAULT 1,
  design_id  TEXT    NOT NULL DEFAULT '',
  due_at     TEXT    NOT NULL DEFAULT '',
  allow_late INTEGER NOT NULL DEFAULT 0,
  -- 大作业：要不要交附件（1 必须 / 0 可选）、收哪些扩展名（JSON 数组字符串）
  require_file INTEGER NOT NULL DEFAULT 1,
  attachments  TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments (course_id);
CREATE INDEX IF NOT EXISTS idx_assignments_item   ON assignments (item_key);

-- 学生提交
CREATE TABLE IF NOT EXISTS submissions (
  id            TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments (id) ON DELETE CASCADE,
  class_id      TEXT NOT NULL DEFAULT '',
  sid           TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  dir           TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT '',
  files         TEXT,                     -- JSON 数组
  changed       TEXT,                     -- JSON 数组（真正改过的文件）
  note          TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  event_id      TEXT NOT NULL DEFAULT '',
  grade         TEXT NOT NULL DEFAULT '',
  late          INTEGER NOT NULL DEFAULT 0,
  raw           REAL,
  dims          TEXT,                     -- JSON
  score         REAL,
  comment       TEXT NOT NULL DEFAULT '',
  graded_at     TEXT NOT NULL DEFAULT '',
  graded_by     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sub_asg_sid ON submissions (assignment_id, sid);
CREATE INDEX IF NOT EXISTS idx_sub_class   ON submissions (class_id, sid);

-- 学生登录密码的**派生值**（不是明文，也不可逆）
--
-- 只在「学生登录方式 = 青果账号密码」时使用：
--   第一次用青果验证通过 → 存下 scrypt(password, salt)
--   之后同一学号再登录   → 本地比对，不再打青果（既快，也不消耗青果的失败次数）
--
-- 三个必须记住的点：
--   · 只存 salt + hash + 算法名，**永远不存明文**
--   · 学生改过青果密码时本地会对不上 → 提供「用青果再验一次」的显式入口，
--     通过后覆盖哈希（绝不静默重试，青果满 5 次锁号）
--   · 教师端可以一键清空（换设备/怀疑泄露时）
CREATE TABLE IF NOT EXISTS student_credentials (
  sid        TEXT PRIMARY KEY,
  algo       TEXT NOT NULL DEFAULT 'scrypt',
  salt       TEXT NOT NULL DEFAULT '',
  hash       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

-- 学生登录失败计数 / 本地熔断
--
-- 为什么要有这张表：
--   外部系统的规则是「24 小时内输错 5 次锁号」。
--   等它锁到第 5 次，学生就已经进不去了。
--   所以在**本系统**里数到 3 次就自己停 —— 之后连请求都不发，
--   学生只是登不进课堂系统，账号本身没事。
--
-- 用 account（登录名）而不是 sid 做主键：账号可能带前缀，失败记录要能对上他输的那个名字。
CREATE TABLE IF NOT EXISTS student_login_fails (
  account        TEXT PRIMARY KEY,
  sid            TEXT    NOT NULL DEFAULT '',  -- 能认出来的学号（班级管理页按它显示）
  fail_count     INTEGER NOT NULL DEFAULT 0,   -- 本系统数的失败次数
  remote_count   INTEGER NOT NULL DEFAULT 0,   -- 外部系统自报的当日输错次数（最近一次）
  remote_at      TEXT    NOT NULL DEFAULT '',
  blocked        INTEGER NOT NULL DEFAULT 0,   -- 自动熔断（数到 3 次）
  manual_blocked INTEGER NOT NULL DEFAULT 0,   -- 老师手动禁用
  blocked_at     TEXT    NOT NULL DEFAULT '',
  updated_at     TEXT    NOT NULL DEFAULT ''
);

-- 迁移版本（谁跑过哪些脚本）
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT ''
);
