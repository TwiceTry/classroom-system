/*
 * students.js —— 每个学生一个专属目录（加进名单那一刻就建）
 *
 *   data/students/<班级 id>/<学号>/
 *       作业/<作业 id>/<提交 id>/…     课堂作业交上来的整份代码
 *       大作业/                        课程项目：证据文件、定稿
 *       机试/                          期末机试交上来的答卷
 *
 * 为什么按学生归档：期末要把「这个人一学期的东西」整包交出去（评优、复查、给学生本人看），
 * 按作业 id 归档时得满磁盘捞；按学号归档，打开就是一套完整材料。
 *
 * 边界：**这里只存「学生交上来的文件」**，而且只有磁盘这一份，别手删。
 *
 * 记分/ 里是**派生表**（总评.xlsx / 明细.xlsx），由 lib/scoresheet.js 在给分后重写；
 * 机试/成绩.xlsx、大作业/证据清单.xlsx 同理。真源始终是数据库里的记分记录。
 *
 * 历史坑：删 server/ 重构时，写这些快照的 writeScoreSheet() 搬过来了、
 * **调用点没搬** —— 文件停在 11-03 而文档一直在承诺它，老师看到的分数是过期的。
 * 现在改成数据层事件钩子（repo.setEventHook）触发，覆盖给分/撤分/恢复全部路径。
 */

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { addStudents } from './repo.js'

const ROOT = path.join(config.dataDir, 'students')

/** 子目录名：目录是要给人翻的，用中文；代码里只认这里的常量 */
const SUB = {
  work: '作业',
  project: '大作业',
  exam: '机试',
  scores: '记分',
}

const NOTE = [
  '这个目录由课堂系统维护：每个学生一套，按「班级 / 学号」分开。',
  '',
  '  作业/   课堂作业的每次提交，子目录是「作业 id / 提交 id」，里面是学生交上来的整份文件',
  '  大作业/ 课程项目：<作业 id>/<提交 id>/ 下是学生交上来的附件',
  '  机试/   期末机试交上来的答卷',
  '  记分/   这个学生的分数（总评.xlsx / 明细.xlsx），给分或撤分后自动重写',
  '',
  '注意两件事：',
  '  1) 作业 / 大作业 / 机试 里的文件只有磁盘这一份，删了就没了；',
  '  2) 记分/ 里的是**派生表** —— 真源在系统数据库里，删了会自动重新生成。',
  '',
  '要整班的分数表，还是用教师端「班级管理 → 导出总评 / 导出流水」（xlsx）。',
  '',
].join('\r\n')

function safeSeg(s) {
  return String(s == null ? '' : s).replace(/[^0-9a-zA-Z_-]/g, '_').slice(0, 64) || '_'
}

function dirOf(classId, sid) {
  return path.join(ROOT, safeSeg(classId), safeSeg(sid))
}

function subOf(classId, sid, kind) {
  return path.join(dirOf(classId, sid), SUB[kind] || SUB.work)
}

/**
 * 把「这个目录是干什么的」写一份，老师打开资源管理器能看懂。
 *
 * 内容变了要覆盖：原来写的是 `if (exists) return`，
 * 结果说明.txt 一旦生成就再也不会更新 —— 里面提到的东西删了，老师看到的还是旧说法。
 */
function ensureNote() {
  const file = path.join(ROOT, '说明.txt')
  try {
    if (fs.existsSync(file)) {
      const old = fs.readFileSync(file, 'utf8')
      if (old === NOTE) return
    }
    fs.mkdirSync(ROOT, { recursive: true })
    fs.writeFileSync(file, NOTE, 'utf8')
  } catch (e) {
    /* 写不出来不影响功能 */
  }
}

/**
 * 建好某个学生的目录骨架。
 * 幂等：已经有的目录不会被动；失败也不抛（磁盘满 / 权限问题时不能让点名、记分跟着挂）。
 */
function ensure(classId, sid) {
  const base = dirOf(classId, sid)
  try {
    ensureNote()
    for (const key of Object.keys(SUB)) fs.mkdirSync(path.join(base, SUB[key]), { recursive: true })
  } catch (e) {
    console.error('[students] 建目录失败 ' + base + '：' + e.message)
  }
  return base
}

/**
 * 「补齐这些学生」= 建目录 + 写名单。
 *
 * 旧实现只建目录：CSV 时代名单在 classes.csv 里，由调用方 save() 落盘。
 * 到了 SQLite，save() 是空操作 —— 只建目录的结果就是
 * **课程包导进来了、班级也建了，名单却是 0 个人**。
 * 所以这里必须同时写库。
 */
function ensureMany(classId, students) {
  for (const s of students || []) if (s && s.sid) ensure(classId, s.sid)
  if (students && students.length) addStudents(classId, students)
}

/** 全量补一遍（启动 / 导入名单后调用：老库里没有目录的学生一次补齐） */
function ensureAll(classes) {
  for (const c of classes || []) {
    if (!c || !c.id) continue
    ensureMany(
      c.id,
      (c.students || []).map((s) => ({ sid: s.sid }))
    )
  }
}

/** 某个学生某次作业的目录：作业/<作业 id> */
function workDir(classId, sid, assignmentId) {
  return path.join(subOf(classId, sid, 'work'), safeSeg(assignmentId))
}

/** 班级目录（删班时整棵删） */
function classDir(classId) {
  return path.join(ROOT, safeSeg(classId))
}

export { ROOT, SUB, safeSeg, dirOf, subOf, workDir, classDir, ensure, ensureMany, ensureAll }
