/*
 * lib/repo.js —— 数据访问层（SQLite）
 *
 * 一条规矩：**DB 里是 snake_case，进出这一层之后全是 camelCase**。
 * 这样 SQL 看着是正经 SQL，前端拿到的还是原来的字段名（迁移时前端不用改字段）。
 *
 * 这一层只做「取/存」，不放业务规则（算分、名单校验那些在 service 层），
 * 免得以后想换库时要跟着改业务逻辑。
 */

import { openDb, dbPath, tableCounts } from '../db/index.js'

let _db = null
/** 单例连接（better-sqlite3 的同步 API 不需要连接池） */
export function db() {
  if (!_db) _db = openDb()
  return _db
}

export function closeDb() {
  if (_db) {
    _db.close()
    _db = null
  }
}

export { dbPath, tableCounts }

/** snake_case → camelCase */
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())

/** 这些列在库里是 JSON 文本 */
const JSON_COLS = new Set(['dims', 'evidence', 'files', 'changed'])
/** 这些列在库里是 0/1 */
const BOOL_COLS = new Set(['archived', 'late', 'voided', 'allow_late'])

/** 一行 DB 记录 → 业务对象（camelCase + JSON 解析 + 布尔还原） */
export function hydrate(row) {
  if (!row) return null
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    const key = camel(k)
    if (JSON_COLS.has(k)) {
      if (v === null || v === undefined || v === '') out[key] = undefined
      else {
        try {
          out[key] = JSON.parse(v)
        } catch (e) {
          out[key] = undefined
        }
      }
    } else if (BOOL_COLS.has(k)) {
      out[key] = v === 1 || v === true
    } else {
      out[key] = v
    }
  }
  return out
}

const hydrateAll = (rows) => rows.map(hydrate)

/* ------------------------------ 课程 ------------------------------ */

export function listCourses() {
  return hydrateAll(db().prepare(`SELECT * FROM courses ORDER BY created_at, id`).all())
}

export function getCourse(id) {
  return hydrate(db().prepare(`SELECT * FROM courses WHERE id = ?`).get(String(id)))
}

export function upsertCourse(c) {
  db()
    .prepare(
      `INSERT INTO courses (id, name, content_dir, scheme_id, note, semester, created_at, archived)
       VALUES (@id, @name, @contentDir, @schemeId, @note, @semester, @createdAt, @archived)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, content_dir = excluded.content_dir, scheme_id = excluded.scheme_id,
         note = excluded.note, semester = excluded.semester, archived = excluded.archived`
    )
    .run({
      id: c.id,
      name: c.name || '',
      contentDir: c.contentDir || '',
      schemeId: c.schemeId || '',
      note: c.note || '',
      semester: c.semester || '',
      createdAt: c.createdAt || new Date().toISOString(),
      archived: c.archived ? 1 : 0,
    })
  return getCourse(c.id)
}

export function deleteCourse(id) {
  return db().prepare(`DELETE FROM courses WHERE id = ?`).run(String(id)).changes > 0
}

/* ------------------------------ 班级 ------------------------------ */

export function listClasses(courseId) {
  const sql = courseId
    ? `SELECT * FROM classes WHERE course_id = ? ORDER BY created_at, id`
    : `SELECT * FROM classes ORDER BY created_at, id`
  return hydrateAll(courseId ? db().prepare(sql).all(String(courseId)) : db().prepare(sql).all())
}

export function getClass(id) {
  return hydrate(db().prepare(`SELECT * FROM classes WHERE id = ?`).get(String(id)))
}

/** 学生属于哪个班（按学号找，可能多个班 → 取最近的） */
export function findClassBySid(sid) {
  return hydrate(
    db()
      .prepare(
        `SELECT c.* FROM classes c JOIN students s ON s.class_id = c.id
         WHERE s.sid = ? ORDER BY c.created_at DESC LIMIT 1`
      )
      .get(String(sid))
  )
}

export function insertClass(c) {
  db()
    .prepare(
      `INSERT INTO classes (id, course_id, name, created_at, rollcall_round)
       VALUES (@id, @courseId, @name, @createdAt, @rollcallRound)`
    )
    .run({
      id: c.id,
      courseId: c.courseId || '',
      name: c.name || '',
      createdAt: c.createdAt || new Date().toISOString(),
      rollcallRound: Number(c.rollcallRound || 1),
    })
  return getClass(c.id)
}

export function updateClass(id, patch) {
  const cur = getClass(id)
  if (!cur) return null
  const next = Object.assign({}, cur, patch)
  db()
    .prepare(`UPDATE classes SET course_id = ?, name = ?, rollcall_round = ? WHERE id = ?`)
    .run(next.courseId || '', next.name || '', Number(next.rollcallRound || 1), String(id))
  return getClass(id)
}

export function deleteClass(id) {
  return db().prepare(`DELETE FROM classes WHERE id = ?`).run(String(id)).changes > 0
}

/* ------------------------------ 名册 ------------------------------ */

export function rosterOf(classId) {
  return hydrateAll(
    db().prepare(`SELECT class_id, sid, name FROM students WHERE class_id = ? ORDER BY sid`).all(String(classId))
  ).map((r) => ({ sid: r.sid, name: r.name }))
}

export function findStudent(classId, sid) {
  return hydrate(
    db().prepare(`SELECT class_id, sid, name FROM students WHERE class_id = ? AND sid = ?`).get(String(classId), String(sid))
  )
}

export function addStudents(classId, list) {
  const stmt = db().prepare(
    `INSERT INTO students (class_id, sid, name) VALUES (?, ?, ?)
     ON CONFLICT(class_id, sid) DO UPDATE SET name = excluded.name`
  )
  db().transaction((rows) => {
    for (const s of rows) stmt.run(String(classId), String(s.sid), String(s.name || ''))
  })(list)
  return rosterOf(classId)
}

export function removeStudent(classId, sid) {
  return db().prepare(`DELETE FROM students WHERE class_id = ? AND sid = ?`).run(String(classId), String(sid)).changes > 0
}

export function renameStudent(classId, sid, name) {
  return (
    db().prepare(`UPDATE students SET name = ? WHERE class_id = ? AND sid = ?`).run(String(name || ''), String(classId), String(sid))
      .changes > 0
  )
}

/* ------------------------------ 记分事件 ------------------------------ */

/**
 * 分页取事件。
 * 游标用 (created_at, id) 的复合游标：同一毫秒写入多条也不会漏/重
 * （只按 created_at 分页，同秒多条会跳行）。
 */
export function eventsOf(classId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000)
  const where = ['class_id = ?']
  const args = [String(classId)]
  if (opts.sid) {
    where.push('sid = ?')
    args.push(String(opts.sid))
  }
  if (opts.item) {
    where.push('item = ?')
    args.push(String(opts.item))
  }
  if (opts.from) {
    where.push('created_at >= ?')
    args.push(String(opts.from))
  }
  if (opts.to) {
    where.push('created_at <= ?')
    args.push(String(opts.to))
  }
  if (opts.cursor) {
    const [cAt, cId] = String(opts.cursor).split('|')
    where.push('(created_at > ? OR (created_at = ? AND id > ?))')
    args.push(cAt || '', cAt || '', cId || '')
  }
  const sql = `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY created_at, id LIMIT ${limit + 1}`
  const rows = hydrateAll(db().prepare(sql).all(...args))
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: hasMore && last ? last.createdAt + '|' + last.id : null,
  }
}

export function allEvents() {
  return hydrateAll(db().prepare(`SELECT * FROM events ORDER BY created_at, id`).all())
}

export function findEvent(classId, eid) {
  return hydrate(db().prepare(`SELECT * FROM events WHERE class_id = ? AND id = ?`).get(String(classId), String(eid)))
}

export function insertEvent(e) {
  db()
    .prepare(
      `INSERT INTO events (id, class_id, sid, item, delta, kind, grade, late, raw, dims, weight, slot,
                           reason, operator, created_at, voided, voided_at, voided_by, evidence, scheme_version)
       VALUES (@id, @classId, @sid, @item, @delta, @kind, @grade, @late, @raw, @dims, @weight, @slot,
               @reason, @operator, @createdAt, @voided, @voidedAt, @voidedBy, @evidence, @schemeVersion)`
    )
    .run({
      id: e.id,
      classId: e.classId,
      sid: e.sid,
      item: e.item,
      delta: Number(e.delta || 0),
      kind: e.kind || '',
      grade: e.grade || '',
      late: e.late ? 1 : 0,
      raw: e.raw === undefined || e.raw === null || e.raw === '' ? null : Number(e.raw),
      dims: e.dims && Object.keys(e.dims).length ? JSON.stringify(e.dims) : null,
      weight: e.weight === undefined || e.weight === null ? 1 : Number(e.weight),
      slot: e.slot || '',
      reason: e.reason || '',
      operator: e.operator || '',
      createdAt: e.createdAt || new Date().toISOString(),
      voided: e.voided ? 1 : 0,
      voidedAt: e.voidedAt || '',
      voidedBy: e.voidedBy || '',
      evidence: e.evidence ? JSON.stringify(e.evidence) : null,
      schemeVersion: e.schemeVersion || '',
    })
  return findEvent(e.classId, e.id)
}

/** 撤销一条记分（append-only：只打标记，不改数值） */
export function voidEvent(classId, eid, by) {
  const n = db()
    .prepare(`UPDATE events SET voided = 1, voided_at = ?, voided_by = ? WHERE class_id = ? AND id = ?`)
    .run(new Date().toISOString(), String(by || ''), String(classId), String(eid)).changes
  return n > 0 ? findEvent(classId, eid) : null
}

/** 恢复一条被撤销的记分 */
export function restoreEvent(classId, eid) {
  const n = db()
    .prepare(`UPDATE events SET voided = 0, voided_at = '', voided_by = '' WHERE class_id = ? AND id = ?`)
    .run(String(classId), String(eid)).changes
  return n > 0 ? findEvent(classId, eid) : null
}

/* ------------------------------ 点名 ------------------------------ */

export function rollState(classId) {
  const round = (getClass(classId) || {}).rollcallRound || 1
  const picked = db()
    .prepare(`SELECT sid, picked_at FROM rollcall WHERE class_id = ? ORDER BY picked_at`)
    .all(String(classId))
    .map((r) => ({ sid: r.sid, pickedAt: r.picked_at }))
  return { round, picked: picked.map((p) => p.sid), detail: picked }
}

export function pickRollcall(classId, sid) {
  db()
    .prepare(`INSERT INTO rollcall (class_id, sid, picked_at) VALUES (?, ?, ?) ON CONFLICT(class_id, sid) DO UPDATE SET picked_at = excluded.picked_at`)
    .run(String(classId), String(sid), new Date().toISOString())
  return rollState(classId)
}

/** 把某人从「已抽过」里去掉（抽错了） */
export function removeRollcall(classId, sid) {
  return db().prepare(`DELETE FROM rollcall WHERE class_id = ? AND sid = ?`).run(String(classId), String(sid)).changes > 0
}

export function resetRollcall(classId) {
  const cur = getClass(classId) || {}
  db().prepare(`DELETE FROM rollcall WHERE class_id = ?`).run(String(classId))
  db().prepare(`UPDATE classes SET rollcall_round = ? WHERE id = ?`).run(Number(cur.rollcallRound || 1) + 1, String(classId))
  return rollState(classId)
}

/* ------------------------------ 作业 / 提交 ------------------------------ */

export function listAssignments(courseId) {
  const sql = courseId
    ? `SELECT * FROM assignments WHERE course_id = ? OR course_id = '' ORDER BY created_at DESC, id`
    : `SELECT * FROM assignments ORDER BY created_at DESC, id`
  return hydrateAll(courseId ? db().prepare(sql).all(String(courseId)) : db().prepare(sql).all())
}

export function getAssignment(id) {
  return hydrate(db().prepare(`SELECT * FROM assignments WHERE id = ?`).get(String(id)))
}

export function insertAssignment(a) {
  db()
    .prepare(
      `INSERT INTO assignments (id, kind, item_key, course_id, title, dir, note, status, created_at,
                                opened_at, closed_at, updated_at, weight, design_id, due_at, allow_late)
       VALUES (@id, @kind, @itemKey, @courseId, @title, @dir, @note, @status, @createdAt,
               @openedAt, @closedAt, @updatedAt, @weight, @designId, @dueAt, @allowLate)`
    )
    .run({
      id: a.id,
      kind: a.kind || 'work',
      itemKey: a.itemKey || '',
      courseId: a.courseId || '',
      title: a.title || '',
      dir: a.dir || '',
      note: a.note || '',
      status: a.status || 'closed',
      createdAt: a.createdAt || new Date().toISOString(),
      openedAt: a.openedAt || '',
      closedAt: a.closedAt || '',
      updatedAt: a.updatedAt || '',
      weight: a.weight === undefined || a.weight === null ? 1 : Number(a.weight),
      designId: a.designId || '',
      dueAt: a.dueAt || '',
      allowLate: a.allowLate ? 1 : 0,
    })
  return getAssignment(a.id)
}

export function updateAssignment(id, patch) {
  const cur = getAssignment(id)
  if (!cur) return null
  const next = Object.assign({}, cur, patch)
  db()
    .prepare(
      `UPDATE assignments SET kind = ?, item_key = ?, course_id = ?, title = ?, dir = ?, note = ?, status = ?,
              opened_at = ?, closed_at = ?, updated_at = ?, weight = ?, design_id = ?, due_at = ?, allow_late = ?
       WHERE id = ?`
    )
    .run(
      next.kind || 'work',
      next.itemKey || '',
      next.courseId || '',
      next.title || '',
      next.dir || '',
      next.note || '',
      next.status || 'closed',
      next.openedAt || '',
      next.closedAt || '',
      new Date().toISOString(),
      next.weight === undefined || next.weight === null ? 1 : Number(next.weight),
      next.designId || '',
      next.dueAt || '',
      next.allowLate ? 1 : 0,
      String(id)
    )
  return getAssignment(id)
}

export function deleteAssignment(id) {
  return db().prepare(`DELETE FROM assignments WHERE id = ?`).run(String(id)).changes > 0
}

export function submissionsOf(assignmentId) {
  return hydrateAll(
    db().prepare(`SELECT * FROM submissions WHERE assignment_id = ? ORDER BY created_at, id`).all(String(assignmentId))
  )
}

export function findSubmission(assignmentId, sid) {
  return hydrate(
    db()
      .prepare(`SELECT * FROM submissions WHERE assignment_id = ? AND sid = ? ORDER BY created_at DESC LIMIT 1`)
      .get(String(assignmentId), String(sid))
  )
}

export function insertSubmission(s) {
  db()
    .prepare(
      `INSERT INTO submissions (id, assignment_id, class_id, sid, name, dir, created_at, files, changed,
                               note, url, event_id, grade, late, raw, dims, score, comment, graded_at, graded_by)
       VALUES (@id, @assignmentId, @classId, @sid, @name, @dir, @createdAt, @files, @changed,
               @note, @url, @eventId, @grade, @late, @raw, @dims, @score, @comment, @gradedAt, @gradedBy)`
    )
    .run({
      id: s.id,
      assignmentId: s.assignmentId,
      classId: s.classId || '',
      sid: s.sid,
      name: s.name || '',
      dir: s.dir || '',
      createdAt: s.createdAt || new Date().toISOString(),
      files: s.files ? JSON.stringify(s.files) : null,
      changed: s.changed ? JSON.stringify(s.changed) : null,
      note: s.note || '',
      url: s.url || '',
      eventId: s.eventId || '',
      grade: s.grade || '',
      late: s.late ? 1 : 0,
      raw: s.raw === undefined || s.raw === null ? null : Number(s.raw),
      dims: s.dims && Object.keys(s.dims).length ? JSON.stringify(s.dims) : null,
      score: s.score === undefined || s.score === null ? null : Number(s.score),
      comment: s.comment || '',
      gradedAt: s.gradedAt || '',
      gradedBy: s.gradedBy || '',
    })
  return findSubmission(s.assignmentId, s.sid)
}

export function updateSubmission(id, patch) {
  const cur = hydrate(db().prepare(`SELECT * FROM submissions WHERE id = ?`).get(String(id)))
  if (!cur) return null
  const next = Object.assign({}, cur, patch)
  db()
    .prepare(
      `UPDATE submissions SET files = ?, changed = ?, note = ?, url = ?, event_id = ?, grade = ?, late = ?,
              raw = ?, dims = ?, score = ?, comment = ?, graded_at = ?, graded_by = ? WHERE id = ?`
    )
    .run(
      next.files ? JSON.stringify(next.files) : null,
      next.changed ? JSON.stringify(next.changed) : null,
      next.note || '',
      next.url || '',
      next.eventId || '',
      next.grade || '',
      next.late ? 1 : 0,
      next.raw === undefined || next.raw === null ? null : Number(next.raw),
      next.dims && Object.keys(next.dims).length ? JSON.stringify(next.dims) : null,
      next.score === undefined || next.score === null ? null : Number(next.score),
      next.comment || '',
      next.gradedAt || '',
      next.gradedBy || '',
      String(id)
    )
  return hydrate(db().prepare(`SELECT * FROM submissions WHERE id = ?`).get(String(id)))
}

export function deleteSubmissionsOf(assignmentId) {
  return db().prepare(`DELETE FROM submissions WHERE assignment_id = ?`).run(String(assignmentId)).changes
}

/* ------------------------------ 通用状态 ------------------------------ */

export function getState(key, fallback = null) {
  const row = db().prepare(`SELECT value FROM state WHERE key = ?`).get(String(key))
  if (!row) return fallback
  try {
    return JSON.parse(row.value)
  } catch (e) {
    return fallback
  }
}

export function setState(key, value) {
  if (value === null || value === undefined) {
    db().prepare(`DELETE FROM state WHERE key = ?`).run(String(key))
    return null
  }
  db()
    .prepare(`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(String(key), JSON.stringify(value))
  return value
}
