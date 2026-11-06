/*
 * legacy-http.js —— 给「从旧后端搬过来的模块」用的 HttpError
 *
 * 那些模块里写的是 `new HttpError(400, '这份包读不出来')`（只有 status + message）。
 * 新代码用 ApiError(status, code, message)。这里做一个 6 行的适配，
 * 好处是搬过来的模块**一行调用都不用改**，而对外仍然是统一的错误体（带 code）。
 */

import { ApiError } from './errors.js'

const CODE_BY_STATUS = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable',
}

export class HttpError extends ApiError {
  constructor(status, message) {
    super(status, CODE_BY_STATUS[status] || 'error', message)
  }
}

export default { HttpError }
