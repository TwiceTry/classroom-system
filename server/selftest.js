'use strict'
/*
 * selftest.js —— 课堂系统自检（零依赖，只连本机已经跑起来的服务）
 *
 * 用法：先启动服务，再
 *   node server/selftest.js [port]
 *
 * 覆盖两类最容易悄悄坏掉的东西：
 *   A. 接口与算分：登录 → 建班 → 导入名单 → 六种记分 → 学生端读自己的分 → 点名 → 导出
 *   B. 投屏中继的协议细节：hello / peers / mode / 二进制转发 / **分片消息拼接**
 *      （分片拼错 = 学生端整帧丢弃 = 全班黑屏，老方案踩过一次，必须有回归）
 *
 * 输出保持纯 ASCII，避免 Windows 控制台编码干扰判断。
 */
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { makeZip, readZip } = require('./lib/zip')
const ExcelJS = require('exceljs')
const config = require('./config')

const PORT = Number(process.argv[2] || process.env.TS_PORT || 18730)
const HOST = '127.0.0.1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0

let skipped = 0

/** 这台机器没有课程内容时，相关用例跳过（不算失败，但会打印出来） */
function skip(name, why) {
  skipped++
  console.log('  SKIP  ' + name + '  · ' + (why || '前置条件不具备'))
}

function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log('  PASS  ' + name)
  } else {
    fail++
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''))
  }
}

/* ---------------- HTTP ---------------- */

function request(method, path, body, token) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = {}
    if (payload) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = payload.length
    }
    if (token) headers['Authorization'] = 'Bearer ' + token
    const req = http.request({ host: HOST, port: PORT, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const text = buf.toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch (e) {
          json = null
        }
        resolve({ status: res.statusCode, json, text, buf, headers: res.headers })
      })
    })
    req.on('error', (e) => resolve({ status: 0, json: null, text: e.message }))
    if (payload) req.write(payload)
    req.end()
  })
}

/** 二进制 POST（上传课程包 zip 用） */
function requestBinary(method, path, buf, token) {
  return new Promise((resolve) => {
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length }
    if (token) headers['Authorization'] = 'Bearer ' + token
    const req = http.request({ host: HOST, port: PORT, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        const text = body.toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch (e) {
          json = null
        }
        resolve({ status: res.statusCode, json, text, buf: body, headers: res.headers })
      })
    })
    req.on('error', (e) => resolve({ status: 0, json: null, text: e.message, buf: Buffer.alloc(0) }))
    req.write(buf)
    req.end()
  })
}

/* ---------------- 极简 WebSocket 客户端 ---------------- */

function wsConnect(role) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const req = http.request({
      host: HOST,
      port: PORT,
      path: '/ws?role=' + role,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.setNoDelay(true)
      const client = {
        socket,
        messages: [],
        waiters: [],
        closed: false,
        push(msg) {
          this.messages.push(msg)
          while (this.waiters.length) this.waiters.shift()(this.messages.shift())
        },
        next(timeoutMs) {
          if (this.messages.length) return Promise.resolve(this.messages.shift())
          return new Promise((res2) => {
            const waiter = (m) => {
              clearTimeout(timer)
              res2(m)
            }
            const timer = setTimeout(() => {
              // 超时把自己摘掉，否则下一条消息会被这个「已经死掉的等待者」吃掉
              const i = this.waiters.indexOf(waiter)
              if (i >= 0) this.waiters.splice(i, 1)
              res2(null)
            }, timeoutMs || 1500)
            this.waiters.push(waiter)
          })
        },
        sendText(obj) {
          this.sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'))
        },
        sendBinary(buf, fin) {
          this.sendFrame(0x2, buf, fin)
        },
        sendCont(buf, fin) {
          this.sendFrame(0x0, buf, fin)
        },
        sendFrame(opcode, payload, fin) {
          const mask = crypto.randomBytes(4)
          const len = payload.length
          let header
          if (len < 126) {
            header = Buffer.alloc(2)
            header[1] = 0x80 | len
          } else if (len < 65536) {
            header = Buffer.alloc(4)
            header[1] = 0x80 | 126
            header.writeUInt16BE(len, 2)
          } else {
            header = Buffer.alloc(10)
            header[1] = 0x80 | 127
            header.writeUInt32BE(0, 2)
            header.writeUInt32BE(len, 6)
          }
          header[0] = (fin === false ? 0 : 0x80) | opcode
          const masked = Buffer.from(payload)
          for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3]
          socket.write(Buffer.concat([header, mask, masked]))
        },
        close() {
          this.closed = true
          try {
            socket.destroy()
          } catch (e) {
            /* ignore */
          }
        },
      }

      let buf = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
          if (buf.length < 2) return
          const opcode = buf[0] & 0x0f
          let len = buf[1] & 0x7f
          let off = 2
          if (len === 126) {
            if (buf.length < 4) return
            len = buf.readUInt16BE(2)
            off = 4
          } else if (len === 127) {
            if (buf.length < 10) return
            len = buf.readUInt32BE(6)
            off = 10
          }
          if (buf.length < off + len) return
          const payload = buf.slice(off, off + len)
          buf = buf.slice(off + len)
          if (opcode === 0x1) client.push({ text: payload.toString('utf8') })
          else if (opcode === 0x2) client.push({ binary: payload })
          else if (opcode === 0x8) client.closed = true
        }
      })
      socket.on('close', () => (client.closed = true))
      socket.on('error', () => (client.closed = true))

      resolve(client)
    })
    req.on('error', reject)
    req.end()
  })
}

async function expectMessage(client, pred, label) {
  for (let i = 0; i < 6; i++) {
    const msg = await client.next(1200)
    if (!msg) break
    if (pred(msg)) return msg
  }
  return null
}

/* ---------------- 测试主体 ---------------- */

/**
 * 上次自检跑到一半挂掉时，夹具会留在库里（比如 selftest-1793… 这样的班）。
 * 名字都以 selftest- 开头，先扫一遍删掉，跑多少次都不会越积越多。
 */
/** 自检跑完后，把「这次才出现的」回收站目录删掉（之前就有的不动） */
function trashSnapshot() {
  try {
    const dir = path.join(config.dataDir, '.trash')
    return fs.existsSync(dir) ? new Set(fs.readdirSync(dir)) : new Set()
  } catch (e) {
    return new Set()
  }
}

function trashPrune(before) {
  let n = 0
  try {
    const dir = path.join(config.dataDir, '.trash')
    if (!fs.existsSync(dir)) return 0
    for (const name of fs.readdirSync(dir)) {
      if (before && before.has(name)) continue
      fs.rmSync(path.join(dir, name), { recursive: true, force: true })
      n++
    }
    if (!fs.readdirSync(dir).length) fs.rmdirSync(dir)
  } catch (e) {
    /* 清不干净也不影响结果 */
  }
  return n
}

/** data/exams 下没有对应作业的目录（自检中断留下的试卷/答案卷） */
function sweepOrphanExams() {
  let n = 0
  try {
    const dir = path.join(config.dataDir, 'exams')
    if (!fs.existsSync(dir)) return 0
    const live = new Set(
      fs
        .readFileSync(path.join(config.dataDir, 'assignments.csv'), 'utf8')
        .split(/\r?\n/)
        .slice(1)
        .map((l) => l.split(',')[0])
        .filter(Boolean)
    )
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() || live.has(ent.name)) continue
      fs.rmSync(path.join(dir, ent.name), { recursive: true, force: true })
      n++
    }
  } catch (e) {
    /* 同上 */
  }
  return n
}

async function sweepLeftovers(token) {
  try {
    const cls = await request('GET', '/api/teacher/classes', undefined, token)
    for (const c of (cls.json && cls.json.classes) || []) {
      if (/^selftest-/.test(c.name)) await request('DELETE', '/api/teacher/classes/' + c.id, undefined, token)
    }
    const courses = await request('GET', '/api/teacher/courses', undefined, token)
    for (const c of (courses.json && courses.json.courses) || []) {
      if (/^selftest/.test(c.id)) await request('DELETE', '/api/teacher/courses/' + c.id, undefined, token)
    }
  } catch (e) {
    /* 扫不干净不影响本次自检 */
  }
}

async function testApi() {
  console.log('\n[A] HTTP API / scoring')

  const boot = await request('GET', '/api/bootstrap')
  check('GET /api/bootstrap 200', boot.status === 200)
  const bootLessons = (boot.json && boot.json.lessons) || []
  const NO_CONTENT = bootLessons.length === 0
  if (NO_CONTENT) {
    console.log('  · 这台机器还没有课程内容（讲义/材料/代码示例），内容相关的用例跳过；建一门课后再跑就是全量')
    skip('bootstrap has lessons', '没有课程内容')
  } else {
    check('bootstrap has lessons', bootLessons.length >= 18, 'len=' + bootLessons.length)
  }
  const liveItems = (boot.json && boot.json.items) || []
  const hasBonus = liveItems.some((i) => i.extra)
  check('bootstrap lists the scheme items', liveItems.length >= 4 && liveItems.every((i) => i.key && i.full >= 0),
    liveItems.map((i) => i.key).join(','))

  const badLogin = await request('POST', '/api/login/teacher', { password: '__wrong__' })
  check('teacher wrong password -> 401', badLogin.status === 401)

  const login = await request('POST', '/api/login/teacher', { password: readPassword() })
  check('teacher login ok', login.status === 200 && !!(login.json && login.json.token), 'status=' + login.status)
  if (!login.json || !login.json.token) return
  const tt = login.json.token

  await sweepLeftovers(tt) // 先清掉上次跑挂留下的夹具

  const noAuth = await request('GET', '/api/teacher/classes')
  check('teacher API without token -> 401', noAuth.status === 401)

  // 方案 → 界面：导航/入口/守卫都读这一份
  const sch = await request('GET', '/api/scheme', undefined, tt)
  const mods = (sch.json && sch.json.modules) || []
  check('GET /api/scheme lists enabled modules with module routes',
    sch.status === 200 &&
      mods.length >= 3 &&
      mods.every((m) => m.itemKey && /^\/teacher\/modules\//.test(m.teacherRoute)) &&
      mods.filter((m) => m.studentRoute).every((m) => /^\/student\/modules\//.test(m.studentRoute)) &&
      mods.filter((m) => m.kind === 'work' || m.kind === 'project').every((m) => m.studentRoute),
    JSON.stringify(mods))
  check('课堂互动是一个模块（只有教师端）',
    mods.some((m) => m.form === 'manual' && m.studentRoute === ''),
    JSON.stringify(mods.filter((m) => m.form === 'manual')))
  check('考勤是一个模块（只有教师端，学生端没有入口）',
    mods.some((m) => m.form === 'attendance' && m.studentRoute === ''),
    JSON.stringify(mods.filter((m) => m.form === 'attendance')))
  // /api/scheme 给的是渲染后的项（跟 bootstrap 一致），/api/teacher/scheme 才带 raw
  check('GET /api/scheme items mirror the bootstrap items',
    (sch.json.items || []).length === liveItems.length,
    'scheme=' + (sch.json.items || []).length + ' bootstrap=' + liveItems.length)
  check('exam module is offered as a paper module', mods.some((m) => m.itemKey === 'exam' && m.form === 'paper'), JSON.stringify(mods.map((m) => m.itemKey + ':' + m.form)))

  // 作息表：现在第几节（服务器算，机房机器时间不准也不影响）
  const tt2 = require('./lib/timetable')
  const atW = (h, m) => tt2.at(new Date(2026, 11, 10, h, m)) // 12 月 = 冬春季
  const atS = (h, m) => tt2.at(new Date(2026, 5, 10, h, m)) // 6 月 = 夏秋季
  check('timetable: 10:30 is period 3 (winter)',
    atW(10, 30).period && atW(10, 30).period.no === 3 && atW(10, 30).pair === '3-4节',
    JSON.stringify(atW(10, 30).text))
  check('timetable: summer starts period 5 at 14:40',
    atS(14, 45).period && atS(14, 45).period.no === 5 && atS(14, 45).period.start === '14:40',
    JSON.stringify(atS(14, 45).text))
  check('timetable: between periods shows the next one',
    !atW(9, 0).period && atW(9, 0).next && atW(9, 0).next.no === 2, JSON.stringify(atW(9, 0).text))
  check('timetable: after the last period -> no current period',
    !atW(21, 0).period && atW(21, 0).next === null, JSON.stringify(atW(21, 0).text))
  check('timetable: before the first period says so',
    /未到上课时间/.test(atW(7, 30).text), JSON.stringify(atW(7, 30).text))

  const clockApi = await request('GET', '/api/timetable', undefined, tt)
  check('GET /api/timetable returns a clock with a period slot',
    clockApi.status === 200 && !!clockApi.json.clock && Array.isArray(clockApi.json.periods),
    JSON.stringify(clockApi.json && clockApi.json.text))

  const cls = await request('POST', '/api/teacher/classes', { name: 'selftest-' + Date.now() }, tt)
  check('create class', cls.status === 200 && cls.json.class && cls.json.class.id)
  if (!cls.json || !cls.json.class) return
  const classId = cls.json.class.id

  const roster = await request('POST', '/api/teacher/classes/' + classId + '/roster', {
    mode: 'replace',
    students: [
      { sid: '2025010101', name: 'AAA' },
      { sid: '2025010102', name: 'BBB' },
      { sid: '2025010103', name: 'CCC' },
    ],
  }, tt)
  check('import roster 3 students', roster.status === 200 && roster.json.total === 3, JSON.stringify(roster.json))

  // 有问题的行：整批拒绝，并逐条说清是第几条、什么问题
  const badRoster = await request('POST', '/api/teacher/classes/' + classId + '/roster', {
    mode: 'merge',
    students: [
      { sid: '2025010101', name: 'AAA' },
      { sid: '', name: '没学号' },
      { sid: '2025010101', name: '重复学号' },
      { sid: '2025010199', name: '这个名字真的太长了长到超过二十个字符上限了所以应该被拒绝掉' },
    ],
  }, tt)
  check('坏名单：整批拒绝并逐条报错（空学号 / 重复 / 姓名过长）',
    badRoster.status === 400 && Array.isArray(badRoster.json.errors) && badRoster.json.errors.length === 3 &&
      badRoster.json.errors.join(' ').indexOf('重复') >= 0,
    'status=' + badRoster.status + ' ' + JSON.stringify(badRoster.json && badRoster.json.errors))

  // 两段式：先干跑（不写），再确认（才写）
  const dry = await request('POST', '/api/teacher/classes/' + classId + '/roster/inspect', {
    mode: 'merge',
    students: [{ sid: '2025010101', name: 'AAA' }, { sid: '2025010999', name: '新来的' }],
  }, tt)
  check('名单干跑：报出新增 1 / 不变 1，且不落盘',
    dry.status === 200 && dry.json.added === 1 && dry.json.unchanged === 1 && dry.json.after === 4,
    JSON.stringify(dry.json && { a: dry.json.added, u: dry.json.unchanged, after: dry.json.after }))
  const rosterNow = await request('GET', '/api/teacher/classes', undefined, tt)
  const clsNow = (rosterNow.json.classes || []).find((x) => x.id === classId)
  check('干跑没写盘（班里还是 3 人）', !!clsNow && (clsNow.students || []).length === 3, JSON.stringify(clsNow && clsNow.students && clsNow.students.length))

  const applied = await request('POST', '/api/teacher/classes/' + classId + '/roster/apply', {
    mode: 'replace',
    students: [{ sid: '2025010101', name: 'AAA' }, { sid: '2025010999', name: '新来的' }],
  }, tt)
  check('名单确认导入：新增 1 / 移出 2 / 班里剩 2',
    applied.status === 200 && applied.json.added === 1 && applied.json.removed === 2 && applied.json.total === 2,
    JSON.stringify(applied.json && { a: applied.json.added, r: applied.json.removed, t: applied.json.total }))

  // 复原成 3 人，后面「改名」用例还要用
  await request('POST', '/api/teacher/classes/' + classId + '/roster/apply', {
    mode: 'replace',
    students: [
      { sid: '2025010101', name: 'AAA' },
      { sid: '2025010102', name: 'BBB' },
      { sid: '2025010103', name: 'CCC' },
    ],
  }, tt)

  // 改名 + 覆盖模式下的「移出」都要能报出来
  const renameOne = await request('POST', '/api/teacher/classes/' + classId + '/roster', {
    mode: 'merge',
    students: [{ sid: '2025010101', name: 'AAA改' }],
  }, tt)
  check('名单：改名会计入 updated', renameOne.status === 200 && renameOne.json.updated === 1 && renameOne.json.added === 0,
    JSON.stringify(renameOne.json && { a: renameOne.json.added, u: renameOne.json.updated }))

  const shrink = await request('POST', '/api/teacher/classes/' + classId + '/roster', {
    mode: 'replace',
    students: [{ sid: '2025010101', name: 'AAA改' }],
  }, tt)
  check('名单：覆盖模式报出移出人数（其余记录保留）',
    shrink.status === 200 && shrink.json.removed === 2 && shrink.json.total === 1,
    JSON.stringify(shrink.json && { r: shrink.json.removed, t: shrink.json.total }))

  /* ---- 直接传表格文件（服务端用 exceljs 解析 xlsx / 按分隔符解析 csv） ---- */
  const xlsxBuf = await (async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('名单')
    ws.addRow(['序号', '学号', '姓名', '性别', '备注'])
    ws.addRow([1, '2025030101', '甲甲', '男', ''])
    ws.addRow([2, 2025030102, '乙乙', '女', '班长']) // 数字型学号也要认
    ws.addRow([3, '2025030103', '', '男', '']) // 姓名空 → 报问题
    ws.addRow([4, '2025030101', '重复', '女', '']) // 同学号 → 报重复
    return Buffer.from(await wb.xlsx.writeBuffer())
  })()

  const sheetDry = await requestBinary('POST', '/api/teacher/classes/' + classId + '/roster/sheet?mode=merge', xlsxBuf, tt)
  check('表格干跑：xlsx 解析出 2 人 + 2 条问题（姓名空 / 同学号重复）',
    sheetDry.status === 200 && sheetDry.json.parsed === 2 && (sheetDry.json.issues || []).length === 2 &&
      sheetDry.json.issues.map((i) => i.line).join(',') === '4,5',
    'status=' + sheetDry.status + ' ' + JSON.stringify(sheetDry.json && { p: sheetDry.json.parsed, i: sheetDry.json.issues }))

  const sheetApply = await requestBinary('POST', '/api/teacher/classes/' + classId + '/roster/sheet?mode=merge&apply=1', xlsxBuf, tt)
  check('表格导入：真的写进名单（班里 1 → 3 人）',
    sheetApply.status === 200 && sheetApply.json.added === 2 && sheetApply.json.total === 3,
    JSON.stringify(sheetApply.json && { a: sheetApply.json.added, t: sheetApply.json.total }))

  const csvBuf = Buffer.from('学号,姓名\n2025030199,丙丙\n', 'utf8')
  const csvDry = await requestBinary('POST', '/api/teacher/classes/' + classId + '/roster/sheet?mode=replace', csvBuf, tt)
  check('表格干跑：csv 覆盖模式报出新增 1 / 移出 3',
    csvDry.status === 200 && csvDry.json.parsed === 1 && csvDry.json.added === 1 && csvDry.json.removed === 3,
    JSON.stringify(csvDry.json && { p: csvDry.json.parsed, a: csvDry.json.added, r: csvDry.json.removed }))

  const junk = await requestBinary('POST', '/api/teacher/classes/' + classId + '/roster/sheet?mode=merge', Buffer.from('hello', 'utf8'), tt)
  check('表格干跑：认不出学号/姓名 → 400 带说明', junk.status === 400, 'status=' + junk.status)

  // 复原成 4 人，后面的用例还要用
  const restore = await request('POST', '/api/teacher/classes/' + classId + '/roster', {
    mode: 'replace',
    students: [
      { sid: '2025010101', name: 'AAA' },
      { sid: '2025010102', name: 'BBB' },
      { sid: '2025010103', name: 'CCC' },
      { sid: '2025010104', name: 'DDD' },
    ],
  }, tt)
  check('名单复原成 4 人', restore.status === 200 && restore.json.total === 4, JSON.stringify(restore.json && restore.json.total))

  // 名单直接改（班级管理页的「添加 / 编辑 / 删除」）
  const addOne = await request('POST', '/api/teacher/classes/' + classId + '/roster', {
    mode: 'merge',
    students: [{ sid: '2025010104', name: 'DDD' }],
  }, tt)
  check('add a single student', addOne.status === 200 && addOne.json.total === 4, JSON.stringify(addOne.json.total))

  const edited = await request('PATCH', '/api/teacher/classes/' + classId + '/students/2025010104', {
    sid: '2025010105',
    name: 'DDD2',
  }, tt)
  check('edit student (no records yet -> sid may change)',
    edited.status === 200 && edited.json.student.sid === '2025010105' && edited.json.student.name === 'DDD2',
    JSON.stringify(edited.json && edited.json.student))

  const dup = await request('PATCH', '/api/teacher/classes/' + classId + '/students/2025010105', {
    sid: '2025010101',
  }, tt)
  check('edit student refuses a duplicate sid', dup.status === 409, 'status=' + dup.status)

  const removed = await request('DELETE', '/api/teacher/classes/' + classId + '/students/2025010105', undefined, tt)
  check('remove student from roster', removed.status === 200 && (removed.json.students || []).length === 3,
    JSON.stringify((removed.json.students || []).length))

  // 每个学生一进名单就该有自己的目录骨架
  const stuLib = require('./lib/students')
  const stuDir = stuLib.dirOf(classId, '2025010101')
  const subs = ['作业', '大作业', '机试', '记分'].filter((k) => fs.existsSync(path.join(stuDir, k)))
  check('per-student dir scaffold created on import', subs.length === 4, 'found=' + subs.join(','))

  const sid = '2025010101'
  const events = [
    { item: 'attend', delta: -2, kind: '缺勤', reason: 'selftest absent' },
    { item: 'interact', delta: 2, reason: 'selftest answer' },
    { item: 'homework', grade: 'A', late: false, reason: 'selftest hw' },
    { item: 'exam', raw: 88, reason: 'selftest exam' },
    { item: 'project', dims: { func: 12, code: 9, ui: 6, doc: 3 }, reason: 'selftest project' },
  ].filter((e) => liveItems.some((i) => i.key === e.item))
  // 加分项如果还在方案里，就再记一条（老师删掉了就不造）
  if (hasBonus) events.push({ item: 'bonus', delta: 5, reason: 'selftest bonus' })
  let lastStatus = 0
  for (const e of events) {
    const res = await request('POST', '/api/teacher/classes/' + classId + '/events', Object.assign({ sid }, e), tt)
    lastStatus = res.status
  }
  check('add 6 scoring events', lastStatus === 200)

  // 已经有记录的学生：姓名能改，学号不能改（否则记分事件与目录对不上）
  const renameWithRecords = await request('PATCH', '/api/teacher/classes/' + classId + '/students/' + sid, {
    sid: '2025010199',
  }, tt)
  check('edit student refuses sid change once records exist', renameWithRecords.status === 400,
    'status=' + renameWithRecords.status)
  const renameOnly = await request('PATCH', '/api/teacher/classes/' + classId + '/students/' + sid, {
    name: 'AAA2',
  }, tt)
  check('edit student still allows renaming with records', renameOnly.status === 200 && renameOnly.json.student.name === 'AAA2',
    JSON.stringify(renameOnly.json && renameOnly.json.student))
  // 名字改回去，后面的断言还用 AAA
  await request('PATCH', '/api/teacher/classes/' + classId + '/students/' + sid, { name: 'AAA' }, tt)

  const sheet = path.join(stuDir, '记分', '总评.csv')
  check('score sheet written into the student dir', fs.existsSync(sheet), sheet)

  // 每条账都带「记这笔时用的是哪一版方案」，溯源用
  const withVer = await request('GET', '/api/teacher/classes/' + classId + '/scores', undefined, tt)
  const schemeVer = String(require('./lib/scheme').version())
  check('events carry schemeVersion',
    (withVer.json.events || []).length > 0 && withVer.json.events.every((e) => e.schemeVersion === schemeVer),
    'ver=' + schemeVer + ' first=' + JSON.stringify((withVer.json.events || [])[0] && withVer.json.events[0].schemeVersion))

  const noReason = await request('POST', '/api/teacher/classes/' + classId + '/events',
    { sid, item: 'interact', delta: 1 }, tt)
  check('event without reason -> 400', noReason.status === 400)

  // 出勤是 0 分但要留痕：带类型时允许 0；互动那种没类型的 0 分要挡掉
  const present = await request('POST', '/api/teacher/classes/' + classId + '/events',
    { sid, item: 'attend', delta: 0, kind: '出勤', reason: 'selftest present' }, tt)
  check('attend 0 with kind accepted', present.status === 200)
  const zeroInteract = await request('POST', '/api/teacher/classes/' + classId + '/events',
    { sid, item: 'interact', delta: 0, reason: 'selftest zero' }, tt)
  check('interact 0 without kind -> 400', zeroInteract.status === 400)

  const scores = await request('GET', '/api/teacher/classes/' + classId + '/scores', undefined, tt)
  const row = scores.json && scores.json.board.list.find((r) => r.student.sid === sid)
  const got = {}
  if (row) for (const r of row.rows) got[r.item.key] = r.score
  // 期望值**从当前方案算**（分值、扣分、等级系数都是老师可配的，写死数字会让自检跟着挂）
  const scLib = require('./lib/scheme')
  // 服务器按「当前课程」激活方案；自检进程里也要激活同一份，
  // 否则「按方案算期望值」会拿默认方案去比，数字对不上。
  {
    const cur = await request('GET', '/api/teacher/courses', undefined, tt)
    const first = ((cur.json && cur.json.courses) || [])[0]
    if (first && first.schemeId) scLib.activate(first.schemeId)
  }
  const n1 = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v) || 0)
  const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const r1 = (v) => Math.round(v * 10) / 10
  const it = (k) => scLib.itemByKey(k)
  const pr = (k) => (it(k).rule.params || {})

  const attItem = it('attend')
  const expAttend = r1(
    clampN(n1(pr('attend').start, attItem.full) - n1(pr('attend').perAbsent, 2), n1(pr('attend').floor, 0), attItem.full)
  )
  const hwItem = it('homework')
  const expHomework = r1(hwItem.full * 1) // 只有一条 A（系数 1）
  const examItem = it('exam')
  const expExam = r1(clampN(88 * n1(pr('exam').factor, 0.3), 0, examItem.full))
  const projItem = it('project')
  const expProject = r1(projItem.dims.reduce((s2, d) => s2 + Math.min(d.full, { func: 12, code: 9, ui: 6, doc: 3 }[d.key] || 0), 0))
  const expTotal = r1(expAttend + 2 + expHomework + expExam + expProject + (hasBonus ? 5 : 0))

  check('attend = start - perAbsent（按当前方案）', got.attend === expAttend, 'got ' + got.attend + ' exp ' + expAttend)
  check('interact = 2', got.interact === 2, 'got ' + got.interact)
  check('homework = full × A 系数', got.homework === expHomework, 'got ' + got.homework + ' exp ' + expHomework)
  check('exam = 卷面 × 系数', got.exam === expExam, 'got ' + got.exam + ' exp ' + expExam)
  check('project = 量规合计', got.project === expProject, 'got ' + got.project + ' exp ' + expProject)
  check('total = 各项之和（含加分）', row && row.total === expTotal, 'got ' + (row && row.total) + ' exp ' + expTotal)

  // 撤销一条，总分应减去那条互动的分
  const firstEvent = scores.json.events.find((e) => e.sid === sid && e.item === 'interact')
  const voided = await request('POST', '/api/teacher/classes/' + classId + '/events/' + firstEvent.id + '/void', {}, tt)
  check('void event ok', voided.status === 200)
  const after = await request('GET', '/api/teacher/classes/' + classId + '/scores', undefined, tt)
  const row2 = after.json.board.list.find((r) => r.student.sid === sid)
  const expTotal2 = r1(expTotal - 2)
  check('total after void = 撤掉那条互动', row2.total === expTotal2, 'got ' + row2.total + ' exp ' + expTotal2)

  const stuBad = await request('POST', '/api/login/student', { classId, sid, name: 'WRONG' })
  check('student wrong name -> 401', stuBad.status === 401)

  const stu = await request('POST', '/api/login/student', { classId, sid, name: 'AAA' })
  check('student login ok', stu.status === 200 && stu.json.token)
  if (!stu.json || !stu.json.token) return
  const st = stu.json.token

  // 刷新后学生端靠 /api/me 恢复身份，课程名必须也在里面（否则头部会显示「未选课程」）
  const me = await request('GET', '/api/me', undefined, st)
  if (NO_CONTENT) {
    skip('GET /api/me gives the student the course name', '没有课程内容')
  } else {
    check('GET /api/me gives the student the course name',
      me.status === 200 && !!me.json.student && !!me.json.student.courseId && !!me.json.student.courseName,
      JSON.stringify(me.json && me.json.student && me.json.student.courseName))
  }

  const mine = await request('GET', '/api/student/score', undefined, st)
  // 期望总分来自上一段按当前方案算出的值（方案改了也不挂）
  check('student reads own score', mine.status === 200 && mine.json.total === expTotal2,
    'total=' + (mine.json && mine.json.total) + ' exp ' + expTotal2)
  check('student score rows match the scheme',
    !!(mine.json && mine.json.rows && mine.json.rows.length === liveItems.length),
    'rows=' + (mine.json && mine.json.rows ? mine.json.rows.length : '?') + ' items=' + liveItems.length)

  const writeAsStudent = await request('POST', '/api/teacher/classes/' + classId + '/events',
    { sid, item: 'interact', delta: 1, reason: 'should fail' }, st)
  check('student cannot write scores -> 403', writeAsStudent.status === 403)

  const otherScore = await request('GET', '/api/student/score?sid=2025010102', undefined, st)
  check('student cannot read others by param', otherScore.status === 200 && otherScore.json.student.sid === sid)

  const lectureAsStudent = await request('GET', '/api/content/doc?type=lecture&id=4', undefined, st)
  check('student cannot read lecture -> 403', lectureAsStudent.status === 403)

  const materials = await request('GET', '/api/content/doc?type=materials&id=4', undefined, st)
  if (NO_CONTENT) {
    skip('student can read materials', '没有课程内容')
  } else {
    check('student can read materials', materials.status === 200 && materials.json.markdown.length > 500,
      'status=' + materials.status + ' len=' + ((materials.json && materials.json.markdown) || '').length)
  }

  // 教学公开：游客也能拿到课程名与课次清单（不含班级、不含名单、不含讲义）
  const pub = await request('GET', '/api/public/course')
  check('游客能拿到课程名与课次清单',
    pub.status === 200 && !!(pub.json && pub.json.course && pub.json.course.name) &&
      Array.isArray(pub.json.lessons) && pub.json.lessons.length > 0,
    'status=' + pub.status + ' lessons=' + ((pub.json && pub.json.lessons && pub.json.lessons.length) || 0))
  check('游客拿到的清单里没有班级信息',
    !!(pub.json && pub.json.course) && !('classes' in (pub.json || {})) && !('students' in (pub.json || {})),
    JSON.stringify(Object.keys(pub.json || {})))
  check('公开课程信息可缓存',
    /public/.test(String((pub.headers || {})['cache-control'] || '')),
    'cc=' + ((pub.headers || {})['cache-control'] || '(无)'))

  // 教学公开：课程材料（学生讲义）不需要登录；讲义（教师讲稿）仍然只有教师能看
  const matGuest = await request('GET', '/api/content/doc?type=materials&id=4')
  check('未登录也能读课程材料（教学公开）',
    matGuest.status === 200 && !!(matGuest.json && matGuest.json.markdown),
    'status=' + matGuest.status)
  check('课程材料是公开可缓存的（public, max-age）',
    /public/.test(String((matGuest.headers || {})['cache-control'] || '')),
    'cc=' + ((matGuest.headers || {})['cache-control'] || '(无)'))
  const lecGuest = await request('GET', '/api/content/doc?type=lecture&id=4')
  check('未登录读讲义 -> 403', lecGuest.status === 403, 'status=' + lecGuest.status)
  const lecTeacher = await request('GET', '/api/content/doc?type=lecture&id=4', undefined, tt)
  check('讲义明确不许缓存（private, no-store）',
    /no-store/.test(String((lecTeacher.headers || {})['cache-control'] || '')),
    'cc=' + ((lecTeacher.headers || {})['cache-control'] || '(无)'))

  const lecture = await request('GET', '/api/content/doc?type=lecture&id=4', undefined, tt)
  if (NO_CONTENT) {
    skip('teacher can read lecture', '没有课程内容')
  } else {
    check('teacher can read lecture', lecture.status === 200 && lecture.json.markdown.indexOf('🎤') >= 0)
  }

  // 示例运行时库要能按相对路径取到（<script src="../vue.global.js">）
  // —— 容器里没有「课程目录旁边的 代码示例/」，只能从课程内容根取；之前这里 404，
  //    页面就报「资源加载失败：<script> …/examples/vue.global.js」
  // 当前课程（服务器按它激活方案、按它取内容）；没有课程时相关用例跳过
  const coursesNow = await request('GET', '/api/teacher/courses', undefined, tt)
  const currentCourse = ((coursesNow.json && coursesNow.json.courses) || [])[0] || null
  const courseDir = currentCourse
    ? path.join(require('./config').dataDir, 'courses', currentCourse.id, 'content', '代码示例')
    : ''
  {
    const runtime = path.join(courseDir, 'vue.global.js')
    if (currentCourse && fs.existsSync(runtime)) {
      const lib = await request('GET', '/examples/vue.global.js')
      check('示例运行时库能按相对路径取到（/examples/vue.global.js）', lib.status === 200, 'status=' + lib.status)
      const boot = await request('GET', '/examples/playground/sfc-boot.js')
      check('示例的 sfc-boot.js 也取得到', boot.status === 200, 'status=' + boot.status)
    } else {
      console.log('  · 这门课没有示例运行时库（vue.global.js），跳过该用例')
    }
  }

  // 讲义里的图片（../assets/…）要能真的打开：地址改写 + 只开放 assets 目录
  // 哪一课带图片不一定（第 01 课有 logo），扫前几课找一篇带 img 的
  let assetRef = null
  const lessonList = await request('GET', '/api/content/lessons', undefined, tt)
  const ids = ((lessonList.json && lessonList.json.lessons) || []).slice(0, 5).map((x) => x.id)
  for (const lid of ids) {
    const one = await request('GET', '/api/content/doc?type=lecture&id=' + encodeURIComponent(lid), undefined, tt)
    const hit = ((one.json && one.json.markdown) || '').match(/<img[^>]+src="(\/api\/content\/asset[^"]+)"/)
    if (hit) {
      assetRef = hit
      break
    }
  }
  if (assetRef) {
    const img = await request('GET', assetRef[1])
    check('讲义图片地址已改写且能取到（svg）',
      img.status === 200 && /image\//.test(String(img.headers && img.headers['content-type'])),
      'status=' + img.status)
    if (currentCourse) {
      const bad = await request('GET', '/api/content/asset?course=' + encodeURIComponent(currentCourse.id) + '&path=lecture%2F00-%E8%AF%BE%E7%A8%8B%E5%B0%81%E9%9D%A2.md')
      check('课程图片接口只放 assets 目录（其它路径 -> 400）', bad.status === 400, 'status=' + bad.status)
    } else {
      skip('课程图片接口只放 assets 目录', '还没有课程')
    }
  } else {
    console.log('  · 这门课还没有 assets 图片，跳过图片用例')
  }

  const draw = await request('POST', '/api/teacher/classes/' + classId + '/rollcall/draw', { count: 2, exclude: true }, tt)
  check('rollcall draw 2', draw.status === 200 && draw.json.drawn.length === 2)
  const draw2 = await request('POST', '/api/teacher/classes/' + classId + '/rollcall/draw', { count: 2, exclude: true }, tt)
  check('rollcall no-repeat hits pool limit', draw2.status === 400 || (draw2.json && draw2.json.drawn.length === 1),
    'status=' + draw2.status)
  const reset = await request('POST', '/api/teacher/classes/' + classId + '/rollcall/reset', {}, tt)
  check('rollcall reset', reset.status === 200 && reset.json.round >= 2)

  // 在场：学生登录后打心跳 → 教师端看得到；报离 → 立刻消失
  await request('POST', '/api/presence/ping', {}, st)
  const pres1 = await request('GET', '/api/teacher/classes/' + classId + '/presence', undefined, tt)
  check('presence: logged-in student is online',
    pres1.status === 200 && pres1.json.onlineCount === 1 && pres1.json.online[0].sid === sid,
    JSON.stringify(pres1.json && pres1.json.onlineCount))

  await request('POST', '/api/presence/leave', {}, st)
  const pres2 = await request('GET', '/api/teacher/classes/' + classId + '/presence', undefined, tt)
  check('presence: leave -> offline', pres2.json.onlineCount === 0, 'online=' + pres2.json.onlineCount)

  // WS 在场通道：浏览器被强杀 / 断网时靠它下线（pagehide 不会触发）
  // 断线后有 5 秒缓冲给自动重连，所以这里等 6.5 秒再断言
  const pws = await wsConnect('presence')
  pws.sendText({ t: 'auth', token: st })
  await sleep(400)
  const pres3 = await request('GET', '/api/teacher/classes/' + classId + '/presence', undefined, tt)
  check('presence: ws auth marks online', pres3.json.onlineCount === 1, 'online=' + pres3.json.onlineCount)

  pws.socket.destroy()
  await sleep(6500)
  const pres4 = await request('GET', '/api/teacher/classes/' + classId + '/presence', undefined, tt)
  check('presence: ws drop -> offline within grace', pres4.json.onlineCount === 0, 'online=' + pres4.json.onlineCount)

  // 投屏在线：只有真正在收画面（mode=watch）才算「在看」
  const castUrl = '/api/teacher/classes/' + classId + '/presence'
  const viewer = await wsConnect('student')
  viewer.sendText({ t: 'hello', token: st })
  await sleep(300)

  let casting = await request('GET', castUrl, undefined, tt)
  check('cast presence: idle -> not counted', casting.json.castingCount === 0, 'count=' + casting.json.castingCount)

  // 教师端如果正开着浏览器页面，它会每 2 秒重连控制器、把模式刷回 idle。
  // 所以这里多试几次，并记录「是不是被别的控制器抢走了」。
  let watched = false
  let stolen = false
  for (let i = 0; i < 8 && !watched; i++) {
    const c = await wsConnect('ctl')
    c.sendText({ t: 'hello', token: tt })
    await sleep(150)
    c.sendText({ t: 'mode', mode: 'watch' })
    await sleep(250)
    const r = await request('GET', castUrl, undefined, tt)
    watched = r.json.castingCount === 1 && r.json.casting[0].sid === sid
    if (!watched && c.closed) stolen = true
    c.close()
    if (!watched) await sleep(120)
  }
  check('cast presence: watching -> counted', watched, stolen ? 'another controller kept taking over' : '')

  viewer.socket.destroy()
  await sleep(700)
  casting = await request('GET', castUrl, undefined, tt)
  check('cast presence: viewer closed -> 0', casting.json.castingCount === 0, 'count=' + casting.json.castingCount)

  // 讲义跟随：教师推节点，学生端读当前节点
  const followByStudent = await request('POST', '/api/teacher/follow', { lessonId: '8', anchor: 'x' }, st)
  check('follow: student cannot push -> 403', followByStudent.status === 403)

  const pushed = await request('POST', '/api/teacher/follow',
    { lessonId: '8', anchor: 'test-anchor', sectionTitle: '测试小节' }, tt)
  check('follow: teacher push ok', pushed.status === 200 && pushed.json.follow.anchor === 'test-anchor')

  const cur = await request('GET', '/api/follow', undefined, st)
  check('follow: student reads current', cur.status === 200 && cur.json.lessonId === '8' && cur.json.anchor === 'test-anchor',
    JSON.stringify(cur.json))

  const examples = await request('GET', '/api/examples', undefined, tt)
  if (NO_CONTENT) {
    skip('examples list', '没有课程内容')
  } else {
    check('examples list', examples.status === 200 && examples.json.lessons.length > 5,
      'len=' + (examples.json && examples.json.lessons && examples.json.lessons.length))
  }

  if (NO_CONTENT) {
    // 没有课程内容就没有示例目录，后面那几段（示例 bundle / 作业起手代码）整块跳过。
    // 令牌照常带回去 —— 投屏那组用例不依赖课程内容。
    console.log('  · 跳过示例与作业相关的用例（没有课程内容）')
    return { classId, sid, teacherToken: tt, studentToken: st }
  }
  const bundle = await request('GET', '/api/examples/' + encodeURIComponent(examples.json.lessons[0].dir), undefined, tt)
  check('example bundle has files', bundle.status === 200 && bundle.json.files.length > 0)

  const csv = await request('GET', '/api/teacher/classes/' + classId + '/export?kind=total', undefined, tt)
  check('export csv', csv.status === 200 && csv.text.indexOf('学号') >= 0)

  await testAssignments(tt, st, classId, sid, examples.json.lessons[0].dir)
  await testProjects(tt, st, classId, sid)
  await testCourses(tt)
  await testSchemeIO(tt)
  await testExamPaper(tt, st, classId, sid)
  await testAttendance(tt, classId)
  await testScheme(tt, classId)
  await testExam(tt, st, classId, sid)

  const cleanup = await request('DELETE', '/api/teacher/classes/' + classId, undefined, tt)
  check('delete class', cleanup.status === 200)

  // 投屏中继那一段要用学生令牌（观看投屏现在必须登录）与教师令牌（控制台认身份，不认 IP）
  return { studentToken: st, sid, teacherToken: tt }
}

async function testCast(ctx) {
  console.log('\n[B] screen-cast relay (WebSocket)')
  const stuToken = ctx.studentToken
  const teaToken = ctx.teacherToken

  // 控制器不再靠「来自本机」认人：不带令牌不许进（否则同网段谁都能抢投屏）
  const anonCtl = await wsConnect('ctl')
  anonCtl.sendText({ t: 'hello' })
  await sleep(300)
  check('controller without token rejected', anonCtl.closed === true)
  anonCtl.close()

  const ctl = await wsConnect('ctl')
  ctl.sendText({ t: 'hello', token: teaToken })
  const peers0 = await expectMessage(ctl, (m) => m.text && JSON.parse(m.text).t === 'peers', 'peers')
  check('controller hello + teacher token -> peers', !!peers0)
  // 基线：别人（比如老师自己开着的学生端页面）可能已经在线，后面断言「回到基线」而不是绝对 0
  const basePeers = peers0 ? JSON.parse(peers0.text).students || 0 : 0

  // 没带令牌的观看连接必须被拒绝
  const anon = await wsConnect('student')
  anon.sendText({ t: 'hello' })
  await sleep(300)
  check('anonymous viewer rejected', anon.closed === true)
  anon.close()

  const stu = await wsConnect('student')
  stu.sendText({ t: 'hello', token: stuToken })
  const modeMsg = await expectMessage(stu, (m) => m.text && JSON.parse(m.text).t === 'mode', 'mode')
  check('new student gets remembered mode', !!modeMsg)

  const peers1 = await expectMessage(ctl, (m) => {
    if (!m.text) return false
    const j = JSON.parse(m.text)
    return j.t === 'peers' && j.students === 1
  }, 'peers=1')
  check('controller sees peers=1', !!peers1)

  ctl.sendText({ t: 'mode', mode: 'watch' })
  const watch = await expectMessage(stu, (m) => m.text && JSON.parse(m.text).t === 'mode' && JSON.parse(m.text).mode === 'watch')
  check('mode watch broadcast to student', !!watch)

  // 单片二进制转发
  const small = crypto.randomBytes(4096)
  ctl.sendBinary(small, true)
  const got1 = await stu.next(1500)
  check('binary frame forwarded byte-exact', !!(got1 && got1.binary && got1.binary.equals(small)),
    got1 && got1.binary ? 'len=' + got1.binary.length : 'no frame')

  // 分片消息（FIN=0 + 续帧）：老方案在这里把半张画面当完整帧，导致全班黑屏
  const part1 = crypto.randomBytes(60000)
  const part2 = crypto.randomBytes(40000)
  ctl.sendBinary(part1, false)
  ctl.sendCont(part2, true)
  const got2 = await stu.next(2000)
  const merged = got2 && got2.binary
  check('fragmented message reassembled (100000B)', !!(merged && merged.length === 100000),
    merged ? 'len=' + merged.length : 'no frame')
  check('fragmented payload intact', !!(merged && merged.slice(0, 60000).equals(part1) && merged.slice(60000).equals(part2)))

  // 开播状态要传得到学生端 SPA（学生靠它自动打开投屏页，开不了就挂「老师开始投屏了」横幅）。
  // 三条路都得通：在场通道实时推、刚连上时补发、心跳接口兜底（WS 被代理掐掉时只剩这条）。
  const spa = await wsConnect('presence')
  spa.sendText({ t: 'auth', token: stuToken })
  const spaOk = await expectMessage(spa, (m) => m.text && JSON.parse(m.text).t === 'auth-ok', 'auth-ok')
  const spaCast = await expectMessage(spa, (m) => m.text && JSON.parse(m.text).t === 'cast', 'cast')
  check('spa channel gets current cast mode on connect',
    !!(spaOk && spaCast && JSON.parse(spaCast.text).mode === 'watch'),
    spaCast ? spaCast.text : 'no cast msg')

  const pingWatch = await request('POST', '/api/presence/ping', {}, stuToken)
  check('presence ping carries cast mode', !!(pingWatch.json && pingWatch.json.cast === 'watch'),
    JSON.stringify(pingWatch.json))

  ctl.sendText({ t: 'mode', mode: 'idle' })
  const spaIdle = await expectMessage(spa,
    (m) => m.text && JSON.parse(m.text).t === 'cast' && JSON.parse(m.text).mode === 'idle', 'cast idle')
  check('stop casting pushed to spa channel', !!spaIdle)

  const pingIdle = await request('POST', '/api/presence/ping', {}, stuToken)
  check('presence ping reflects idle after stop', !!(pingIdle.json && pingIdle.json.cast === 'idle'),
    JSON.stringify(pingIdle.json))

  spa.close()
  await sleep(200)

  stu.close()
  await sleep(300)
  const peersBack = await expectMessage(ctl, (m) => {
    if (!m.text) return false
    const j = JSON.parse(m.text)
    return j.t === 'peers' && j.students === basePeers
  }, 'peers back to baseline')
  check('student disconnect -> peers 回到基线（不受别人在线影响）', !!peersBack)

  ctl.close()

  // 未定义的 role 一律关连接（ctl 的令牌校验上面已单独验过）
  const bad = await wsConnect('guest')
  await new Promise((r) => setTimeout(r, 200))
  check('unknown role is closed', bad.closed === true)
  bad.close()

  // 局域网代理：N 个学生的观看合成一条上行连接（公网上行/下行都只 1 份），
  // 但服务端必须照样知道「谁在看投屏」—— 上游 hello 里带一份名单（for）。
  {
    // 局域网代理：N 个学生的观看合成一条上行连接（公网上行/下行都只 1 份），
    // 但服务端必须照样知道「谁在看投屏」—— 上游 hello 里带一份名单（for）。
    //
    // 注意：自检是**另一个进程**（连的是已运行的服务），所以只能通过 HTTP 接口看结果，
    // 不能直接读服务端的 presence 模块。
    const cls0 = await request('GET', '/api/teacher/classes', undefined, teaToken)
    const c0 = cls0.json.classes[0]
    const two = c0.students.slice(0, 2)
    check('proxy roster: class has students to test', two.length >= 2, '班级人数=' + two.length)

    // 开播（服务端只在 mode=watch 时登记「谁在看投屏」）
    const opener = await wsConnect('ctl')
    opener.sendText({ t: 'hello', token: teaToken })
    await sleep(200)
    opener.sendText({ t: 'mode', mode: 'watch' })
    await sleep(300)

    const proxyConn = await wsConnect('student')
    proxyConn.sendText({ t: 'hello', token: stuToken, cid: 'cs', for: two.map((x) => ({
      classId: c0.id, sid: x.sid, name: x.name || '',
    })) })
    await sleep(500)
    const cast1 = await request('GET', '/api/teacher/classes/' + c0.id + '/presence', undefined, teaToken)
    const casting1 = (cast1.json.casting || []).map((x) => x.sid)
    check('proxy roster: one connection can represent many watchers',
      two.every((x) => casting1.includes(x.sid)),
      'casting=' + casting1.join(',') + ' 期望含 ' + two.map((x) => x.sid).join(','))

    // 代理那边「没人看了」→ 空名单 → 服务端不能留下幽灵观众
    proxyConn.sendText({ t: 'hello', token: stuToken, cid: 'cs', for: [] })
    await sleep(500)
    const cast2 = await request('GET', '/api/teacher/classes/' + c0.id + '/presence', undefined, teaToken)
    const casting2 = (cast2.json.casting || []).map((x) => x.sid)
    check('proxy roster: empty roster leaves nobody behind',
      !two.some((x) => casting2.includes(x.sid)),
      'casting=' + casting2.join(','))

    proxyConn.close()
    opener.close()
    await sleep(400)
    const cast3 = await request('GET', '/api/teacher/classes/' + c0.id + '/presence', undefined, teaToken)
    const casting3 = (cast3.json.casting || []).map((x) => x.sid)
    check('proxy roster: closed connection drops its roster',
      !two.some((x) => casting3.includes(x.sid)),
      'casting=' + casting3.join(','))
  }

  // 边缘端快照：代理把本地 N 个学生的状态打包成**一次**请求发上来，
  // 服务端按**令牌**认人（客户端说了不算）—— 这样既省流又伪造不了。
  {
    const cls1 = await request('GET', '/api/teacher/classes', undefined, teaToken)
    const c1 = cls1.json.classes[0]
    const one = c1.students[0]
    const snap = await request('POST', '/api/presence/snapshot', {
      source: 'selftest-edge',
      students: [{ token: stuToken, online: true, casting: true }],
    }, teaToken)
    check('edge snapshot: accepted', !!(snap.json && snap.json.ok),
      'online=' + (snap.json && snap.json.online) + ' casting=' + (snap.json && snap.json.casting))
    await sleep(300)
    const pres5 = await request('GET', '/api/teacher/classes/' + c1.id + '/presence', undefined, teaToken)
    check('edge snapshot: teacher sees the online student',
      (pres5.json.online || []).length >= 1,
      'online=' + pres5.json.onlineCount + ' casting=' + pres5.json.castingCount)
    // 令牌不对的条目要被忽略（伪造不了）
    const bad = await request('POST', '/api/presence/snapshot', {
      source: 'selftest-edge-bad',
      students: [{ token: 'not-a-real-token', online: true, casting: true }],
    }, teaToken)
    check('edge snapshot: forged token ignored', bad.json.online === 0,
      'online=' + bad.json.online)
  }
}
  // 差量模式下，一帧「整屏」就是学生的基准画面（差量块画在它上面）。
  // 慢链路（公网隧道）上整屏帧大、差量帧小 —— 背压若一视同仁地覆盖，
  // 整屏帧会被后来的差量帧顶掉、永远发不出去 → 学生端黑屏，只有变化处有内容。
  {
    const { Conn } = require('./lib/ws')
    const written = []
    const pending = []
    const sock = {
      writable: true,
      remoteAddress: '127.0.0.1',
      write(data, cb) {
        written.push(data)
        if (cb) pending.push(cb)
        return true
      },
      on() {},
      once() {},
      removeListener() {},
      end() {},
      destroy() {},
      setNoDelay() {},
      setTimeout() {},
    }
    const req = { socket: sock, headers: {}, url: '/ws?role=student' }
    const keyFrame = (tag) => {
      const b = Buffer.alloc(16 + 400 * 1024)
      b[0] = 1
      b[1] = 1 // flags: 整屏
      b.writeUInt16LE(1, 2)
      b.writeUInt16LE(1280, 4)
      b.writeUInt16LE(720, 6)
      b[15] = tag
      return b
    }
    const tileFrame = (tag) => {
      const b = Buffer.alloc(16 + 2 * 1024)
      b[0] = 1
      b[1] = 0 // flags: 差量
      b.writeUInt16LE(2, 2)
      b[15] = tag
      return b
    }
    const kinds = () => {
      let keys = 0
      let tiles = 0
      for (const w of written) {
        let off = 2
        const l = w[1] & 0x7f
        if (l === 126) off = 4
        else if (l === 127) off = 10
        if (w[off + 1] & 1) keys++
        else tiles++
      }
      return { keys, tiles }
    }
    const drain = () => {
      let g = 0
      while (pending.length && g++ < 120) {
        const cb = pending.shift()
        if (cb) cb()
      }
    }
    // 慢链路：整屏帧正在写时，连送 5 帧差量 → 整屏帧必须还在
    const conn = new Conn(sock, req, () => {}, () => {})
    conn.sendBinaryLatest(keyFrame(1))
    for (let k = 0; k < 5; k++) conn.sendBinaryLatest(tileFrame(k + 2))
    drain()
    const kk = kinds()
    check('cast key frame survives slow link', kk.keys >= 1, '整屏帧 ' + kk.keys + ' 张 · 差量帧 ' + kk.tiles + ' 张')
    // 关键帧队列有上限，不堆积
    written.length = 0
    pending.length = 0
    const conn2 = new Conn(sock, req, () => {}, () => {})
    for (let k = 0; k < 8; k++) conn2.sendBinaryLatest(keyFrame(k))
    drain()
    const k2 = kinds()
    check('cast key frame queue is bounded', k2.keys <= 6, '写了 ' + k2.keys + ' 张整屏帧')
  }


async function testAssignments(tt, st, classId, sid, dir) {
  console.log('\n[A2] classroom assignments')
  const stuLib = require('./lib/students')
  const scLib = require('./lib/scheme')
  const r1 = (v) => Math.round(v * 10) / 10
  const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

  const made = await request('POST', '/api/teacher/assignments', { dir, title: 'selftest-hw' }, tt)
  const aid = made.json && made.json.assignment && made.json.assignment.id
  check('assignment carries the default weight 1', made.json.assignment.weight === 1,
    'weight=' + made.json.assignment.weight)
  check('create assignment', made.status === 200 && !!aid, JSON.stringify(made.json))
  if (!aid) return
  check('new assignment is closed by default', made.json.assignment.status === 'closed')

  const listClosed = await request('GET', '/api/student/assignments', undefined, st)
  const a0 = listClosed.json && listClosed.json.assignments.find((x) => x.id === aid)
  check('student sees assignment as not started', !!a0 && a0.status === 'closed')

  const early = await request('POST', '/api/student/assignments/' + aid + '/submit',
    { files: [{ path: 'index.html', text: '<h1>early</h1>' }] }, st)
  check('submit before start -> 403', early.status === 403, 'status=' + early.status)

  const started = await request('POST', '/api/teacher/assignments/' + aid + '/start', {}, tt)
  check('teacher start assignment', started.status === 200 && started.json.assignment.status === 'open')

  const evil = await request('POST', '/api/student/assignments/' + aid + '/submit',
    { files: [{ path: '../escape.js', text: 'x' }] }, st)
  check('path traversal rejected -> 400', evil.status === 400, 'status=' + evil.status)

  const empty = await request('POST', '/api/student/assignments/' + aid + '/submit', { files: [] }, st)
  check('empty submission rejected -> 400', empty.status === 400, 'status=' + empty.status)

  const sub = await request('POST', '/api/student/assignments/' + aid + '/submit',
    { files: [{ path: 'index.html', text: '<h1>selftest</h1>' }, { path: 'src/app.js', text: 'console.log(1)' }] }, st)
  check('student submit 2 files', sub.status === 200 && sub.json.submission.fileCount === 2, JSON.stringify(sub.json))
  const subId = sub.json && sub.json.submission && sub.json.submission.id
  if (!subId) return

  const detail = await request('GET', '/api/teacher/assignments/' + aid + '?classId=' + classId, undefined, tt)
  check('teacher sees 1 submission', detail.status === 200 && detail.json.submissions.length === 1,
    JSON.stringify(detail.json && detail.json.stats))
  check('teacher stats: 1 submitted / 3 roster', detail.json.stats.submittedStudents === 1 && detail.json.stats.rosterCount === 3,
    JSON.stringify(detail.json.stats))
  check('teacher stats: 2 missing', detail.json.stats.missing.length === 2)

  const peek = await request('GET', '/api/teacher/assignments/' + aid + '/submissions/' + subId, undefined, tt)
  const idx = peek.json && peek.json.files.find((f) => f.path === 'index.html')
  check('teacher reads submitted file body', !!idx && idx.text === '<h1>selftest</h1>', idx ? idx.text : 'no file')

  // 课堂作业批阅 = 判等级；分数由服务端折算并直接记进「课堂作业」项
  /* 评分证据：未给分时不许传；给分后能传、会写进该学生的 证据清单.csv；能删 */
  const evEarly = await request('POST', '/api/teacher/assignments/' + aid + '/submissions/' + subId + '/evidence',
    { name: 'x.png', dataUrl: 'data:image/png;base64,aGk=' }, tt)
  check('未给分就传证据 -> 400', evEarly.status === 400, 'status=' + evEarly.status)

  const graded = await request('POST', '/api/teacher/assignments/' + aid + '/submissions/' + subId + '/grade',
    { grade: 'A', late: false, comment: 'ok' }, tt)
  check('grade submission by letter (A -> 100)', graded.status === 200 && graded.json.submission.score === 100,
    JSON.stringify(graded.json.submission))

  const board = await request('GET', '/api/teacher/classes/' + classId + '/scores', undefined, tt)
  const hwRow = ((board.json.board.list || []).find((r) => r.student.sid === sid) || { rows: [] }).rows.find(
    (r) => r.item.key === 'homework'
  )
  const liveHw = (hwRow.events || []).filter((e) => !e.voided)
  check('grading writes a 课堂作业 score event', liveHw.length === 2 && liveHw.some((e) => e.grade === 'A'),
    'live=' + liveHw.length)

  const regraded = await request('POST', '/api/teacher/assignments/' + aid + '/submissions/' + subId + '/grade',
    { grade: 'B', late: true, comment: 'late' }, tt)
  const board2 = await request('GET', '/api/teacher/classes/' + classId + '/scores', undefined, tt)
  const hwRow2 = ((board2.json.board.list || []).find((r) => r.student.sid === sid) || { rows: [] }).rows.find(
    (r) => r.item.key === 'homework'
  )
  const liveHw2 = (hwRow2.events || []).filter((e) => !e.voided)
  // 迟交 B 的百分制分 = 100 × B 系数 × 迟交系数（等级表可配，所以按当前方案算）
  const hwP = (scLib.itemByKey('homework').rule.params || {})
  const bFactor = ((scLib.itemByKey('homework').grades || []).find((g) => g.key === 'B') || {}).factor
  const lateFactor = hwP.lateFactor === undefined ? 1 : Number(hwP.lateFactor)
  const expLateB = r1(clampN(100 * (bFactor === undefined ? 0 : bFactor) * lateFactor, 0, 100))
  check('re-grading voids the previous event (no double counting)',
    regraded.status === 200 && regraded.json.submission.score === expLateB && liveHw2.length === 2,
    'score=' + regraded.json.submission.score + ' exp=' + expLateB + ' live=' + liveHw2.length)

  const badGrade = await request('POST', '/api/teacher/assignments/' + aid + '/submissions/' + subId + '/grade',
    { grade: 'Z' }, tt)
  check('unknown grade -> 400', badGrade.status === 400, 'status=' + badGrade.status)

  const mine = await request('GET', '/api/student/assignments/' + aid, undefined, st)
  check('student sees own score (late B)', mine.status === 200 && mine.json.myLatest && mine.json.myLatest.score === expLateB,
    JSON.stringify(mine.json && mine.json.myLatest))

  const otherMine = await request('GET', '/api/student/assignments/' + aid, undefined, st)
  check('student sees only own submissions', otherMine.json.mine.length === 1 && otherMine.json.mine[0].sid === sid)

  // 批过之后不许再覆盖（否则分数会挂在一份已经不存在的提交上）
  const blocked = await request('POST', '/api/student/assignments/' + aid + '/submit',
    { files: [{ path: 'index.html', text: '<h1>blocked</h1>' }] }, st)
  check('批阅后再交 -> 403（要改得先打回）', blocked.status === 403, 'status=' + blocked.status)

  // 打回重做：分数清空、计分作废，学生就能再交
  const redo = await request('POST', '/api/teacher/assignments/' + aid + '/submissions/' + subId + '/redo', {}, tt)
  check('打回重做 -> 分数清空', redo.status === 200 && redo.json.submission.score === null,
    JSON.stringify(redo.json && redo.json.submission && redo.json.submission.score))

  // 重交 = 替换：只保留最新一次（旧的文件挪进 .trash，库里也只剩一条）
  await new Promise((r) => setTimeout(r, 20))
  const second = await request('POST', '/api/student/assignments/' + aid + '/submit',
    { files: [{ path: 'index.html', text: '<h1>v2</h1>' }] }, st)
  check('student submits again -> 200', second.status === 200 && second.json.submission.fileCount === 1,
    'status=' + second.status)
  const detail2 = await request('GET', '/api/teacher/assignments/' + aid, undefined, tt)
  const list2 = (detail2.json && detail2.json.submissions) || []
  check('re-submit replaces the old one（只保留最新）',
    list2.length === 1 && list2[0].id === second.json.submission.id,
    JSON.stringify(list2.map((x) => x.id)))
  check('旧提交记录已不在（被替换掉）', list2.every((x) => x.id !== subId), 'old=' + subId)

  // 整份提交：files 是全部，changed 只认交上来的那些路径（老师那边要能跑起来看渲染）
  const full = await request('POST', '/api/student/assignments/' + aid + '/submit', {
    files: [
      { path: 'index.html', text: '<h1>full</h1>' },
      { path: 'src/app.js', text: 'console.log(2)' },
      { path: 'style.css', text: 'body{color:red}' },
    ],
    changed: ['index.html', 'nothere.js'],
  }, st)
  check('full submit: all files kept, changed trimmed to real paths',
    full.status === 200 && full.json.submission.fileCount === 3 && full.json.submission.changedCount === 1 &&
      full.json.submission.changed[0] === 'index.html',
    JSON.stringify(full.json.submission))
  const fullRead = await request('GET', '/api/teacher/assignments/' + aid + '/submissions/' + full.json.submission.id, undefined, tt)
  const css = (fullRead.json.files || []).find((f) => f.path === 'style.css')
  check('teacher reads every file (rendering needs the whole project)',
    (fullRead.json.files || []).length === 3 && !!css && css.text === 'body{color:red}',
    JSON.stringify((fullRead.json.files || []).map((f) => f.path)))

  // 正文要落在「这个学生」的目录里：students/<班级>/<学号>/作业/<作业>/<提交>/
  const onDisk = path.join(stuLib.workDir(classId, sid, aid), full.json.submission.id)
  check('submission stored inside the student dir',
    fs.existsSync(path.join(onDisk, 'index.html')) && fs.existsSync(path.join(onDisk, 'style.css')), onDisk)

  const cleared = await request('POST', '/api/teacher/assignments/' + aid + '/submissions/' + full.json.submission.id + '/grade',
    { grade: '', comment: 'redo' }, tt)
  check('clear grade -> back to pending', cleared.status === 200 && cleared.json.submission.score === null,
    JSON.stringify(cleared.json.submission))

  // 证据挂在「这条提交的那次评分」上，所以先给这条打分
  const gradedForEv = await request('POST', '/api/teacher/assignments/' + aid + '/submissions/' + full.json.submission.id + '/grade',
    { grade: 'A' }, tt)
  const evAdd = await request('POST', '/api/teacher/assignments/' + aid + '/submissions/' + full.json.submission.id + '/evidence',
    { name: '抽查截图.png', dataUrl: 'data:image/png;base64,' + Buffer.from('png').toString('base64') }, tt)
  check('给分后传证据 -> 记在这条提交上',
    evAdd.status === 200 && (evAdd.json.submission.evidence || []).length === 1,
    JSON.stringify(evAdd.json && evAdd.json.submission && evAdd.json.submission.evidence))

  // 证据是老师侧材料：走带令牌的通道，学生拿不到
  const evUrl = ((evAdd.json.submission.evidence || [])[0] || {}).url || ''
  const evAsTeacher = await request('GET', evUrl, undefined, tt)
  check('证据下载：老师带令牌 -> 200', evAsTeacher.status === 200, 'status=' + evAsTeacher.status)
  const evAsStudent = await request('GET', evUrl, undefined, st)
  check('证据下载：学生 -> 403', evAsStudent.status === 403, 'status=' + evAsStudent.status)
  const evAsAnon = await request('GET', evUrl)
  check('证据下载：不带令牌 -> 401', evAsAnon.status === 401, 'status=' + evAsAnon.status)

  const evFile = path.join(stuLib.subOf(classId, sid, 'project'), '证据清单.csv')
  let evText = ''
  try {
    evText = fs.readFileSync(evFile, 'utf8')
  } catch (e) {
    evText = ''
  }
  check('证据清单.csv 落在学生目录里并列出文件名', evText.indexOf('抽查截图.png') >= 0, evFile)

  const evDel = await request('DELETE', '/api/teacher/assignments/' + aid + '/submissions/' + full.json.submission.id + '/evidence?name=' + encodeURIComponent('抽查截图.png'), undefined, tt)
  check('删证据 -> 清单里也没了',
    evDel.status === 200 && (evDel.json.submission.evidence || []).length === 0,
    JSON.stringify(evDel.json && evDel.json.submission && evDel.json.submission.evidence))

  const stopped = await request('POST', '/api/teacher/assignments/' + aid + '/stop', {}, tt)
  check('teacher stop assignment', stopped.status === 200 && stopped.json.assignment.status === 'closed')

  const late = await request('POST', '/api/student/assignments/' + aid + '/submit',
    { files: [{ path: 'index.html', text: 'late' }] }, st)
  check('submit after stop -> 403', late.status === 403, 'status=' + late.status)

  const delSub = await request('DELETE', '/api/teacher/assignments/' + aid + '/submissions/' + full.json.submission.id, undefined, tt)
  check('delete submission', delSub.status === 200)
  const delA = await request('DELETE', '/api/teacher/assignments/' + aid, undefined, tt)
  check('delete assignment', delA.status === 200)
  check('delete assignment also clears the folder in every student dir',
    !fs.existsSync(stuLib.workDir(classId, sid, aid)), stuLib.workDir(classId, sid, aid))
}

async function testProjects(tt, st, classId, sid) {
  console.log('\n[A3] course projects (大作业)')
  const stuLib = require('./lib/students')

  const made = await request('POST', '/api/teacher/assignments',
    { kind: 'project', title: 'selftest-project', note: 'do the thing' }, tt)
  const aid = made.json && made.json.assignment && made.json.assignment.id
  check('create project assignment (no code dir needed)', made.status === 200 && !!aid && made.json.assignment.kind === 'project',
    JSON.stringify(made.json))
  if (!aid) return
  check('new project is closed by default', made.json.assignment.status === 'closed')

  // 每个作业都挂在一个考核项上（itemKey），模块入口按它分流
  const byItem = await request('GET', '/api/teacher/assignments?itemKey=project', undefined, tt)
  check('assignments are filtered by itemKey', byItem.status === 200 && (byItem.json.assignments || []).every((x) => x.itemKey === 'project'),
    JSON.stringify((byItem.json.assignments || []).map((x) => x.itemKey)))

  const listP = await request('GET', '/api/student/assignments?kind=project', undefined, st)
  check('student project list contains it', (listP.json.assignments || []).some((x) => x.id === aid))
  const listW = await request('GET', '/api/student/assignments?kind=work', undefined, st)
  check('project is not mixed into classroom assignments', !(listW.json.assignments || []).some((x) => x.id === aid))

  const early = await request('POST', '/api/student/projects/' + aid + '/submit', { note: 'too early' }, st)
  check('project submit before start -> 403', early.status === 403, 'status=' + early.status)

  await request('POST', '/api/teacher/assignments/' + aid + '/start', {}, tt)

  const wrong = await request('POST', '/api/student/assignments/' + aid + '/submit',
    { files: [{ path: 'index.html', text: 'x' }] }, st)
  check('classroom submit on a project -> 400', wrong.status === 400, 'status=' + wrong.status)

  const empty = await request('POST', '/api/student/projects/' + aid + '/submit', {}, st)
  check('empty project submit -> 400', empty.status === 400, 'status=' + empty.status)

  const body = 'hello project from selftest'
  const sub = await request('POST', '/api/student/projects/' + aid + '/submit', {
    note: '我的项目说明',
    url: 'https://example.com/p',
    files: [{ name: '源码说明.md', dataUrl: 'data:text/markdown;base64,' + Buffer.from(body, 'utf8').toString('base64') }],
  }, st)
  check('project submit note + url + attachment',
    sub.status === 200 && sub.json.submission.fileCount === 1 && sub.json.submission.note === '我的项目说明' &&
      sub.json.submission.url === 'https://example.com/p',
    JSON.stringify(sub.json.submission))
  const subId = sub.json && sub.json.submission && sub.json.submission.id
  if (!subId) return

  // 附件要落在「这个学生」的大作业目录里
  const dir = path.join(stuLib.subOf(classId, sid, 'project'), aid, subId)
  check('attachment stored in the student project dir',
    fs.existsSync(path.join(dir, '源码说明.md')), dir)

  const dl = await request('GET', '/api/files/project/' + aid + '/' + subId + '/' + encodeURIComponent('源码说明.md'), undefined, tt)
  check('teacher can download the attachment', dl.status === 200 && dl.text === body, 'status=' + dl.status + ' len=' + dl.text.length)

  const login2 = await request('POST', '/api/login/student', { classId, sid: '2025010102', name: 'BBB' })
  const st2 = login2.json && login2.json.token
  const steal = await request('GET', '/api/files/project/' + aid + '/' + subId + '/' + encodeURIComponent('源码说明.md'), undefined, st2)
  check('another student cannot download it -> 403', steal.status === 403, 'status=' + steal.status)

  const detail = await request('GET', '/api/teacher/assignments/' + aid + '?classId=' + classId, undefined, tt)
  check('teacher sees the project submission', detail.status === 200 && detail.json.submissions.length === 1,
    JSON.stringify(detail.json && detail.json.stats))

  const graded = await request('POST', '/api/teacher/assignments/' + aid + '/submissions/' + subId + '/grade',
    { dims: { func: 12, code: 9, ui: 6, doc: 0 }, comment: '结构清楚' }, tt)
  check('grade project by rubric (12+9+6+0 = 27)', graded.status === 200 && graded.json.submission.score === 27)

  const delA = await request('DELETE', '/api/teacher/assignments/' + aid, undefined, tt)
  check('delete project assignment', delA.status === 200)
  check('delete project also clears every student project dir',
    !fs.existsSync(path.join(stuLib.subOf(classId, sid, 'project'), aid)), dir)
}

async function testCourses(tt) {
  console.log('\n[A4] courses (课程 / 课程包 zip)')

  /* 手搓一个课程包 zip：课程信息 + 方案 + 两个班 + 两个内容文件 */
  const mkPack = (opt) => {
    const o = opt || {}
    const files = {
      'lecture/第01课-测试.md': Buffer.from('# 讲义\n', 'utf8'),
      'materials/第01课-测试.md': Buffer.from('# 材料\n', 'utf8'),
    }
    // slim：只留一个内容文件，用来测「replace 把本地多出来的那个移进回收站」
    if (o.slim) delete files['materials/第01课-测试.md']
    const roster = (rows) => Buffer.from('\ufeff学号,姓名,备注\r\n' + rows.map((r) => r.join(',')).join('\r\n') + '\r\n', 'utf8')
    const classes = [
      { name: '自检1班', roster: '自检1班.roster.csv', csv: roster([['9001', '甲', ''], ['9002', '乙', '']]) },
      { name: '自检2班', roster: '自检2班.roster.csv', csv: roster(o.dupSid ? [['9001', '重复', '']] : [['9101', '丙', '']]) },
    ]
    const manifest = Object.entries(files)
      .map(([p, b]) => ({ path: 'content/' + p, sha256: crypto.createHash('sha256').update(b).digest('hex'), size: b.length }))
      .concat([
        { path: 'course.json', sha256: '', size: 0 },
        { path: 'scheme.json', sha256: '', size: 0 },
      ])

    const entries = [
      { path: 'selftest-course/pack.json', data: Buffer.from(JSON.stringify({
        format: 'teaching-course', version: 1, kind: 'course-package', courseId: 'selftest-course',
        exportedAt: new Date().toISOString(), contentRoots: ['lecture', 'materials', '代码示例', 'exams', 'assets'],
        parts: { course: 'course.json', scheme: 'scheme.json', classes: 'classes/index.json', content: 'content/' },
        counts: { classes: 2, students: 3, files: 2, bytes: 32 },
        files: manifest,
      }, null, 2), 'utf8') },
      { path: 'selftest-course/course.json', data: Buffer.from(JSON.stringify({
        format: 'teaching-course/course', version: 1, id: 'selftest-course', name: '自检课程',
        note: '自检用', scheme: 'scheme.json', classes: 'classes/index.json', content: 'content/',
      }, null, 2), 'utf8') },
      { path: 'selftest-course/scheme.json', data: Buffer.from(JSON.stringify({
        id: 'selftest-course', name: '自检课程', version: 1, totalFull: 100, passLine: 60,
        // 带一个 module：课堂显示开关（stuvis）的用例要有「可显示的模块」才有意义
        items: [{ key: 'homework', name: '课堂作业', full: 100, form: 'graded', rule: { type: 'acc', params: { perAbsent: 2 } }, module: { enabled: true, title: '课堂作业', submit: 'code' } }],
      }, null, 2), 'utf8') },
      { path: 'selftest-course/classes/index.json', data: Buffer.from(JSON.stringify({
        format: 'teaching-course/classes', version: 1,
        classes: classes.map((c) => ({ id: 'selftest-course-' + c.name, name: c.name, roster: c.roster, students: 0 })),
      }, null, 2), 'utf8') },
      ...classes.map((c) => ({ path: 'selftest-course/classes/' + c.roster, data: c.csv })),
      ...Object.entries(files).map(([p, b]) => ({ path: 'selftest-course/content/' + p, data: b })),
    ]
    return makeZip(entries)
  }

  /* 0) 空壳模板：能下载、是 zip、里面该有的都在 */
  const tpl = await request('GET', '/api/teacher/courses/template.zip', undefined, tt)
  const tplText = tpl.buf ? tpl.buf.toString('utf8') : ''
  check('下载空壳课程包模板（zip + course.json + 名单模板）',
    tpl.status === 200 && tplText.slice(0, 2) === 'PK' && tplText.indexOf('course.json') >= 0 &&
      tplText.indexOf('roster.csv') >= 0 && tplText.indexOf('pack.json') >= 0,
    'status=' + tpl.status + ' · ct=' + ((tpl.headers || {})['content-type'] || ''))

  const zip = mkPack()

  /* 1) 干跑：不落盘，只给差异 */
  const ins = await requestBinary('POST', '/api/teacher/courses/import/inspect', zip, tt)
  check('inspect: 新课 -> action=create，2 个班，2 个内容文件全新增',
    ins.status === 200 && ins.json.course.action === 'create' && ins.json.classes.length === 2 && ins.json.content.added === 2,
    'status=' + ins.status + ' ' + JSON.stringify(ins.json && ins.json.course))
  check('inspect 不落盘（课程仍未创建）',
    !(await request('GET', '/api/teacher/courses', undefined, tt)).json.courses.some((x) => x.id === 'selftest-course'))

  /* 2) 真正导入（merge） */
  const imp = await requestBinary('POST', '/api/teacher/courses/import/apply?strategy=merge', zip, tt)
  check('apply merge: 建课 + 2 个班 + 3 名学生 + 2 个文件',
    imp.status === 200 && imp.json.report.classes.length === 2 &&
      imp.json.report.classes.reduce((n, c) => n + c.added, 0) === 3 && imp.json.report.files.written === 2,
    'status=' + imp.status + ' ' + JSON.stringify(imp.json && imp.json.report && imp.json.report.files))
  const contentFile = path.join(config.dataDir, 'courses', 'selftest-course', 'content', 'lecture', '第01课-测试.md')
  check('内容文件真的写到磁盘', fs.existsSync(contentFile), contentFile)

  /* 0) 内容在线管理：列目录 / 新建 / 写文本 / 改名 / 越界拒绝 */
  const fl = await request('GET', '/api/teacher/courses/selftest-course/files', undefined, tt)
  check('内容：能列出四个内容目录',
    fl.status === 200 && (fl.json.entries || []).length >= 4 && (fl.json.entries || []).every((e) => e.dir),
    JSON.stringify((fl.json.entries || []).map((e) => e.name)))

  const mk = await request('POST', '/api/teacher/courses/selftest-course/files/mkdir', { path: 'lecture', name: '临时目录' }, tt)
  check('内容：新建文件夹', mk.status === 200 && mk.json.path === 'lecture/临时目录', JSON.stringify(mk.json))

  const sv = await request('POST', '/api/teacher/courses/selftest-course/files/save',
    { path: 'lecture/临时目录/a.md', text: '# 在线写的\n' }, tt)
  check('内容：在线写入文本', sv.status === 200 && sv.json.size > 0, JSON.stringify(sv.json))

  const rd = await request('GET', '/api/teacher/courses/selftest-course/files/text?path=' + encodeURIComponent('lecture/临时目录/a.md'), undefined, tt)
  check('内容：能读回刚写的文本', rd.status === 200 && rd.json.text.indexOf('在线写的') >= 0, JSON.stringify(rd.json && rd.json.text))

  const rn = await request('POST', '/api/teacher/courses/selftest-course/files/rename',
    { from: 'lecture/临时目录/a.md', to: 'b.md' }, tt)
  check('内容：改名', rn.status === 200 && rn.json.path === 'lecture/临时目录/b.md', JSON.stringify(rn.json))

  const esc1 = await request('GET', '/api/teacher/courses/selftest-course/files?path=' + encodeURIComponent('../data'), undefined, tt)
  check('内容：越界路径被拒（../data）', esc1.status === 400, 'status=' + esc1.status)
  const esc2 = await request('GET', '/api/teacher/courses/selftest-course/files?path=students', undefined, tt)
  check('内容：不在四类目录下被拒（students）', esc2.status === 400, 'status=' + esc2.status)

  const delFile = await request('POST', '/api/teacher/courses/selftest-course/files/delete', { path: 'lecture/临时目录' }, tt)
  check('内容：删目录（非空需 recursive，这里带 recursive 成功）',
    delFile.status === 200 || delFile.status === 409, 'status=' + delFile.status)
  if (delFile.status === 409) {
    const delRec = await request('POST', '/api/teacher/courses/selftest-course/files/delete', { path: 'lecture/临时目录', recursive: true }, tt)
    check('内容：recursive 删除成功', delRec.status === 200, 'status=' + delRec.status)
  }


  /* 3) 再干跑一次：全都「未变」，方案也不该再涨版本 */
  const ins2 = await requestBinary('POST', '/api/teacher/courses/import/inspect', zip, tt)
  check('再 inspect：内容全未变 + 方案同版本 + 名单无新增',
    ins2.status === 200 && ins2.json.content.unchanged === 2 && ins2.json.content.added === 0 &&
      ins2.json.scheme.action === 'same' && ins2.json.classes.every((c) => c.students.added === 0),
    JSON.stringify(ins2.json && { c: ins2.json.content, s: ins2.json.scheme }))

  /* 4) 坏包：同一门课里学号跨班重复 */
  const dup = await requestBinary('POST', '/api/teacher/courses/import/inspect', mkPack({ dupSid: true }), tt)
  check('坏包：学号跨班重复 -> 400 且指出重复学号',
    dup.status === 400 && JSON.stringify(dup.json || {}).indexOf('9001') >= 0,
    'status=' + dup.status)

  /* 5) 坏包：内容被篡改（哈希对不上） */
  const tampered = Buffer.from(zip)
  const at = tampered.indexOf(Buffer.from('# 讲义'))
  if (at > 0) tampered[at + 2] = 0x40
  const bad = await requestBinary('POST', '/api/teacher/courses/import/inspect', tampered, tt)
  check('坏包：内容被改过 -> 400（CRC / 哈希不符）', bad.status === 400, 'status=' + bad.status)

  /* 6) 不是 zip */
  const junk = await requestBinary('POST', '/api/teacher/courses/import/inspect', Buffer.from('not a zip', 'utf8'), tt)
  check('坏包：不是 zip -> 400', junk.status === 400, 'status=' + junk.status)

  /* 7) 课程列表能报出内容文件数 */
  const list = await request('GET', '/api/teacher/courses', undefined, tt)
  const c = (list.json.courses || []).find((x) => x.id === 'selftest-course')
  const lecture = c && (c.content || []).find((x) => x.dir === 'lecture')
  check('course list reports content files', !!c && !!lecture && lecture.files === 1, JSON.stringify(c && c.content))

  /* 7.5) 学生端显示开关（课堂开关，不进方案、不动方案版本） */
  const vis0 = await request('GET', '/api/teacher/courses/selftest-course/stuvis', undefined, tt)
  check('显示开关：初始无隐藏，且列出可显示的模块',
    vis0.status === 200 && Array.isArray(vis0.json.hidden) && vis0.json.hidden.length === 0 &&
      Array.isArray(vis0.json.modules) && vis0.json.modules.length >= 1,
    JSON.stringify(vis0.json && { h: vis0.json.hidden, m: (vis0.json.modules || []).map((x) => x.itemKey) }))

  const schemeBefore = await request('GET', '/api/teacher/scheme', undefined, tt)
  const vis1 = await request('POST', '/api/teacher/courses/selftest-course/stuvis', { hidden: ['homework'] }, tt)
  check('显示开关：收起 homework', vis1.status === 200 && vis1.json.hidden.join(',') === 'homework', JSON.stringify(vis1.json))

  const sc = await request('GET', '/api/scheme?courseId=selftest-course', undefined, tt)
  const hw = (sc.json.modules || []).find((m) => m.itemKey === 'homework')
  check('显示开关：学生视角 /api/scheme 里 homework 变成不可见',
    sc.status === 200 && (sc.json.hidden || []).indexOf('homework') >= 0 && hw && hw.studentVisible === false,
    JSON.stringify({ hidden: sc.json.hidden, hw: hw && hw.studentVisible }))

  const schemeAfter = await request('GET', '/api/teacher/scheme', undefined, tt)
  check('显示开关：不碰考核方案（版本不变）',
    schemeAfter.json.version === schemeBefore.json.version,
    schemeBefore.json.version + ' → ' + schemeAfter.json.version)

  await request('POST', '/api/teacher/courses/selftest-course/stuvis', { hidden: [] }, tt)

  /* 8) 导出 = zip */
  const exp = await request('GET', '/api/teacher/courses/selftest-course/package.zip', undefined, tt)
  // 导出 = zip（deflate 压缩，得用 readZip 解开来看，不能直接搜原始字节）
  let expNames = []
  try {
    expNames = readZip(exp.buf).map((f) => f.name)
  } catch (e) {
    expNames = []
  }
  check(
    'export coursepack → zip（PK 头 + pack.json + course.json + content 文件）',
    exp.status === 200 &&
      (exp.buf || Buffer.alloc(0)).slice(0, 2).toString('latin1') === 'PK' &&
      expNames.some((n) => /pack\.json$/.test(n)) &&
      expNames.some((n) => /course\.json$/.test(n)) &&
      expNames.filter((n) => /content\/lecture\//.test(n)).length >= 1,
    'status=' + exp.status + ' · 条目=' + expNames.length + ' · ct=' + ((exp.headers || {})['content-type'] || '')
  )

  // 压缩：文本走 deflate、已压缩格式仍按存储（用一段可压缩的长文本直接验）
  const bigText = Buffer.from('课堂系统 deflate 测试 '.repeat(4000), 'utf8')
  const packedZip = makeZip([{ path: 'a/big.md', data: bigText }, { path: 'a/pic.png', data: Buffer.alloc(2000, 7) }])
  const packedEntries = readZip(packedZip)
  const mdEntry = packedEntries.find((f) => f.name === 'a/big.md')
  const pngEntry = packedEntries.find((f) => f.name === 'a/pic.png')
  check('makeZip 会压缩文本（deflate，包远小于原文）',
    mdEntry && mdEntry.method === 8 && packedZip.length < bigText.length / 3,
    '原文=' + bigText.length + ' 包=' + packedZip.length + ' method=' + (mdEntry && mdEntry.method))
  check('makeZip 对已压缩格式仍用存储（png method=0）',
    pngEntry && pngEntry.method === 0,
    'method=' + (pngEntry && pngEntry.method))

  /* 8.5) 部件级：只导方案 / 只导内容 */
  const expScheme = await request('GET', '/api/teacher/courses/selftest-course/package.zip?parts=scheme', undefined, tt)
  let schemeOnlyNames = []
  let schemeOnlyParts = {}
  try {
    const filesAll = readZip(expScheme.buf)
    schemeOnlyNames = filesAll.map((f) => f.name.replace('selftest-course/', ''))
    const pj = filesAll.find((f) => /pack\.json$/.test(f.name))
    schemeOnlyParts = pj ? JSON.parse(pj.data.toString('utf8')).parts : {}
  } catch (e) {
    schemeOnlyNames = []
  }
  check('导出只带方案：包里没有 content/ 与 classes/',
    expScheme.status === 200 &&
      schemeOnlyNames.some((n) => n === 'scheme.json') &&
      !schemeOnlyNames.some((n) => n.startsWith('content/')) &&
      !schemeOnlyNames.some((n) => n.startsWith('classes/')),
    JSON.stringify(schemeOnlyNames))
  check('导出只带方案：pack.json 的 parts 对应留空',
    schemeOnlyParts.scheme === 'scheme.json' && schemeOnlyParts.classes === '' && schemeOnlyParts.content === '',
    JSON.stringify(schemeOnlyParts))

  const insParts = await requestBinary('POST', '/api/teacher/courses/import/inspect', expScheme.buf, tt)
  check('干跑方案包：parts 只有 course + scheme，content 标为未包含',
    insParts.status === 200 &&
      insParts.json.parts.join(',') === 'course,scheme' &&
      insParts.json.content.included === false &&
      insParts.json.classesIncluded === false,
    JSON.stringify({ parts: insParts.json && insParts.json.parts, inc: insParts.json && insParts.json.content && insParts.json.content.included }))

  // 关键回归：用 replace 导入「只带方案」的包，不能把本地内容与班级当多余清掉
  const beforeFiles = await request('GET', '/api/teacher/courses/selftest-course/files?path=lecture', undefined, tt)
  const repParts = await requestBinary('POST', '/api/teacher/courses/import/apply?strategy=replace', expScheme.buf, tt)
  const afterFiles = await request('GET', '/api/teacher/courses/selftest-course/files?path=lecture', undefined, tt)
  check('replace 导入方案包：内容与班级不受影响（移走 0 个）',
    repParts.status === 200 &&
      repParts.json.report.files.removed === 0 &&
      (beforeFiles.json.entries || []).length === (afterFiles.json.entries || []).length &&
      (afterFiles.json.entries || []).length >= 1,
    JSON.stringify({ removed: repParts.json && repParts.json.report && repParts.json.report.files && repParts.json.report.files.removed, before: (beforeFiles.json.entries || []).length, after: (afterFiles.json.entries || []).length }))

  const expContent = await request('GET', '/api/teacher/courses/selftest-course/package.zip?parts=content', undefined, tt)
  let contentNames = []
  try {
    contentNames = readZip(expContent.buf).map((f) => f.name.replace('selftest-course/', ''))
  } catch (e) {
    contentNames = []
  }
  check('导出只带内容：有 content/、没有 scheme.json 与 classes/',
    expContent.status === 200 &&
      contentNames.some((n) => n.startsWith('content/')) &&
      !contentNames.some((n) => n === 'scheme.json') &&
      !contentNames.some((n) => n.startsWith('classes/')),
    JSON.stringify(contentNames))

  /* 9) 导出的包再干跑：应与本机完全一致（闭环） */
  const round = await requestBinary('POST', '/api/teacher/courses/import/inspect', exp.buf, tt)
  check('导出的包能再被解析，且内容全未变（往返一致）',
    round.status === 200 && round.json.content.unchanged === 2 && round.json.content.added === 0,
    'status=' + round.status + ' ' + JSON.stringify(round.json && round.json.content))

  /* 10) fork：另建一份，原课程不动 */
  const fork = await requestBinary('POST', '/api/teacher/courses/import/apply?strategy=fork', zip, tt)
  check('apply fork -> 新课程 id 另起一份',
    fork.status === 200 && fork.json.report.courseId !== 'selftest-course' && !!fork.json.course,
    JSON.stringify(fork.json && fork.json.report && fork.json.report.courseId))
  const forkId = fork.json && fork.json.report && fork.json.report.courseId
  if (forkId) {
    const delFork = await request('DELETE', '/api/teacher/courses/' + forkId, undefined, tt)
    check('删除 fork 出来的课程', delFork.status === 200, 'status=' + delFork.status)
  }

  /* 10.5) 学期字段 + 课程复制 */
  const withSem = await request('PATCH', '/api/teacher/courses/selftest-course', { semester: '2026秋' }, tt)
  check('课程可以标学期', withSem.status === 200 && withSem.json.course.semester === '2026秋',
    JSON.stringify(withSem.json && withSem.json.course && withSem.json.course.semester))

  const expSem = await request('GET', '/api/teacher/courses/selftest-course/package.zip', undefined, tt)
  let semInPack = ''
  try {
    const cj = readZip(expSem.buf).find((f) => /course\.json$/.test(f.name))
    semInPack = cj ? JSON.parse(cj.data.toString('utf8')).semester : ''
  } catch (e) {
    semInPack = ''
  }
  check('导出包里带上学期的值', semInPack === '2026秋', 'semester=' + JSON.stringify(semInPack))

  const dupCourse = await request('POST', '/api/teacher/courses/selftest-course/duplicate', { name: '自检课程副本', semester: '2027春' }, tt)
  check('复制课程：新 id / 新学期 / 内容文件跟着走',
    dupCourse.status === 200 && dupCourse.json.course && dupCourse.json.course.id !== 'selftest-course' &&
      dupCourse.json.course.semester === '2027春' && dupCourse.json.files >= 2,
    JSON.stringify(dupCourse.json && { id: dupCourse.json.course && dupCourse.json.course.id, files: dupCourse.json.files }))

  check('复制课程：默认不带班级与名单',
    dupCourse.status === 200 && dupCourse.json.classes === 0 && dupCourse.json.students === 0,
    JSON.stringify({ classes: dupCourse.json && dupCourse.json.classes, students: dupCourse.json && dupCourse.json.students }))

  const dupId = dupCourse.json && dupCourse.json.course && dupCourse.json.course.id
  if (dupId) {
    const dupScheme = await request('GET', '/api/teacher/scheme?courseId=' + dupId, undefined, tt)
    check('复制课程：方案另存一份（id 跟着新课程，版本从 1 起）',
      dupScheme.status === 200 && dupScheme.json.raw && dupScheme.json.raw.id === dupId && dupScheme.json.version === 1,
      JSON.stringify(dupScheme.json && { id: dupScheme.json.raw && dupScheme.json.raw.id, v: dupScheme.json.version }))
    const delDup = await request('DELETE', '/api/teacher/courses/' + dupId, undefined, tt)
    check('删除复制出来的课程', delDup.status === 200, 'status=' + delDup.status)
  }

  const dupCourse2 = await request('POST', '/api/teacher/courses/selftest-course/duplicate', { withClasses: true }, tt)
  check('复制课程 withClasses：连班级与名单一起复制',
    dupCourse2.status === 200 && dupCourse2.json.classes === 2 && dupCourse2.json.students === 3,
    JSON.stringify(dupCourse2.json && { classes: dupCourse2.json.classes, students: dupCourse2.json.students }))
  if (dupCourse2.json && dupCourse2.json.course) {
    await request('DELETE', '/api/teacher/courses/' + dupCourse2.json.course.id, undefined, tt)
  }

  /* 10.6) 作业库：设计包导入 / 从设计建作业 / 批阅进度 */
  const hwTpl = await request('GET', '/api/teacher/courses/selftest-course/designs/template.zip?kind=homework', undefined, tt)
  let hwTplNames = []
  try {
    hwTplNames = readZip(hwTpl.buf).map((f) => f.name)
  } catch (e) {
    hwTplNames = []
  }
  check('作业库模板：课堂作业设计包含 homework.json 与 code/',
    hwTpl.status === 200 && hwTplNames.indexOf('homework.json') >= 0 && hwTplNames.some((n) => n.indexOf('code/') === 0),
    JSON.stringify(hwTplNames))

  const hwPack = makeZip([
    { path: 'homework.json', data: Buffer.from(JSON.stringify({ title: '自检作业设计', weight: 2, allowLate: false }), 'utf8') },
    { path: 'code/index.html', data: Buffer.from('<h1>t</h1>', 'utf8') },
    { path: 'code/main.js', data: Buffer.from('// x', 'utf8') },
  ])
  const hwIm = await requestBinary('POST', '/api/teacher/courses/selftest-course/designs/import?kind=homework', hwPack, tt)
  const hwDesignId = hwIm.json && hwIm.json.design ? hwIm.json.design.id : ''
  check('作业库导入：进库并认出标题/权重/是否收迟交',
    hwIm.status === 200 && !!hwDesignId && hwIm.json.design.weight === 2 && hwIm.json.design.allowLate === false,
    JSON.stringify(hwIm.json && hwIm.json.design))

  const hwMade = await request('POST', '/api/teacher/assignments?courseId=selftest-course', { itemKey: 'homework', designId: hwDesignId }, tt)
  const hwAid2 = hwMade.json && hwMade.json.assignment ? hwMade.json.assignment.id : ''
  check('从设计建作业：套用设计的权重/迟交策略，起手代码来自设计',
    hwMade.status === 200 && hwMade.json.assignment.weight === 2 && hwMade.json.assignment.allowLate === false,
    JSON.stringify(hwMade.json && hwMade.json.assignment))
  const hwCode = await request('GET', '/api/examples/' + encodeURIComponent('@a:' + hwAid2), undefined, tt)
  check('从设计建出的作业，工作台能读到 code/ 里的文件',
    hwCode.status === 200 && (hwCode.json.files || []).length === 2,
    JSON.stringify((hwCode.json && hwCode.json.files || []).map((f) => f.path)))

  const prog = await request('GET', '/api/teacher/assignments/' + hwAid2 + '/progress', undefined, tt)
  check('批阅进度：给出学生数 / 已交 / 未交名单',
    prog.status === 200 && prog.json.studentCount > 0 && Array.isArray(prog.json.missing) &&
      prog.json.missing.length === prog.json.studentCount - prog.json.submitted,
    JSON.stringify({ total: prog.json && prog.json.studentCount, submitted: prog.json && prog.json.submitted, missing: prog.json && prog.json.missing.length }))

  const hwExp = await request('GET', '/api/teacher/courses/selftest-course/designs/' + encodeURIComponent(hwDesignId) + '/zip?kind=homework', undefined, tt)
  let hwExpNames = []
  try {
    hwExpNames = readZip(hwExp.buf).map((f) => f.name)
  } catch (e) {
    hwExpNames = []
  }
  check('作业库导出：把设计原样打成 zip',
    hwExp.status === 200 && hwExpNames.indexOf('homework.json') >= 0 && hwExpNames.some((n) => n.indexOf('code/') === 0),
    JSON.stringify(hwExpNames))

  await request('DELETE', '/api/teacher/assignments/' + hwAid2, undefined, tt)
  await request('DELETE', '/api/teacher/courses/selftest-course/designs/' + encodeURIComponent(hwDesignId) + '?kind=homework', undefined, tt)

  /* 10.7) 班级与名单整体导入导出（课程级 zip） */
  const clsZip = await request('GET', '/api/teacher/courses/selftest-course/classes.zip', undefined, tt)
  let clsNames = []
  try {
    clsNames = readZip(clsZip.buf).map((f) => f.name)
  } catch (e) {
    clsNames = []
  }
  check('班级导出：一个班一个 roster.csv（文件名=班名）',
    clsZip.status === 200 &&
      clsNames.some((n) => /\.roster\.csv$/.test(n)) &&
      clsNames.some((n) => /README\.txt$/.test(n)),
    JSON.stringify(clsNames))

  const clsPack = makeZip([
    { path: 'classes/自检1班.roster.csv', data: Buffer.from('\ufeff学号,姓名,备注\r\n9001,甲改,\r\n9003,新来的,\r\n', 'utf8') },
    { path: 'classes/自检3班.roster.csv', data: Buffer.from('\ufeff学号,姓名\r\n9301,丁\r\n', 'utf8') },
  ])
  const clsDry = await requestBinary('POST', '/api/teacher/courses/selftest-course/classes/inspect', clsPack, tt)
  check('班级干跑：新建 1 班 / 更新 1 班 / 新增 2 人 / 改名 1 人',
    clsDry.status === 200 && clsDry.json.totals.create === 1 && clsDry.json.totals.update === 1 &&
      clsDry.json.totals.added === 2 && clsDry.json.totals.renamed === 1,
    JSON.stringify(clsDry.json && clsDry.json.totals))

  const clsMerge = await requestBinary('POST', '/api/teacher/courses/selftest-course/classes/apply?mode=merge', clsPack, tt)
  check('班级导入 merge：建出新班且不动包里没有的老班',
    clsMerge.status === 200 && clsMerge.json.totals.created === 1 &&
      (clsMerge.json.notInPack || []).indexOf('自检2班') >= 0,
    JSON.stringify(clsMerge.json && { totals: clsMerge.json.totals, notInPack: clsMerge.json.notInPack }))

  const oneCls = makeZip([{ path: 'classes/自检1班.roster.csv', data: Buffer.from('\ufeff学号,姓名\r\n9001,甲改,\r\n', 'utf8') }])
  const clsRep = await requestBinary('POST', '/api/teacher/courses/selftest-course/classes/apply?mode=replace', oneCls, tt)
  check('班级导入 replace：名单同步成包里的（多余的人移出）',
    clsRep.status === 200 && clsRep.json.totals.removed >= 1,
    JSON.stringify(clsRep.json && clsRep.json.totals))

  const clsTpl = await request('GET', '/api/teacher/courses/selftest-course/classes/template.zip', undefined, tt)
  let tplNames = []
  try {
    tplNames = readZip(clsTpl.buf).map((f) => f.name)
  } catch (e) {
    tplNames = []
  }
  check('班级模板：一个示例班 + README',
    clsTpl.status === 200 && tplNames.some((n) => /\.roster\.csv$/.test(n)) && tplNames.some((n) => /README/.test(n)),
    JSON.stringify(tplNames))

  const clsBad = await requestBinary('POST', '/api/teacher/courses/selftest-course/classes/inspect', Buffer.from('nope'), tt)
  check('班级导入：不是 zip 就中文报错', clsBad.status === 400 && /zip/.test(String(clsBad.json && clsBad.json.error)), String(clsBad.json && clsBad.json.error))

  /* 10.8) 单个内容目录的导入 / 导出（各 tab 上的「导出/导入本页」） */
  const dirZip = await request('GET', '/api/teacher/courses/selftest-course/content.zip?dir=lecture', undefined, tt)
  let dirNames = []
  try {
    dirNames = readZip(dirZip.buf).map((f) => f.name)
  } catch (e) {
    dirNames = []
  }
  check('目录导出：lecture 打成一个 zip（文件名带课程与目录）',
    dirZip.status === 200 && dirNames.length >= 1 && dirNames.every((n) => n.indexOf('/') < 0 || !n.startsWith('content/')),
    'entries=' + JSON.stringify(dirNames))

  const dirPack = makeZip([
    { path: '第01课-测试.md', data: Buffer.from('# 讲义\n', 'utf8') }, // 与本地一致
    { path: '第99课-新增.md', data: Buffer.from('# 新增\n', 'utf8') },
  ])
  const dirDry = await requestBinary('POST', '/api/teacher/courses/selftest-course/content/inspect?dir=lecture', dirPack, tt)
  check('目录干跑：新增 1 / 未变 1 / 本地多出 0',
    dirDry.status === 200 && dirDry.json.added.length === 1 && dirDry.json.unchanged.length === 1 && dirDry.json.extra.length === 0,
    JSON.stringify(dirDry.json && { added: dirDry.json.added, unchanged: dirDry.json.unchanged }))

  const dirMerge = await requestBinary('POST', '/api/teacher/courses/selftest-course/content/apply?dir=lecture&mode=merge', dirPack, tt)
  check('目录导入 merge：写入 2 个文件', dirMerge.status === 200 && dirMerge.json.written === 2, JSON.stringify(dirMerge.json))

  const oneOnly = makeZip([{ path: '第01课-测试.md', data: Buffer.from('# 讲义\n', 'utf8') }])
  const dirReplace = await requestBinary('POST', '/api/teacher/courses/selftest-course/content/apply?dir=lecture&mode=replace', oneOnly, tt)
  check('目录导入 replace：本地多出的移进回收站',
    dirReplace.status === 200 && dirReplace.json.removed === 1 && dirReplace.json.trash && dirReplace.json.trash.count === 1,
    JSON.stringify(dirReplace.json && { removed: dirReplace.json.removed, trash: dirReplace.json.trash }))
  if (dirReplace.json && dirReplace.json.trash) {
    try {
      fs.rmSync(path.join(require('./config').dataDir, dirReplace.json.trash.dir), { recursive: true, force: true })
    } catch (e) {
      /* 清不掉无妨 */
    }
  }

  /* 模板：新部署时照着改的那几份，内容要跟着「小节锚点约定 / 三方职能约定」走 */
  if (true) {
  const tplLecture = await request('GET', '/api/teacher/courses/selftest-course/content/template.zip?dir=lecture', undefined, tt)
  let leTplText = ''
  let leTplNames = []
  try {
    const fsAll = readZip(tplLecture.buf)
    leTplNames = fsAll.map((f) => f.name)
    leTplText = fsAll.filter((f) => /\.md$/.test(f.name)).map((f) => f.data.toString('utf8')).join('\n')
  } catch (e) {
    leTplNames = []
  }
  check('讲义模板：带「📺 屏幕 / 🎤 讲稿」与元信息块，且说明小节对应规则',
    tplLecture.status === 200 &&
      leTplText.indexOf('📺 屏幕') >= 0 &&
      leTplText.indexOf('🎤 讲稿') >= 0 &&
      leTplText.indexOf('📅 教学信息') >= 0 &&
      leTplNames.some((n) => /README\.txt$/.test(n)),
    JSON.stringify(leTplNames))

  const tplMat = await request('GET', '/api/teacher/courses/selftest-course/content/template.zip?dir=materials', undefined, tt)
  let matTplText = ''
  try {
    matTplText = readZip(tplMat.buf).filter((f) => /\.md$/.test(f.name)).map((f) => f.data.toString('utf8')).join('\n')
  } catch (e) {
    matTplText = ''
  }
  check('材料模板：含「✅ 自测与练习 / 📚 拓展阅读 / 🧪 配套代码」，且不写教师向内容',
    tplMat.status === 200 &&
      matTplText.indexOf('✅ 自测与练习') >= 0 &&
      matTplText.indexOf('📚 拓展阅读') >= 0 &&
      matTplText.indexOf('🧪 配套代码') >= 0 &&
      matTplText.indexOf('📺 屏幕') < 0,
    'len=' + matTplText.length)

  const tplEx = await request('GET', '/api/teacher/courses/selftest-course/content/template.zip?dir=' + encodeURIComponent('代码示例') + '', undefined, tt)
  let exNames = []
  try {
    exNames = readZip(tplEx.buf).map((f) => f.name)
  } catch (e) {
    exNames = []
  }
  check('代码示例模板：一课一个目录，里面 index.html + 脚本 + 说明',
    tplEx.status === 200 &&
      exNames.some((n) => /index\.html$/.test(n)) &&
      exNames.some((n) => /README\.txt$/.test(n)),
    JSON.stringify(exNames))

  }
  const badDir = await request('GET', '/api/teacher/courses/selftest-course/content.zip?dir=students', undefined, tt)
  check('目录导入导出：只允许四个内容目录（students 被拒）', badDir.status === 400, 'status=' + badDir.status)

  /* 11) 导出前体检 + replace 的删除进回收站 */
  const sum = await request('GET', '/api/teacher/courses/selftest-course/package/summary', undefined, tt)
  check('导出前体检：报出文件数 / 体积 / 超限文件',
    sum.status === 200 && sum.json.files >= 1 && typeof sum.json.bytes === 'number' &&
      Array.isArray(sum.json.skipped) && sum.json.overLimit === false,
    JSON.stringify(sum.json && { files: sum.json.files, bytes: sum.json.bytes, mb: sum.json.mb }))

  // 造一个「少一个内容文件」的包，replace 时多出来的那个应当被移进回收站，而不是删掉
  const slim = mkPack({ slim: true })
  const dryExtra = await requestBinary('POST', '/api/teacher/courses/import/inspect', slim, tt)
  check('干跑报告列出「本地多出的文件」清单（replace 会移走）',
    dryExtra.status === 200 && dryExtra.json.content.extra >= 1 &&
      Array.isArray(dryExtra.json.content.extraList) && dryExtra.json.content.extraList.length === dryExtra.json.content.extra,
    JSON.stringify(dryExtra.json && dryExtra.json.content && { extra: dryExtra.json.content.extra, list: dryExtra.json.content.extraList }))

  const rep1 = await requestBinary('POST', '/api/teacher/courses/import/apply?strategy=replace', slim, tt)
  const trash = rep1.json && rep1.json.report && rep1.json.report.files && rep1.json.report.files.trash
  check('replace：多出的文件被移进回收站（报告给出目录）',
    rep1.status === 200 && rep1.json.report.files.removed >= 1 && !!trash && trash.count >= 1 && !!trash.dir,
    JSON.stringify(rep1.json && rep1.json.report && rep1.json.report.files))

  let trashHasFile = false
  try {
    const base = path.join(require('./config').dataDir, trash.dir)
    const walk = (d) => {
      for (const it of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, it.name)
        if (it.isDirectory()) walk(p)
        else if (it.isFile()) trashHasFile = true
      }
    }
    walk(base)
  } catch (e) {
    trashHasFile = false
  }
  check('回收站里确实有被移走的文件（能捞回来）', trashHasFile, 'dir=' + (trash && trash.dir))

  // 自检别在老师的数据目录里留垃圾：把自己造的那次回收站清掉
  if (trash && trash.abs) {
    try {
      fs.rmSync(trash.abs, { recursive: true, force: true })
      fs.rmdirSync(path.dirname(trash.abs)) // 这一戳下的目录空了就一起删
    } catch (e) {
      /* 还有别的课程那次导入，留着无妨 */
    }
  }

  const del = await request('DELETE', '/api/teacher/courses/selftest-course', undefined, tt)
  check('delete course with no scores', del.status === 200, 'status=' + del.status)
  const after = await request('GET', '/api/teacher/courses', undefined, tt)
  check('course gone after delete', !(after.json.courses || []).some((x) => x.id === 'selftest-course'))
}

async function testCompat() {
  console.log('\n[A0] browser compat gate (浏览器兼容性兜底)')

  const c = await request('GET', '/api/compat')
  check('compat: 公开接口返回最低版本与下载信息（登录前就能用）',
    c.status === 200 && Number(c.json.minChrome) === 109 && typeof c.json.available === 'boolean' &&
      typeof c.json.contact === 'string' && c.json.contact.length > 0,
    JSON.stringify(c.json))

  check('compat: 没放绿色版时 downloadUrl 为空、available=false（页面会显示「向老师索取」）',
    c.json.available === true || c.json.downloadUrl === '',
    'available=' + c.json.available + ' url=' + c.json.downloadUrl)

  const dl = await request('GET', '/download/chrome109')
  check('compat: 绿色版下载口存在（有包 200 / 没包 404 带说明）',
    dl.status === 200 || dl.status === 404 || dl.status === 302,
    'status=' + dl.status)

  // 放了绿色版时（本机就有 Chrome-109*.exe）：要能说清「是什么类型、下完怎么用」
  if (c.json.available) {
    check('compat: 找到绿色版时带上类型与用法提示（exe 双击运行 / zip 解压）',
      ['exe', 'zip', '7z'].indexOf(c.json.kind) >= 0 && !!c.json.filename && !!c.json.tip && c.json.sizeMB > 0,
      JSON.stringify({ kind: c.json.kind, file: c.json.filename, mb: c.json.sizeMB }))
  }
}

async function testSchemeIO(tt) {
  console.log('\n[A4b] scheme import / export (方案单独导入导出)')

  const exp = await request('GET', '/api/teacher/scheme/export.json', undefined, tt)
  let raw = null
  try {
    raw = JSON.parse(exp.text)
  } catch (e) {
    raw = null
  }
  check('下载方案：返回 scheme.json（有 items / totalFull）',
    exp.status === 200 && !!raw && Array.isArray(raw.items) && raw.items.length > 0 && typeof raw.totalFull === 'number',
    'status=' + exp.status)

  if (!raw) return

  // 造一份改过的：第一项满分 +5、总分 +5、末尾加一项（抄第一项的规则，保证合法）
  const draft = JSON.parse(JSON.stringify(raw))
  const first = draft.items[0]
  first.full = Number(first.full) + 5
  draft.items.push({
    key: 'selftest-extra',
    name: '自检附加项',
    full: 5,
    form: first.form,
    rule: JSON.parse(JSON.stringify(first.rule)),
    module: { enabled: false },
  })
  draft.totalFull = Number(draft.totalFull) + 10

  const ins = await request('POST', '/api/teacher/scheme/inspect', { raw: draft }, tt)
  const d = (ins.json && ins.json.diff) || {}
  check('干跑方案：报出「改 1 项 + 增 1 项」且不改本机版本',
    ins.status === 200 && d.same === false && (d.changed || []).length >= 1 && (d.added || []).length === 1,
    JSON.stringify({ changed: (d.changed || []).map((x) => x.key), added: (d.added || []).map((x) => x.key) }))
  check('干跑方案：总满分变化有提示',
    (ins.json.warnings || []).join(' ').indexOf('总满分') >= 0,
    JSON.stringify(ins.json && ins.json.warnings))

  const keep = await request('POST', '/api/teacher/scheme/apply?mode=keep', { raw: draft }, tt)
  const afterKeep = await request('GET', '/api/teacher/scheme', undefined, tt)
  check('keep 模式：什么都不改（版本与总分不变）',
    keep.status === 200 && keep.json.mode === 'keep' &&
      afterKeep.json.version === ins.json.current.version &&
      afterKeep.json.raw.totalFull === raw.totalFull,
    'version=' + (afterKeep.json && afterKeep.json.version) + ' total=' + (afterKeep.json && afterKeep.json.raw && afterKeep.json.raw.totalFull))

  const copy = await request('POST', '/api/teacher/scheme/apply?mode=copy', { raw: draft }, tt)
  const afterCopy = await request('GET', '/api/teacher/scheme', undefined, tt)
  check('copy 模式：另存为新方案，当前方案不受影响',
    copy.status === 200 && copy.json.mode === 'copy' && !!copy.json.savedId && copy.json.savedId !== raw.id &&
      afterCopy.json.raw.id === raw.id && afterCopy.json.raw.totalFull === raw.totalFull,
    JSON.stringify({ saved: copy.json && copy.json.savedId, current: afterCopy.json && afterCopy.json.raw && afterCopy.json.raw.id }))

  // 清掉自检产生的方案文件，别污染 data/schemes
  if (copy.json && copy.json.savedId) {
    try {
      fs.unlinkSync(path.join(config.dataDir, 'schemes', copy.json.savedId + '.json'))
    } catch (e) {
      /* 没有就算了 */
    }
  }

  // 坏方案：给个不存在的规则类型，必须被拦下
  const bad = JSON.parse(JSON.stringify(draft))
  bad.items[0].rule = { type: 'no-such-rule', params: {} }
  const badIns = await request('POST', '/api/teacher/scheme/inspect', { raw: bad }, tt)
  check('坏方案：干跑标出校验错误（ok=false）',
    badIns.status === 200 && badIns.json.ok === false && (badIns.json.errors || []).length > 0,
    JSON.stringify(badIns.json && badIns.json.errors))
}

async function testExamPaper(tt, st, classId, sid) {
  console.log('\n[A6] exam paper (试卷 / 答卷)')

  const made = await request('POST', '/api/teacher/assignments', { itemKey: 'exam', title: 'selftest 机试' }, tt)
  const aid = made.json && made.json.assignment && made.json.assignment.id
  check('create exam assignment on the paper item', made.status === 200 && !!aid, JSON.stringify(made.json))
  if (!aid) return

  const paper = {
    kind: 'paper',
    title: 'selftest 卷',
    duration: 30,
    sections: [
      { id: 'c', title: '一、选择题（每题 5 分）', type: 'choice', score: 5,
        questions: [{ id: 'c1', stem: '1+1=?', options: ['A. 1', 'B. 2'], answer: 'B' },
                    { id: 'c2', stem: '2+2=?', options: ['A. 4', 'B. 5'], answer: 'A' }] },
      { id: 'j', title: '二、判断题', type: 'judge', score: 5,
        questions: [{ id: 'j1', stem: '水是湿的。', answer: '对' }] },
      { id: 's', title: '三、简答题', type: 'short', score: 20,
        questions: [{ id: 's1', stem: '说说思路', answer: '参考：先拆再合' }] },
    ],
  }
  const imp = await request('POST', '/api/teacher/exams/' + aid + '/paper', { source: paper }, tt)
  check('import exam paper + writes 试卷/答案卷', imp.status === 200 && !!imp.json.paperDir, JSON.stringify(imp.json && imp.json.paperDir))
  const dir = imp.json.paperDir
  check('试卷 + 答案卷（md/html）都生成了',
    ['试卷.md', '试卷.html', '答案卷.md', '答案卷.html'].every((f) => fs.existsSync(path.join(dir, f))),
    dir)
  const blankHtml = fs.readFileSync(path.join(dir, '试卷.html'), 'utf8')
  const keyHtml = fs.readFileSync(path.join(dir, '答案卷.html'), 'utf8')
  check('空白卷不含答案，答案卷含参考答案',
    !blankHtml.includes('参考答案') && keyHtml.includes('参考答案') && blankHtml.includes('得分'))
  check('判断题在卷面上排成「对 / 错」两格', blankHtml.includes('A. 对') && blankHtml.includes('B. 错'))

  await request('POST', '/api/teacher/assignments/' + aid + '/start', {}, tt)
  const started = await request('POST', '/api/student/exams/' + aid + '/start', undefined, st)
  const ans = { c1: 'B', c2: 'A', j1: '对', s1: '我先把页面拆成组件' }
  await request('POST', '/api/student/exams/' + aid + '/answers', { answers: ans }, st)
  const submit = await request('POST', '/api/student/exams/' + aid + '/submit', undefined, st)
  check('客观题自动判：3 题全对 = 15', submit.status === 200 && submit.json.autoScore === 15,
    'auto=' + (submit.json && submit.json.autoScore))

  const early = await request('GET', '/api/student/exams/' + aid + '/paper-file/html', undefined, st)
  check('交卷后立刻能看答卷，主观题标「待老师判定」',
    early.status === 200 && early.text.indexOf('待老师判定') > 0,
    'status=' + early.status)

  const rows = (await request('GET', '/api/teacher/exams/' + aid, undefined, tt)).json.rows
  const subId = rows[0] && rows[0].submissionId
  const g = await request('POST', '/api/teacher/exams/' + aid + '/submissions/' + subId + '/grade',
    { scores: { s1: 16 }, comment: '写得清楚' }, tt)
  check('判主观题 → 卷面 31 分', g.status === 200 && g.json.graded.total === 31, JSON.stringify(g.json && g.json.graded && g.json.graded.total))

  const stuLib = require('./lib/students')
  const sheetDir = path.join(stuLib.subOf(classId, sid, 'exam'), aid, subId)
  const sheetMd = fs.readFileSync(path.join(sheetDir, '答卷.md'), 'utf8')
  const sheetHtml = fs.readFileSync(path.join(sheetDir, '答卷.html'), 'utf8')
  check('答卷 md/html + exam.json 都落在学生目录',
    ['答卷.md', '答卷.html', 'exam.json'].every((f) => fs.existsSync(path.join(sheetDir, f))))
  check('答卷里有卷头、逐题得分与总分',
    sheetMd.includes('2025010101') && sheetMd.includes('本大题得分') && sheetMd.includes('卷面总分'), sheetMd.slice(0, 80))
  check('答卷 html 有得分框与作答标记',
    sheetHtml.includes('卷面得分') && (sheetHtml.includes('✓') || sheetHtml.includes('class="ok"')))

  const mine = await request('GET', '/api/student/exams/' + aid + '/paper-file/html', undefined, st)
  check('学生能取自己那份答卷', mine.status === 200 && mine.text.indexOf('卷面得分') > 0, 'status=' + mine.status)
  const other = await request('GET', '/api/teacher/exams/' + aid + '/submissions/' + subId + '/paper-file/html', undefined, tt)
  check('老师能取任意一份答卷', other.status === 200 && other.text.length > 500, 'status=' + other.status)

  const del = await request('DELETE', '/api/teacher/assignments/' + aid, undefined, tt)
  check('delete exam assignment', del.status === 200)
}

async function testAttendance(tt, classId) {
  console.log('\n[A7] 考勤点名（一屏提交）')
  const view = await request('GET', '/api/teacher/classes/' + classId + '/attendance', undefined, tt)
  check('attendance view lists kinds and scores', view.status === 200 && Array.isArray(view.json.kinds) && Array.isArray(view.json.scores),
    'status=' + view.status)
  if (view.status !== 200) return

  const absent = view.json.kinds.find((k) => k.kind === '缺勤')
  const late = view.json.kinds.find((k) => k.kind === '迟到')
  const sidA = view.json.students[0] && view.json.students[0].sid
  const sidB = view.json.students[1] && view.json.students[1].sid
  if (!sidA || !sidB) {
    check('attendance needs at least 2 students', false, 'roster too small')
    return
  }

  const beforeA = ((view.json.scores || []).find((x) => x.sid === view.json.students[0].sid) || {}).score || 0
  const day = '2026-01-05'
  const post = await request('POST', '/api/teacher/classes/' + classId + '/attendance', {
    entries: [
      { sid: sidA, kind: '缺勤' },
      { sid: sidB, kind: '迟到' },
      { sid: sidA, kind: '出勤' },
    ],
    date: day,
    slot: '1-2节',
  }, tt)
  check('只记异常：出勤不记账（present 计数）',
    post.status === 200 && post.json.created === 2 && post.json.present === 1 && post.json.skipped === 0,
    JSON.stringify(post.json))

  const after = await request('GET', '/api/teacher/classes/' + classId + '/attendance?date=' + day, undefined, tt)
  const marks = (after.json.marks || []).map((m) => m.sid + ':' + m.kind).sort().join(',')
  check('attendance marks read back for that day', (after.json.marks || []).length === 2, marks)
  const scoreA = (after.json.scores || []).find((x) => x.sid === sidA)
  check('缺勤按 perAbsent 扣分（相对提交前）',
    scoreA && Math.abs(beforeA - scoreA.score - Math.abs(absent.delta)) < 0.01,
    'before=' + beforeA + ' after=' + (scoreA && scoreA.score) + ' delta=' + absent.delta)

  // 覆盖当天：撤掉旧的、只留一条请假
  const over = await request('POST', '/api/teacher/classes/' + classId + '/attendance', {
    entries: [{ sid: sidA, kind: '请假' }],
    date: day,
    replaceDay: true,
  }, tt)
  check('replaceDay voids the old records for that day', over.status === 200 && over.json.voided === 2 && over.json.created === 1,
    JSON.stringify(over.json))
  const after2 = await request('GET', '/api/teacher/classes/' + classId + '/attendance?date=' + day, undefined, tt)
  check('after replace only one mark remains', (after2.json.marks || []).length === 1,
    JSON.stringify(after2.json.marks))

  // 单条即时标记：点一下 = 存一条；换状态 = 先撤旧再记；回出勤 = 撤销
  const day3 = '2026-01-07'
  const mk1 = await request('POST', '/api/teacher/classes/' + classId + '/attendance/mark',
    { sid: sidA, kind: '缺勤', date: day3, slot: '1-2节' }, tt)
  check('one-click mark saves immediately', mk1.status === 200 && !!mk1.json.eventId && mk1.json.kind === '缺勤',
    JSON.stringify(mk1.json))
  const mk2 = await request('POST', '/api/teacher/classes/' + classId + '/attendance/mark',
    { sid: sidA, kind: '迟到', date: day3, slot: '1-2节' }, tt)
  check('changing the mark voids the old one (no stacking)', mk2.json.voided === 1 && mk2.json.kind === '迟到',
    JSON.stringify(mk2.json))
  const dayView = await request('GET', '/api/teacher/classes/' + classId + '/attendance?date=' + day3 + '&slot=' + encodeURIComponent('1-2节'), undefined, tt)
  check('only one live mark for that student/slot', (dayView.json.marks || []).length === 1,
    JSON.stringify(dayView.json.marks))
  const mk3 = await request('POST', '/api/teacher/classes/' + classId + '/attendance/mark',
    { sid: sidA, kind: '出勤', date: day3, slot: '1-2节' }, tt)
  const dayView2 = await request('GET', '/api/teacher/classes/' + classId + '/attendance?date=' + day3 + '&slot=' + encodeURIComponent('1-2节'), undefined, tt)
  check('back to 出勤 clears the record', mk3.json.kind === '出勤' && (dayView2.json.marks || []).length === 0,
    JSON.stringify(dayView2.json.marks))

  // 课堂互动：随机点名 + 当场加减分
  const it = await request('GET', '/api/teacher/classes/' + classId + '/interact', undefined, tt)
  check('interact view lists students and presets',
    it.status === 200 && Array.isArray(it.json.students) && it.json.students.length >= 2,
    'status=' + it.status)
  const drew = await request('POST', '/api/teacher/classes/' + classId + '/rollcall/draw', { count: 1, exclude: true }, tt)
  const who = (drew.json.drawn || [])[0]
  check('random draw returns a student not picked this round', drew.status === 200 && !!who, JSON.stringify(drew.json))
  if (who) {
    const add = await request('POST', '/api/teacher/classes/' + classId + '/events',
      { sid: who.sid, item: it.json.itemKey, delta: 1, reason: 'selftest 发言' }, tt)
    check('interact add score', add.status === 200, 'status=' + add.status)
    const afterAdd = await request('GET', '/api/teacher/classes/' + classId + '/interact', undefined, tt)
    const row = (afterAdd.json.students || []).find((x) => x.sid === who.sid)
    check('interact score lands on that student', row && row.score > 0, JSON.stringify(row))
    const last = (afterAdd.json.recent || [])[0]
    if (last) {
      await request('POST', '/api/teacher/classes/' + classId + '/events/' + last.id + '/void', {}, tt)
      const afterUndo = await request('GET', '/api/teacher/classes/' + classId + '/interact', undefined, tt)
      const row2 = (afterUndo.json.students || []).find((x) => x.sid === who.sid)
      check('undo removes the interact record', row2 && row2.score === 0, JSON.stringify(row2))
    }
  }
  const afterA2 = (after2.json.scores || []).find((x) => x.sid === sidA)
  check('请假不扣分（覆盖当天后回到提交前）', afterA2 && Math.abs(afterA2.score - beforeA) < 0.01,
    'before=' + beforeA + ' after=' + (afterA2 && afterA2.score))

  // 节次：同一班同一天，两节各记各的，互不覆盖（换一天，免得和上面的用例叠加）
  const day2 = '2026-01-06'
  await request('POST', '/api/teacher/classes/' + classId + '/attendance', {
    entries: [{ sid: sidA, kind: '缺勤' }], date: day2, slot: '1-2节', replaceDay: true,
  }, tt)
  await request('POST', '/api/teacher/classes/' + classId + '/attendance', {
    entries: [{ sid: sidB, kind: '迟到' }], date: day2, slot: '3-4节',
  }, tt)
  const bySlot = await request('GET', '/api/teacher/classes/' + classId + '/attendance?date=' + day2 + '&slot=' + encodeURIComponent('3-4节'), undefined, tt)
  const allSlots = await request('GET', '/api/teacher/classes/' + classId + '/attendance?date=' + day2, undefined, tt)
  check('按节次读取：3-4 节只有那一条迟到',
    (bySlot.json.marks || []).length === 1 && bySlot.json.marks[0].slot === '3-4节' && bySlot.json.marks[0].sid === sidB,
    JSON.stringify(bySlot.json.marks))
  check('同一天两节各留各的记录', (allSlots.json.marks || []).length === 2 && (allSlots.json.slotStats || []).length === 2,
    JSON.stringify(allSlots.json.slotStats))

  // 点名状态存在服务端：教师端刷新 / 学生端刷新都能接着来
  await request('POST', '/api/teacher/classes/' + classId + '/spotlight', {
    kind: 'attend', sid: sidA, seq: 1, total: 3, lock: true,
  }, tt)
  const spGet = await request('GET', '/api/teacher/classes/' + classId + '/spotlight', undefined, tt)
  check('spotlight 状态落库（含 lock）',
    spGet.status === 200 && spGet.json.spotlight && spGet.json.spotlight.sid === sidA && spGet.json.spotlight.lock === true,
    JSON.stringify(spGet.json && spGet.json.spotlight))

  await request('POST', '/api/teacher/classes/' + classId + '/attend-state', {
    day: day2, slot: '1-2节', drawn: [sidA], order: true, scope: 'all',
  }, tt)
  const spAtt = await request('GET', '/api/teacher/classes/' + classId + '/spotlight', undefined, tt)
  check('考勤点名会话落库（抽过谁 / 顺序 / 档位）',
    spAtt.json.attend && (spAtt.json.attend.drawn || []).length === 1 && spAtt.json.attend.order === true && spAtt.json.attend.scope === 'all',
    JSON.stringify(spAtt.json && spAtt.json.attend))

  await request('POST', '/api/teacher/classes/' + classId + '/spotlight', { clear: true }, tt)
  const spCleared = await request('GET', '/api/teacher/classes/' + classId + '/spotlight', undefined, tt)
  check('结束点名后状态清空', spCleared.json.spotlight === null, JSON.stringify(spCleared.json && spCleared.json.spotlight))

  void late
}

async function testScheme(tt, classId) {
  console.log('\n[A4] assessment scheme (data + rules)')
  const scheme = require('./lib/scheme')
  const scoring = require('./lib/scoring')

  const live = scheme.current()
  check('scheme file loaded from data/schemes', !!live.file && live.items.length >= 5, live.file)


  // 项数不写死：老师在方案页可能已经增删过考核项，这里只核对结构
  check('scheme has main items and consistent totals',
    live.items.filter((i) => !i.extra).length >= 4 &&
      live.items.every((i) => i.key && i.name && i.rule && typeof i.full === 'number'),
    live.items.map((i) => i.key).join(','))

  // 校验器要挡得住常见的手改错误
  const bad = scheme.validate({
    id: 'x',
    items: [
      { key: 'a', name: 'A', full: 10, rule: { type: 'nope' } },
      { key: 'a', name: 'A2', full: 10, rule: { type: 'acc' } },
      { key: 'b', name: 'B', full: 0, rule: { type: 'avg', params: {} } },
    ],
  })
  check('validator catches unknown rule / dupCourse key / zero full / avg without grades',
    bad.errors.length >= 4, bad.errors.join(' | '))

  // 改分值不用改代码：把作业从 20 提到 30，同一批事实重算出 30
  const raw = JSON.parse(fs.readFileSync(live.file, 'utf8'))
  raw.items = raw.items.filter((i) => i.key !== 'bonus')
  raw.items.find((i) => i.key === 'homework').full = 30
  const alt = scheme.materialize(raw)
  const hw = alt.items.find((i) => i.key === 'homework')
  const evs = [{ id: 'e1', sid: 's', item: 'homework', grade: 'A', voided: false }]
  check('changing item.full re-scores without touching events',
    hw.full === 30 && scoring.itemScore(hw, evs) === 30, 'full=' + hw.full + ' score=' + scoring.itemScore(hw, evs))

  // 规则本身：等级折算 / 迟交 / 量规 / 卷面 各来一条
  const mk = (item, o) => Object.assign({ id: 'e' + Math.random(), sid: 's', item, voided: false }, o)
  const HW = scoring.itemByKey('homework')
  check('rule avg: A+B -> 92.5% of full', scoring.itemScore(HW,
    [mk('homework', { grade: 'A' }), mk('homework', { grade: 'B' })]) === 18.5,
    'score=' + scoring.itemScore(HW, [mk('homework', { grade: 'A' }), mk('homework', { grade: 'B' })]))
  check('rule avg: late A -> 50%', scoring.itemScore(HW,
    [mk('homework', { grade: 'A', late: true })]) === 10)
  check('rule avg: A–F 五档都在等级表里', ['A', 'B', 'C', 'D', 'F'].every((k) => (HW.grades || []).some((g) => g.key === k)),
    (HW.grades || []).map((g) => g.key).join(''))
  check('rule avg: F 档记 0 分', scoring.itemScore(HW, [mk('homework', { grade: 'F' })]) === 0)
  // 每次权重可调：加权平均 = Σ(系数×权重)/Σ权重
  check('rule avg: 权重 A×3 + C×1 -> 92.5%',
    scoring.itemScore(HW, [mk('homework', { grade: 'A', weight: 3 }), mk('homework', { grade: 'C', weight: 1 })]) === 18.5,
    'score=' + scoring.itemScore(HW, [mk('homework', { grade: 'A', weight: 3 }), mk('homework', { grade: 'C', weight: 1 })]))
  check('rule avg: 权重 A×1 + C×3 -> 77.5%',
    scoring.itemScore(HW, [mk('homework', { grade: 'A', weight: 1 }), mk('homework', { grade: 'C', weight: 3 })]) === 15.5,
    'score=' + scoring.itemScore(HW, [mk('homework', { grade: 'A', weight: 1 }), mk('homework', { grade: 'C', weight: 3 })]))
  check('rule avg: 不给权重 = 等权（老数据不变）',
    scoring.itemScore(HW, [mk('homework', { grade: 'A' }), mk('homework', { grade: 'C' })]) ===
      scoring.itemScore(HW, [mk('homework', { grade: 'A', weight: 1 }), mk('homework', { grade: 'C', weight: 1 })]))
  // 规则单测用**自己造的考勤项**（老师随时会改方案，单测不该跟着变）
  const attendBase = {
    key: 'attend',
    name: '考勤',
    full: 10,
    mode: 'base',
    rule: {
      type: 'base',
      params: { start: 10, perAbsent: 2, perLate: 1, floor: 0, zeroRule: { kind: '缺勤', count: 3, lateMerge: 2 } },
    },
  }
  const one = [mk('attend', { delta: -2, kind: '缺勤' })]
  check('rule base: 1 缺勤 按 perAbsent=2 扣 2 分', scoring.itemScore(attendBase, one) === 8,
    'score=' + scoring.itemScore(attendBase, one))
  const stricter = JSON.parse(JSON.stringify(attendBase))
  stricter.rule.params.perAbsent = 4
  check('rule base: 改成 perAbsent=4 后同一条记录变成 6 分', scoring.itemScore(stricter, one) === 6,
    'score=' + scoring.itemScore(stricter, one))
  const lateCut = JSON.parse(JSON.stringify(attendBase))
  lateCut.rule.params.perLate = 3
  check('rule base: 迟到按 perLate 扣（1 次迟到 3 分 → 7）',
    scoring.itemScore(lateCut, [mk('attend', { delta: -1, kind: '迟到' })]) === 7,
    'score=' + scoring.itemScore(lateCut, [mk('attend', { delta: -1, kind: '迟到' })]))
  check('rule base: 请假 / 出勤不扣分',
    scoring.itemScore(attendBase, [mk('attend', { delta: 0, kind: '请假' }), mk('attend', { delta: 0, kind: '出勤' })]) === 10)

  check('rule base: 3 absents -> 0', scoring.itemScore(attendBase,
    [mk('attend', { delta: -2, kind: '缺勤' }), mk('attend', { delta: -2, kind: '缺勤' }), mk('attend', { delta: -2, kind: '缺勤' })]) === 0)
  check('rule raw: last raw wins (90 -> 27)', scoring.itemScore(scoring.itemByKey('exam'),
    [mk('exam', { raw: 60 }), mk('exam', { raw: 90 })]) === 27)
  check('rule rubric: 12+9+6+3 = 30', scoring.itemScore(scoring.itemByKey('project'),
    [mk('project', { dims: { func: 12, code: 9, ui: 6, doc: 3 } })]) === 30)
  check('rule acc: 3 次 +1 -> 3', scoring.itemScore(scoring.itemByKey('interact'),
    [mk('interact', { delta: 1 }), mk('interact', { delta: 1 }), mk('interact', { delta: 1 })]) === 3)

  // 编辑器后端（只读部分：读方案 / 试算，都不落盘）
  const got = await request('GET', '/api/teacher/scheme', undefined, tt)
  check('GET /api/teacher/scheme returns raw + rules + forms',
    got.status === 200 && !!got.json.raw && Array.isArray(got.json.rules) && Array.isArray(got.json.forms),
    (got.json && (got.json.errors || []).join(';')) || '')
  check('editor lists all 6 rules', ((got.json && got.json.rules) || []).length === 6,
    ((got.json && got.json.rules) || []).map((r) => r.type).join(','))

  // 说明是模板：改参数后文案自动跟着变（不用手动同步）
  const rawScheme = JSON.parse(JSON.stringify(got.json.raw))
  const mat = scheme.materialize(rawScheme)
  const att = mat.items.find((i) => i.key === 'attend')
  check('item hint renders template placeholders', /缺勤每次扣 \d+ 分/.test(att.hint) && att.hint.indexOf('{') < 0, att.hint)
  const bumped = JSON.parse(JSON.stringify(rawScheme))
  bumped.items.find((i) => i.key === 'attend').rule.params.perAbsent = 6
  const att2 = scheme.materialize(bumped).items.find((i) => i.key === 'attend')
  check('changing perAbsent rewrites the hint text', att2.hint.indexOf('扣 6 分') >= 0, att2.hint)
  const hwBumped = JSON.parse(JSON.stringify(rawScheme))
  const hwItem = hwBumped.items.find((i) => i.key === 'homework')
  hwItem.full = 26
  hwItem.rule.params.lateFactor = 0.4
  const hw2 = scheme.materialize(hwBumped).items.find((i) => i.key === 'homework')
  check('hint follows full / lateFactor too', hw2.hint.indexOf('26 分') >= 0 && hw2.hint.indexOf('40%') >= 0, hw2.hint)
  check('unknown placeholder is kept as-is', scheme.fillTemplate('共 {full} 分 {nope}', { full: 7 }) === '共 7 分 {nope}')

  const draft = JSON.parse(JSON.stringify(got.json.raw))
  const hwDraft = draft.items.find((i) => i.key === 'homework')
  hwDraft.full = (Number(hwDraft.full) || 0) + 5
  const pv = await request('POST', '/api/teacher/scheme/preview', { classId, raw: draft }, tt)
  check('preview compares before/after without saving',
    pv.status === 200 && pv.json.before && pv.json.after,
    JSON.stringify(pv.json && pv.json.before) + ' -> ' + JSON.stringify(pv.json && pv.json.after))
}

async function testExam(tt, st, classId, sid) {
  console.log('\n[A5] computer-based exam (机试)')
  const stuLib = require('./lib/students')

  const made = await request('POST', '/api/teacher/assignments', { itemKey: 'exam', title: 'selftest-exam' }, tt)
  const aid = made.json && made.json.assignment && made.json.assignment.id
  check('create exam assignment', made.status === 200 && !!aid && made.json.assignment.itemKey === 'exam',
    JSON.stringify(made.json.assignment || made.json))
  if (!aid) return

  const bank = {
    kind: 'bank',
    title: 'selftest 题库卷',
    duration: 30,
    sections: [
      { id: 'c', title: '选择题', type: 'choice', score: 10, pick: 2, questions: [
        { id: 'c1', stem: '1+1=?', options: ['A. 1', 'B. 2'], answer: 'B' },
        { id: 'c2', stem: '2+2=?', options: ['A. 4', 'B. 5'], answer: 'A' },
        { id: 'c3', stem: '3+3=?', options: ['A. 5', 'B. 6'], answer: 'B' },
      ] },
      { id: 's', title: '简答', type: 'short', score: 20, pick: 1, questions: [
        { id: 's1', stem: '说说你的思路', answer: '参考' },
      ] },
    ],
  }
  const imp = await request('POST', '/api/teacher/exams/' + aid + '/paper', { source: bank }, tt)
  check('import exam bank', imp.status === 200 && imp.json.summary.kind === 'bank' && imp.json.summary.fullScore === 40,
    JSON.stringify(imp.json && imp.json.summary))
  const bad = await request('POST', '/api/teacher/exams/' + aid + '/paper',
    { source: { sections: [{ title: 'x', type: 'choice', score: 0, questions: [] }] } }, tt)
  check('bad paper rejected -> 400', bad.status === 400, 'status=' + bad.status)

  await request('POST', '/api/teacher/assignments/' + aid + '/start', {}, tt)
  const beforeStart = await request('POST', '/api/student/exams/' + aid + '/start', undefined, st)
  check('student can start the exam', beforeStart.status === 200 && !!beforeStart.json.paper, 'status=' + beforeStart.status)
  check('answers are not leaked to the student', !JSON.stringify(beforeStart.json.paper).includes('"answer"'))

  const paper = beforeStart.json.paper
  const answers = {}
  for (const sec of paper.sections) {
    for (const q of sec.questions) {
      if (sec.type === 'choice') answers[q.id] = q.id === 'c2' ? 'A' : 'B'
      if (sec.type === 'short') answers[q.id] = '随便写点'
    }
  }
  const saved = await request('POST', '/api/student/exams/' + aid + '/answers', { answers }, st)
  check('save answers', saved.status === 200)
  const submit = await request('POST', '/api/student/exams/' + aid + '/submit', undefined, st)
  check('submit auto-grades objective parts', submit.status === 200 && submit.json.autoScore === 20,
    'auto=' + (submit.json && submit.json.autoScore))

  const detail = await request('GET', '/api/teacher/exams/' + aid + '/submissions/' + submit.json.submissionId, undefined, tt)
  const shortQ = (detail.json.paper.sections.find((x) => x.type === 'short') || { questions: [] }).questions[0]
  const graded = await request('POST', '/api/teacher/exams/' + aid + '/submissions/' + submit.json.submissionId + '/grade',
    { scores: { [shortQ.id]: 18 }, comment: 'selftest' }, tt)
  check('teacher grades short answers -> total', graded.status === 200 && graded.json.graded.total === 38,
    JSON.stringify(graded.json && graded.json.graded && graded.json.graded.total))
  check('exam score lands in the score sheet (38 x 0.3 = 11.4)',
    graded.json.submission.score === 11.4, 'score=' + (graded.json.submission && graded.json.submission.score))

  const dir = require('path').join(stuLib.subOf(classId, sid, 'exam'), aid, submit.json.submissionId)
  check('answer sheet written into the student dir',
    fs.existsSync(require('path').join(dir, '答卷.md')) && fs.existsSync(require('path').join(dir, 'exam.json')), dir)

  const del = await request('DELETE', '/api/teacher/assignments/' + aid, undefined, tt)
  check('delete exam assignment', del.status === 200)
}

function readPassword() {
  try {
    const cfg = require('./config')
    return cfg.teacherPassword
  } catch (e) {
    return 'teacher'
  }
}

async function main() {
  console.log('teaching-system selftest  -> http://' + HOST + ':' + PORT)
  const trashBefore = trashSnapshot()
  const orphans = sweepOrphanExams()
  if (orphans) console.log('  清掉 ' + orphans + ' 个孤儿试卷目录（data/exams）')
  try {
    await testCompat()
  const ctx = await testApi()
    await testCast(ctx)
  } catch (e) {
    fail++
    console.log('  FAIL  unexpected error: ' + (e && e.stack ? e.stack : e))
  }
  const pruned = trashPrune(trashBefore)
  if (pruned) console.log('  清掉本次运行写进 data/.trash 的 ' + pruned + ' 个目录')
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + '  pass=' + pass + ' fail=' + fail +
    (skipped ? ' skipped=' + skipped : '') + '\n')
  process.exit(fail === 0 ? 0 : 1)
}

main()
