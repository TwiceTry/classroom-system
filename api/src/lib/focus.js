/*
 * lib/focus.js —— 课堂聚焦：一个班同一时刻只允许一种「学生端状态」
 *
 * 会占用学生屏幕的东西一共六样，它们本来各存各的、互不知晓：
 *
 *   exam       正在考试          考试开始 → 交卷/超时
 *   spotlight  点名（考勤 / 互动） 老师抽人 → 结束点名
 *   homework   学生自己在做作业     学生打开作业页 → 离开
 *   follow     讲义跟随          老师翻讲义 → 停跟随
 *   pgsync     代码同步          老师推代码 → 停同步
 *   idle       什么都没有
 *
 * 原来只有前三样里的 three 种能互相清（standDown），而且是「谁后立谁赢」——
 * 于是老师推代码能把正在考试的学生带离考场，点名结束后学生的作业页被
 * 讲义的跳转打断。谁先谁后全看操作顺序，没有规矩。
 *
 * 现在有了明确优先级（数字大的压住小的，同级可互覆）：
 *
 *   exam 100  >  spotlight 80  >  homework 60  >  follow = pgsync 40  >  idle 0
 *
 * 立不起来的时候**不是悄悄失败**：pushFocus 返回 { blocked: true, current }，
 * 调用方（教师端）据此提示「这次没推下去，有学生在考试」，而不是按了没反应。
 *
 * 存储：state['focus:<cid>']，一个班一条。为什么落库不纯内存 ——
 * 学生刷新页面、换设备都要能恢复出「现在该显示什么」，服务端重启也不该丢。
 * 带 expiresAt 的（考试）过期自动失效，避免学生没交卷就关掉、状态永远卡住。
 */

/* 优先级表：改这里就是改规则，不要在各个入口散着写 if */
export const RANK = {
  idle: 0,
  pgsync: 40,
  follow: 40,
  homework: 60,
  spotlight: 80,
  exam: 100,
}

const KEY = (cid) => 'focus:' + cid

/**
 * 讲义跟随的当前位置。
 *
 * 单独留在内存里（不放进 focus 记录）：学生刷新时前端要拿它恢复页面，
 * 而 focus 记录只是「谁占了屏幕」。两者生命周期一样，但用途不同。
 * 语义仍是「全局一个」：一个老师在讲，全班看同一处。
 */
let followState = null

export function getFollow() {
  return followState
}

export function setFollow(v) {
  followState = v
}

/** 只清跟随（教师主动停） */
export function stopFollow(broadcast) {
  if (!followState) return false
  followState = null
  broadcast({ t: 'follow', stopped: true })
  return true
}

/**
 * 每种状态「被顶掉」时要广播的清空消息。
 * 这些消息是给各组件自己用的（它们早就认识），focus 只是总闸。
 */
const CLEAR_MSG = {
  follow: () => ({ t: 'follow', stopped: true }),
  pgsync: () => ({ t: 'pgsync', sync: null }),
  spotlight: () => ({ t: 'spotlight', clear: true }),
  homework: () => ({ t: 'activity', active: 'idle' }),
  exam: () => ({ t: 'exam', active: false }),
}

/** 当前占用者（过期的不算） */
export function getFocus(classId, deps) {
  if (!classId) return null
  let cur = null
  try {
    cur = deps.repo.getState(KEY(classId), null)
  } catch (e) {
    return null
  }
  if (!cur) return null
  if (cur.expiresAt && Date.parse(cur.expiresAt) < Date.now()) {
    /* 过期（考试超时没交卷）——当作没有，顺手清掉，别让状态永远卡着 */
    try {
      deps.repo.setState(KEY(classId), null)
    } catch (e) {
      /* 清不掉也不影响本次判断 */
    }
    return null
  }
  return cur
}

/**
 * 立起一种状态。
 *
 * @param classId 班级 id
 * @param kind    RANK 里的键
 * @param payload { sid?, assignmentId?, expiresAt?, ... } 该状态自己的数据
 * @param deps    { repo, broadcast } —— 用参数传，避免 compat/classroom 反向 import 成环
 * @returns {{ ok:boolean, blocked?:boolean, current?:object, focus?:object, stopped?:string[] }}
 */
export function pushFocus(classId, kind, payload, deps) {
  const { repo, broadcast } = deps
  if (!classId || !(kind in RANK)) return { ok: false, reason: 'bad-args' }

  const cur = getFocus(classId, deps)
  const mine = RANK[kind]
  const theirs = cur ? RANK[cur.kind] ?? 0 : 0

  /*
   * 高优先级在场时，低的一律立不起来 —— 这是整个设计的核心：
   * 正在考试的学生，不会因为老师翻讲义 / 点个名就被拽走。
   * 同级（follow 与 pgsync）允许互相覆盖，那是同一种「内容展示」。
   */
  if (cur && theirs > mine) {
    return { ok: false, blocked: true, current: cur, reason: 'lower-priority' }
  }

  /* 先真的把旧的停掉（广播它自己的清空消息），再立新的 */
  const stopped = []
  if (cur && cur.kind !== kind) {
    const msg = CLEAR_MSG[cur.kind]
    if (msg) broadcast(msg())
    stopped.push(cur.kind)
    if (cur.kind === 'follow') followState = null
  }

  const next = { kind, payload: payload || null, at: new Date().toISOString() }
  if (payload && payload.expiresAt) next.expiresAt = payload.expiresAt
  if (payload && payload.sid) next.sid = String(payload.sid)

  try {
    repo.setState(KEY(classId), next)
  } catch (e) {
    return { ok: false, reason: 'persist-failed' }
  }

  if (kind === 'follow' && payload) setFollow(payload)

  /* 一条总消息：学生端只认它，各组件也顺带收到自己那份清空 */
  broadcast({ t: 'focus', active: kind, focus: next, stopped })
  return { ok: true, focus: next, stopped }
}

/**
 * 主动释放（考试交卷、学生离开作业页）。
 *
 * 只清「确实是自己」的那条：如果中途已经被更高优先级顶掉，这里不该误伤。
 * 交卷时还要判断「这个班是不是还有别人在考」—— 由调用方决定是否调用本函数。
 */
export function releaseFocus(classId, kind, deps) {
  const cur = getFocus(classId, deps)
  if (!cur || cur.kind !== kind) return false
  try {
    deps.repo.setState(KEY(classId), null)
  } catch (e) {
    return false
  }
  const msg = CLEAR_MSG[kind]
  if (msg) deps.broadcast(msg())
  deps.broadcast({ t: 'focus', active: 'idle', stopped: [kind] })
  return true
}

/** 教师端监视用：当前状态 + 优先级，前端不用自己维护这张表 */
export function describeFocus(classId, deps) {
  const cur = getFocus(classId, deps)
  return {
    focus: cur,
    kind: cur ? cur.kind : 'idle',
    rank: cur ? RANK[cur.kind] ?? 0 : 0,
    ranks: RANK,
  }
}

/**
 * 兼容旧调用：把「立起 keep 之前清掉别人」的老语义映射到 pushFocus 的拒绝对话上。
 * 现在只剩「停跟随」这一处还在用（compat.js 的 /api/teacher/follow 带 stopped 那支）。
 */
export function standDown(classId, keep, deps) {
  const cur = getFocus(classId, deps)
  if (!cur) {
    if (keep !== 'follow' && stopFollow(deps.broadcast)) return ['follow']
    return []
  }
  if (cur.kind === keep) return []
  const mine = RANK[keep] ?? 0
  const theirs = RANK[cur.kind] ?? 0
  if (theirs > mine) return []
  const stopped = []
  const msg = CLEAR_MSG[cur.kind]
  if (msg) deps.broadcast(msg())
  stopped.push(cur.kind)
  if (cur.kind === 'follow') followState = null
  try {
    deps.repo.setState(KEY(classId), null)
  } catch (e) {
    /* 忽略 */
  }
  return stopped
}
