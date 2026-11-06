/*
 * timetable.js —— 作息时间表：现在几点、对应第几节
 *
 * 为什么放服务端：机房里学生机/教师机的系统时间未必准，节次又直接影响考勤
 * （几点算迟到），所以「第几节」以服务器时间为准算好，前端只显示。
 *
 * 默认值就是示例职业学院那张表（冬春季 / 夏秋季两套）；
 * 学校换作息了改 data/config.json 里的 timetable，不用改代码。
 *
 * 配置长这样（省略就是默认）：
 *   "timetable": {
 *     "title": "示例职业学院作息时间表",
 *     "summer": { "from": "05-01", "to": "10-31" },     // 这段日期算夏秋季
 *     "periods": {
 *       "winter": [["08:10","08:55"], ...],             // 10 段
 *       "summer": [["08:10","08:55"], ...]
 *     }
 *   }
 */

/** 示例职业学院作息（冬春季 / 夏秋季） */

import { config } from '../config.js'

const DEFAULT = {
  title: '示例职业学院作息时间表',
  // 5 月 1 日 – 10 月 31 日 视为夏秋季，其余算冬春季
  summer: { from: '05-01', to: '10-31' },
  periods: {
    winter: [
      ['08:10', '08:55'],
      ['09:05', '09:50'],
      ['10:10', '10:55'],
      ['11:05', '11:50'],
      ['14:10', '14:55'],
      ['15:05', '15:50'],
      ['16:00', '16:45'],
      ['16:55', '17:40'],
      ['19:00', '19:45'],
      ['19:55', '20:40'],
    ],
    summer: [
      ['08:10', '08:55'],
      ['09:05', '09:50'],
      ['10:10', '10:55'],
      ['11:05', '11:50'],
      ['14:40', '15:25'],
      ['15:35', '16:20'],
      ['16:30', '17:15'],
      ['17:25', '18:10'],
      ['19:00', '19:45'],
      ['19:55', '20:40'],
    ],
  },
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 考勤页的节次档：一天 10 节、两节连上 → 5 个可选档 */
const PAIRS = ['1-2节', '3-4节', '5-6节', '7-8节', '9-10节']

const pad = (n) => String(n).padStart(2, '0')
const mmdd = (d) => pad(d.getMonth() + 1) + '-' + pad(d.getDate())
/** 'HH:MM' → 当天第几分钟 */
const mins = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1
}
const norm = (list, fallback) => {
  const src = Array.isArray(list) && list.length ? list : fallback
  return src
    .map((p, i) => {
      const start = Array.isArray(p) ? p[0] : p && p.start
      const end = Array.isArray(p) ? p[1] : p && p.end
      return { no: i + 1, start: String(start || ''), end: String(end || '') }
    })
    .filter((p) => mins(p.start) >= 0 && mins(p.end) > mins(p.start))
}

/** 当前生效的表（配置里有就盖掉默认，按字段合并） */
function table() {
  const c = (config && config.timetable) || {}
  const summer = c.summer && c.summer.from && c.summer.to ? c.summer : DEFAULT.summer
  const periods = c.periods || {}
  return {
    title: c.title || DEFAULT.title,
    summer,
    winter: norm(periods.winter, DEFAULT.periods.winter),
    summerList: norm(periods.summer, DEFAULT.periods.summer),
  }
}

/** 这一天算夏秋季还是冬春季 */
function seasonOf(date) {
  const t = table()
  const now = mmdd(date)
  const { from, to } = t.summer
  const hit = from <= to ? now >= from && now <= to : now >= from || now <= to // 跨年也认
  return hit ? { key: 'summer', name: '夏秋季', periods: t.summerList } : { key: 'winter', name: '冬春季', periods: t.winter }
}

/** 第 n 节属于考勤的哪一档（两节一档） */
function pairOf(no) {
  const i = Math.ceil(Number(no) / 2) - 1
  return PAIRS[i] || ''
}

/**
 * 这一刻的状态：
 *   period  正在上的那一节（含 end 时刻，不算迟到）
 *   next    下一节（当天已经没有就是 null）
 *   text    给人看的一句话
 */
function at(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now())
  const s = seasonOf(d)
  const nowMin = d.getHours() * 60 + d.getMinutes()
  const list = s.periods
  const period = list.find((p) => nowMin >= mins(p.start) && nowMin <= mins(p.end)) || null
  const next = list.find((p) => mins(p.start) > nowMin) || null
  const last = list.length ? list[list.length - 1] : null

  let text = ''
  if (period) text = '第 ' + period.no + ' 节 · ' + period.start + '–' + period.end
  else if (list.length && nowMin < mins(list[0].start)) text = '未到上课时间 · 第 1 节 ' + list[0].start
  else if (next) text = '课间 · 下一节 第 ' + next.no + ' 节 ' + next.start
  else if (last) text = '已下课（今天最后一节 ' + last.end + ' 结束）'
  else text = '作息表为空'

  return {
    title: table().title,
    season: s.key,
    seasonName: s.name,
    now: d.toISOString(),
    clock: pad(d.getHours()) + ':' + pad(d.getMinutes()),
    date: pad(d.getMonth() + 1) + '月' + pad(d.getDate()) + '日',
    week: WEEK[d.getDay()],
    period: period,
    next,
    pair: period ? pairOf(period.no) : next ? pairOf(next.no) : '',
    text,
    periods: list,
    pairs: PAIRS,
  }
}

export { DEFAULT, PAIRS, table, seasonOf, pairOf, at }