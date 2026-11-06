/*
 * lib/legacy.js —— 复用旧后端里「纯函数、无状态」的模块
 *
 * 为什么复用而不是重写：
 *   · exam.js：题库抽卷（按种子保证同一学生每次拿到同一份）、自动判分、
 *     卷面渲染 —— 这些是「算错了没人立刻发现，但学生会来吵」的逻辑；
 *   · coursepack.js：课程包格式（版本、校验、路径安全、哈希）
 *   —— 一旦与新实现有细微差异，导出的包在别人机器上就打不开。
 *
 * 这两个模块本身不碰数据库、不碰全局状态，所以直接 require 是安全的。
 * scheme/scoring 的复用见 lib/scheme.js（同样理由）。
 * S5 可以逐个内联，但现在优先保证「行为与旧版完全一致」。
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { addStudents } from './repo.js'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url)) // api/src/lib
const ROOT = path.resolve(HERE, '..', '..', '..')
const LEGACY = path.join(ROOT, 'server', 'lib')

/** 机试：抽卷 / 判分 / 卷面渲染 */
export const examLib = require(path.join(LEGACY, 'exam.js'))
/** 课程包：导出 / 模板 / 路径安全 */
export const coursepack = require(path.join(LEGACY, 'coursepack.js'))
/** 课程包导入（解析 zip） */
export const coursepackImport = require(path.join(LEGACY, 'coursepack-import.js'))
/** 内容扫描：课次清单 / 文档正文 / 代码示例（纯文件遍历，无状态） */
export const content = require(path.join(LEGACY, 'content.js'))
/** 内容在线编辑（列目录/读写/上传/改名/删除）—— 纯文件操作 */
export const coursefiles = require(path.join(LEGACY, 'coursefiles.js'))
/** 整目录 zip 导入导出 —— 纯文件操作 */
export const contentio = require(path.join(LEGACY, 'contentio.js'))
/** 方案 JSON 的导入/导出/试算 —— 读写 data/schemes/*.json */
export const schemeio = require(path.join(LEGACY, 'schemeio.js'))
/** 作业库（设计稿）：列表/导入/导出/删除/模板 —— 纯文件操作 */
export const assignlib = require(path.join(LEGACY, 'assignlib.js'))
/** 班级包：导出/预检/应用/template —— 同样是把 db 当参数传 */
export const classio = require(path.join(LEGACY, 'classio.js'))
/** 表格解析：Excel / CSV 名单（纯解析，无状态） */
export const sheet = require(path.join(LEGACY, 'sheet.js'))
/** 作息时间表：按当前时刻算出「第几节 / 周几 / 时段」（纯计算） */
export const timetable = require(path.join(LEGACY, 'timetable.js'))
/** 浏览器兼容性兜底页的信息（最低 Chrome 版本 / 绿色版包 / 找谁要） */
export const compat = require(path.join(LEGACY, 'compat.js'))
/** 学生目录（data/students/<班>/<学号>/…）的创建与路径规则 */
export const studentsLib = require(path.join(LEGACY, 'students.js'))

/**
 * 给 coursepack-import 打一个必要的补丁。
 *
 * 它内部拿到 `studentsLib` 后，导入名单时只调 `ensureMany(classId, students)` ——
 * 而旧的 `ensureMany` **只建学生目录，不写名单**（CSV 时代名单在 classes.csv 里，
 * 导入时由 save() 落盘）。到了 SQLite 这里，save() 是空操作 →
 * 课程导进来了，班级也建了，**名单却是 0 个人**。
 *
 * 这里把它改成「建目录 + 写库」。用的是同一个模块对象，
 * coursepack-import 里的引用会立刻看到改动。
 */
studentsLib.ensureMany = (classId, list) => {
  for (const s of list || []) if (s && s.sid) studentsLib.ensure(classId, s.sid)
  addStudents(classId, list || [])
}

export { ROOT }
