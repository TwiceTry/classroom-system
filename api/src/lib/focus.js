/*
 * lib/focus.js —— 课堂聚焦：一个班同一时刻只允许一种「学生端浮层」
 *
 * 会占住学生屏幕的三样东西：
 *   follow     讲义跟随（学生端跳到某节课某一节）
 *   pgsync     代码同步（学生端工作台跟着老师的代码变）
 *   spotlight  点名 —— 考勤 attend / 课堂互动 interact 共用 spot:<cid>，靠 kind 区分，
 *              本来就是互斥的；所以这里只需要它和其它两样互斥
 *
 * 原来三处各存各的、互不知晓：
 *   follow     compat.js 的模块变量（内存，连班级维度都没有）
 *   pgsync     state['pg:<cid>']
 *   spotlight  state['spot:<cid>']
 *
 * 于是：老师一边跟随讲义一边点人，学生端两个浮层叠着；
 *       推完代码再点名，学生端还挂着上次的同步位置。
 *
 * 现在每个入口在立起自己之前先调 standDown(cid, 自己的 kind)，
 * 把别人**真的停掉**（置 null + 广播各自的清空消息），不是只标个记 ——
 * 否则学生刷新一下又回来了。
 */

/* key 与 classroom.js 里的 SPOT_KEY / PG_KEY 必须一致（那边是 'spot:' + cid / 'pg:' + cid） */
const PG_KEY = (cid) => 'pg:' + cid
const SPOT_KEY = (cid) => 'spot:' + cid

/**
 * 当前讲义跟随的位置。
 *
 * 放在这里而不是 compat.js，是因为 standDown 要能清它 ——
 * 一个模块级变量散在路由文件里，别处就没法统一收拾。
 * 语义仍是「全局一个」：一个老师在讲，全班看同一处。
 */
let followState = null

export function getFollow() {
  return followState
}

export function setFollow(v) {
  followState = v
}

/** 只清跟随（教师主动停，或切到别的动作时用） */
export function stopFollow(broadcast) {
  if (!followState) return false
  followState = null
  broadcast({ t: 'follow', stopped: true })
  return true
}

/**
 * 立起 keep 之前，把其它几类清掉并广播。
 *
 * @param classId 班级 id；空则只清全局的 follow（点名/代码同步是按班存的，没班级就没法清）
 * @param keep    这次要立起的种类：'follow' | 'pgsync' | 'spotlight'
 * @param deps    { repo, broadcast } —— 用参数传而不是 import，
 *                因为 compat.js / classroom.js 都 import 这里，反过来 import 会成环
 * @returns 被停掉的种类名，给日志和测试用
 */
export function standDown(classId, keep, deps) {
  const { repo, broadcast } = deps
  const stopped = []

  if (classId && keep !== 'pgsync' && repo.getState(PG_KEY(classId), null)) {
    repo.setState(PG_KEY(classId), null)
    broadcast({ t: 'pgsync', sync: null })
    stopped.push('pgsync')
  }
  if (classId && keep !== 'spotlight' && repo.getState(SPOT_KEY(classId), null)) {
    repo.setState(SPOT_KEY(classId), null)
    broadcast({ t: 'spotlight', clear: true })
    stopped.push('spotlight')
  }
  if (keep !== 'follow' && stopFollow(broadcast)) {
    stopped.push('follow')
  }

  /*
   * 一条总消息：前端（StudentLayout）收到就知道「现在该显示哪一块」。
   * 上面那几条清空消息是给各组件自己用的（它们已经能处理），
   * 这条是兜底 —— 万一某个组件的清空分支有遗漏，前端还能按 active 收一遍。
   */
  if (stopped.length) {
    broadcast({ t: 'focus', active: keep, stopped })
  }
  return stopped
}
