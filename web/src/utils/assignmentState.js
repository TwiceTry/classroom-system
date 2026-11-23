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
 * ⚠️ **只在学生端用**。它回答的是「**我**能不能进」——
 * 所以会出现「还没轮到你」「这批已结束」这种第二人称的话。
 * 教师端请用下面的 teacherStateOf()，别在这里加 if 迁就两边。
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

/* ============================ 教师端 ============================ */

/**
 * 学生端才会出现的措辞。
 *
 * 教师端一句话都不该出现这些 —— 「还没轮到你」「这批已结束」是回答
 * 「**我**能不能进」的，老师的视角里没有「我」，只有「这场现在是什么阶段」。
 * 放在这里是为了能被断言/回归测试直接引用，别再靠眼睛盯。
 */
export const STUDENT_ONLY_TEXTS = ['还没轮到你', '这批已结束', '这批时间到', '已交 · 等老师批']

/**
 * 这场现在还收吗 —— **教师口径**（整场视角）。
 *
 * 只看两件事：老师开没开（status）、过没过截止时间。
 * 刻意**不读** x.collecting 和 x.myBatch：那两样在接口里是「按当前登录者算的」，
 * 学生调用时代表「这个人能不能进」，教师调用时才代表整场 —— 一旦哪天
 * 后端把教师列表也返回成按人算，复用学生那份 collectingOf 的页面就会
 * 静默变成学生口径（历史上作业页就是这么错的）。
 */
export function teacherCollectingOf(x, now) {
  if (!x) return false
  if (x.status !== 'open') return false
  if (overDueOf(x, now) && x.allowLate === false) return false
  return true
}

/**
 * 教师端看到的状态：这场考试/作业现在处于什么阶段。
 *
 * 取值范围是封闭的：考试中(或进行中) / 分批进行中 / 已截止（时间到） / 已结束 / 未开始。
 * 没有「还没轮到你」这类第二人称的话 —— 见 STUDENT_ONLY_TEXTS。
 *
 * 排序有讲究：
 *   整场开着且没到期   → 全班都能进
 *   有批次在放人       → 分批进行中（分批时整场 status 是 closed，只看上面那条会全显示未开始）
 *   过截止且不收迟交   → 已截止，改截止时间就能再开
 *   开过               → 已结束，要重新点开始
 */
export function teacherStateOf(x, now, word = '进行中') {
  if (!x) return { key: 'none', text: '', tone: '' }
  if (teacherCollectingOf(x, now)) return { key: 'open', text: word, tone: 'ok' }
  if (Number(x.openBatches) > 0) return { key: 'batch', text: '分批进行中', tone: 'ok' }
  if (overDueOf(x, now) && x.allowLate === false) return { key: 'overdue', text: '已截止（时间到）', tone: 'mute' }
  if (x.started) return { key: 'closed', text: '已结束', tone: 'mute' }
  return { key: 'draft', text: '未开始', tone: 'warn' }
}

/**
 * 兜底断言：教师页面拿到学生口径的文案就报警。
 *
 * 这不是防御式编程的洁癖 —— 「教师端出现还没轮到你」这种错，
 * 肉眼看不出来（页面照样渲染，只是那句话对老师没意义），
 * 一报警就能在控制台定位到是哪个页面又引错了函数。
 */
export function assertTeacherState(st, where = '') {
  if (st && STUDENT_ONLY_TEXTS.indexOf(st.text) >= 0 && typeof console !== 'undefined') {
    console.warn('[assignmentState] 教师端出现了学生口径的文案「' + st.text + '」' + (where ? '（' + where + '）' : ''))
  }
  return st
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
