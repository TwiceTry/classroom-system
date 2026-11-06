/*
 * api.js —— 唯一的网络出口
 *
 * 约定：所有接口都返回 JSON；失败抛 Error(message)，页面只管 try/catch。
 * 令牌放 localStorage：学生机每次开机还原，重新登录就好（名单校验很轻）。
 */
const TOKEN_KEY = 'teach-system-token'

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch (e) {
    return ''
  }
}

export function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
  } catch (e) {
    /* 隐私模式忽略 */
  }
}

export const COURSE_KEY = 'teach-system-course'

/** 当前课程 id（右上角切换器写这里；课程是最高一级，内容/班级/作业都跟着走） */
export function getCourse() {
  try {
    return localStorage.getItem(COURSE_KEY) || ''
  } catch (e) {
    return ''
  }
}

export function setCourse(id) {
  try {
    if (id) localStorage.setItem(COURSE_KEY, id)
    else localStorage.removeItem(COURSE_KEY)
  } catch (e) {
    /* 隐私模式忽略 */
  }
}

/** 给 /api 请求补上 courseId：页面代码一行都不用改 */
function withCourse(path) {
  const id = getCourse()
  if (!id || path.indexOf('/api/') !== 0 || path.indexOf('courseId=') >= 0) return path
  return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'courseId=' + encodeURIComponent(id)
}

export const unauthorized = { handler: null }

/** 给错误对象挂上 HTTP 状态码（判断「登录失效」要用） */
function withStatus(err, status) {
  try {
    err.status = status
  } catch (e) {
    /* ignore */
  }
  return err
}

/**
 * 从错误响应里取一句人话。
 * 后端两代格式都要认：
 *   · 旧版：{ "error": "班级不存在" }            ← error 是字符串
 *   · 新版：{ "error": { "code", "message" } }   ← error 是对象
 * 直接把对象塞给 new Error() 会变成「[object Object]」——
 * 那会让所有报错都失去信息，所以这里必须分开处理。
 */
function errorMessage(data, status) {
  const e = data && data.error
  if (typeof e === 'string' && e) return e
  if (e && typeof e === 'object') return e.message || e.code || '请求失败（' + status + '）'
  return '请求失败（' + status + '）'
}

/** 稳定的错误码（新版有 code，旧版没有） */
function errorCode(data) {
  const e = data && data.error
  return e && typeof e === 'object' && e.code ? e.code : ''
}

async function request(path, opts) {
  const o = opts || {}
  const headers = Object.assign({}, o.headers || {})
  const token = getToken()
  if (token) headers['Authorization'] = 'Bearer ' + token
  if (o.body !== undefined && !(o.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
    o.body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
  }

  let res
  try {
    res = await fetch(withCourse(path), Object.assign({}, o, { headers }))
  } catch (e) {
    throw new Error('连不上服务器，请确认教师机上的课堂系统正在运行')
  }

  const ct = res.headers.get('content-type') || ''
  if (ct.indexOf('application/json') < 0) {
    if (!res.ok) throw withStatus(new Error('请求失败（' + res.status + '）'), res.status)
    return res.text()
  }

  const data = await res.json()
  if (res.status === 401 && unauthorized.handler) unauthorized.handler()
  if (!res.ok) {
    const err = withStatus(new Error(errorMessage(data, res.status)), res.status)
    const code = errorCode(data)
    if (code) err.code = code
    if (data && data.error && typeof data.error === 'object' && data.error.details) err.details = data.error.details
    throw err
  }
  return data
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body }),
  patch: (p, body) => request(p, { method: 'PATCH', body }),
  del: (p) => request(p, { method: 'DELETE' }),
}

/**
 * 下载（CSV 导出）
 * 导出接口要校验 Bearer，直接用 <a href> 带不上令牌，所以 fetch 成 blob 再点。
 */
/** 带令牌用新窗口打开一份 HTML（试卷 / 答卷的打印版）。<a href> 带不上令牌，所以走 fetch+blob */
export function openDoc(path) {
  const token = getToken()
  fetch(path, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
    .then(async (res) => {
      if (!res.ok) {
        let msg = '打开失败（' + res.status + '）'
        try {
          msg = errorMessage(await res.json(), res.status)
        } catch (e) {
          /* 不是 JSON 就算了 */
        }
        throw new Error(msg)
      }
      return res.blob()
    })
    .then((blob) => {
      const url = URL.createObjectURL(new Blob([blob], { type: 'text/html' }))
      const w = window.open(url, '_blank')
      if (!w) alert('浏览器拦了新窗口，允许弹出窗口再试一次')
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    })
    .catch((e) => alert(e.message))
}

export function download(path, fallbackName) {
  const token = getToken()
  fetch(path, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
    .then((res) => {
      if (!res.ok) throw new Error('下载失败（' + res.status + '）')
      // 文件名从 Content-Disposition 里取；取不到就用调用方给的名字
      let name = fallbackName || ''
      const cd = res.headers.get('content-disposition') || ''
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd)
      if (m) {
        try {
          name = decodeURIComponent(m[1])
        } catch (e) {
          /* 解不出来就用 fallback */
        }
      }
      return res.blob().then((blob) => ({ blob, name }))
    })
    .then(({ blob, name }) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      if (name) a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    })
    .catch((e) => alert(e.message))
}
