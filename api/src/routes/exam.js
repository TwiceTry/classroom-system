/*
 * routes/exam.js —— 机试（出卷 / 开考 / 答题 / 交卷 / 判卷）
 *
 * 数据模型：机试就是「kind=paper 的作业」+ 提交记录 + 每个学生一份答卷状态文件。
 *   · 试卷源：  data/exams/<作业id>/source.json      （导入的题库/试卷）
 *   · 纸质卷：  data/exams/<作业id>/试卷.md · 答案卷.md（老师打印）
 *   · 答卷：    data/students/<班>/<学号>/机试/<作业id>/<提交id>/exam.json
 *
 * 抽题用**种子**（作业id + 学号）：同一个学生每次进来拿到的都是同一份卷，
 * 刷新/换设备不会换题；不同学生抽到的题不同。
 */
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { requireAuth } from '../plugins/auth.js'
import { badRequest, notFound, forbidden, conflict } from '../lib/errors.js'
import * as repo from '../lib/repo.js'
import { gradeSubmission, submissionView, courseOfAssignment } from '../lib/grading.js'
import * as scheme from '../lib/scheme.js'
import { withCourseScheme } from '../lib/scheme.js'
import { pushFocus, releaseFocus, getFocus } from '../lib/focus.js'
import { broadcast } from './cast.js'
import * as examLib from '../lib/exam.js'
/* 状态判定只有一份：lib/phase.js（学生视角 phaseOf / 教师视角 teacherPhaseOf） */
import { gateOf, phaseMessage, teacherPhaseOf } from '../lib/phase.js'

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

/** 试卷目录 */
function paperDirOf(assignmentId) {
  return path.join(config.dataDir, 'exams', String(assignmentId).replace(/[^A-Za-z0-9_.-]/g, '_'))
}

/** 这次作业必须是「试卷」形态的考核项 */
function examItemOf(a) {
  const item = withCourseScheme(courseOfAssignment(a), () => scheme.itemByKey(a.itemKey))
  if (!item || item.form !== 'paper') throw badRequest('这次作业的考核项不是「试卷」形态（方案里 form 要设成 paper）')
  return item
}

function loadExam(a) {
  const raw = examLib.readJson(examLib.sourceFile(a.id), null)
  if (!raw) throw notFound('还没有导入试卷 / 题库')
  return examLib.normalize(raw)
}

/** 学生答卷状态（存文件，不进 SQLite：题目结构大且只在机试期间用） */
function readState(a, sub) {
  const file = path.join(examLib.examDir(sub.classId, sub.sid, a.id, sub.id), 'exam.json')
  return examLib.readJson(file, null)
}

function writeState(a, sub, state) {
  const dir = examLib.examDir(sub.classId, sub.sid, a.id, sub.id)
  fs.mkdirSync(dir, { recursive: true })
  examLib.writeJson(path.join(dir, 'exam.json'), state)
  if (state.graded) {
    // 交卷/判卷后留一份人看得懂的答卷（md），老师可以直接看
    try {
      const cls = repo.getClass(sub.classId)
      const ctx = {
        course: (repo.getCourse(a.courseId) || {}).name || '',
        assignment: a,
        paper: state.paper,
        student: { sid: sub.sid, name: sub.name, className: cls ? cls.name : '' },
        state,
        graded: state.graded,
      }
      fs.writeFileSync(path.join(dir, '答卷.md'), examLib.renderReport(ctx), 'utf8')
    } catch (e) {
      /* 渲染失败不影响交卷 */
    }
  }
}

/**
 * 选项统一成**字符串数组**。
 * 前端模板写的是 `{{ o }}`（历史格式就是 ["2","3"]），
 * 如果老师导入的卷子用 [{key,text}]，学生端就会显示成 [object Object]。
 * 在后端归一一次，比让每个页面都写兼容判断稳。
 */
function normalizeOptions(paper) {
  if (!paper || !Array.isArray(paper.sections)) return paper
  for (const s of paper.sections) {
    for (const q of s.questions || []) {
      if (Array.isArray(q.options)) {
        q.options = q.options.map((o) => (typeof o === 'string' ? o : o.text || o.label || o.key || ''))
      }
    }
  }
  return paper
}

function remainingOf(state) {
  if (!state.paper || !state.paper.duration) return null
  const end = new Date(state.startedAt).getTime() + state.paper.duration * 60000
  return Math.max(0, Math.round((end - Date.now()) / 1000))
}

/** 幂等开考：已有答卷就返回它，没有才抽题新建 */
function ensureSubmission(a, t) {
  const mine = repo.submissionsOf(a.id).filter((s) => s.sid === t.sid && s.classId === t.classId)
  const last = mine[mine.length - 1]
  if (last) {
    const st = readState(a, last)
    if (st) return { sub: last, state: st }
  }
  const exam = loadExam(a) // 没导卷子在这里就抛，别先建 sub 留下脏记录
  const sub = repo.insertSubmission({
    id: uid('sb'),
    assignmentId: a.id,
    classId: t.classId,
    sid: t.sid,
    name: t.name,
    createdAt: new Date().toISOString(),
  })
  /*
   * 抽题种子 = 作业 + 学号 + **这一份答卷的 id**。
   *
   * 原来只有「作业 + 学号」：同一个人每次进来都是同一套题（这是对的，
   * 断电重进要能接着答）。但重考时就不行了 —— 老师让他重考，抽到的还是
   * 刚才那张卷子，等于背答案。
   *
   * 答卷 id 是每次新建才生成的，而重考会删掉旧答卷重新建，
   * 于是「同一次考试稳定、重考换一套」两件事同时成立。
   */
  const { paper } = examLib.paperFor(exam, a.id + ':' + t.sid + ':' + sub.id)
  const state = { paper, answers: {}, startedAt: new Date().toISOString(), submittedAt: '', graded: null }
  writeState(a, sub, state)
  return { sub, state }
}

/**
 * 收一份卷子：判客观题 + 记账 + 落盘。**学生自己交**和**老师强制交**都走这里。
 *
 * 抽出来是因为两条路必须完全一样：同样的判分、同样的分数。
 * 如果各写一遍，迟早会出现「老师替他交的分和学生自己交的对不上」。
 *
 * @param {string} by  谁交的。空 = 学生自己；非空 = 教师强制（记进 graded.forcedBy，事后能追溯）
 */
function finishExam(a, sub, state, by) {
  if (state.submittedAt) {
    /* 重查一次：传进来的 sub 可能是交卷之前那一份的快照，分还没写进去 */
    const fresh = repo.findSubmission(a.id, sub.sid) || sub
    return {
      already: true,
      autoScore: state.graded ? state.graded.autoScore : 0,
      total: state.graded ? state.graded.total : 0,
      score: typeof fresh.score === 'number' ? fresh.score : null,
    }
  }
  state.submittedAt = new Date().toISOString()
  state.graded = examLib.autoGrade(state.paper, state.answers || {}, {})
  state.graded.at = state.submittedAt
  if (by) state.graded.forcedBy = by
  writeState(a, sub, state)

  /*
   * 自动判分立刻进计分表：学生交完就能看到分，老师再改也是「撤旧记新」。
   * 强制交卷时把经手人写进 reason，计分流水里能看出这次不是学生自己交的。
   */
  const graded = gradeSubmission(a, sub, by ? '机试强制交卷（' + by + '）' : '机试自动判分', {
    raw: state.graded.autoScore,
    comment: '',
  })
  return { autoScore: state.graded.autoScore, total: state.graded.total, score: graded.score }
}

export default async function examRoutes(app) {
  /* ============================ 教师侧 ============================ */

  /** 导入试卷 / 题库（老师把 JSON 贴进来），顺带出「试卷 / 答案卷」各一份 */
  app.post('/api/exams/:id/paper', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: { source: { type: 'object' } },
        additionalProperties: true,
      },
    },
    handler: async (req) => {
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      examItemOf(a)
      const src = req.body.source || req.body
      const norm = examLib.normalize(src)
      const check = examLib.validate(norm)
      if (check.errors.length) throw badRequest(check.errors.join('；'))

      /*
       * 卷面满分与方案对不上时提醒。
       *
       * 方案的「卷面折算」规则自带两个数：rawFull（卷面按多少分算）和 factor（折合系数）。
       * 如果出卷时卷面总分不是 rawFull，学生就**永远拿不到该项满分** ——
       * 比如方案写「卷面 100 折 30 分」，而卷子只出了 30 分：
       * 全对也只有 30 × 0.3 = 9 分，剩下的 21 分拿不到，而且界面上看不出原因。
       *
       * 不阻断（有人可能确实想用小卷面、或者打算手工调分），但必须说清楚后果。
       */
      {
        const it = examItemOf(a)
        const want = Number(it.rawFull || 100)
        const f = Number(it.factor || (want ? it.full / want : 0.3))
        if (norm.fullScore && want && Math.abs(norm.fullScore - want) > 0.01) {
          const canGet = Math.round(norm.fullScore * f * 10) / 10
          check.warnings.push(
            '这份卷的卷面满分是 ' + norm.fullScore + ' 分，而方案里「' + it.name + '」按卷面 ' +
              want + ' 分、乘以 ' + f + ' 折合成本项 ' + it.full + ' 分。' +
              '照现在这样，学生卷面全对也只能拿到 ' + canGet + ' / ' + it.full + ' 分。' +
              '要么把卷子改成 ' + want + ' 分，要么把方案里「' + it.name + '」的卷面满分改成 ' +
              norm.fullScore + '。'
          )
        }
      }

      const dir = paperDirOf(a.id)
      fs.mkdirSync(dir, { recursive: true })
      examLib.writeJson(examLib.sourceFile(a.id), src)

      // 空白卷 + 答案卷（md / html 各一份，老师直接打印）
      const paper = examLib.printPaper(norm, a.id)
      const base = {
        course: (repo.getCourse(a.courseId) || {}).name || '',
        assignment: a,
        paper,
        student: null,
      }
      try {
        fs.writeFileSync(path.join(dir, '试卷.md'), examLib.renderPaperMd(Object.assign({}, base, { withAnswer: false })), 'utf8')
        fs.writeFileSync(path.join(dir, '答案卷.md'), examLib.renderPaperMd(Object.assign({}, base, { withAnswer: true })), 'utf8')
        fs.writeFileSync(path.join(dir, '试卷.html'), examLib.renderHtml(Object.assign({}, base, { withAnswer: false })), 'utf8')
        fs.writeFileSync(path.join(dir, '答案卷.html'), examLib.renderHtml(Object.assign({}, base, { withAnswer: true })), 'utf8')
      } catch (e) {
        /* 渲染失败不影响导入 */
      }

      return {
        ok: true,
        paperDir: dir,
        warnings: check.warnings,
        summary: {
          kind: norm.kind,
          title: norm.title,
          duration: norm.duration,
          fullScore: norm.fullScore,
          sections: norm.sections.map((s) => ({
            id: s.id,
            title: s.title,
            type: s.type,
            typeName: examLib.TYPE_NAME[s.type],
            score: s.score,
            pick: s.pick,
            count: s.questions.length,
          })),
        },
      }
    },
  })

  /** 这场机试的概况 + 每个学生的进度与得分 */
  /**
   * 改这场考试的时长（分钟）。
   *
   *   PATCH /api/exams/:id/duration  { minutes }
   *
   * 三件事都要做，少一件就会出现「老师说延长了 10 分钟，学生那边照样到点交卷」：
   *
   *   ① 改源文件 —— 之后才开考的学生按新时长
   *   ② 改**已经在考**的学生的答卷 state —— 它们开考时把 paper（含 duration）
   *      快照进了 exam.json，而 remainingOf() 算的是 startedAt + paper.duration。
   *      不动这份快照，改源文件对他们完全无效
   *   ③ 广播 —— 学生端立刻重算倒计时，不用刷新
   *
   * 缩短到比「已用时间」还短，学生那边会立刻归零并自动交卷 —— 这是老师的选择，
   * 但返回值里告诉他影响了多少个正在考的人，别让他无意识地这么干。
   */
  app.patch(
    '/api/exams/:id/duration',
    {
      preHandler: requireAuth('teacher'),
      schema: {
        body: {
          type: 'object',
          required: ['minutes'],
          properties: { minutes: { type: 'number' } },
        },
      },
    },
    async (req) => {
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      examItemOf(a)

      const mins = Math.floor(Number(req.body.minutes))
      if (!(mins > 0)) throw badRequest('时长要大于 0 分钟（不限时请把整场考试删掉重开）')
      if (mins > 600) throw badRequest('时长最长 600 分钟（10 小时），再长请分两场')

      /* ① 源文件：之后开考的人用新时长 */
      const srcFile = examLib.sourceFile(a.id)
      const src = examLib.readJson(srcFile, null)
      if (!src) throw badRequest('这场考试还没导入试卷')
      src.duration = mins
      examLib.writeJson(srcFile, src)

      /* ② 已经在考的人：他们的 paper 是开考时的快照，得单独改 */
      let inProgress = 0
      for (const sub of repo.submissionsOf(a.id)) {
        const st = readState(a, sub)
        if (!st || st.submittedAt) continue
        st.paper = Object.assign({}, st.paper, { duration: mins })
        writeState(a, sub, st)
        inProgress++
      }

      /* ③ 学生端马上跟着变 */
      const delivered = broadcast({
        t: 'assignment',
        action: 'duration',
        id: a.id,
        title: a.title,
        minutes: mins,
      })

      return { ok: true, minutes: mins, inProgress, delivered }
    }
  )

  app.get('/api/exams/:id', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    examItemOf(a)
    const raw = examLib.readJson(examLib.sourceFile(a.id), null)
    // 给前端**完整**试卷结构：教师页要读 paper.kind / paper.sections.length 来渲染摘要，
    // 少一个字段页面就炸在 undefined.length。
    const norm = raw ? examLib.normalize(raw) : null
    const subs = repo.submissionsOf(a.id)
    const names = new Map(repo.listClasses().map((c) => [c.id, c.name]))
    return {
      /*
       * 前端状态标签用 stateOf(collecting / overDue / started) 算，
       * 只给 status 的话它拿不到另外两个 —— 一场**已经结束**的考试
       * 会显示成「未开始」（观察到的现象）。三个都给，和列表接口同一套口径。
       */
      assignment: {
        id: a.id,
        title: a.title,
        status: a.status,
        itemKey: a.itemKey,
        dueAt: a.dueAt || '',
        allowLate: !!a.allowLate,
        started: !!a.openedAt,
        overDue: !!(a.dueAt && Date.parse(a.dueAt) && Date.now() > Date.parse(a.dueAt)),
        /*
         * 教师视角的阶段 —— 和课堂作业页同一份判定（lib/phase.js）。
         *
         * 原来这里自己拼了一个 collecting（status + 截止时间），
         * 分批时整场永远是 closed，于是恒 false；
         * 教师端又不能读它（读了永远「未开始」），只能去看 openBatches ——
         * 同一个状态两套算法，就是「状态不更新」这类问题的来源。
         */
        phase: teacherPhaseOf(a),
        /*
         * 有几批正在放人（open 且没过时间）。
         *
         * 这个字段必须挂在 assignment 里 —— 教师端 stateOf(d.assignment) 读的就是它。
         * 分批时整场 status 永远是 closed，只看 collecting 会一律显示「未开始」，
         * 而那正是「状态没实时更新」的观感：数据一直在刷，只是这一句话没跟着变。
         */
        openBatches: repo
          .batchesOf(a.id)
          .filter((b) => b.status === 'open' && !repo.batchOverdue(b)).length,
      },
      imported: !!raw,
      paper: norm
        ? {
            kind: norm.kind,
            title: norm.title,
            fullScore: norm.fullScore,
            duration: norm.duration,
            // 摘要里显示「单选(2 题)」：pick 为空时用实际题数兜底
            sections: norm.sections.map((s) => Object.assign({}, s, { count: (s.questions || []).length })),
          }
        : null,
      rows: subs.map((s) => {
        const st = readState(a, s)
        return Object.assign(submissionView(s, names.get(s.classId)), {
          startedAt: st ? st.startedAt : '',
          submittedAt: st ? st.submittedAt || '' : '',
          answered: st && st.answers ? Object.keys(st.answers).length : 0,
          autoScore: st && st.graded ? st.graded.autoScore : null,
          })
          }),
          /*
           * 分批放人：机试也要能分几批考（机器不够的时候只能一批一批来）。
           *
           * 这批字段和课堂作业那边是同一套形状 —— 前端两块面板长得一样，
           * 数据不一样就会分叉成两种写法。
           */
          batches: repo.batchesOf(a.id).map((b) => {
            const over = repo.batchOverdue(b)
            const leftMs = b.dueAt ? Date.parse(b.dueAt) - Date.now() : 0
            const inBatch = subs.filter((s) => b.sids.includes(s.sid))
            return {
              id: b.id,
              seq: b.seq,
              status: b.status,
              openedAt: b.openedAt,
              closedAt: b.closedAt,
              dueAt: b.dueAt,
              note: b.note,
              count: b.sids.length,
              submitted: inBatch.filter((s) => {
                const st = readState(a, s)
                return !!(st && st.submittedAt)
              }).length,
              started: inBatch.length,
              overDue: over,
              leftMin: b.dueAt && !over ? Math.max(1, Math.ceil(leftMs / 60000)) : 0,
            }
          }),
          /* 全班名单（带「考没考」「在第几批」），分批放人要勾人 */
          roster: repo.listClasses().flatMap((cl) =>
            repo.rosterOf(cl.id).map((s) => {
              const sub = subs.find((x) => x.sid === s.sid && x.classId === cl.id)
              const st = sub ? readState(a, sub) : null
              /* 已经在第几批 —— 开下一批时默认只勾「还没排过」的人 */
              const inB = repo.batchesOf(a.id).filter((b) => b.sids.includes(String(s.sid)))
              const lastB = inB.length ? inB[inB.length - 1] : null
              return {
                sid: s.sid,
                name: s.name,
                classId: cl.id,
                className: cl.name,
                submitted: !!(st && st.submittedAt),
                started: !!st,
                batchSeq: lastB ? lastB.seq : 0,
                batched: !!lastB,
              }
            })
          ),
          openBatches: repo.batchesOf(a.id).filter((b) => b.status === 'open' && !repo.batchOverdue(b)).length,

          /*
           * 补考放行名单**没有了** —— 重考改成「从批次里剔除，下一批重新勾他」。
           * 那个名单存在的唯一理由就是「重考会删掉答卷、老师看不见人」，
           * 而现在这个人会回到 roster 里（batched=false），在选人面板上看得见。
           */
          }
          })

  /** 下载纸质卷（?answer=1 取答案卷；fmt=md|html） */
  app.get('/api/exams/:id/paper-file/:fmt', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const answer = String(req.query.answer || '') === '1'
    const fmt = String(req.params.fmt || 'md').toLowerCase() === 'html' ? 'html' : 'md'
    const file = path.join(paperDirOf(a.id), (answer ? '答案卷.' : '试卷.') + fmt)
    if (!fs.existsSync(file)) throw notFound('还没导入试卷')
    const st = fs.statSync(file)
    return reply
      .status(200)
      .headers({
        'Content-Type': fmt === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Content-Length': st.size,
        'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(path.basename(file)),
      })
      .send(fs.createReadStream(file))
  })

  /** 判卷（老师改机试分：录卷面分 → 按方案折算并记账） */
  app.post('/api/exams/:id/submissions/:subId/grade', {
    preHandler: requireAuth('teacher'),
    schema: {
      body: {
        type: 'object',
        properties: {
          raw: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          comment: { type: 'string', maxLength: 1000 },
        },
      },
    },
    handler: async (req) => {
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      const sub = repo.findSubmission(a.id, req.params.subId) || hydrateById(req.params.subId)
      if (!sub) throw notFound('答卷不存在')
      const patch = { comment: req.body.comment || '' }
      if (req.body.raw !== undefined && req.body.raw !== null && String(req.body.raw) !== '') patch.raw = Number(req.body.raw)
      return { submission: submissionView(gradeSubmission(a, sub, req.user.name || '教师', patch)) }
    },
  })

  /**
   * 让某一个学生重考。
   *
   *   POST /api/exams/:id/submissions/:subId/reset
   *
   * 用在哪里：设备坏了、误交卷、考砸了想补一次。
   *
   * 做四件事（顺序有讲究）：
   *   ① 撤掉这次记的分 —— 不撤的话分数会在计分表里悬着，而对应的答卷已经没了
   *   ② 删掉答卷记录 —— 下次开考 ensureSubmission 会重新建一份
   *   ③ 删掉答卷目录（exam.json + 那份 md）—— 不清就是"重新进还接着答"
   *   ④ 广播 —— 学生如果正开着考试页，要能立刻被退回「未开考」
   *
   * 重考会**换一套题**：抽题种子带上了答卷 id（见 ensureSubmission），
   * 旧答卷删了、新答卷换个 id，题库卷就抽到另一套。统一卷当然还是同一份。
   *
   * 时限也重新算：startedAt 随新答卷重建，等于给满时长。
   */
  app.post('/api/exams/:id/submissions/:subId/reset', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    examItemOf(a)
    const sub = repo.findSubmission(a.id, req.params.subId) || hydrateById(req.params.subId)
    if (!sub) throw notFound('答卷不存在')

    /* ① 撤分 */
    if (sub.eventId) {
      try {
        const ev = repo.findEvent(sub.classId, sub.eventId)
        if (ev && !ev.voided) repo.voidEvent(sub.classId, sub.eventId, '老师安排重考')
      } catch (e) {
        /* 撤不掉也别卡住重考 —— 分数是次要的，先让学生能再考一次 */
      }
    }

    /* ② 删答卷记录 */
    try {
      repo.db().prepare('DELETE FROM submissions WHERE id = ?').run(sub.id)
    } catch (e) {
      throw badRequest('删不掉这份答卷：' + e.message)
    }

    /* ③ 删答卷目录 */
    try {
      const dir = examLib.examDir(sub.classId, sub.sid, a.id, sub.id)
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      /* 文件删不掉不影响开新卷（新答卷会建新目录），只是磁盘上留一份旧文件 */
    }

    /*
     * ④ 把他从**所有批次**里剔除。
     *
     * 这是「重考」的新口径：不再单独给一个人开门，而是把他退回到
     * 「还没排过批」的状态 —— 老师下一批勾人的时候，他就在「剩下的 N 人」里。
     *
     * 比原来那套「放行」好在：
     *   · 开放考试的通道只有一个（批次），不会出现「放行」和「批次」两套并存
     *   · 老师看到的是「他回到队伍里了」，而不是「我给他开了个后门」
     *   · 学生端口径一致：被剔除 = 还没轮到你（而不是特殊状态）
     */
    let removedFrom = 0
    for (const b of repo.batchesOf(a.id)) {
      if (!b.sids.some((x) => String(x) === String(sub.sid))) continue
      const left = b.sids.filter((x) => String(x) !== String(sub.sid))
      /* 剔空了就把这一批关掉：留着一条 0 人的「进行中」只会让人困惑 */
      repo.updateBatch(b.id, {
        sids: left,
        ...(left.length ? {} : { status: 'closed', closedAt: new Date().toISOString() }),
      })
      removedFrom++
    }

    /* ⑤ 通知学生端 */
    const delivered = broadcast({
      t: 'assignment',
      action: 'exam-reset',
      id: a.id,
      title: a.title,
      sid: sub.sid,
      name: sub.name,
    })

    return {
      ok: true,
      sid: sub.sid,
      name: sub.name,
      delivered,
      removedFrom,
      message:
        (sub.name || sub.sid) +
        ' 已移出' +
        (removedFrom ? ' ' + removedFrom + ' 个批次' : '（原本就不在任何批次里）') +
        '。下一批勾人时他会在「剩下的」名单里',
    }
  })

  /**
   * 教师强制收某个人的卷（立即交卷）。
   *
   *   POST /api/exams/:id/submissions/:subId/force-submit
   *
   * 用在：设备坏了交不上、发现违纪要立刻收、学生说"我卡住了"。
   *
   * 和「重考」的区别是根本性的：
   *   强制交卷  把**他现在已经答的**收上来，正常判分，分数算数
   *   重考      清空重来，之前那次作废
   *
   * 所以这里绝不能弹「确定吗」之后悄悄改成后者 —— 老师要的是收卷，不是重考。
   *
   * 判分走的是和学生自己交卷同一个 finishExam()，保证两条路得分一致。
   * 剩下的时间归零与否不重要了：submittedAt 一写，答案就冻结，他再想改也交不上去
   * （保存答案那条会拒绝「已经交卷了」）。
   */
  app.post('/api/exams/:id/submissions/:subId/force-submit', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    examItemOf(a)
    const sub = repo.findSubmission(a.id, req.params.subId) || hydrateById(req.params.subId)
    if (!sub) throw notFound('答卷不存在')

    const state = readState(a, sub)
    if (!state) throw badRequest('这个学生还没开考，没有可收的答卷')

    const done = finishExam(a, sub, state, req.user.name || '教师')

    /* 通知学生端：他的页面要立刻变成「已交卷」，别让他以为还能继续答 */
    const delivered = broadcast({
      t: 'assignment',
      action: 'exam-force-submit',
      id: a.id,
      title: a.title,
      sid: sub.sid,
      name: sub.name,
    })

    return Object.assign(
      {
        ok: true,
        already: !!done.already,
        sid: sub.sid,
        name: sub.name,
        delivered,
        message: done.already
          ? (sub.name || sub.sid) + ' 已经交过卷了'
          : (sub.name || sub.sid) + ' 的卷子已收，客观题自动判分',
      },
      done
    )
  })

  /** 取消某个人的补考放行（整场已结束时，他就进不来了） */

  /** 教师看某一份答卷（答案 + 得分） */
  app.get('/api/exams/:id/submissions/:subId', { preHandler: requireAuth('teacher') }, async (req) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const sub = repo.findSubmission(a.id, req.params.subId) || hydrateById(req.params.subId)
    if (!sub) throw notFound('答卷不存在')
    const st = readState(a, sub)
    return {
      submission: submissionView(sub),
      state: st ? { answers: st.answers, startedAt: st.startedAt, submittedAt: st.submittedAt, graded: st.graded } : null,
      paper: st ? normalizeOptions(examLib.publicPaper(st.paper)) : null,
    }
  })

  /** 教师下载某份答卷（渲染成 md/html） */
  app.get('/api/exams/:id/submissions/:subId/paper-file/:fmt', { preHandler: requireAuth('teacher') }, async (req, reply) => {
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const sub = repo.findSubmission(a.id, req.params.subId) || hydrateById(req.params.subId)
    if (!sub) throw notFound('答卷不存在')
    const st = readState(a, sub)
    if (!st || !st.graded) throw notFound('这份答卷还没交卷')
    const cls = repo.getClass(sub.classId)
    const ctx = {
      course: (repo.getCourse(a.courseId) || {}).name || '',
      assignment: a,
      paper: st.paper,
      student: { sid: sub.sid, name: sub.name, className: cls ? cls.name : '' },
      state: st,
      graded: st.graded,
    }
    const fmt = String(req.params.fmt || 'md').toLowerCase() === 'html' ? 'html' : 'md'
    const body = fmt === 'html' ? examLib.renderHtml(ctx) : examLib.renderReport(ctx)
    return reply
      .status(200)
      .headers({
        'Content-Type': fmt === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Content-Disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent(sub.sid + '-答卷.' + fmt),
      })
      .send(body)
  })

  /* ============================ 学生侧 ============================ */

  /** 学生下载自己的答卷 */
  app.get('/api/student/exams/:id/paper-file/:fmt', { preHandler: requireAuth('student') }, async (req, reply) => {
    const t = req.user
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const mine = repo.submissionsOf(a.id).filter((s) => s.sid === t.sid && s.classId === t.classId)
    const sub = mine[mine.length - 1]
    if (!sub) throw notFound('你还没开卷')
    const st = readState(a, sub)
    if (!st || !st.graded) throw notFound('还没交卷')
    const cls = repo.getClass(sub.classId)
    const ctx = {
      course: (repo.getCourse(a.courseId) || {}).name || '',
      assignment: a,
      paper: st.paper,
      student: { sid: sub.sid, name: sub.name, className: cls ? cls.name : '' },
      state: st,
      graded: st.graded,
    }
    const fmt = String(req.params.fmt || 'md').toLowerCase() === 'html' ? 'html' : 'md'
    return reply
      .status(200)
      .headers({
        'Content-Type': fmt === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Content-Disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent('我的答卷.' + fmt),
      })
      .send(fmt === 'html' ? examLib.renderHtml(ctx) : examLib.renderReport(ctx))
  })

  /** 开考（幂等：刷新/换设备还是同一份卷） */
  app.post('/api/student/exams/:id/start', { preHandler: requireAuth('student') }, async (req) => {
    const t = req.user
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    examItemOf(a)
    /*
     * 整场结束了，但这个人是老师放行补考的 → 放他进去。
     *
     * 没有这一条的话，「重考」只对「考试还在收」的时候有用：
     * 一旦老师点了结束（或者到点自动结束），重置完学生点开考还是被拒，
     * 而老师那边的入口已经变成「再开一场」—— 一个人补考要把整场重新开一遍。
     */
    /*
     * 三种放行方式，任一成立就能考：
     *   ① 整场开着            —— 全班
     *   ② 他在某一批里、那批 open —— 分批（机器不够就一批一批来）
     *   ③ 单人放行            —— 整场结束后的补考
     */
    /*
     * 能不能进：统一问 lib/phase.js。
     *
     * 机试现在和作业**完全同一条通道** —— 只有批次能放人。
     * 原来的「单人放行」（exam_passes）已经去掉了：
     * 重考改成「把人从批次里剔除，下一批重新勾他」，
     * 补考就是「开一批只放他」。多一套后门只会多一套状态要维护。
     */
    const g = gateOf(a, t.sid)
    if (!g.ok) throw forbidden(phaseMessage(g.via, a))
    const { sub, state } = ensureSubmission(a, t)
    /* 开考即占住学生端屏幕（优先级最高，谁都压不掉）——交卷时释放 */
    lockExamFocus(a, t, state)
    return {
      submissionId: sub.id,
      paper: normalizeOptions(examLib.publicPaper(state.paper)),
      answers: state.answers || {},
      startedAt: state.startedAt,
      submittedAt: state.submittedAt || '',
      remaining: remainingOf(state),
    }
  })

  /** 当前状态（不抽题，只读） */
  app.get('/api/student/exams/:id/current', { preHandler: requireAuth('student') }, async (req) => {
    const t = req.user
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    const mine = repo.submissionsOf(a.id).filter((s) => s.sid === t.sid && s.classId === t.classId)
    const sub = mine[mine.length - 1]
    // 没开考也要给空壳字段：前端会直接读 answers[qid]，少一个键就炸在 undefined
    if (!sub) return { started: false, answers: {}, paper: null, submittedAt: '', remaining: null }
    const st = readState(a, sub)
    if (!st) return { started: false, answers: {}, paper: null, submittedAt: '', remaining: null }
    return {
      started: true,
      submissionId: sub.id,
      paper: normalizeOptions(examLib.publicPaper(st.paper)),
      answers: st.answers || {},
      startedAt: st.startedAt,
      submittedAt: st.submittedAt || '',
      remaining: remainingOf(st),
      score: typeof sub.score === 'number' ? sub.score : null,
      comment: sub.comment || '',
    }
  })

  /** 保存答案（交卷后不可改；超时不可改） */
  app.post('/api/student/exams/:id/answers', {
    preHandler: requireAuth('student'),
    schema: {
      body: {
        type: 'object',
        properties: { answers: { type: 'object' } },
      },
    },
    handler: async (req) => {
      const t = req.user
      const a = repo.getAssignment(req.params.id)
      if (!a) throw notFound('作业不存在')
      examItemOf(a)
      const { sub, state } = ensureSubmission(a, t)
      if (state.submittedAt) throw conflict('已经交卷了，不能再改')
      const left = remainingOf(state)
      if (left !== null && left <= 0) throw forbidden('考试时间到了，不能再作答')
      state.answers = Object.assign({}, state.answers, req.body.answers || {})
      writeState(a, sub, state)
      return { ok: true, remaining: left, answered: Object.keys(state.answers).length }
    },
  })

  /** 交卷：自动判分 + 立刻记账（老师之后还能改分） */
  app.post('/api/student/exams/:id/submit', { preHandler: requireAuth('student') }, async (req) => {
    const t = req.user
    const a = repo.getAssignment(req.params.id)
    if (!a) throw notFound('作业不存在')
    examItemOf(a)
    const { sub, state } = ensureSubmission(a, t)
    if (state.submittedAt) return { ok: true, already: true, submissionId: sub.id }

    const done = finishExam(a, sub, state, '')
    /* 交卷即退出「考试中」；同班还有人没交就继续占着 */
    unlockExamFocus(a, t)
    return Object.assign({ ok: true, submissionId: sub.id }, done)
  })
}

/* ---------------- 考试期间的「屏幕占用」---------------- */

const examDeps = () => ({ repo, broadcast })

/**
 * 开考 → 占住学生端屏幕。
 *
 * 优先级 100，压过点名(80)、做作业(60)、讲义跟随/代码同步(40)：
 * 正在答题的学生，不该因为老师翻页讲义或点个名就被拽走 —— 那是会丢分的。
 *
 * 记录里维护一份 sids（这场考试还有谁在考），交卷时逐个剔除，
 * 全交完才真的放开。带 expiresAt（时长 + 10 分钟宽限）：
 * 学生没交卷就关掉浏览器的话，状态不会永远卡在「考试中」。
 */
function lockExamFocus(a, t, state) {
  const cid = String(t.classId || '')
  if (!cid) return
  const cur = getFocus(cid, examDeps())
  const prev = cur && cur.kind === 'exam' && cur.payload && Array.isArray(cur.payload.sids) ? cur.payload.sids : []
  const sids = prev.includes(String(t.sid)) ? prev : prev.concat([String(t.sid)])
  const mins = Number((state.paper && state.paper.duration) || 0) || 60
  const start = Date.parse(state.startedAt || '') || Date.now()
  pushFocus(
    cid,
    'exam',
    {
      sids,
      assignmentId: a.id,
      title: a.title || '',
      expiresAt: new Date(start + (mins + 10) * 60 * 1000).toISOString(),
    },
    examDeps()
  )
}

/** 交卷 → 把自己从「在考名单」里去掉；全都交完才放开屏幕 */
function unlockExamFocus(a, t) {
  const cid = String(t.classId || '')
  if (!cid) return
  const cur = getFocus(cid, examDeps())
  if (!cur || cur.kind !== 'exam') return
  const prev = cur.payload && Array.isArray(cur.payload.sids) ? cur.payload.sids : []
  const sids = prev.filter((x) => x !== String(t.sid))
  if (!sids.length) {
    releaseFocus(cid, 'exam', examDeps())
    return
  }
  pushFocus(
    cid,
    'exam',
    Object.assign({}, cur.payload, { sids }),
    examDeps()
  )
}

/** 兜底：直接按提交 id 查（机试路由允许用 subId） */
function hydrateById(id) {
  const row = repo.db().prepare(`SELECT * FROM submissions WHERE id = ?`).get(String(id))
  return row ? repo.hydrate(row) : null
}
