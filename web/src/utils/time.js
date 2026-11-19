/*
 * time.js —— 界面上的时间显示
 *
 * 作业提交要「按时间顺序」给老师看，顺序本身由服务端的 ISO 字符串排（字典序=时间序），
 * 这里只负责把它显示成人一眼能读的样子：今天的只显示时分秒，跨天的带上月日。
 */

function pad(n) {
  return n < 10 ? '0' + n : String(n)
}

/** ISO → 'HH:MM:SS'；解析不了就返回原串 */
export function clock(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso || '')
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

/** ISO → '今天 10:32:05' / '10-24 10:32' */
export function when(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso || '')
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return '今天 ' + clock(iso)
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/**
 * ISO → '11-19 01:23'（**不带秒**）
 *
 * 专给「截止时间」这类**指向未来**的时刻用。
 * 为什么不复用 when()：when() 对今天返回「今天 10:32:05」—— 那个秒是给
 * 「刚刚发生的事」用的（提交时间、流水时间），截止时间带秒既啰嗦又像在倒数。
 *
 * @param {boolean} withYear 跨年的作业会需要（比如寒假作业）
 */
export function at(iso, withYear) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso || '')
  const head = withYear === true ? d.getFullYear() + '-' : ''
  return head + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 过了多久：'3 分钟前'，用来给老师看「刚刚有人交」 */
export function ago(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const sec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  if (sec < 60) return sec + ' 秒前'
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前'
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前'
  return Math.floor(sec / 86400) + ' 天前'
}
