/**
 * 作业 / 考试的「现在处在哪一步」。
 *
 * ============================ 为什么要有这个文件 ============================
 *
 * 这套判定原来散在五处：后端 gateOf、前端两份 stateOf、学生端两个页面各写一份。
 * 每修一个场景就多一套，下次漏掉一套再修一次 —— 表现出来就是
 * 「教师端状态不更新」「学生分批后进不去」「两端提示语不一样」反复出现。
 *
 * 现在只有这里判，其他地方要么调用它，要么把 phase 翻译成人话。
 *
 * ============================ 两份，不是一份 ============================
 *
 * phaseOf(a, sid)      **学生视角**：这个人现在能不能进
 * teacherPhaseOf(a)    **教师视角**：这场整体处在什么阶段
 *
 * 它们不能合并：学生要回答「我能不能进」，所以有「还没轮到你」；
 * 老师要回答「这场什么阶段」，没有「我」这个概念。
 * 强行合成一份，一定会出现教师端显示「还没轮到你」这种话。
 */
import * as repo from './repo.js'

/* ---------------- 学生视角 ---------------- */

/**
 * @typedef {'open'|'waiting'|'batch-overdue'|'batch-closed'|'overdue'|'closed'|'draft'} StudentPhase
 *
 * @returns {{ phase: StudentPhase, batch: object|null }}
 */
export function phaseOf(a, sid, now) {
  const t = now || Date.now()
  const batches = repo.batchesOf(a.id)

  /* 没有批次的老数据：只看整场，行为和以前完全一致 */
  if (!batches.length) {
    if (a.status !== 'open') return { phase: a.openedAt ? 'closed' : 'draft', batch: null }
    if (a.dueAt && Date.parse(a.dueAt) && t > Date.parse(a.dueAt) && !a.allowLate) {
      return { phase: 'overdue', batch: null }
    }
    return { phase: 'open', batch: null }
  }

  /*
   * 有批次就**只认批次**，整场 status 不参与判定。
   * 顺序有讲究：先找他能进的，再找他进的但已经不能交的，最后才轮到「别人在考」。
   */
  const mine = batches.filter((b) => b.sids.includes(String(sid)))

  const live = mine.find((b) => b.status === 'open' && !repo.batchOverdue(b, t))
  if (live) return { phase: 'open', batch: live }

  /* 他这一批到点了：和「被老师收了」是两件事，前者可能还有商量余地 */
  const expired = mine.find((b) => b.status === 'open' && repo.batchOverdue(b, t))
  if (expired) return { phase: 'batch-overdue', batch: expired }

  /* 他进过某一批，但那批已经关了 */
  if (mine.length) return { phase: 'batch-closed', batch: mine[mine.length - 1] }

  /* 他不在任何一批里：还有别的批在放人就叫「没轮到你」，否则就是结束了 */
  const waiting = batches.some((b) => b.status === 'open' && !repo.batchOverdue(b, t))
  if (waiting) return { phase: 'waiting', batch: null }
  return { phase: 'closed', batch: null }
}

/* ---------------- 教师视角 ---------------- */

/**
 * @typedef {'open'|'batch'|'overdue'|'closed'|'draft'} TeacherPhase
 */
export function teacherPhaseOf(a, now) {
  const t = now || Date.now()
  const batches = repo.batchesOf(a.id)

  const live = batches.filter((b) => b.status === 'open' && !repo.batchOverdue(b, t))
  /* 有批在放人 —— 分批是常态，放在最前 */
  if (live.length) return 'batch'

  const over = !!(a.dueAt && Date.parse(a.dueAt) && t > Date.parse(a.dueAt) && !a.allowLate)
  if (batches.length) {
    /*
     * 有批次但都不在跑 = 这场跑过了，已经收工。
     *
     * 这里**不能**用 a.openedAt 判断「开过没开过」：
     * 分批模式下老师从不点整场「开始」，openedAt 永远是空的，
     * 而实际上刚刚放完人、收完了 —— 显示成「未开始」等于把这一场抹掉。
     */
    if (over) return 'overdue'
    return 'closed'
  }
  if (a.status !== 'open') return a.openedAt ? 'closed' : 'draft'
  if (over) return 'overdue'
  return 'open'
}

/* ---------------- 文案 ---------------- */

/**
 * phase → 给学生的解释。**后端只有这一份。**
 *
 * 前端标签有自己的短说法（「这批已结束」），但「为什么交不上」必须由这里说。
 * @param {string} phase
 * @param {object} a     作业（用来区分作业 / 机试的称呼）
 */
export function phaseMessage(phase, a) {
  const exam = a && (a.kind === 'paper' || a.kind === 'exam' || String(a.itemKey || '') === 'exam')
  switch (phase) {
    case 'batch-overdue':
      return '你这一批的时间到了，不能再提交'
    case 'batch-closed':
      return '你这一批已经结束了'
    case 'waiting':
      return '还没有轮到你（老师正在分批放人），等一会儿再试'
    case 'overdue':
      return '已经过了截止时间，不再接收。有特殊情况请找老师'
    case 'closed':
      return exam ? '这场机试已经结束了' : '这次作业已经结束了'
    default:
      return exam ? '老师还没开始这场机试' : '这次作业还没开始'
  }
}

/** 这个学生此刻能不能交 —— 「能不能」是 phase 的一小部分，别在调用方拼逻辑 */
export function gateOf(a, sid, now) {
  const p = phaseOf(a, sid, now)
  return { ok: p.phase === 'open', via: p.phase, batch: p.batch }
}
