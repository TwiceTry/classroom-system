/*
 * rules/index.js —— 计分规则库（服务端权威，前端不算分）
 *
 * 一条规则 = { type, name, desc, schema, score(item, events) }
 *   · schema 描述这条规则要哪些参数（名字/类型/范围/说明），
 *     前端的方案编辑器照着 schema 渲染表单 —— 以后加规则不用改界面；
 *   · score(item, events) 是纯函数：同一个 item + 同一批事件，永远同一个分。
 *
 * 边界（刻意）：**老师只调参数，不写公式**。自定义表达式意味着要沙箱、要解释报错、
 * 成绩出了问题没人能查；所以规则是代码，参数是配置。
 *
 * 现有 6 条规则正好覆盖当前的 5 个考核项 + 加分项，行为与改造前逐位一致：
 *   base   —— 考勤（起始满分，按事件加减，缺勤满 N 次归零）
 *   acc    —— 互动 / 加分（从 0 累加，封顶）
 *   avg    —— 课堂作业（多次评定取均，可迟交折算、可去最差）
 *   last   —— 只看最后一次评定（终稿、定稿类）
 *   raw    —— 机试 / 笔试（卷面分 × 系数，取最后一次）
 *   rubric —— 大作业 / 课程设计（量规逐项相加，取最后一次）
 *
 * 后续要加的（best / passRate / ladder / threshold / weighted / peer）只需在这里补一条，
 * 编辑器和界面会自动认得。
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const round1 = (v) => Math.round(v * 10) / 10
const num = (v) => (isFinite(Number(v)) ? Number(v) : 0)

/** 规则参数：新方案放在 item.rule.params，兜底认老结构的 item.params */
function paramsOf(item) {
  return (item.rule && item.rule.params) || item.params || {}
}

function liveOf(events) {
  return (events || []).filter((e) => !e.voided)
}

function lastOf(list, pred) {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return list[i]
  return null
}

/** 等级 → 系数（找不到就当 0 分，宁可少给不乱给） */
function factorOf(item, gradeKey) {
  const g = (item.grades || []).find((x) => x.key === gradeKey)
  return g ? g.factor : 0
}

/* ---------------- 规则实现 ---------------- */

/**
 * 起始分 · 按次加减（考勤 / 纪律分）
 *
 * 扣分怎么算：按记录类型 × 每次扣分（params.perAbsent / perLate），
 * 而不是照抄事件里当时记下的 delta —— 这样老师把「缺勤一次扣 2 分」改成 3 分，
 * 一学期的老记录会一起重算，不用回改历史。
 * 兼容：没写类型的老记录（只有 delta）照样按 delta 加；自定义类型也按它自己的 delta。
 */
function scoreBase(item, events) {
  const p = paramsOf(item)
  const live = liveOf(events)
  const start = num(p.start !== undefined ? p.start : item.base)
  const zero = p.zeroRule
  const absentKind = (zero && zero.kind) || '缺勤'
  const perAbsent = p.perAbsent === undefined ? 2 : num(p.perAbsent)
  const perLate = p.perLate === undefined ? 1 : num(p.perLate)

  let sum = 0
  for (const e of live) {
    const kind = String(e.kind || '').trim()
    if (!kind) {
      sum += num(e.delta) // 老记录：没有类型就按当时记的 delta
      continue
    }
    if (kind === absentKind) sum -= perAbsent
    else if (kind === '迟到' || kind === '早退') sum -= perLate
    else if (kind === '请假' || kind === '出勤') sum -= 0
    else sum += num(e.delta) // 自定义类型（违纪、加分…）用它自己的 delta
  }

  // 归零规则：某类记录累计到 N 次，本项直接 0（缺勤满 3 次那种）
  if (zero && zero.kind) {
    const hits = live.filter((e) => e.kind === zero.kind).length
    const merge = num(zero.lateMerge)
    const extra = merge > 0 ? Math.floor(live.filter((e) => e.kind === '迟到' || e.kind === '早退').length / merge) : 0
    if (hits + extra >= num(zero.count || 3)) return 0
  }

  return round1(clamp(start + sum, num(p.floor), item.full))
}

/** 从 0 累加 · 封顶（互动 / 加分） */
function scoreAcc(item, events) {
  const p = paramsOf(item)
  const live = liveOf(events)
  const sum = live.reduce((s, e) => s + num(e.delta), 0)
  return round1(clamp(num(p.start) + sum, 0, item.full))
}

/** 多次评定取均（作业 / 报告）；可选去掉最差 N 次 */
function scoreAvg(item, events) {
  const p = paramsOf(item)
  const live = liveOf(events)
  const lateFactor = p.lateFactor === undefined ? 1 : num(p.lateFactor)
  let recs = live.filter((e) => e.grade)
  if (!recs.length) return 0

  // 每次评定换算成「得分率」= 等级系数 × 迟交折扣，再按**每次自己的权重**加权平均。
  // 权重缺省 1 → 退化成简单平均（老数据行为不变）；权重不同 → 满分大/次数多的那次自然更重。
  let pairs = recs.map((e) => {
    const w = Number(e.weight)
    return {
      f: factorOf(item, e.grade) * (e.late ? lateFactor : 1),
      w: isFinite(w) && w > 0 ? w : 1,
    }
  })
  const drop = num(p.skipWorst)
  if (drop > 0 && pairs.length > drop) {
    // 去最差：按得分率排序扔掉最低的 N 条（权重不参与「谁最差」的判断）
    pairs = pairs.slice().sort((a, b) => b.f - a.f).slice(0, pairs.length - drop)
  }
  const wSum = pairs.reduce((s, x) => s + x.w, 0)
  const avg = wSum > 0 ? pairs.reduce((s, x) => s + x.f * x.w, 0) / wSum : 0
  const manual = live.reduce((s, e) => s + num(e.delta), 0)
  return round1(clamp(avg * item.full + manual, 0, item.full))
}

/** 只看最后一次评定（终稿类） */
function scoreLast(item, events) {
  const p = paramsOf(item)
  const live = liveOf(events)
  const last = lastOf(live, (e) => e.grade || typeof e.raw === 'number' || typeof e.delta === 'number')
  if (!last) return 0
  if (last.grade) {
    const lateFactor = p.lateFactor === undefined ? 1 : num(p.lateFactor)
    return round1(clamp(factorOf(item, last.grade) * item.full * (last.late ? lateFactor : 1), 0, item.full))
  }
  if (typeof last.raw === 'number') {
    const rawFull = num(p.rawFull || 100) || 100
    return round1(clamp((last.raw / rawFull) * item.full, 0, item.full))
  }
  return round1(clamp(num(last.delta), 0, item.full))
}

/** 卷面分 × 系数（机试 / 笔试） */
function scoreRaw(item, events) {
  const p = paramsOf(item)
  const live = liveOf(events)
  const last = lastOf(live, (e) => typeof e.raw === 'number')
  if (!last) return 0
  const factor = p.factor === undefined ? item.full / (num(p.rawFull) || 100) : num(p.factor)
  return round1(clamp(last.raw * factor, 0, item.full))
}

/** 量规逐项相加（大作业 / 课程设计 / 论文） */
function scoreRubric(item, events) {
  const live = liveOf(events)
  const last = lastOf(live, (e) => e.dims)
  if (!last) return 0
  let s = 0
  for (const d of item.dims || []) s += clamp(num(last.dims[d.key]), 0, d.full)
  return round1(clamp(s, 0, item.full))
}

/* ---------------- 规则登记表（schema 供编辑器渲染） ---------------- */

const RULES = {
  base: {
    type: 'base',
    name: '起始分 · 按次加减',
    desc: '从起始分往下扣（或往上加）：缺勤一次扣多少、迟到一次扣多少都能配；可设「某类记录满 N 次直接归零」（考勤用）',
    schema: [
      { key: 'start', label: '起始分', type: 'number', min: 0, hint: '默认等于本项满分（全勤就是满分）' },
      { key: 'perAbsent', label: '缺勤一次扣', type: 'number', min: 0, defaultValue: 2, hint: '每次「缺勤」扣几分' },
      { key: 'perLate', label: '迟到/早退一次扣', type: 'number', min: 0, defaultValue: 1, hint: '每次「迟到 / 早退」扣几分' },
      { key: 'floor', label: '最低分', type: 'number', min: 0, defaultValue: 0 },
      {
        key: 'zeroRule',
        label: '归零规则',
        type: 'object',
        optional: true,
        hint: '例：缺勤满 3 次本项计 0 分',
        fields: [
          { key: 'kind', label: '记录类型', type: 'string', defaultValue: '缺勤' },
          { key: 'count', label: '满几次归零', type: 'number', defaultValue: 3 },
          { key: 'lateMerge', label: '几次迟到折 1 次', type: 'number', defaultValue: 2 },
        ],
      },
    ],
    score: scoreBase,
  },

  acc: {
    type: 'acc',
    name: '从零累加 · 封顶',
    desc: '只加分（也可以记负分），加到满分封顶；用于互动、参与度、加分项',
    schema: [
      { key: 'start', label: '起始分', type: 'number', min: 0, defaultValue: 0 },
      { key: 'perHitMax', label: '单次上限', type: 'number', optional: true, hint: '留空表示不限制' },
    ],
    score: scoreAcc,
  },

  avg: {
    type: 'avg',
    name: '多次评定取均（可设每次权重 / 迟交折算 / 去最差）',
    desc: '每次交上来判一个等级，按**每次的权重**加权平均后折算成本项满分（权重缺省 1 即简单平均）；可设迟交系数、可去掉最差的 N 次',
    schema: [
      { key: 'grades', label: '等级表', type: 'grades', hint: '等级 → 折算系数（A=1 即满分）' },
      { key: 'lateFactor', label: '迟交折算', type: 'number', min: 0, max: 1, defaultValue: 1 },
      { key: 'skipWorst', label: '去掉最差几次', type: 'number', min: 0, defaultValue: 0 },
    ],
    score: scoreAvg,
  },

  last: {
    type: 'last',
    name: '只看最后一次评定',
    desc: '开题 → 中期 → 终稿，只认最后一条；也适用于「最后一次补考算数」',
    schema: [
      { key: 'grades', label: '等级表', type: 'grades', optional: true },
      { key: 'lateFactor', label: '迟交折算', type: 'number', min: 0, max: 1, defaultValue: 1 },
    ],
    score: scoreLast,
  },

  raw: {
    type: 'raw',
    name: '卷面分 × 系数',
    desc: '录原始分（如机试 0–100），按系数折算成本项满分，取最后一次',
    schema: [
      { key: 'rawFull', label: '卷面满分', type: 'number', min: 1, defaultValue: 100 },
      { key: 'factor', label: '折算系数', type: 'number', min: 0, hint: '留空 = 本项满分 ÷ 卷面满分' },
    ],
    score: scoreRaw,
  },

  rubric: {
    type: 'rubric',
    name: '量规逐项加分',
    desc: '按几个维度分别给分，加起来是本项得分（维度可给权重或绝对满分）',
    schema: [{ key: 'dims', label: '评分维度', type: 'dims', hint: '维度名 + 权重/满分' }],
    score: scoreRubric,
  },
}

function ruleOf(type) {
  return RULES[type] || RULES[type === 'mode' ? 'acc' : type] || null
}

export { RULES, ruleOf, round1, clamp, num }