/*
 * 作业 / 机试的「现在是什么状态」。
 *
 * 为什么要有这个文件：同一个判断在作业页和机试页各写一遍，就一定会分叉。
 * 事实上第一版就分叉了 —— 作业页改成了读 collecting，机试页还在读 status，
 * 于是同一份数据在两个页面显示两种状态。
 *
 * 核心约定：**状态是算出来的，不是存出来的。**
 * 数据库里的 status 只记「老师点过开始 / 停止」，它不会因为时间流逝自己变。
 * 到期之后学生那边已经交不上了，界面却还写着「进行中」，
 * 等于要求老师手动点一下，系统才承认这件事结束了。
 *
 * 所以这里所有函数都是纯函数：输入「这份作业的数据 + 现在几点」，
 * 输出状态。不读时钟、不读全局，方便单测，也方便调用方自己控制时间来源。
 */

/**
 * 过没过截止时间。
 *
 * 用调用方传进来的 now，而不是 Date.now()：
 * 前端有个 nowTick ref 每 8 秒推一次，模板才能跟着重算
 * （直接写 Date.now() 的话 Vue 追踪不到，标签会一直停在拉数据那一刻）。
 *
 * @param {object} x    作业 / 机试
 * @param {number} now  当前时间戳
 */
export function overDueOf(x, now) {
  if (!x || !x.dueAt) return false
  const t = Date.parse(x.dueAt)
  return isFinite(t) && now > t
}

/**
 * 实际还在收 / 还能开考吗。
 *
 *   status 不是 open        → 老师没开，或者已经手动停了
 *   过截止且不收迟交         → 时间到了
 *
 * 这两件事合起来才是「现在真的还能交」。
 */
export function collectingOf(x, now) {
  if (!x) return false
  /*
   * **优先用后端算好的 collecting。**
   *
   * 后端那份认三件事：整场开着 / 我在某一批里 / 单人放行补考。
   * 这里如果还拿 status 再判一遍，分批就全废了 ——
   * 分批时整场是 closed、只有批次在 open，status 永远是 'closed'，
   * 于是学生端显示「未开始」，连开考入口都不给。
   *
   * 这正是上一轮作业页犯过的错（v-if="a.status === 'open'"），
   * 当时只修了页面，没修这个公共函数，机试就漏了。
   */
  const base =
    typeof x.collecting === 'boolean'
      ? x.collecting
      : x.status === 'open' // 老接口没给 collecting 时兜底
  if (!base) return false
  /* 过了截止又不收迟交：哪怕开了也对这个人关了 */
  if (overDueOf(x, now) && x.allowLate === false) return false
  return true
}

/**
 * 给人看的状态：{ key, text, tone }。
 *
 * key 拿来给代码判断，text 直接显示，tone 对应全站的 tag 配色。
 * 作业和机试只差一个词（进行中 / 考试中），用 word 参数区分。
 *
 * 为什么要分「已截止（时间到）」和「已结束」：
 * 出路不一样 —— 前者老师改一下截止时间就能再开，后者要重新点开始。
 * 合成一个「已结束」，老师会不知道该动哪里。
 */
export function stateOf(x, now, word = '进行中') {
  if (!x) return { key: 'none', text: '', tone: '' }
  if (collectingOf(x, now)) return { key: 'open', text: word, tone: 'ok' }

  /*
   * 下面几种「进不来」要分开说。
   * 分批模式下整场从没 open 过（started 永远是 false），
   * 如果只按 started 判，所有没轮到的人都会显示「未开始」——
   * 而老师明明已经开始了，他只是还没被点到。
   */
  if (x.myBatch && x.myBatch.overDue) return { key: 'b-overdue', text: '这批时间到', tone: 'mute' }
  if (x.myBatch) return { key: 'b-closed', text: '这批已结束', tone: 'mute' }
  if (Number(x.openBatches) > 0) return { key: 'waiting', text: '还没轮到你', tone: 'warn' }

  if (overDueOf(x, now) && x.allowLate === false) {
    return { key: 'overdue', text: '已截止（时间到）', tone: 'mute' }
  }
  if (x.started) return { key: 'closed', text: '已结束', tone: 'mute' }
  return { key: 'draft', text: '未开始', tone: 'warn' }
}

/**
 * 学生端多一层：他自己**做到哪一步了**。
 *
 * 作业级状态只说明「收不收」，学生还要知道「我交没交、批没批」。
 * 这两件事叠起来才是他打开这一页看到的全部。
 *
 * @returns {{ key, text, tone }}
 */
export function myStateOf(x, mine, now, word = '进行中') {
  const s = stateOf(x, now, word)
  if (mine && mine.graded) {
    return { key: 'graded', text: '已批 · ' + mine.score + ' 分', tone: 'ok' }
  }
  if (mine) return { key: 'submitted', text: '已交 · 等老师批', tone: 'ok' }
  return s
}
