/*
 * scoresheet.js —— 每个学生目录下的「分数派生表」
 *
 *   data/students/<班级>/<学号>/记分/总评.xlsx   各项分数 + 总评（一张表）
 *   data/students/<班级>/<学号>/记分/明细.xlsx   这条记分流水
 *   data/students/<班级>/<学号>/机试/成绩.xlsx   机试每次录入的卷面分与折算
 *   data/students/<班级>/<学号>/大作业/证据清单.xlsx 老师侧的评分证据索引
 *
 * ## 这里曾经断过
 *
 * 旧实现（server/lib/students.js 的 writeScoreSheet）在 11-03 之前一直真实生成这些文件，
 * 删掉 server/ 重构时**函数搬过来了、调用点没搬** —— 于是文件停在 11-03，
 * 而 README、说明.txt、几份规范、以及大作业页的 toast 都还在承诺它。
 * 老师按文档去看，看到的是过期分数。这比"没有"更糟。
 *
 * 现在由 repo 的事件钩子触发（insertEvent / voidEvent / restoreEvent），
 * 单一入口，覆盖所有给分路径（批阅、手动给分、考勤、撤销、恢复）。
 *
 * ## 为什么是 xlsx 而不是 CSV
 *
 * 学号是长数字，CSV 进 Excel 会变 2.02E+09；中文姓名在部分版本乱码。
 * 和「导出总评 / 导出流水」保持同一种格式，老师不用记两套。
 *
 * ## 边界
 *
 * 纯派生：真源是数据库里的记分记录，这些文件删了会重新生成。
 * 所以**任何失败都只记日志，绝不影响记分本身**（磁盘满、权限、文件被占用都不该让学生给不了分）。
 */
import fs from 'node:fs'
import path from 'node:path'
import * as repo from './repo.js'
import * as scoring from './scoring.js'
import * as students from './students.js'
import { rowsToXlsx } from './xlsx.js'

/** 同一学生 300ms 内的多次变更合并成一次写（点名一次改 60 人时很关键） */
const timers = new Map()

/**
 * 安排刷新。fire-and-forget：不 await、不抛，失败只记日志。
 * @param {string} classId
 * @param {string} sid
 */
export function schedule(classId, sid) {
  if (!classId || !sid) return
  const key = classId + '/' + sid
  if (timers.has(key)) clearTimeout(timers.get(key))
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      refreshOne(classId, sid).catch((e) => {
        console.error('[scoresheet] 刷新失败 ' + key + '：' + (e && e.message))
      })
    }, 300)
  )
  // 进程退出时不阻塞
  if (timers.get(key).unref) timers.get(key).unref()
}

/** 某个班的全部学生都刷一遍（批量改分后想立刻看到时用；平时走 schedule 就够了） */
export async function refreshClass(classId) {
  const roster = repo.rosterOf(classId)
  for (const s of roster) await refreshOne(classId, s.sid)
  return roster.length
}

/** 刷新一个学生的 4 张表 */
export async function refreshOne(classId, sid) {
  const cls = repo.getClass(classId)
  if (!cls) return false
  const stu = repo.rosterOf(classId).find((s) => s.sid === sid)
  if (!stu) return false

  const events = repo.eventsOf(classId, { limit: 5000 }).items.filter((e) => e.sid === sid)

  /*
   * 分数要在「这门课的方案」上下文里算。
   * 直接调 scoring.computeStudent 会用默认方案 —— 多课程时分数会算错
   * （这正是老实现的一个隐患，搬过来时顺手修掉）。
   */
  const course = cls.courseId ? repo.getCourse(cls.courseId) : null
  const schemeMod = await import('./scheme.js')
  const sc = schemeMod.withCourseScheme(course, () => scoring.computeStudent(events, sid))
  const items = schemeMod.withCourseScheme(course, () => schemeMod.items())

  const pick = (key) => {
    const row = (sc.rows || []).find((r) => r.item && r.item.key === key)
    return row ? Number(row.score || 0) : 0
  }
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

  // 1) 总评：一张表里既有各项也有总评，比拆两张更实用
  const totalRows = [['学号', '姓名', '班级', ...items.map((i) => i.name), '总评', '更新时间']]
  totalRows.push([stu.sid, stu.name || '', cls.name || '', ...items.map((i) => pick(i.key)), sc.total, now])

  // 2) 明细：这个人的记分流水
  const detailRows = [['时间', '计分项', '变更', '事由', '操作人', '状态']]
  for (const e of events.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
    const item = items.find((i) => i.key === e.item)
    detailRows.push([
      e.createdAt || '',
      item ? item.name : e.item,
      scoring.eventSummary(e),
      e.reason || '',
      e.operator || '',
      e.voided ? '已撤销' : '有效',
    ])
  }

  // 3) 机试：每次录入的卷面分与折算
  const examRows = [['时间', '卷面分', '折算', '事由', '操作人', '状态']]
  for (const e of events) {
    if (e.item !== 'exam' || typeof e.raw !== 'number') continue
    examRows.push([e.createdAt || '', e.raw, scoring.round1(e.raw * 0.3), e.reason || '', e.operator || '', e.voided ? '已撤销' : '有效'])
  }

  // 4) 大作业：证据索引（文件本体在 data/uploads/）
  const projRows = [['时间', '事由', '文件名', '链接', '操作人']]
  for (const e of events) {
    for (const f of e.evidence || []) {
      projRows.push([e.createdAt || '', e.reason || '', f.name || '', f.url || '', e.operator || ''])
    }
  }

  const base = students.dirOf(classId, sid)
  const write = async (sub, name, rows, sheetName) => {
    const dir = path.join(base, sub)
    fs.mkdirSync(dir, { recursive: true })
    const buf = await rowsToXlsx(rows, { sheetName, textCols: [0] })
    fs.writeFileSync(path.join(dir, name), buf)
  }

  await write(students.SUB.scores, '总评.xlsx', totalRows, '总评')
  await write(students.SUB.scores, '明细.xlsx', detailRows, '明细')
  await write(students.SUB.exam, '成绩.xlsx', examRows, '机试')
  await write(students.SUB.project, '证据清单.xlsx', projRows, '证据清单')

  // 老版本留下的 .csv 顺手清掉，免得老师看到两份内容不一致的表
  for (const [sub, name] of [
    [students.SUB.scores, '总评.csv'],
    [students.SUB.scores, '明细.csv'],
    [students.SUB.exam, '成绩.csv'],
    [students.SUB.project, '证据清单.csv'],
  ]) {
    const old = path.join(base, sub, name)
    try {
      if (fs.existsSync(old)) fs.unlinkSync(old)
    } catch (e) {
      /* 删不掉就算了，不影响新的 xlsx */
    }
  }

  return true
}
