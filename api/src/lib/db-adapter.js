/*
 * lib/db-adapter.js —— 给旧 lib 用的「数据库适配器」
 *
 * 旧后端有几个模块（coursepack / coursepack-import / classio）把 db 当参数传进来，
 * 也就是**依赖注入**。这让我们可以完全不改它们的逻辑，只换一个实现：
 * 传进去的对象背后是新 repo（SQLite），于是「课程包导入导出」的格式与校验
 * 全部沿用旧代码 —— 导出的包在旧版课堂系统里也能打开，反之亦然。
 *
 * 只实现这三个模块真正用到的 6 个方法（见 .work/list-db-methods.mjs）。
 */

import * as repo from './repo.js'

export const dbAdapter = {
  getCourse: (id) => repo.getCourse(id),

  /**
   * 旧代码假设「班级对象自带 students 数组」（CSV 时代名册内嵌在 classes.csv 里），
   * 而 SQLite 里名册是独立的 students 表。这里把名册挂回去 ——
   * 否则 coursepack-import 里 `hit.students.map(...)` 会直接崩。
   */
  listClassesOf: (courseId) =>
    repo.listClasses(courseId).map((c) => Object.assign({}, c, { students: repo.rosterOf(c.id) })),

  rosterOf: (clsOrId) => repo.rosterOf(typeof clsOrId === 'string' ? clsOrId : clsOrId.id),

  upsertCourse: (c) => repo.upsertCourse(c),

  /**
   * 旧签名是 createClass(id, name, courseId)。
   *
   * 返回值必须带 `students: []` —— 旧导入代码紧接着就跑
   * `target.students.map(...)`，缺这个数组会直接崩「reading 'map'」，
   * 而且崩在「班级刚建好、名单还没写」的时刻，留下空班级。
   */
  createClass: (id, name, courseId) => {
    const row = repo.insertClass({ id, name, courseId, createdAt: new Date().toISOString(), rollcallRound: 1 })
    return Object.assign({}, row, { students: [] })
  },

  // 原来这里有个 `save: () => {}`，是为了接住旧代码里的 `db.save()`（CSV 时代要手动落盘）。
  // SQLite 是即时写入，它一直是空操作；调用点也已经删掉，这里不再假装提供这个接口。
}
