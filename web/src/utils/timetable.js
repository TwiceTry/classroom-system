/*
 * timetable.js —— 作息时钟
 *
 * 「第几节」不在前端算：机房的机器时间未必准，而节次直接决定几点算迟到，
 * 所以让服务器算好（/api/timetable 返回 period / next / text / pair），
 * 前端只负责显示，并按本地时钟每分钟走一下、每 30 秒跟服务器对一次表。
 */
import { ref } from 'vue'
import { api } from '../api'

export const clock = ref({
  ready: false,
  title: '',
  clock: '',
  date: '',
  week: '',
  seasonName: '',
  text: '',
  period: null,
  next: null,
  pair: '',
  pairs: [],
})

let timer = null
let drift = 0 // 本机时间 - 服务器时间（毫秒），只用于本地走动

async function sync() {
  try {
    const res = await api.get('/api/timetable')
    const now = Date.now()
    const at = new Date(res.now).getTime()
    drift = Number.isFinite(at) ? now - at : 0
    clock.value = Object.assign({ ready: true }, res)
  } catch (e) {
    /* 拿不到就保持上一次的值，页面不报错 */
  }
}

/** 本地走动：每分钟重算一次 HH:MM（以服务器时间为基准） */
function tickLocal() {
  if (!clock.value.ready) return
  const d = new Date(Date.now() - drift)
  const pad = (n) => String(n).padStart(2, '0')
  clock.value.clock = pad(d.getHours()) + ':' + pad(d.getMinutes())
}

export function startClock() {
  if (timer) return
  sync()
  timer = setInterval(() => {
    tickLocal()
    if (document.hidden) return
    sync()
  }, 30000)
}

export function stopClock() {
  if (timer) clearInterval(timer)
  timer = null
}

/** 「第 3 节 · 10:10–10:55」这种一行字的备选拼法（给需要的页面用） */
export function periodLine(c) {
  const v = c || clock.value
  if (!v || !v.ready) return ''
  return v.text || ''
}
