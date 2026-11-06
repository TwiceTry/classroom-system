/*
 * lib/errors.js —— 统一错误
 *
 * 对外错误体固定是：
 *   { "error": { "code": "not_found", "message": "班级不存在", "details": {...} } }
 *
 * 为什么带 code：前端可以按 code 做分支（比如 401 就跳登录），
 * 不用去正则匹配中文提示语。
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code)
    this.name = 'ApiError'
    this.statusCode = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export const badRequest = (message, details) => new ApiError(400, 'bad_request', message, details)
export const unauthorized = (message) => new ApiError(401, 'unauthorized', message || '登录已失效，请重新登录')
export const forbidden = (message) => new ApiError(403, 'forbidden', message || '当前身份无权访问')
export const notFound = (message) => new ApiError(404, 'not_found', message || '资源不存在')
export const conflict = (message, details) => new ApiError(409, 'conflict', message, details)
