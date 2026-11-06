/*
 * students.js —— 每个学生一个专属目录（加进名单那一刻就建）
 *
 *   data/students/<班级 id>/<学号>/
 *       作业/<作业 id>/<提交 id>/…     课堂作业交上来的整份代码
 *       大作业/                        课程项目：证据文件、定稿
 *       机试/                          期末机试生成的试卷（出卷功能落地后放这里）
 *       记分/明细.csv、总评.csv        这个学生的记分记录
 *
 * 为什么按学生归档：期末要把「这个人一学期的东西」整包交出去（评优、复查、给学生本人看），
 * 按作业 id 归档时得满磁盘捞；按学号归档，打开就是一套完整材料。
 *
 * 边界：**真源仍是 data/*.csv**。目录里的记分快照是派生物（events.csv 算出来的），
 * 删掉也能重新生成；作业正文反过来只有磁盘这一份，所以那部分别手删。
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
  '  大作业/ 课程项目：<作业 id>/<提交 id>/ 下是学生交上来的附件；证据清单.csv 记老师侧的评分证据',
  '  机试/   期末机试的成绩记录（成绩.csv），将来生成的试卷也放这里',
  '  记分/   这个学生的记分记录（总评.csv / 明细.csv）',
  '',
  '注意：作业正文只有磁盘这一份，别手删；其余 CSV 都是派生物，',
  '      真源是data/events.csv，删了会在下次记分时重新生成。',
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

/** 首次用到时把「这个目录是干什么的」写一份，老师打开资源管理器能看懂 */
function ensureNote() {
  const file = path.join(ROOT, '说明.txt')
  if (fs.existsSync(file)) return
  try {
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
