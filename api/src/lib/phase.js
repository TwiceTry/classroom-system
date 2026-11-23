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
 * **学生视角只有四个状态**，而且都是「他能不能做这件事」的口径：
 *
 *   open      进行中 —— 能交 / 能考
 *   waiting   还没开始 —— 老师还没放开
 *   overdue   已截止 —— 时间到了
 *   closed    已结束 —— 老师收了
 *
 * ============================ 为什么没有「分批」的词 ============================
 *
 * 分批是**老师的管理工具**（机器不够、要盯纪律），不是学生要理解的概念。
 *
 * 学生不该看到「第 1 批」「这批已结束」「还没轮到你」——
 * 那等于告诉他「你们被分成几组，你是第 2 组」，而他只需要知道
 * 「现在能不能做」。教室里的安排老师会口头说，系统不必复述。
 *
 * 所以「他这一批到点了」归一成 `overdue`，「他所在那批被收了」归一成 `closed`。
 * 老师那边仍然知道是哪一批（teacherPhaseOf 只关心「有没有批在跑」）。
 *
 * @returns {{ phase: 'open'|'waiting'|'overdue'|'closed', batch: object|null }}
 *          batch 只给后端自己用（算批次统计），**不往学生接口上暴露**
 */
export function phaseOf(a, sid, now) {
  const t = now || Date.now()
  const batches = repo.batchesOf(a.id)

  /* 整场的截止时间：和批次无关，任何时候都算 */
  const overDue = !!(a.dueAt && Date.parse(a.dueAt) && t > Date.parse(a.dueAt) && !a.allowLate)

  /* 没有批次的老数据：只看整场，行为和以前一致 */
  if (!batches.length) {
    if (a.status !== 'open') return { phase: a.openedAt ? 'closed' : 'waiting', batch: null }
    if (overDue) return { phase: 'overdue', batch: null }
    return { phase: 'open', batch: null }
  }

  /*
   * 有批次就只认批次，整场 status 不参与判定。
   * 顺序：先找他能进的，再找他进的但已经不能做的，最后才轮到「别人在做」。
   */
  const mine = batches.filter((b) => b.sids.includes(String(sid)))

  const live = mine.find((b) => b.status === 'open' && !repo.batchOverdue(b, t))
  if (live) return { phase: 'open', batch: live }

  /* 他这一批到点 / 被关：对学生都是「不能做了」，不细分是哪一种 */
  if (mine.length) {
    const last = mine[mine.length - 1]
    const expired = last.status === 'open' && repo.batchOverdue(last, t)
    return { phase: expired ? 'overdue' : 'closed', batch: last }
  }

  /* 他不在任何一批里：有别的批在跑就是「还没开始」，否则就是结束了 */
  const waiting = batches.some((b) => b.status === 'open' && !repo.batchOverdue(b, t))
  return { phase: waiting ? 'waiting' : 'closed', batch: null }
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
  const what = exam ? '这场考试' : '这次作业'
  switch (phase) {
    /*
     * 文案里**不出现「批」字**。
     * 分批是老师那边的排班方式，学生只需要知道「现在能不能做」。
     */
    case 'overdue':
      return '时间到了，不能再提交'
    case 'closed':
      return what + '已经结束了'
    case 'waiting':
      return what + '还没开始，等老师开始后再来'
    default:
      return what + '还没开始'
  }
}

/** 这个学生此刻能不能交 —— 「能不能」是 phase 的一小部分，别在调用方拼逻辑 */
export function gateOf(a, sid, now) {
  const p = phaseOf(a, sid, now)
  return { ok: p.phase === 'open', via: p.phase, batch: p.batch }
}
