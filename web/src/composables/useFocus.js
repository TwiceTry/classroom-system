/*
 * useFocus —— 学生端「此刻该显示哪一块」的唯一数据源
 *
 * 后面有六个状态在抢同一块屏幕（优先级从低到高）：
 *
 *   idle → pgsync(40) = follow(40) → homework(60) → spotlight(80) → exam(100)
 *
 * 谁赢由服务端的 lib/focus.js 决定，前端**不重新算一遍** ——
 * 两处各有一套规则，迟早会不一致（学生端显示「考试中」、服务端却认为可以推讲义）。
 * 这里只做两件事：
 *   1. 收 { t:'focus', active } 消息，更新 ref
 *   2. 挂载时拉一次 GET /api/student/focus，刷新 / 断线重连也能恢复
 *
 * 各页面用它显示页头的状态标签（FocusLabel），不需要自己判断优先级。
 */
import { computed, ref } from 'vue'

/** 当前占用者：idle / pgsync / follow / homework / spotlight / exam */
const kind = ref('idle')
/** 该状态的附加信息（谁在考、哪份作业……） */
const payload = ref(null)

/** 文案与配色：一处维护，页面里不要再各写一遍 */
const META = {
  exam: { text: '考试中', tone: 'err' },
  spotlight: { text: '点名中', tone: 'warn' },
  homework: { text: '做作业中', tone: 'ok' },
  pgsync: { text: '同步练习中', tone: 'brand' },
  follow: { text: '跟随讲义中', tone: 'brand' },
  idle: { text: '', tone: 'mute' },
}

export function setFocus(nextKind, nextPayload) {
  kind.value = nextKind || 'idle'
  payload.value = nextPayload || null
}

export function useFocus() {
  const info = computed(() => META[kind.value] || META.idle)
  const active = computed(() => kind.value !== 'idle')
  return { focusKind: kind, focusPayload: payload, focusMeta: info, focusActive: active, setFocus }
}
