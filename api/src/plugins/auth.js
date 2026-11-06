/*
 * plugins/auth.js —— 认证（Fastify preHandler）
 *
 * 用法：
 *   app.get('/api/me', { preHandler: requireAuth() }, h)          // 登录即可
 *   app.post('/api/classes', { preHandler: requireAuth('teacher') }, h) // 必须是老师
 *
 * 为什么不用全局 hook：显式写在每条路由上更好读 ——
 * 「这个接口要不要登录」应该一眼看得见，而不是翻到某个插件里猜。
 */
import { fromRequest } from '../lib/auth.js'
import { unauthorized, forbidden } from '../lib/errors.js'

/**
 * @param {'teacher'|'student'|'guest'|undefined} role 需要的角色；不传 = 登录即可
 */
export function requireAuth(role) {
  return async function authGuard(req) {
    const t = fromRequest(req.raw)
    if (!t) throw unauthorized()
    if (role && t.role !== role) throw forbidden()
    req.user = t
  }
}

/** 老师或学生都行（比如投屏状态） */
export function requireAnyUser() {
  return requireAuth()
}
