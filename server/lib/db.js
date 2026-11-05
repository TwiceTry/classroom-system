'use strict'
/*
 * db.js —— 数据仓库（CSV 落盘）
 *
 * 四张表，一个班一学期几千行，全部是纯文本，能直接进 git：
 *
 *   data/classes.csv     id,name,createdAt,rollcallRound
 *   data/students.csv    classId,sid,name            ← 名单（classes 的关系化投影）
 *   data/events.csv      id,classId,sid,item,…,voided  ← 记分流水（只追加，撤销只改标记）
 *   data/rollcall.csv    classId,sid,pickedAt        ← 本轮已抽过的人
 *   data/assignments.csv id,title,dir,status,…       ← 课堂作业（status 只有 open / closed）
 *   data/submissions.csv id,assignmentId,sid,files…  ← 作业提交记录（时间序）
 *
 * 作业提交的**文件正文不在这两张表里**：正文落在 data/students/<班级>/<学号>/作业/<作业>/<提交>/ 下，
 * 这张 CSV 只当索引（谁、什么时候、交了哪些文件、多少分）。理由是正文动辄几千行，
 * 塞进 CSV 之后 git diff 就没法看了 —— 索引和人看的清单留在 CSV，代码留在磁盘。
 *
 * 两个刻意的设计：
 *   1) 内存里名单挂在 class.students 上（接口层直接 c.students 读写最顺手），
 *      students.csv 保存时从内存平铺回去 —— 它存在的意义是「git diff 好读」，
 *      而不是再当一份数据源，避免两处真相打架。
 *   2) 写入前统一排序，同样的数据永远序列化成同样的文本；内容没变就不碰文件。
 *
 * 迁移：发现老版本的 data/db.json 且还没有 CSV 数据时自动导入，然后把
 * db.json 改名留档（不删，老师可以自己核对）。
 */
const fs = require('fs')
const path = require('path')
const { CsvTable, byText } = require('./csv')

const SCHEMA = {
  courses: [
    'id',
    'name',
    { key: 'contentDir', type: 'string' }, // 内容根目录（相对系统目录或绝对路径），下面放 lecture / materials / 代码示例 / exams
    { key: 'schemeId', type: 'string' }, // 绑定的考核方案（data/schemes/<id>.json）
    { key: 'note', type: 'string' },
    { key: 'semester', type: 'string' }, // 学期：'2026秋' 这种短串，用来分组与复用（老数据为空串）
    { key: 'createdAt', type: 'string' },
    { key: 'archived', type: 'bool' }, // 归档：不删数据，只是不在下拉里默认出现
  ],
  classes: ['id', { key: 'courseId', type: 'string' }, 'name', 'createdAt', { key: 'rollcallRound', type: 'number' }],
  students: ['classId', 'sid', 'name'],
  events: [
    'id',
    'classId',
    'sid',
    'item',
    { key: 'delta', type: 'number' },
    { key: 'kind', type: 'string' },
    { key: 'grade', type: 'string' },
    { key: 'late', type: 'bool' },
    { key: 'raw', type: 'number' },
    { key: 'dims', type: 'map' },
    { key: 'weight', type: 'number' }, // 这次评定在「多次取均」里的权重（默认 1）
    { key: 'slot', type: 'string' }, // 考勤用：这一笔是哪个节次记的（1-2节 / 3-4节 …）
    'reason',
    'operator',
    'createdAt',
    { key: 'voided', type: 'bool' },
    { key: 'voidedAt', type: 'string' },
    { key: 'voidedBy', type: 'string' },
    { key: 'evidence', type: 'files' },
    { key: 'schemeVersion', type: 'string' }, // 记这条账时用的是哪一版考核方案（溯源用，不影响算分）
  ],
  rollcall: ['classId', 'sid', 'pickedAt'],
  // 通用小状态：value 存 JSON 字符串。目前用来存「当前点名（spot:班级）」与「考勤点名会话（attend:班级）」
  state: ['key', { key: 'value', type: 'string' }],
  assignments: [
    'id',
    { key: 'kind', type: 'string' }, // work=代码工作台 / project=材料表单（由方案里 module.submit 推出来，给老代码兜底）
    { key: 'itemKey', type: 'string' }, // 对应方案里的哪个考核项（homework / project / 新加的任何一项）
    { key: 'courseId', type: 'string' }, // 属于哪门课（作业是课程级的，不跟班级走）
    'title',
    'dir',
    'note',
    { key: 'status', type: 'string' }, // 只有 open / closed；默认 closed（未开始）
    'createdAt',
    { key: 'openedAt', type: 'string' },
    { key: 'closedAt', type: 'string' },
    { key: 'updatedAt', type: 'string' },
    { key: 'weight', type: 'number' }, // 这次作业占「本项」的权重（默认 1，可调）
    { key: 'designId', type: 'string' }, // 来自作业库里的哪个设计（追溯用，可空）
    { key: 'dueAt', type: 'string' }, // 截止时间（ISO；空 = 不限）
    { key: 'allowLate', type: 'bool' }, // 截止后还收不收（收的话自动标 late，方案按 lateFactor 打折）
  ],
  submissions: [
    'id',
    'assignmentId',
    'classId',
    'sid',
    'name',
    'dir', // 交作业时用的示例目录，冻结下来：将来老师改了作业的 dir，老提交仍能还原
    'createdAt',
    { key: 'files', type: 'paths' }, // 课堂作业：整份交上来的文件；大作业：附件名
    { key: 'changed', type: 'paths' }, // 课堂作业里真被学生改过的（审阅时标红用）
    { key: 'note', type: 'string' }, // 大作业的说明（学生写的）
    { key: 'url', type: 'string' }, // 大作业的部署 / 仓库地址
    { key: 'eventId', type: 'string' }, // 批阅写进计分表的那条记录（改分时先撤旧的）
    { key: 'grade', type: 'string' }, // 课堂作业批的等级 A/B/C/X（回填表单用）
    { key: 'late', type: 'bool' }, // 迟交
    { key: 'raw', type: 'number' }, // 卷面分（机试 / 笔试这类 raw 规则）
    { key: 'dims', type: 'map' }, // 大作业四维量规得分
    { key: 'score', type: 'number' },
    { key: 'comment', type: 'string' },
    { key: 'gradedAt', type: 'string' },
    { key: 'gradedBy', type: 'string' },
  ],
}

function createDb(dataDir) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

  const files = {
    courses: path.join(dataDir, 'courses.csv'),
    classes: path.join(dataDir, 'classes.csv'),
    students: path.join(dataDir, 'students.csv'),
    events: path.join(dataDir, 'events.csv'),
    rollcall: path.join(dataDir, 'rollcall.csv'),
    state: path.join(dataDir, 'state.csv'),
    assignments: path.join(dataDir, 'assignments.csv'),
    submissions: path.join(dataDir, 'submissions.csv'),
  }

  const t = {
    courses: new CsvTable(files.courses, SCHEMA.courses),
    classes: new CsvTable(files.classes, SCHEMA.classes),
    students: new CsvTable(files.students, SCHEMA.students),
    events: new CsvTable(files.events, SCHEMA.events),
    rollcall: new CsvTable(files.rollcall, SCHEMA.rollcall),
    state: new CsvTable(files.state, SCHEMA.state),
    assignments: new CsvTable(files.assignments, SCHEMA.assignments),
    submissions: new CsvTable(files.submissions, SCHEMA.submissions),
  }

  /* ---------------- 内存视图 ---------------- */

  const courses = new Map() // id → { id, name, contentDir, schemeId, note, createdAt, archived }
  const classes = new Map() // id → { id, courseId, name, createdAt, rollcallRound, students:[{sid,name}] }
  const rollCache = new Map() // classId → { round, picked:[sid], updatedAt }
  const stateMap = new Map() // key → 任意 JSON
  const assignments = new Map() // id → { id, title, dir, note, status, createdAt, openedAt, closedAt, updatedAt }
  const subsBy = new Map() // assignmentId → [提交]，按 createdAt 升序（先交的在前）

  function hydrate() {
    courses.clear()
    classes.clear()
    rollCache.clear()
    assignments.clear()
    subsBy.clear()
    stateMap.clear()
    for (const row of t.state.all()) {
      if (!row.key) continue
      try {
        stateMap.set(row.key, JSON.parse(row.value || 'null'))
      } catch (e) {
        /* 坏行忽略，不影响启动 */
      }
    }
    for (const row of t.courses.all()) {
      if (!row.id) continue
      courses.set(row.id, {
        id: row.id,
        name: row.name || '未命名课程',
        contentDir: row.contentDir || '',
        schemeId: row.schemeId || '',
        note: row.note || '',
        createdAt: row.createdAt || '',
        archived: !!row.archived,
      })
    }
    for (const row of t.classes.all()) {
      if (!row.id) continue
      classes.set(row.id, {
        id: row.id,
        courseId: row.courseId || '',
        name: row.name || '未命名班级',
        createdAt: row.createdAt || new Date().toISOString(),
        rollcallRound: row.rollcallRound || 1,
        students: [],
      })
    }
    // 名单按学号排序挂回班级：同一份数据每次加载顺序一致
    const rows = t.students.all().slice().sort((a, b) => byText(a.classId, b.classId) || byText(a.sid, b.sid))
    for (const row of rows) {
      const c = classes.get(row.classId)
      if (!c || !row.sid) continue
      if (c.students.some((s) => s.sid === row.sid)) continue
      c.students.push({ sid: row.sid, name: row.name || '' })
    }
    t.events.sortBy((a, b) => byText(a.createdAt || '', b.createdAt || '') || byText(a.id, b.id))

    for (const row of t.assignments.all()) {
      if (!row.id) continue
      assignments.set(row.id, {
        id: row.id,
        kind: row.kind === 'project' ? 'project' : 'work',
        // 老数据没有 itemKey：按 kind 回推（project → project，其余 → homework）
        itemKey: row.itemKey || (row.kind === 'project' ? 'project' : 'homework'),
        courseId: row.courseId || '',
        title: row.title || '课堂作业',
        dir: row.dir || '',
        note: row.note || '',
        status: row.status === 'open' ? 'open' : 'closed',
        weight: row.weight === undefined || row.weight === null || row.weight === '' ? 1 : Number(row.weight) || 1,
        createdAt: row.createdAt || new Date().toISOString(),
        openedAt: row.openedAt || '',
        closedAt: row.closedAt || '',
        updatedAt: row.updatedAt || row.createdAt || '',
      })
    }
    for (const row of t.submissions.all()) {
      if (!row.id || !assignments.has(row.assignmentId)) continue
      const sub = {
        id: row.id,
        assignmentId: row.assignmentId,
        classId: row.classId || '',
        sid: row.sid || '',
        name: row.name || '',
        dir: row.dir || '',
        createdAt: row.createdAt || '',
        files: Array.isArray(row.files) ? row.files : [],
        // 老数据只有「改过的文件」，没有 changed 列：那时候 files 本身就是改动清单
        changed: Array.isArray(row.changed) ? row.changed : [],
        note: row.note || '',
        url: row.url || '',
        eventId: row.eventId || '',
        grade: row.grade || '',
        late: !!row.late,
        raw: typeof row.raw === 'number' ? row.raw : undefined,
        dims: row.dims || undefined,
        score: typeof row.score === 'number' ? row.score : undefined,
        comment: row.comment || '',
        gradedAt: row.gradedAt || '',
        gradedBy: row.gradedBy || '',
      }
      if (!subsBy.has(sub.assignmentId)) subsBy.set(sub.assignmentId, [])
      subsBy.get(sub.assignmentId).push(sub)
    }
    for (const list of subsBy.values()) sortSubs(list)
  }

  function sortSubs(list) {
    list.sort((a, b) => byText(a.createdAt || '', b.createdAt || '') || byText(a.id, b.id))
    return list
  }

  /* ---------------- 迁移老数据 ---------------- */

  function migrateFromJson() {
    const jsonFile = path.join(dataDir, 'db.json')
    if (!fs.existsSync(jsonFile)) return false
    if (t.classes.all().length || t.events.all().length) return false

    let raw
    try {
      raw = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
    } catch (e) {
      console.error('[db] 老的 db.json 解析失败，跳过迁移：' + e.message)
      return false
    }

    const oldClasses = Array.isArray(raw.classes) ? raw.classes : []
    for (const c of oldClasses) {
      t.classes.insert({
        id: c.id,
        name: c.name,
        createdAt: c.createdAt,
        rollcallRound: (raw.rollcall && raw.rollcall[c.id] && raw.rollcall[c.id].round) || 1,
      })
      for (const s of c.students || []) t.students.insert({ classId: c.id, sid: s.sid, name: s.name })
      const roll = raw.rollcall && raw.rollcall[c.id]
      if (roll && Array.isArray(roll.picked)) {
        for (const sid of roll.picked) t.rollcall.insert({ classId: c.id, sid, pickedAt: roll.updatedAt || '' })
      }
    }
    for (const e of Array.isArray(raw.events) ? raw.events : []) {
      t.events.insert({
        id: e.id,
        classId: e.classId,
        sid: e.sid,
        item: e.item,
        delta: e.delta,
        kind: e.kind,
        grade: e.grade,
        late: e.late,
        raw: e.raw,
        dims: e.dims,
        reason: e.reason,
        operator: e.operator,
        createdAt: e.createdAt,
        voided: e.voided,
        voidedAt: e.voidedAt,
        voidedBy: e.voidedBy,
        evidence: e.evidence,
      })
    }

    flushSync()
    const bak = jsonFile + '.migrated'
    try {
      fs.renameSync(jsonFile, bak)
    } catch (e) {
      /* ignore */
    }
    console.log('[db] 已把 db.json 迁移为 CSV：' + oldClasses.length + ' 个班 / ' +
      (raw.events || []).length + ' 条记录（原文件留档为 db.json.migrated）')
    return true
  }

  /* ---------------- 落盘 ---------------- */

  function syncTables() {
    const list = Array.from(classes.values()).sort(
      (a, b) => byText(a.createdAt || '', b.createdAt || '') || byText(a.id, b.id)
    )

    t.classes.clear()
    for (const c of list) {
      t.classes.insert({
        id: c.id,
        courseId: c.courseId || '',
        name: c.name,
        createdAt: c.createdAt,
        rollcallRound: c.rollcallRound || 1,
      })
    }
    t.classes.sortBy((a, b) => byText(a.createdAt || '', b.createdAt || '') || byText(a.id, b.id))

    t.courses.clear()
    for (const c of Array.from(courses.values()).sort((x, y) => byText(x.id, y.id))) {
      t.courses.insert({
        id: c.id,
        name: c.name,
        contentDir: c.contentDir,
        schemeId: c.schemeId,
        note: c.note,
        createdAt: c.createdAt,
        archived: !!c.archived,
      })
    }

    t.students.clear()
    for (const c of list) {
      for (const s of c.students) t.students.insert({ classId: c.id, sid: s.sid, name: s.name })
    }
    t.students.sortBy((a, b) => byText(a.classId, b.classId) || byText(a.sid, b.sid))

    t.rollcall.clear()
    for (const [classId, st] of rollCache) {
      for (const sid of st.picked) t.rollcall.insert({ classId, sid, pickedAt: st.updatedAt || '' })
    }
    t.rollcall.sortBy((a, b) => byText(a.classId, b.classId) || byText(a.sid, b.sid))

    t.events.sortBy((a, b) => byText(a.createdAt || '', b.createdAt || '') || byText(a.id, b.id))

    t.assignments.clear()
    for (const a of Array.from(assignments.values()).sort(
      (x, y) => byText(x.createdAt || '', y.createdAt || '') || byText(x.id, y.id)
    )) {
      t.assignments.insert({
        id: a.id,
        itemKey: a.itemKey,
        courseId: a.courseId || '',
        title: a.title,
        dir: a.dir,
        note: a.note,
        status: a.status,
        kind: a.kind,
        weight: a.weight === undefined ? 1 : Number(a.weight) || 1,
        createdAt: a.createdAt,
        openedAt: a.openedAt,
        closedAt: a.closedAt,
        updatedAt: a.updatedAt,
      })
    }
    t.assignments.sortBy((a, b) => byText(a.createdAt || '', b.createdAt || '') || byText(a.id, b.id))

    t.submissions.clear()
    for (const list of subsBy.values()) {
      for (const s of list) {
        t.submissions.insert({
          id: s.id,
          assignmentId: s.assignmentId,
          classId: s.classId,
          sid: s.sid,
          name: s.name,
          dir: s.dir,
          createdAt: s.createdAt,
          files: s.files,
          changed: s.changed,
          note: s.note,
          url: s.url,
          eventId: s.eventId,
          grade: s.grade,
          late: s.late,
          raw: s.raw,
          dims: s.dims,
          score: s.score,
          comment: s.comment,
          gradedAt: s.gradedAt,
          gradedBy: s.gradedBy,
        })
      }
    }
    t.submissions.sortBy(
      (a, b) =>
        byText(a.assignmentId, b.assignmentId) ||
        byText(a.createdAt || '', b.createdAt || '') ||
        byText(a.id, b.id)
    )
  }

  let timer = null

  function flushSync() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    syncTables()
    let changed = 0
    for (const key of Object.keys(t)) if (t[key].save()) changed++
    return changed
  }

  /** 记一次改动；200ms 内的连续改动合并成一次写盘 */
  function save() {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      try {
        flushSync()
      } catch (e) {
        console.error('[db] 写盘失败：' + e.message)
      }
    }, 200)
  }

  /* ---------------- 对外接口 ---------------- */

  const api = {
    /* 班级 */
    /* ---- 课程 ---- */
    listCourses() {
      return Array.from(courses.values()).sort((a, b) => byText(a.createdAt || '', b.createdAt || '') || byText(a.id, b.id))
    },
    getCourse(id) {
      return courses.get(id) || null
    },
    /** 新建 / 覆盖写入一门课程（导入课程包时也走这里） */
    upsertCourse(fields) {
      const id = String(fields.id || '').trim()
      if (!id) return null
      const old = courses.get(id) || null
      const c = {
        id,
        name: fields.name || (old && old.name) || id,
        contentDir: fields.contentDir !== undefined ? fields.contentDir : (old ? old.contentDir : ''),
        schemeId: fields.schemeId !== undefined ? fields.schemeId : (old ? old.schemeId : ''),
        note: fields.note !== undefined ? fields.note : (old ? old.note : ''),
        semester: fields.semester !== undefined ? fields.semester : (old ? old.semester : ''),
        createdAt: (old && old.createdAt) || new Date().toISOString(),
        archived: fields.archived !== undefined ? !!fields.archived : !!(old && old.archived),
      }
      courses.set(id, c)
      save()
      return c
    },
    deleteCourse(id) {
      if (!courses.has(id)) return false
      courses.delete(id)
      save()
      return true
    },
    /** 某门课下的班级（按建班时间排） */
    listClassesOf(courseId) {
      return Array.from(classes.values())
        .filter((c) => c.courseId === courseId)
        .sort((a, b) => byText(a.createdAt || '', b.createdAt || '') || byText(a.id, b.id))
    },
    /** 同一门课里按学号找班级：课程内学号唯一，所以最多命中一个 */
    findClassBySid(courseId, sid) {
      const hits = Array.from(classes.values()).filter(
        (c) => c.courseId === courseId && c.students.some((s) => s.sid === sid)
      )
      return { hits, cls: hits[0] || null }
    },

    listClasses() {
      return Array.from(classes.values()).sort(
        (a, b) => byText(a.createdAt || '', b.createdAt || '') || byText(a.id, b.id)
      )
    },
    getClass(id) {
      return classes.get(id) || null
    },
    createClass(id, name, courseId) {
      const c = {
        id,
        courseId: courseId || '',
        name,
        createdAt: new Date().toISOString(),
        rollcallRound: 1,
        students: [],
      }
      classes.set(id, c)
      save()
      return c
    },
    renameClass(id, name) {
      const c = classes.get(id)
      if (!c) return null
      c.name = name
      save()
      return c
    },
    deleteClass(id) {
      if (!classes.has(id)) return false
      classes.delete(id)
      rollCache.delete(id)
      t.events.remove((e) => e.classId === id)
      // 删班连带删掉这个班的作业提交记录（提交文件目录由 routes 层负责清）
      for (const [aid, list] of subsBy) {
        const kept = list.filter((s) => s.classId !== id)
        if (kept.length === list.length) continue
        if (kept.length) subsBy.set(aid, kept)
        else subsBy.delete(aid)
      }
      save()
      return true
    },

    /* 名单（内存里挂在 class.students 上，改完调 save） */
    rosterOf(classId) {
      const c = classes.get(classId)
      return c ? c.students.map((s) => ({ sid: s.sid, name: s.name })) : []
    },
    findStudent(classId, sid) {
      const c = classes.get(classId)
      return (c && c.students.find((s) => s.sid === sid)) || null
    },

    /* 记分流水 */
    eventsOf(classId) {
      return t.events.filter((e) => e.classId === classId)
    },
    allEvents() {
      return t.events.all()
    },
    addEvent(ev) {
      t.events.insert(ev)
      save()
      return ev
    },
    /** 一批记录一次落盘（点名 60 个人不要写 60 次盘） */
    addEvents(list) {
      const arr = Array.isArray(list) ? list : []
      for (const ev of arr) t.events.insert(ev)
      if (arr.length) save()
      return arr
    },
    findEvent(classId, id) {
      return t.events.find((e) => e.id === id && e.classId === classId)
    },

    /* 点名 */
    /** 读一个通用小状态（不存在返回 null） */
    getState(key) {
      const v = stateMap.get(key)
      return v === undefined ? null : v
    },

    /** 写一个小状态；value 传 null 表示删除 */
    setState(key, value) {
      if (value === null || value === undefined) {
        stateMap.delete(key)
        t.state.remove((r) => r.key === key)
        save()
        return null
      }
      const raw = JSON.stringify(value)
      if (t.state.find((r) => r.key === key)) t.state.update((r) => r.key === key, { value: raw })
      else t.state.insert({ key, value: raw })
      stateMap.set(key, JSON.parse(raw))
      save()
      return stateMap.get(key)
    },

    rollState(classId) {
      if (!rollCache.has(classId)) {
        const c = classes.get(classId)
        rollCache.set(classId, {
          round: (c && c.rollcallRound) || 1,
          picked: t.rollcall.filter((r) => r.classId === classId).map((r) => r.sid),
          updatedAt: '',
        })
      }
      return rollCache.get(classId)
    },

    /* 课堂作业 */
    listAssignments() {
      return Array.from(assignments.values()).sort(
        (a, b) => byText(a.createdAt || '', b.createdAt || '') || byText(a.id, b.id)
      )
    },
    getAssignment(id) {
      return assignments.get(id) || null
    },
    createAssignment(fields) {
      const now = new Date().toISOString()
      const a = {
        id: fields.id,
        kind: fields.kind === 'project' ? 'project' : 'work',
        itemKey: fields.itemKey || (fields.kind === 'project' ? 'project' : 'homework'),
        courseId: fields.courseId || '',
        title: fields.title || '课堂作业',
        dir: fields.dir || '',
        note: fields.note || '',
        weight: fields.weight === undefined || fields.weight === null ? 1 : Number(fields.weight) || 1,
        designId: fields.designId ? String(fields.designId) : '',
        dueAt: fields.dueAt ? String(fields.dueAt) : '', // 截止时间（空 = 不限）
        allowLate: fields.allowLate === undefined ? true : !!fields.allowLate,
        status: 'closed', // 铁律：新建的作业一律「未开始」，由老师手动开
        createdAt: now,
        openedAt: '',
        closedAt: '',
        updatedAt: now,
      }
      assignments.set(a.id, a)
      save()
      return a
    },
    updateAssignment(id, patch) {
      const a = assignments.get(id)
      if (!a) return null
      for (const key of ['title', 'dir', 'note', 'status', 'openedAt', 'closedAt', 'dueAt', 'allowLate']) {
        if (patch[key] !== undefined) a[key] = patch[key]
      }
      if (a.status === 'open') a.closedAt = ''
      a.updatedAt = new Date().toISOString()
      save()
      return a
    },
    deleteAssignment(id) {
      if (!assignments.has(id)) return false
      assignments.delete(id)
      subsBy.delete(id)
      t.submissions.remove((s) => s.assignmentId === id)
      save()
      return true
    },

    /* 作业提交（时间序：先交的在前） */
    submissionsOf(assignmentId) {
      return (subsBy.get(assignmentId) || []).slice()
    },
    allSubmissions() {
      const out = []
      for (const list of subsBy.values()) out.push(...list)
      return out
    },
    addSubmission(sub) {
      if (!subsBy.has(sub.assignmentId)) subsBy.set(sub.assignmentId, [])
      const list = subsBy.get(sub.assignmentId)
      list.push(sub)
      sortSubs(list)
      save()
      return sub
    },
    findSubmission(assignmentId, id) {
      return (subsBy.get(assignmentId) || []).find((s) => s.id === id) || null
    },
    updateSubmission(assignmentId, id, patch) {
      const s = this.findSubmission(assignmentId, id)
      if (!s) return null
      // 用 hasOwnProperty 而不是 !== undefined：撤分就是把 score 显式写成 undefined
      for (const key of ['score', 'comment', 'gradedAt', 'gradedBy', 'files', 'name', 'dir', 'note', 'url', 'eventId', 'grade', 'late', 'raw', 'dims']) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) s[key] = patch[key]
      }
      save()
      return s
    },
    deleteSubmission(assignmentId, id) {
      const list = subsBy.get(assignmentId)
      if (!list) return false
      const idx = list.findIndex((s) => s.id === id)
      if (idx < 0) return false
      list.splice(idx, 1)
      if (!list.length) subsBy.delete(assignmentId)
      save()
      return true
    },

    /* 持久化 */
    save,
    flush: flushSync,
    files,
    tables: t,
  }

  hydrate()
  migrateFromJson()
  hydrate()

  // 首次运行时把四个文件的表头写出来，方便直接 git add
  for (const key of Object.keys(t)) {
    if (!fs.existsSync(files[key])) {
      // 走 CsvTable.save()（tmp + fsync + rename 原子写），别直接 writeFileSync 覆盖
      t[key].loadedText = '' // 清掉「内容没变就不写」的判定，强制落一份表头
      t[key].save()
    }
  }

  return api
}

module.exports = { createDb, SCHEMA }
