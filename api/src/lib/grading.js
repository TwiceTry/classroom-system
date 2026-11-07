/*
 * lib/grading.js —— 判分 + 记账（唯一的记账入口）
 *
 * 作业批阅、机试判卷、大作业量规都走这一段，保证「分数从哪来、哪条账生效」
 * 只有一种解释：
 *   1) 先撤掉上一条账（eventId 记在提交记录上）
 *   2) 按方案里这一项的规则判分（rubric / raw / avg）
 *   3) 记一条新事件
 *   4) 把分数/等级/评语回写提交记录
 * 计分表始终「只追加 + 撤销」，不会两条同时生效。
 */

import * as repo from './repo.js'
import * as scheme from './scheme.js'
import { scoring, withCourseScheme } from './scheme.js'
import { badRequest } from './errors.js'

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

/** 考核项 → 作业类型（与旧实现同一判据） */
export function kindOfItem(item) {
  if (!item) return 'work'
  if (item.form === 'paper') return 'paper'
  if (item.module && item.module.submit === 'files') return 'project'
  return 'work'
}

export function courseOfClass(classId) {
  const c = classId ? repo.getClass(classId) : null
  return c && c.courseId ? repo.getCourse(c.courseId) : null
}

export function courseOfAssignment(a) {
  return a && a.courseId ? repo.getCourse(a.courseId) : null
}

/**
 * 判分 + 记账。
 * body 三选一：{ grade, late } / { raw } / { dims }；都为空 = 清分。
 */
export function gradeSubmission(a, sub, who, body) {
  const course = courseOfClass(sub.classId) || courseOfAssignment(a)
  return withCourseScheme(course, () => {
    const cls = repo.getClass(sub.classId)
    const item = scheme.itemByKey(a.itemKey) || scheme.itemByKey('homework')
    const mode = item && item.rule ? item.rule.type : 'avg'
    const isRubric = mode === 'rubric'
    const isRaw = mode === 'raw'

    /*
     * 注意顺序：**先算、先校验，全部通过了才动旧账**。
     *
     * 原来这里是「先把上一条 event 作废，再解析并校验新的」。
     * 于是老师手滑输个超范围的卷面分（比如卷面 100 却打了 500），
     * 接口返回 400 弹个错，看起来「没保存成功、原来那条还在」——
     * 实际上旧成绩**已经被作废了**，学生这一项直接变成 0 分。
     *
     * 这个 bug 是 e2e 抓出来的：判 80 得 24 分之后，再发一个 raw=500，
     * 虽然 400 被拒，学生那一项就归零了。
     *
     * 所以撤旧账的动作挪到 insertEvent 之前（下面），这里只声明变量。
     */
    let eventId = sub.eventId || ''

    const clear = isRubric
      ? body.dims === '' || body.dims === null || body.dims === undefined
      : isRaw
        ? body.raw === '' || body.raw === null || body.raw === undefined
        : !body.grade

    let score
    let ev = null

    if (!clear) {
      if (!item) throw badRequest('考核方案里找不到这一项（' + a.itemKey + '）')
      ev = {
        id: uid('e'),
        classId: sub.classId,
        sid: sub.sid,
        item: item.key,
        reason: a.title,
        operator: who || '教师',
        createdAt: new Date().toISOString(),
        voided: false,
        evidence: [],
        weight: body.weight === undefined ? a.weight : body.weight,
        schemeVersion: String(scheme.version ? scheme.version() : ''),
      }

      if (isRubric) {
        ev.dims = {}
        let sum = 0
        for (const d of item.dims || []) {
          const v = scoring.clamp(Number((body.dims || {})[d.key]) || 0, 0, d.full)
          ev.dims[d.key] = v
          sum += v
        }
        score = scoring.round1(sum)
      } else if (isRaw) {
        const raw = Number(body.raw)
        const rawFull = Number(item.rawFull || 100)
        if (!isFinite(raw) || raw < 0 || raw > rawFull) throw badRequest('卷面分应在 0–' + rawFull + ' 之间')
        ev.raw = raw
        score = scoring.round1(scoring.clamp(raw * (item.factor || item.full / rawFull), 0, item.full))
      } else {
        const g = (item.grades || []).find((x) => x.key === body.grade)
        if (!g) throw badRequest('等级不在方案的等级表里')
        ev.grade = g.key
        ev.late = !!body.late
        /*
         * 按**本项满分**折算，不是固定 100。
         *
         * 原来这里写的是 `100 * factor * late`：作业项满分 20 时，
         * 判 A 存进 submission.score 的就是 100（判 B 迟交是 42.5），
         * 而计分引擎按方案算出的是 20（和 8.5）—— 两套数字对不上。
         * 老师在批阅页看到「100 分」，实际只计了 20 分；
         * 导出成绩表读的也是这个字段，会把分带错。
         *
         * 现在与计分引擎同口径：item.full × 等级系数 × 迟交系数，并夹到 [0, full]。
         */
        const lateFactor = item.lateFactor === undefined ? 0.5 : Number(item.lateFactor)
        const full = Number(item.full) || 100
        score = scoring.round1(
          scoring.clamp(full * g.factor * (ev.late ? lateFactor : 1), 0, full)
        )
      }
      // 到这里已经算完、校验通过 —— 现在才动旧账，失败也不会把旧成绩弄丢
      if (sub.eventId && cls) {
        const old = repo.findEvent(cls.id, sub.eventId)
        if (old && !old.voided) repo.voidEvent(cls.id, sub.eventId, '重新批阅')
      }

      repo.insertEvent(ev)
      eventId = ev.id
    } else if (sub.eventId && cls) {
      // 清分（老师把评分清空）：这时候确实要作废旧账
      const old = repo.findEvent(cls.id, sub.eventId)
      if (old && !old.voided) repo.voidEvent(cls.id, sub.eventId, '清空评分')
      eventId = ''
    }

    return submissionView(
      repo.updateSubmission(sub.id, {
        score: clear ? null : score,
        comment: String(body.comment || '').slice(0, 1000),
        gradedAt: clear ? '' : new Date().toISOString(),
        gradedBy: clear ? '' : who || '教师',
        eventId,
        grade: ev && ev.grade ? ev.grade : '',
        late: !!(ev && ev.late),
        raw: ev && typeof ev.raw === 'number' ? ev.raw : null,
        dims: ev && ev.dims ? ev.dims : null,
      })
    )
  })
}

/** 提交记录对外形状（作业与机试共用） */
export function submissionView(s, className) {
  if (!s) return null
  return {
    id: s.id,
    assignmentId: s.assignmentId,
    classId: s.classId,
    className: className || '',
    sid: s.sid,
    name: s.name || '',
    dir: s.dir || '',
    createdAt: s.createdAt || '',
    files: s.files || [],
    changed: s.changed || [],
    // 列表里的「改动 / 文件」列、抽屉底部的「整份交了 N 个、其中改了 M 个」都要用
    fileCount: (s.files || []).length,
    changedCount: (s.changed || []).length,
    note: s.note || '',
    url: s.url || '',
    eventId: s.eventId || '',
    grade: s.grade || '',
    late: !!s.late,
    raw: s.raw === null || s.raw === undefined ? undefined : Number(s.raw),
    dims: s.dims || undefined,
    score: s.score === null || s.score === undefined ? undefined : Number(s.score),
    comment: s.comment || '',
    gradedAt: s.gradedAt || '',
    gradedBy: s.gradedBy || '',
  }
}
