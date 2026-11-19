/*
 * local 插件：学号 + 姓名（对本系统自己的名册）
 *
 * 它是最"不像插件"的插件 —— 不连任何外部系统，也不会失败得很花哨。
 * 但把它也做成插件有两个实在的好处：
 *   ① 登录链路只有一条（系统不用为它留 if 分支）
 *   ② 契约立刻被两方使用 —— 只有一方在用的接口，设计一定是错的
 *
 * 免密、离线、瞬时。代价是身份强度低：知道某人的学号和姓名就能登进来。
 * 所以它适合「教室里、局域网、老师眼皮底下」这种场景。
 */
import { REASON, ok, fail } from '../types.js'

export const apiVersion = 1
export const key = 'local'
export const name = '学号 + 姓名'
export const desc = '和本系统名册比对，不需要密码'

/** 不记住密码 —— 它压根没有密码 */
export const remember = false

export const credentials = [
  {
    key: 'name',
    label: '姓名',
    type: 'text',
    required: true,
    placeholder: '名单上的姓名',
    autocomplete: 'off',
    tip: '你的账号是「学号 + 姓名」，填名单上的名字即可。',
  },
]

/** 没有可配置项 */
export const settings = []

/**
 * 验证。
 *
 * 三种失败要分开说，否则学生会一直以为是自己打错了：
 *   学号不在名册里  → 「找老师核对学号」
 *   姓名对不上      → 「和名册不一致」（这个是他的问题，可重试）
 *   姓名没填        → 前端本该拦住，兜一下
 */
export async function verify(ctx) {
  const name = String((ctx.credentials && ctx.credentials.name) || '').trim()
  if (!name) return fail(REASON.BAD_CREDENTIAL, '请填写姓名')

  const cls = ctx.roster.classOf(ctx.sid)
  if (!cls) return fail(REASON.NOT_ENROLLED, '这个学号不在任何班级名册里，找老师确认一下')

  const stu = ctx.roster.studentOf(cls.id, ctx.sid)
  if (!stu) return fail(REASON.NOT_ENROLLED, '这个学号不在班级名册里，找老师确认一下')

  if (String(stu.name || '').trim() !== name) {
    /*
     * 这条是**可以重试**的（学生可能打错字），所以用 BAD_CREDENTIAL。
     * 措辞给出具体方向：「要和名册完全一致」，而不是笼统的「登录失败」。
     */
    return fail(REASON.BAD_CREDENTIAL, '学号与姓名对不上（注意姓名要和名册完全一致）')
  }

  return ok({ sid: ctx.sid, name: stu.name })
}
