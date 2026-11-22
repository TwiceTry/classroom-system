<template>
  <PageShell>
    <template #head>
      <PageHead @reload="loadAll">
        <template #title>{{ moduleTitle }}</template>
        <!--
          副标题改放批阅进度：交了几份、还有几份没批。
          操作流程（新建 → 开始 → 边看边打分）挪到 title。
        -->
        <template #sub>
          <span :title="'新建 → 点「开始」收作业 → 学生交一份这里就多一条，按时间顺序排，边看边打分'">
            {{ hwSub }}
          </span>
        </template>
        <!-- 专属区：只有这一页有的操作。刷新走通用区那个「↻」，这里不再重复放 -->
        <template #right>
          <button class="btn mini" @click="openLib" title="作业设计目录：已导入 / 新建的设计都可以在这里挑、导入、导出">
            作业目录
          </button>
          <button class="btn primary" @click="openEditor('new')">＋ 新建作业</button>
        </template>
      </PageHead>
    </template>
    <p v-if="err" class="hint err">{{ err }}</p>

    <!-- 批阅进度：谁没交、批了几个 -->
    <div v-if="prog && prog.studentCount" class="progbar">
      <span class="pb-k">已交</span>
      <b>{{ prog.submitted }}</b><span class="dim">/ {{ prog.studentCount }} 人</span>
      <span class="pb-sep"></span>
      <span class="pb-k">已批</span>
      <b>{{ prog.graded }}</b>
      <span class="dim">· 待批 {{ prog.pending }}</span>
      <span class="pb-sep"></span>
      <span class="pb-k">未交</span>
      <b :class="{ 'pb-warn': prog.missing.length }">{{ prog.missing.length }}</b>
      <button v-if="prog.missing.length" class="linkish" @click="showMissing = !showMissing">
        {{ showMissing ? '收起名单' : '看名单' }}
      </button>
      <span v-if="showMissing" class="pb-miss dim">{{ missingText }}</span>
    </div>

    <!-- 作业切换条：一个学期就几份，横向摆开比下拉好点 -->
    <div class="card hwbar">
      <button
      v-for="a in list"
      :key="a.id"
      class="pill hwpill"
      :class="{ on: a.id === curId }"
      @click="select(a.id)"
      >
      <!--
        状态读 collecting（实际还在收），不读 status。
        到期之后不需要老师手动点「结束」，这里自己就翻成「已截止」。
        区分「时间到」和「老师停的」：前者要告诉老师还能改截止时间再开。
      -->
      <i class="led" :class="collectingOf(a) ? 'on' : a.started ? 'off' : ''"></i>
      {{ a.title }}
      <span class="dim">{{ stateOf(a).text }}</span>
      <span v-if="a.weight && Number(a.weight) !== 1" class="cnt" :title="'权重 ' + a.weight">×{{ a.weight }}</span>
      <span class="cnt">{{ a.studentCount }}</span>
    </button>
    <span v-if="!list.length && !loading" class="dim" style="font-size: var(--fs-md)">还没有作业，点右上角「＋ 新建作业」。</span>
    </div>

    <template v-if="d">
    <!-- 控制台：开始 / 结束 -->
    <div class="card ctrl">
      <div class="ctrl-l">
        <h3>
          {{ d.assignment.title }}
          <span class="tag" :class="stateOf(d.assignment).tone">{{ stateOf(d.assignment).text }}</span>
        </h3>
        <p class="dim mini">
          {{ d.assignment.selfCode ? '作业自带代码（建作业时复制了一份）' : '对应示例：' + d.assignment.dirTitle }}
          <span v-if="d.assignment.note"> · {{ d.assignment.note }}</span>
        </p>
        <p class="mini dim">
          <span v-if="d.assignment.openedAt">开始于 {{ when(d.assignment.openedAt) }}</span>
          <!-- 有批在放人的时候不能说「学生端是灰的」—— 那批人是亮的 -->
          <span v-else-if="d.assignment.openBatches">整场没开，正在按批次放人</span>
          <span v-else>还没开始过，学生端现在是灰的</span>
          <span v-if="d.assignment.closedAt"> · 结束于 {{ when(d.assignment.closedAt) }}</span>
        </p>
      </div>
      <div class="ctrl-r">
        <!--
          按钮也按 collecting 走。到期之后自动变成「再收一轮」——
          老师想延长不用先去改状态，直接点它（会提示改截止时间）。
        -->
        <!--
          这里原来有「▶ 开始作业 / ■ 结束作业」两个按钮，**去掉了**。
          现在唯一的入口是下面的「分批开始」：勾人 → 开始这一批。
          全选一批就等于全班，和原来的「开始作业」完全等价。

          去掉的理由：两套入口同时在，学生端就要同时兼容「整场 open」和
          「批次 open」两种状态，一处没对齐就出现「按钮亮着点进去是灰的」。
          只留批次，状态来源只有一个。
        -->
        <button class="btn mini" @click="openEditor('edit')">改标题 / 说明</button>
        <button class="btn mini danger" @click="remove">删除</button>
      </div>
    </div>

    <!--
      分批开始：机器不够、要盯纪律、或者想分两拨做的时候用。

      和「▶ 开始作业」的分工：
        开始作业   全班一起（一下子都放进来）
        分批       一次放几个人，这批做完点「结束这批」，再放下一批
      两者不冲突 —— 整场开着的时候全班都能交；整场关着时只有批次放的人能交。
    -->
    <div class="card batches">
      <CardHead>
        <template #title>分批开始</template>
        <template #meta>
          <span class="dim mini">勾几个人 → 开始这一批；这批做完点「结束这批」，再放下一批</span>
        </template>
      </CardHead>

      <!-- 有批次在跑时给一个「全部结束」—— 原来那个「■ 结束作业」的替代 -->
      <div v-if="openBatchCount" class="ball">
        <span class="dim mini">正在放 {{ openBatchCount }} 个批次</span>
        <span class="spacer"></span>
        <button class="btn mini danger" @click="stopAllBatches">■ 全部结束</button>
      </div>

      <div v-if="d.batches && d.batches.length" class="blist">
        <div
          v-for="b in d.batches"
          :key="b.id"
          class="brow"
          :class="{ live: b.status === 'open' && !b.overDue, timeup: b.status === 'open' && b.overDue }"
        >
          <span class="bseq">第 {{ b.seq }} 批</span>
          <span class="bstat">
            {{ b.status === 'open' ? (b.overDue ? '时间到' : '进行中') : '已结束' }}
          </span>
          <span class="dim mini">{{ b.count }} 人 · 已交 {{ b.submitted }}</span>
          <!-- 这一批自己的计时：到点之后学生就交不上来了，老师要看得见 -->
          <span v-if="b.status === 'open' && b.leftMin" class="bleft">还剩 {{ b.leftMin }} 分钟</span>
          <span v-else-if="b.status === 'open' && b.overDue" class="bleft over">已到时间</span>
          <span v-if="b.note" class="dim mini">· {{ b.note }}</span>
          <span class="spacer"></span>
          <button v-if="b.status === 'open'" class="btn mini" @click="stopBatch(b)">结束这批</button>
        </div>
      </div>

      <div class="pickbar">
        <button class="btn mini" @click="pickRest">勾剩下的 {{ unbatchedLeft }} 人</button>
        <button class="btn mini" @click="pickAll">全选</button>
        <button class="btn mini" @click="picked = []">清空</button>
        <!--
          按班快速选：一个课程两个班时，一批通常就是「一个班」。
          按钮上写着这个班还剩多少人没排过，点之前就知道会勾多少。
        -->
        <span v-if="classGroups.length > 1" class="clgroup">
          <button
            v-for="g in classGroups"
            :key="g.id"
            class="btn mini clbtn"
            :disabled="!g.left"
            :title="g.name + '：共 ' + g.total + ' 人，还有 ' + g.left + ' 人没排过批'"
            @click="pickClass(g.id)"
          >
            {{ g.name }}<em v-if="g.left">{{ g.left }}</em><em v-else class="done">✓</em>
          </button>
        </span>
        <span class="dim mini">已勾 {{ picked.length }} 人</span>
        <!--
          这一批的限时。填了就按「从现在起 N 分钟」算，到点这批人自动交不上来；
          留空则不限时（看整场的截止时间）。
        -->
        <label class="minbox" title="这一批从现在起给多少分钟。留空 = 不限时（看整场截止时间）">
          限时
          <input v-model="batchMin" type="number" min="0" max="300" placeholder="不限" />
          分钟
        </label>
        <span class="spacer"></span>
        <button class="btn primary" :disabled="!picked.length || busy" @click="startBatch">
          ▶ 开始这一批
        </button>
      </div>

      <div class="pickers">
        <label
          v-for="s in d.roster || []"
          :key="s.sid"
          class="pk"
          :class="{ on: picked.includes(s.sid), done: s.submitted }"
        >
          <input type="checkbox" :checked="picked.includes(s.sid)" @change="togglePick(s.sid)" />
          <span class="pkn">{{ s.name }}</span>
          <em v-if="s.submitted">已交</em>
          <!-- 已经排过批的人标出第几批，免得老师重复勾 -->
          <em v-else-if="s.batchSeq" class="bq">第{{ s.batchSeq }}批</em>
        </label>
      </div>
    </div>

    <!-- 统计 -->
    <div class="stats">
      <div class="st">
        <span class="stn">{{ d.stats.rosterCount }}</span>
        <span class="stl">应交人数</span>
      </div>
      <div class="st">
        <span class="stn ok">{{ d.stats.submittedStudents }}</span>
        <span class="stl">已交人数</span>
      </div>
      <div class="st">
        <span class="stn">{{ d.stats.submissionCount }}</span>
        <span class="stl">提交条数</span>
      </div>
      <div class="st">
        <span class="stn" :class="{ warn: d.stats.submissionCount > d.stats.gradedCount }">{{ d.stats.gradedCount }}</span>
        <span class="stl">
          {{
          /* 一条都没交的时候不要说「都批完了」—— 那是反的 */
          !d.stats.submissionCount
          ? '已批'
          : d.stats.submissionCount > d.stats.gradedCount
            ? '已批 · 还差 ' + (d.stats.submissionCount - d.stats.gradedCount) + ' 条'
            : '已批 · 都批完了'
          }}
        </span>
      </div>
      <div class="st">
        <span class="stn" :class="{ err: d.stats.missing.length }">{{ d.stats.missing.length }}</span>
        <span class="stl">未交</span>
      </div>
    </div>

    <!-- 提交记录（时间顺序） -->
    <div class="card">
      <CardHead>
        <template #title>提交记录 · 按交的时间排</template>
        <template #right>
          <span class="pill" :class="{ on: !classId }" @click="setClass('')">全部班级</span>
          <span
          v-for="c in classes"
          :key="c.id"
          class="pill"
          :class="{ on: classId === c.id }"
          @click="setClass(c.id)"
          >
          {{ c.name }}
        </span>
        <span class="dim mini">每 8 秒自动刷新</span>
      </template>
    </CardHead>

    <div v-if="!d.submissions.length" class="empty">
      {{ collectingOf(d.assignment) ? '还没有人交，等一会儿再看。' : '这次作业没有提交记录。' }}
    </div>

    <DataTable
      v-else
      :columns="subCols"
      :rows="d.submissions"
      row-key="id"
      clickable
      :empty="'还没有人交'"
      @row-click="review"
    >
      <template #cell-no="{ index }">{{ index + 1 }}</template>
      <template #cell-when="{ row }">
        {{ clock(row.createdAt) }}
        <span v-if="fresh(row.createdAt)" class="tag ok" style="margin-left: 6px">新</span>
      </template>
      <template #cell-sid="{ row }"><span class="mono">{{ row.sid }}</span></template>
      <template #cell-className="{ row }"><span class="dim">{{ row.className }}</span></template>
      <template #cell-files="{ row }">{{ row.changedCount }} / {{ row.fileCount }}</template>
      <template #cell-score="{ row }">
        <span :class="{ ok: row.graded }">{{ !row.graded ? '—' : row.score }}</span>
      </template>
      <template #cell-comment="{ row }"><span class="cmt dim">{{ row.comment || '—' }}</span></template>
      <template #cell-actions="{ row }">
        <button class="btn mini" @click.stop="review(row)">看代码 / 打分</button>
      </template>
    </DataTable>
    </div>

    <!--
      未交名单：默认**收起**。

      原来一进来就铺开 —— 一个跨两个班的作业「未交 117 人」，
      8 行 × 15 列全是名字和学号，把下面「提交记录」挤到看不见。
      而老师此刻不能对这 117 人做任何事：名单只在「快截止了、想点几个名字」
      的时候才有用，那时候才需要展开。

      收起之后标题那一行就说完了该说的：多少人、跨几个班。
    -->
    <div v-if="d.stats.missing.length" class="card">
    <CardHead>
      <template #title>
        <button class="misstoggle" @click="showMiss = !showMiss">
          <span class="tri">{{ showMiss ? '▾' : '▸' }}</span>
          未交 · {{ d.stats.missing.length }} 人
        </button>
      </template>
      <div class="right dim mini">
        {{ missSummary }}
        <button class="linkish" @click="showMiss = !showMiss">{{ showMiss ? '收起' : '看名单' }}</button>
      </div>
    </CardHead>
    <div v-if="showMiss" class="miss">
      <span v-for="m in d.stats.missing" :key="m.classId + m.sid" class="missi">
        {{ m.name }}<em>{{ m.sid }}</em>
      </span>
    </div>
    </div>
    </template>

    <div v-else-if="!loading" class="card empty">
    {{ list.length ? '选一份作业看提交' : '还没有作业。先「新建作业」，选一课要改的代码示例。' }}
    </div>


    <!-- 审阅 + 打分 -->
    <div v-if="viewing" class="mask" @click.self="closeReview">
    <div class="modal wide xwide">
    <div class="modal-head">
      <h3>
        {{ viewing.name }} <span class="dim mono">{{ viewing.sid }}</span>
        <span class="tag" style="margin-left: 6px">{{ when(viewing.createdAt) }}</span>
      </h3>
      <div class="right">
        <label class="check mini"><input v-model="onlyChanged" type="checkbox" /> 只看改过的</label>
        <button class="btn mini" :disabled="reviewIdx <= 0" @click="step(-1)">↑ 上一条</button>
        <button class="btn mini" :disabled="reviewIdx >= d.submissions.length - 1" @click="step(1)">↓ 下一条</button>
        <button class="btn mini" @click="closeReview">×</button>
      </div>
    </div>

    <div class="modal-body review">
      <div v-if="loadingFiles" class="empty">正在读取提交的文件…</div>
      <template v-else>
        <div class="rev-code">
          <CodeViewer :files="codeFiles" :marked="viewing.changed" :font-size="12.5" />
        </div>

        <div class="rev-run">
          <div class="rev-head">
            <select v-if="pages.length" v-model="previewPage" class="select" @change="runPreview">
              <option v-for="p in pages" :key="p" :value="p">{{ p }}</option>
            </select>
            <span class="spacer"></span>
            <span v-if="previewNpm" class="tag warn">npm 工程</span>
            <span v-else-if="previewOk" class="tag ok">已渲染</span>
            <button class="btn mini" :disabled="previewBusy || previewNpm" @click="runPreview">▶ 运行</button>
          </div>
          <div v-if="previewNpm" class="npmnote">
            这一课的入口是 <code>{{ npmEntry }}</code>，代码靠 Vite 打包、裸模块由 node_modules 解析，
            浏览器里跑不起来（不是学生交坏了）。左边源码照样能看。
          </div>
          <template v-else>
            <!-- 跑的是学生交上来的代码：不给 allow-same-origin，隔离成独立源，
            免得有人借这份代码读到教师端的令牌 -->
            <iframe
            ref="frame"
            class="rev-frame"
            title="学生提交的渲染结果"
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            ></iframe>
          <div v-if="previewError" class="perr">
            <b>页面报错</b>
            <span>{{ previewError }}</span>
            <button class="perr-x" @click="previewError = ''">×</button>
          </div>
          <p class="dim mini rev-note">
            渲染用的是学生交上来的那份代码（在本页内跑，不落服务器）；改了分页或想重跑，点「运行」。
          </p>
        </template>
      </div>
    </template>

    <p v-if="!loadingFiles" class="dim mini filenote">
      整份交了 {{ viewing.fileCount }} 个文件，其中改了 {{ viewing.changedCount }} 个
      <template v-if="viewing.changedCount">：{{ viewing.changed.join('、') }}</template>
    </p>
    </div>

    <div class="modal-foot grade">
    <!-- 打什么控件由这一项的规则决定（等级 / 量规 / 卷面分），页面不写死 -->
    <GradeBox v-if="moduleItem" :item="moduleItem" :model-value="grade" />
    <p class="dim mini" style="margin: 2px 0 6px">
      本次权重 ×{{ d && d.assignment ? d.assignment.weight || 1 : 1 }}
      （计入「{{ moduleTitle }}」，加权平均时按这个比重算）
    </p>
    <input v-model="grade.comment" class="input" placeholder="评语（可选，学生看得到）" />
    <span class="spacer"></span>
    <span v-if="viewing.graded" class="dim mini">
      上次：{{ viewing.score }} 分 {{ viewing.gradedAt ? '· ' + when(viewing.gradedAt) : '' }}
    </span>
    <button class="btn line" :disabled="saving" @click="clearGrade">清掉</button>
    <button class="btn line" :disabled="saving" title="分数与评语清空、计分记录作废，学生可以再交一次" @click="redo">打回重做</button>
    <button
      class="btn line danger"
      :disabled="saving"
      title="连文件一起删掉、学生回到「未交」，不可恢复（和「打回重做」不同）"
      @click="delSubmit"
    >删除提交</button>
    <button class="btn primary" :disabled="saving" @click="saveGrade">
      {{ saving ? '保存中…' : '保存并下一条' }}
    </button>
    </div>
    </div>
    </div>

    <!--
      作业目录：设计都在这里，新建作业时从这儿挑。

      **这个弹窗刻意没用 ImportDialog**，因为它和「导入弹窗」不是同一种东西：
        · 主体是**已有设计稿的列表**（挑一个建作业 / 导出 / 删除），导入只是其中一个动作
        · 上传设计包**没有预检**（选了就写，接口本身没有 inspect），
          而 ImportDialog 一半的价值就是「先给报告再确认」那一屏
      硬套的结果会是把列表、上传、报告都塞成插槽 —— 组件等于什么也没提供。
      所以这里保持「管理面板 + 上传按钮」的形态，模板也就在上传按钮旁边。
    -->
    <div v-if="lib.open" class="mask" @click.self="lib.open = false">
      <div class="modal wide">
        <div class="modal-head">
          <h3>作业目录 · {{ moduleTitle }}</h3>
          <button class="btn mini" style="margin-left: auto" @click="lib.open = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="row" style="margin-bottom: 10px">
            <button class="btn mini" @click="libPick.click()" :disabled="lib.busy">⤒ 上传设计包</button>
            <input ref="libPick2" type="file" accept=".zip" style="display: none" @change="onDesignUpload" />
            <button class="btn mini" :disabled="lib.busy" @click="downloadTpl">⤓ 下载模板</button>
            <span class="dim mini">一个设计包 = <code>homework.json</code> + <code>code/</code>（起手代码）；模板里带说明</span>
          </div>

          <p v-if="lib.err" class="hint err">{{ lib.err }}</p>
          <p v-if="!designs.length" class="dim mini">还没有设计。上传一个设计包，或者新建作业时选「空白」自己写。</p>

          <div v-for="x in designs" :key="x.id" class="lib-row">
            <div class="lib-main">
              <b>{{ x.title }}</b>
              <!-- 截止用 fmtAt（不带秒）：「今天 02:23:21」对一个未来时刻很怪 -->
              <span class="dim mini">{{ x.fileCount }} 个文件 · 权重 {{ x.weight }}<template v-if="x.dueAt"> · 截止 {{ fmtAt(x.dueAt) }}</template></span>
            </div>
            <div class="lib-acts">
              <button class="btn mini" @click="useDesign(x)">用这个建作业</button>
              <button class="btn mini" @click="exportDesign(x)">导出</button>
              <button class="btn mini danger" @click="removeDesign(x)">删除</button>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <span class="dim mini">删设计不影响已经建出来的作业（它们有自己的代码副本）</span>
          <span class="spacer"></span>
          <button class="btn" @click="lib.open = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- 新建 / 修改作业 -->
    <div v-if="editing" class="mask" @click.self="editing = ''">
    <div class="modal">
    <div class="modal-head">
    <h3>{{ editing === 'new' ? '新建' + moduleTitle : '修改' + moduleTitle }}</h3>
    <button class="btn mini" @click="editing = ''">×</button>
    </div>
    <div class="modal-body form">
    <label class="field">
      <span>
        作业设计（学生的起手代码从这儿来）
        <em class="mini wtip">课堂作业不再挂「代码示例」，有自己的一份代码</em>
      </span>
      <div class="row">
        <select v-if="editing === 'new'" v-model="form.designId" class="select" @change="onDesignChange">
          <option value="">空白（系统给一份最小三件套）</option>
          <option v-for="x in designs" :key="x.id" :value="x.id">{{ x.title }}（{{ x.fileCount }} 个文件）</option>
        </select>
        <span v-else class="dim mini">修改作业不会动起手代码（代码在建作业时就复制好了）</span>
        <button v-if="editing === 'new'" class="btn mini" :disabled="saving" @click="libPick.click()">上传设计包…</button>
        <input ref="libPick" type="file" accept=".zip" style="display: none" @change="onDesignUpload" />
      </div>
    </label>
    <label class="field">
      <span>截止时间（可留空 = 不限）</span>
      <div class="row">
        <input v-model="form.dueAt" class="input" type="datetime-local" style="width: 220px" />
        <label class="check">
          <input v-model="form.allowLate" type="checkbox" />
          截止后仍收（自动标「迟交」，按方案的迟交系数打折）
        </label>
      </div>
    </label>
    <label class="field">
      <span>作业标题（学生端显示这个）</span>
      <input v-model="form.title" class="input" maxlength="60" :placeholder="dirTitleOf(form.dir)" />
    </label>
    <label class="field">
      <span>作业说明（学生能看到，可留空）</span>
      <textarea v-model="form.note" class="textarea" rows="4" maxlength="500" placeholder="例如：把列表改成卡片，加上删除按钮"></textarea>
    </label>
    <label class="field">
      <span>
        本次权重（占「{{ moduleTitle }}」的比重）
        <em class="mini wtip">默认 1，越大越吃重；比如期末综合练习填 2，随堂小练填 0.5</em>
      </span>
      <input v-model.number="form.weight" class="input" type="number" min="0.1" max="20" step="0.5" style="width: 120px" />
    </label>
    <p class="dim mini">
      多项作业按权重加权平均（{{ weightHint }}）。新建的作业一律是「未开始」，等你在列表里点「开始」学生才交得上。
    </p>
    </div>
    <div class="modal-foot">
    <span class="spacer"></span>
    <button class="btn" @click="editing = ''">取消</button>
    <button class="btn primary" :disabled="saving" @click="saveEditor">{{ saving ? '保存中…' : '保存' }}</button>
    </div>
    </div>
    </div>

    <Toast :text="toast" @close="toast = ''" />
  </PageShell>
</template>

<script setup>
/*
 * 教师端「课堂作业」
 *
 * 一页把老师的全套动作串起来：
 *   建作业（选一课示例）→ 开始 / 结束（控制学生能不能交）→ 按时间顺序看提交 →
 *   点开某一条看代码 + 打分。
 *
 * 几个刻意的决定：
 *   · 提交列表按「交的时间」正序，不是按学号：谁先交谁在上面，正好是课堂的节奏；
 *   · 只看改过的文件（默认开）：学生改了什么一眼看清，需要上下文再关掉；
 *   · 打分框放在弹层底部：「看代码 → 给分 → 下一条」一条流水线，不用来回关窗口；
 *   · 未交名单跟着班级筛选走，讲评时可以顺手点个名。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { api, download, getCourse, getToken } from '../../api'
import CodeViewer from '../../components/CodeViewer.vue'
import GradeBox from '../../components/GradeBox.vue'
import Toast from '../../components/Toast.vue'
import { clock, when, at as fmtAt } from '../../utils/time'
import { buildPreviewDoc, ensureSfcSrcdoc, isNpmProject, pagesOf } from '../../utils/pgPreview'
import { loadScheme, scheme } from '../../utils/scheme'
import PageHead from '../../components/PageHead.vue'
import DataTable from '../../components/DataTable.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'

/* 哪个考核项的模块：由路由 /teacher/modules/:itemKey 传进来 */
const props = defineProps({
  itemKey: { type: String, default: 'homework' },
})

/** 这一项在方案里的定义（等级表、量规维度、卷面满分都从这儿来） */
const moduleItem = computed(() => scheme.items.find((i) => i.key === props.itemKey) || null)
const moduleTitle = computed(() => (moduleItem.value ? moduleItem.value.name : '课堂作业'))

/** 权重怎么算的，用当前方案里的等级表说明一句（改了分值/等级表这里也跟着变） */
const weightHint = computed(() => {
  const it = moduleItem.value
  if (!it) return '按每次的权重加权平均'
  const grades = (it.grades || []).map((g) => g.name).join(' / ')
  return '每次判 ' + (grades || '等级') + '，按每次权重加权平均，最后折算到本项 ' + it.full + ' 分'
})

const list = ref([])
const dirs = ref([])
const classes = ref([])
const curId = ref('')
const d = ref(null) // { assignment, submissions, stats }
const classId = ref('')
const err = ref('')
const toast = ref('')

/* 提交记录表：列定义（原来写死在模板里，现在一处声明） */
const subCols = [
  { key: 'no', label: '#', num: true, width: '46px' },
  { key: 'when', label: '提交时间', hint: '先交的在前' },
  { key: 'sid', label: '学号' },
  { key: 'name', label: '姓名' },
  { key: 'className', label: '班级' },
  { key: 'files', label: '改动 / 文件', num: true },
  { key: 'score', label: '分数', num: true },
  { key: 'comment', label: '评语' },
  { key: 'actions', label: '', width: '120px' },
]
const loading = ref(false)
const saving = ref(false)
let timer = null

/* 审阅弹层 */
const viewing = ref(null)
const reviewIdx = ref(-1)
const subFiles = ref([]) // [{path,text}] 学生交上来的整份文件
const loadingFiles = ref(false)
const onlyChanged = ref(true)
// 打分的三种载体都在这里（等级 / 卷面 / 量规），页面按规则各取所需
const grade = reactive({ grade: '', late: false, raw: '', dims: {}, comment: '' })

/* 弹层里的预览（跑学生交的代码） */
const frame = ref(null)
const previewPage = ref('')
const previewError = ref('')
const previewOk = ref(false)
const previewBusy = ref(false)

/* 新建 / 修改 */
const editing = ref('') // '' | 'new' | 'edit'
const form = reactive({ dir: '', designId: '', title: '', note: '', weight: 1, dueAt: '', allowLate: true })

/* ---------------- 作业目录（设计） ---------------- */
const designs = ref([])
const libPick = ref(null)
const libPick2 = ref(null)
const lib = reactive({ open: false, busy: false, err: '' })

/* ---------------- 批阅进度 ---------------- */
const prog = ref(null)
const showMissing = ref(false)

/**
 * 页头副标题：当前这份作业收到什么程度了。
 *
 * 例：`已交 3 / 57 人 · 待批 2`
 * 没有选中作业时退回作业总数（老师刚进来，还没点开哪一份）。
 *
 * 原来这行写的是「新建 → 点开始 → 学生交一份这里就多一条」——
 * 第一次用有用，之后每次进页面都在占着最显眼的位置。
 */
/** 未交名单默认收起（117 个名字铺开时下面什么都看不见） */
const showMiss = ref(false)

/* ---------------- 分批开始 ---------------- */

/** 这一批勾了谁（sid 数组） */
const picked = ref([])
/** 这一批的限时（分钟）。空 = 不限时 */
const batchMin = ref('')
/** 正在提交（防止连点两下开出两批） */
const busy = ref(false)

function togglePick(sid) {
  const i = picked.value.indexOf(sid)
  if (i >= 0) picked.value = picked.value.filter((x) => x !== sid)
  else picked.value = picked.value.concat([sid])
}

/**
 * 勾上「还没排过批、也还没交」的人 —— 分批最常用的那一手。
 *
 * 前一版是「所有还没交的人」，会把已经在第 1 批里的人又勾一遍；
 * 现在的口径是「上批剩下的人」：没进过任何批的，才是这一批该放的。
 */
function pickRest() {
  const r = (d.value && d.value.roster) || []
  picked.value = r.filter((s) => !s.submitted && !s.batched).map((s) => s.sid)
}

/** 按班快速选：只勾这个班里「还没排过批、也还没交」的人 */
function pickClass(classId) {
  const r = (d.value && d.value.roster) || []
  picked.value = r.filter((s) => s.classId === classId && !s.submitted && !s.batched).map((s) => s.sid)
}

/** 每个班还剩多少人没排过 —— 按钮上直接写出来，不用点进去看 */
const classGroups = computed(() => {
  const r = (d.value && d.value.roster) || []
  const m = new Map()
  for (const s of r) {
    if (!m.has(s.classId)) m.set(s.classId, { id: s.classId, name: s.className || '未分班', total: 0, left: 0 })
    const g = m.get(s.classId)
    g.total++
    if (!s.submitted && !s.batched) g.left++
  }
  return Array.from(m.values())
})

/** 还有多少人没排过批（折叠/按钮上的提示用） */
const unbatchedLeft = computed(() => {
  const r = (d.value && d.value.roster) || []
  return r.filter((s) => !s.submitted && !s.batched).length
})

/** 有几个批次正在放人（没过时间的才算） */
const openBatchCount = computed(() => {
  const bs = (d.value && d.value.batches) || []
  return bs.filter((b) => b.status === 'open' && !b.overDue).length
})

/** 一键结束所有还在放的批次（替代原来的「结束作业」） */
async function stopAllBatches() {
  const n = openBatchCount.value
  if (!n) return
  if (!window.confirm('结束全部 ' + n + ' 个批次？\n\n这些批次里的人都不能再交了（已交的照样留着）。')) return
  try {
    const res = await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/batches/stop-all')
    toast.value = res.message || '已全部结束'
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  }
}

function pickAll() {
  picked.value = ((d.value && d.value.roster) || []).map((s) => s.sid)
}

/** 开始这一批：只对勾到的人生效，整场状态不动 */
async function startBatch() {
  if (!picked.value.length || busy.value) return
  const n = picked.value.length
  const mins = Math.max(0, Math.floor(Number(batchMin.value) || 0))
  if (
    !window.confirm(
      '开始新的一批？\n\n这一批 ' + n + ' 个人可以进入，其他人还是进不来。\n' +
        (mins > 0 ? '限时 ' + mins + ' 分钟（到点他们就交不上来了）。\n' : '不限时（看整场的截止时间）。\n') +
        '做完之后点「结束这批」，再放下一批。'
    )
  )
    return
  busy.value = true
  try {
    const res = await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/start', {
      sids: picked.value.slice(),
      minutes: mins,
    })
    toast.value = (res.message || n + ' 人已放行') + '。已勾上剩下没排的人，做完再点「开始这一批」'
    await loadAll()
    /* 开完一批，下一批几乎总是「上批剩下的人」——直接勾好，老师确认一下就能点 */
    pickRest()
  } catch (e) {
    toast.value = e.message
  } finally {
    busy.value = false
  }
}

/** 结束某一批：整场不动，只是这一批不能再交了 */
async function stopBatch(b) {
  if (!b) return
  if (!window.confirm('结束第 ' + b.seq + ' 批？\n\n这批 ' + b.count + ' 人就不能再交了（已交的照样留着）。\n整场不受影响，你可以接着放下一批。')) return
  try {
    const res = await api.post(
      '/api/assignments/' + encodeURIComponent(curId.value) + '/batches/' + encodeURIComponent(b.id) + '/stop'
    )
    toast.value = res.message || '第 ' + b.seq + ' 批已结束'
    await loadDetail(true)
  } catch (e) {
    toast.value = e.message
  }
}

/** 未交的人跨了几个班 —— 收起状态下这一句比 117 个名字有用 */
const missSummary = computed(() => {
  const list = (d.value && d.value.stats && d.value.stats.missing) || []
  if (!list.length) return ''
  const n = new Set(list.map((x) => x.classId)).size
  return n > 1 ? '跨 ' + n + ' 个班' : '按当前班级'
})

const hwSub = computed(() => {
  if (prog.value && prog.value.studentCount) {
    const p = prog.value
    const parts = ['已交 ' + p.submitted + ' / ' + p.studentCount + ' 人']
    if (p.pending) parts.push('待批 ' + p.pending)
    /* submitted > 0 才算「都批完了」—— 一个人都没交的时候说这句是反的 */
    else if (p.submitted > 0 && p.graded === p.submitted) parts.push('都批完了')
    if (p.missing && p.missing.length) parts.push('未交 ' + p.missing.length)
    return parts.join(' · ')
  }
  const n = list.value.length
  if (!n) return '还没有作业'
  return n + ' 份作业 · 点开一份看批阅进度'
})
const missingText = computed(() => {
  if (!prog.value) return ''
  return prog.value.missing.map((m) => m.name).join('、')
})

async function loadDesigns() {
  try {
    const r = await api.get('/api/courses/' + encodeURIComponent(getCourse()) + '/designs?kind=homework')
    /*
     * 字段是 items，不是 homework。
     *
     * 这里原来读的是 r.homework —— 接口返回的是 { courseId, kind, items }，
     * 于是永远取到 undefined → designs 恒为空数组。表现就是：
     * 上传设计包**明明成功**（toast 也弹了、库里也真写进去了），
     * 但「作业目录」里始终显示「还没有设计」，新建作业的下拉里也选不出来。
     * 后端没错、上传也没错，只是这一行读错了字段，而且被 catch 吞成了空列表，
     * 连个报错都没有。
     */
    const list = r.items || r.homework || []
    designs.value = list.map((d) => Object.assign({}, d, { dueAt: d.dueAt || '' }))
  } catch (e) {
    designs.value = []
  }
}

async function loadProgress() {
  prog.value = null
  showMissing.value = false
  if (!curId.value) return
  try {
    prog.value = await api.get('/api/assignments/' + encodeURIComponent(curId.value) + '/progress')
  } catch (e) {
    prog.value = null
  }
}

function openLib() {
  lib.open = true
  lib.err = ''
  loadDesigns()
}

/** 选了设计：把它的标题/说明/权重/截止带过来（老师可以改） */
function onDesignChange() {
  const x = designs.value.find((d) => d.id === form.designId)
  if (!x) return
  if (!form.title || form.title === lastAutoTitle) {
    form.title = x.title
    lastAutoTitle = x.title
  }
  if (!form.note) form.note = x.note || ''
  if (!form.dueAt && x.dueAt) form.dueAt = toLocalInput(x.dueAt)
  form.weight = x.weight === undefined ? 1 : Number(x.weight) || 1
  form.allowLate = x.allowLate !== false
}

/** ISO → datetime-local 需要的 "YYYY-MM-DDTHH:mm" */
function toLocalInput(iso) {
  const d = new Date(iso)
  if (!isFinite(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 上传一个设计包 → 进库 → 直接选中它 */
async function onDesignUpload(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  lib.busy = true
  lib.err = ''
  try {
    const buf = await f.arrayBuffer()
    const token = getToken()
    const res = await fetch(
      '/api/courses/' + encodeURIComponent(getCourse()) + '/designs/import?kind=homework',
      {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, token ? { Authorization: 'Bearer ' + token } : {}),
        body: buf,
      }
    )
    const j = await res.json().catch(() => null)
    if (!res.ok) throw new Error((j && j.error) || '导入失败（' + res.status + '）')
    toast.value = '已导入设计：' + j.design.title
    await loadDesigns()
    form.designId = j.design.id
    onDesignChange()
  } catch (err) {
    lib.err = err.message
    toast.value = err.message
  } finally {
    lib.busy = false
  }
}

function downloadTpl() {
  download('/api/courses/' + encodeURIComponent(getCourse()) + '/designs/template.zip?kind=homework', 'homework-design-template.zip')
  toast.value = '模板已下载：改完压缩成 zip 再上传'
}

function exportDesign(x) {
  download(
    '/api/courses/' + encodeURIComponent(getCourse()) + '/designs/' + encodeURIComponent(x.id) + '/zip?kind=homework',
    'homework-' + x.id + '.zip'
  )
}

async function removeDesign(x) {
  if (!window.confirm('从作业目录里删掉「' + x.title + '」？\n\n已经建出来的作业不受影响（它们有自己的代码副本）。')) return
  try {
    await api.del('/api/courses/' + encodeURIComponent(getCourse()) + '/designs/' + encodeURIComponent(x.id) + '?kind=homework')
    toast.value = '已从目录删除'
    await loadDesigns()
  } catch (e) {
    toast.value = e.message
  }
}

/** 目录里直接「用这个建作业」：关掉目录，打开新建弹层并选中它 */
function useDesign(x) {
  lib.open = false
  openEditor('new')
  form.designId = x.id
  onDesignChange()
}

/* 代码面板里显示哪些文件：「只看改过的」勾着就只列他动过的，取消就列整份 */
const codeFiles = computed(() => {
  const changed = new Set((viewing.value && viewing.value.changed) || [])
  if (!onlyChanged.value) return subFiles.value
  const out = subFiles.value.filter((f) => changed.has(f.path))
  return out.length ? out : subFiles.value
})

/* 预览：用交上来的整份文件，选一个页面跑 */
const pages = computed(() => pagesOf(subFiles.value))
const previewNpm = computed(() => !!previewPage.value && isNpmProject(subFiles.value, previewPage.value))
const npmEntry = computed(() => {
  const f = subFiles.value.find((x) => x.path === previewPage.value)
  const m = f && /<script\b[^>]*\bsrc\s*=\s*["']([^"']*\/src\/[^"']+)["']/i.exec(f.text)
  return m ? m[1] : 'npm run dev'
})

async function runPreview() {
  if (!previewPage.value || previewNpm.value) return
  const iframe = frame.value
  if (!iframe) return
  previewBusy.value = true
  previewError.value = ''
  try {
    await ensureSfcSrcdoc()
    const dirName = (viewing.value && viewing.value.dir) || (d.value && d.value.assignment.dir) || ''
    // base 指向能真取到共享运行时的接口（vue.global.js / sfc-boot.js 在示例目录的上级）
    iframe.srcdoc = buildPreviewDoc(subFiles.value, previewPage.value, '/api/example-files/' + encodeURI(dirName) + '/')
    previewOk.value = true
  } catch (e) {
    previewError.value = '预览失败：' + e.message
    previewOk.value = false
  } finally {
    previewBusy.value = false
  }
}

function onPreviewMessage(e) {
  const m = e.data
  if (!m || !m.__pg) return
  if (e.source !== (frame.value && frame.value.contentWindow)) return
  previewError.value = m.l ? m.m + '（行 ' + m.l + '）' : m.m
}

/*
 * 切回来立刻刷一次。
 *
 * 轮询里有 document.hidden 的判断（切走的标签页不该继续发请求），
 * 但代价是：老师切去别的窗口待了一会儿再回来，看到的还是离开时的状态，
 * 最多要等 8 秒才对 —— 而「这次作业到没到期」正是他切回来要确认的事。
 */
function onVisible() {
  if (!document.hidden) {
    nowTick.value = Date.now()
    loadList()
    if (curId.value) loadDetail(true)
  }
}

onMounted(async () => {
  window.addEventListener('message', onPreviewMessage)
  document.addEventListener('visibilitychange', onVisible)
  await loadAll()
  /*
   * 学生交作业随时发生，老师这边靠轮询兜住（WS 只发给学生端）。
   *
   * 三件事都要刷：
   *   list    —— 「进行中 / 已截止」是现算的，**到点得自己翻过去**
   *               （原来只刷详情，胶囊和小灯永远停在「进行中」，
   *                老师不点「结束」就不认账）
   *   detail  —— 提交记录、统计
   *   progress—— 批阅进度条
   */
  timer = setInterval(() => {
    /*
     * 先推时钟 —— 纯本地，不发请求，所以放在 hidden 判断之前。
     * 这样即使标签页在后台（不轮询网络），切回来那一刻状态也是对的。
     */
    nowTick.value = Date.now()
    if (document.hidden) return
    loadList()
    if (d.value && curId.value && !viewing.value) loadDetail(true)
  }, 8000)
})

onUnmounted(() => {
  window.removeEventListener('message', onPreviewMessage)
  document.removeEventListener('visibilitychange', onVisible)
  if (timer) clearInterval(timer)
})

/**
 * 只刷作业列表（轻量）。
 *
 * 和 loadAll 的区别：不重拉考核方案、目录、班级 —— 那些一学期都不变，
 * 每 8 秒重拉一遍纯属浪费。轮询只需要列表，因为
 * **「进行中 / 已截止」是每次读的时候现算的**（collecting 依赖当前时间），
 * 到点之后列表里这几条要能自己翻过去，而不用老师手动点「结束」。
 */
async function loadList() {
  try {
    const res = await api.get('/api/assignments?itemKey=' + encodeURIComponent(props.itemKey))
    list.value = res.items || []
  } catch (e) {
    /* 轮询失败不打扰老师，下一轮再试 */
  }
}

async function loadAll() {
  loading.value = true
  err.value = ''
  try {
    await loadScheme() // 等级表 / 量规维度 / 卷面满分都从方案来
    const res = await api.get('/api/assignments?itemKey=' + encodeURIComponent(props.itemKey))
    list.value = res.items || []
    dirs.value = res.dirs || []
    classes.value = res.allClasses || []
    if (!curId.value) {
      /* 默认选中「还在收」的那份（到期的不算 —— 那份已经交不了了） */
      const openOne = list.value.filter((a) => collectingOf(a))
      curId.value = (openOne.length ? openOne[openOne.length - 1] : list.value[list.value.length - 1] || {}).id || ''
    }
    if (curId.value) {
      await loadDetail()
      loadProgress()
    } else {
      d.value = null
      prog.value = null
    }
  } catch (e) {
    err.value = e.message
  } finally {
    loading.value = false
  }
}

async function loadDetail(quiet) {
  if (!curId.value) return
  try {
    const q = classId.value ? '?classId=' + encodeURIComponent(classId.value) : ''
    d.value = await api.get('/api/assignments/' + encodeURIComponent(curId.value) + q)
    if (!quiet) return
  } catch (e) {
    if (!quiet) err.value = e.message
  }
}

function select(id) {
  if (curId.value === id) return
  curId.value = id
  d.value = null
  classId.value = ''
  loadDetail()
  loadProgress()
}

function setClass(id) {
  classId.value = id
  loadDetail()
}

/** 刚刚交上来的那条标个「新」，老师一眼看到有人交了 */
function fresh(iso) {
  const t = new Date(iso).getTime()
  return isFinite(t) && Date.now() - t < 120000
}

/* ---------------- 开始 / 结束 ---------------- */

/**
 * 教师端看到的作业状态。
 *
 * 判断基准是 collecting（实际还在收），**不是 status**。
 * status 只记「老师点过开始 / 停止」，它不会因为时间流逝自己变 ——
 * 所以到期之后不需要老师再手动点一次「结束」，这里自己就翻成「已截止」。
 *
 * 三态之外多一档细分：「已截止（时间到）」和「已结束」（老师手动停的）
 * 分开写，因为前者老师还能改截止时间再开，后者要重新点开始。
 */
/**
 * 这份作业「过没过截止」—— **用当前时间现算**，不用接口带回来的 overDue。
 *
 * 接口那份 overDue 是拉数据那一刻算的。详情的轮询在 document.hidden 时会让开，
 * 于是老师切走一会儿再回来，详情还是离开时的旧值：
 * 胶囊（列表）已经翻成「已截止」，中间标签（详情）还写着「进行中」，自相矛盾。
 *
 * 时间这件事本来就有唯一的真相来源（dueAt + 现在几点），
 * 只要 dueAt 没变，状态就不该依赖「这份数据是什么时候拉的」。
 */
/*
 * 时钟 tick。
 *
 * 光写 Date.now() 是不够的：Vue 追踪不到它，模板不会因为「时间过去了」重新渲染，
 * 状态标签就会一直停在拉数据那一刻的样子（实测：胶囊翻了、中间标签还是「进行中」）。
 * 用一个 ref 每 8 秒推一下，让依赖它的地方重算。
 */
const nowTick = ref(Date.now())

function overDueOf(x) {
  if (!x || !x.dueAt) return false
  const t = Date.parse(x.dueAt)
  return isFinite(t) && nowTick.value > t
}

/** 实际还在收吗：老师开着 **且** 没到期（不收迟交时） */
function collectingOf(x) {
  if (!x || x.status !== 'open') return false
  if (overDueOf(x) && x.allowLate === false) return false
  return true
}

function stateOf(x) {
  if (!x) return { text: '', tone: '' }
  /* 整场开着 = 全班都能交 */
  if (collectingOf(x)) return { text: '进行中', tone: 'ok' }
  /*
   * 整场没开、但有一批在放人 → 「分批进行中」。
   * 不加这一条的话，老师刚点了「开始这一批」，标签还写着「未开始」——
   * 而下面明明列着「第 1 批 进行中 2 人」，两句话互相打脸。
   */
  if (Number(x.openBatches) > 0) return { text: '分批进行中', tone: 'ok' }
  if (overDueOf(x) && x.allowLate === false) return { text: '已截止（时间到）', tone: 'mute' }
  if (x.started) return { text: '已结束', tone: 'mute' }
  return { text: '未开始', tone: 'warn' }
}

async function start() {
  if (!d.value) return
  const a = d.value.assignment
  /*
   * 时间已经过了、而且不收迟交 —— 光点「开始」是没用的：
   * status 本来就是 open，collecting 仍然算 false，学生会发现还是交不上。
   * 与其让他点完看不出变化，不如直接说清楚要先改截止时间。
   */
  if (a.overDue && a.allowLate === false) {
    toast.value = '截止时间已经过了，先点「改标题 / 说明」把截止时间往后调，再开始'
    return
  }
  const ok = window.confirm(
    '开始「' + a.title + '」？\n\n学生端立刻能进入这次作业并提交，已经在学生端的学生也会自动刷新。'
  )
  if (!ok) return
  try {
    const res = await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/start')
    toast.value = res.delivered
      ? '已开始，' + res.delivered + ' 个学生端已收到通知'
      : '已开始（有学生端稍后刷新也能看到）'
    await loadAll()
  } catch (e) {
    toast.value = e.message
  }
}

async function stop() {
  if (!d.value) return
  const ok = window.confirm(
    '结束「' + d.value.assignment.title + '」？\n\n结束后学生就交不上来了（已经交的照样能看、能批）。'
  )
  if (!ok) return
  try {
    const res = await api.post('/api/assignments/' + encodeURIComponent(curId.value) + '/stop')
    toast.value = res.delivered ? '已结束，' + res.delivered + ' 个学生端已收到通知' : '已结束，停止收卷'
    await loadAll()
  } catch (e) {
    toast.value = e.message
  }
}

async function remove() {
  if (!d.value) return
  const n = d.value.stats.submissionCount
  const ok = window.confirm(
    '删除「' + d.value.assignment.title + '」？\n\n' + (n ? '连同学生交上来的 ' + n + ' 条记录一起删，删了就找不回来。' : '这份作业还没有提交记录。')
  )
  if (!ok) return
  try {
    await api.del('/api/assignments/' + encodeURIComponent(curId.value))
    curId.value = ''
    d.value = null
    toast.value = '已删除'
    await loadAll()
  } catch (e) {
    toast.value = e.message
  }
}

/* ---------------- 新建 / 修改 ---------------- */

function dirTitleOf(dir) {
  const x = dirs.value.find((y) => y.dir === dir)
  return x ? x.title : ''
}

/** 标题还是「跟着目录自动填的」那个，换课时就跟着换；老师手动改过就不动了 */
let lastAutoTitle = ''

function onDirChange() {
  const t = dirTitleOf(form.dir)
  if (!form.title || form.title === lastAutoTitle) {
    form.title = t
    lastAutoTitle = t
  }
}

function openEditor(mode) {
  editing.value = mode
  if (mode === 'new') {
    loadDesigns()
    form.designId = ''
    form.dir = ''
    form.title = ''
    lastAutoTitle = ''
    form.note = ''
    form.weight = 1
    form.dueAt = ''
    form.allowLate = true
  } else if (d.value) {
    form.dir = d.value.assignment.dir
    form.title = d.value.assignment.title
    form.note = d.value.assignment.note || ''
    form.weight = d.value.assignment.weight === undefined ? 1 : Number(d.value.assignment.weight) || 1
    form.dueAt = d.value.assignment.dueAt ? toLocalInput(d.value.assignment.dueAt) : ''
    form.allowLate = d.value.assignment.allowLate !== false
  }
}

async function saveEditor() {
  saving.value = true
  try {
    const dueIso = form.dueAt ? new Date(form.dueAt).toISOString() : ''
    const body = {
      itemKey: props.itemKey,
      title: form.title,
      note: form.note,
      weight: form.weight,
      dueAt: dueIso,
      allowLate: !!form.allowLate,
    }
    if (editing.value === 'new') body.designId = form.designId || ''
    if (editing.value === 'new') {
      const res = await api.post('/api/assignments', body)
      curId.value = res.assignment.id
      toast.value = '建好了，记得点「开始收」学生才交得上'
    } else {
      await api.patch('/api/assignments/' + encodeURIComponent(curId.value), body)
      toast.value = '已保存'
    }
    editing.value = ''
    await loadAll()
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}

/* ---------------- 审阅 + 打分 ---------------- */

async function review(s) {
  reviewIdx.value = d.value.submissions.findIndex((x) => x.id === s.id)
  viewing.value = s
  grade.grade = s.grade || ''
  grade.late = !!s.late
  grade.raw = s.raw === null || s.raw === undefined ? '' : String(s.raw)
  grade.dims = Object.assign({}, s.dims || {})
  grade.comment = s.comment || ''
  await loadSubmission(s)
}

function step(dir) {
  const next = d.value.submissions[reviewIdx.value + dir]
  if (next) review(next)
}

function closeReview() {
  viewing.value = null
  subFiles.value = []
  previewPage.value = ''
  previewError.value = ''
  previewOk.value = false
}

async function loadSubmission(s) {
  loadingFiles.value = true
  subFiles.value = []
  previewPage.value = ''
  previewError.value = ''
  previewOk.value = false
  try {
    const res = await api.get(
      '/api/assignments/' + encodeURIComponent(curId.value) + '/submissions/' + encodeURIComponent(s.id)
    )
    subFiles.value = res.files || []
    // 默认跑 index.html；没有就第一页。学生交的是整份，不用再回去拿原始示例
    const list = pagesOf(subFiles.value)
    previewPage.value = list.find((p) => /^index\.html?$/i.test(p)) || list[0] || ''
  } catch (e) {
    toast.value = e.message
  } finally {
    loadingFiles.value = false
    // iframe 是 v-else 才渲染的，等它上屏之后再灌 srcdoc
    await nextTick()
    if (viewing.value && previewPage.value) runPreview()
  }
}

async function saveGrade() {
  if (!viewing.value) return
  saving.value = true
  try {
    const res = await api.post(
      '/api/assignments/' + encodeURIComponent(curId.value) +
        '/submissions/' + encodeURIComponent(viewing.value.id) + '/grade',
      { grade: grade.grade, late: grade.late, raw: grade.raw, dims: grade.dims, comment: grade.comment }
    )
    // 就地把列表里的那行改掉，不重新拉整页，免得打断「下一条」的节奏
    const i = d.value.submissions.findIndex((x) => x.id === viewing.value.id)
    if (i >= 0) d.value.submissions[i] = res.submission
    d.value.stats.gradedCount = d.value.submissions.filter((x) => x.graded).length
    toast.value = '已保存'
    if (reviewIdx.value < d.value.submissions.length - 1) step(1)
    else closeReview()
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}

/** 打回重做：清分 + 作废计分记录，学生就能再交 */
async function redo() {
  if (!viewing.value) return
  if (!window.confirm('打回「' + (viewing.value.name || '这位同学') + '」的这次提交？\n\n分数与评语会清空、计分记录作废，学生可以重新提交。')) return
  saving.value = true
  try {
    const res = await api.post(
      '/api/assignments/' + encodeURIComponent(curId.value) +
        '/submissions/' + encodeURIComponent(viewing.value.id) + '/redo'
    )
    const i = d.value.submissions.findIndex((x) => x.id === viewing.value.id)
    if (i >= 0) d.value.submissions[i] = res.submission
    viewing.value = res.submission
    d.value.stats.gradedCount = d.value.submissions.filter((x) => x.graded).length
    toast.value = res.message || '已打回'
    loadProgress()
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}

/**
 * 删除某个学生的这份提交。
 *
 * 和「打回重做」的区别（两个都要，别合并）：
 *   打回重做 —— 提交还在，只清分数/评语、作废计分，学生能接着改再交
 *   删除提交 —— 文件 + 记录一起删，学生回到「未交」，**找不回来**
 *
 * 为什么需要它：学生交错了（比如把别的课的包传上来），老师没法在界面上清掉，
 * 只能让他重交覆盖 —— 但「这份根本不该存在」的情况覆盖不了。
 * 后端一直有 DELETE /api/assignments/:id/submissions/:sid，缺的是入口。
 */
async function delSubmit() {
  if (!viewing.value) return
  const s = viewing.value
  const ok = window.confirm(
    '删除「' + (s.name || s.sid) + '」的这份提交？\n\n' +
      '会一起删掉：交上来的 ' + (s.fileCount || 0) + ' 个文件' +
      (s.graded ? '，以及这次的评分（计分记录会作废）' : '') + '。\n' +
      '删完学生回到「未交」，可以重新交一次。\n\n' +
      '删掉找不回来 —— 只是想让他重做的话，用「打回重做」。',
  )
  if (!ok) return
  saving.value = true
  try {
    await api.del(
      '/api/assignments/' + encodeURIComponent(curId.value) +
        '/submissions/' + encodeURIComponent(s.id),
    )
    /* 就地从列表里去掉，再拉一次进度（已交/已批两个数字要跟着变） */
    const i = d.value.submissions.findIndex((x) => x.id === s.id)
    if (i >= 0) d.value.submissions.splice(i, 1)
    if (d.value.stats) {
      d.value.stats.submissionCount = d.value.submissions.length
      d.value.stats.gradedCount = d.value.submissions.filter((x) => x.graded).length
    }
    closeReview()
    toast.value = '已删除 ' + (s.name || s.sid) + ' 的提交'
    loadProgress()
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}

async function clearGrade() {
  if (!viewing.value) return
  grade.grade = ''
  grade.late = false
  grade.raw = ''
  grade.dims = {}
  saving.value = true
  try {
    const res = await api.post(
      '/api/assignments/' + encodeURIComponent(curId.value) +
        '/submissions/' + encodeURIComponent(viewing.value.id) + '/grade',
      { grade: '', late: false, raw: '', dims: '', comment: grade.comment }
    )
    const i = d.value.submissions.findIndex((x) => x.id === viewing.value.id)
    if (i >= 0) d.value.submissions[i] = res.submission
    viewing.value = res.submission
    toast.value = '已清掉分数'
  } catch (e) {
    toast.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
/* 「正在放 N 个批次 + 全部结束」那条 */
.ball {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px var(--sp-3);
  margin-bottom: var(--sp-2);
  border-radius: var(--r-sm);
  background: #fdf6ec;
  border: 1px solid #f0dcc0;
}

/* 批阅进度条（已交 / 已批 / 未交） */
.progbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin: 2px 0 8px;
  font-size: var(--fs-sm);
  color: #40505f;
}

.pb-k {
  color: #6b7a88;
}

.pb-sep {
  width: 1px;
  height: 12px;
  background: var(--line);
  margin: 0 4px;
}

.pb-warn {
  color: #b4740f;
}

.pb-miss {
  flex-basis: 100%;
  line-height: 1.6;
}

/* 作业目录里的每一行 */
.lib-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 8px var(--sp-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  margin: var(--sp-2);
  background: var(--card);
}

.lib-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.lib-acts {
  display: flex;
  gap: 4px;
  flex: 0 0 auto;
}

/* ---------------- 分批开始 ---------------- */

/* 批次列表：一行一批，进行中的左侧一条蓝线 */
.blist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--sp-3);
}
.brow {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px var(--sp-2) 6px var(--sp-3);
  border-left: 2px solid transparent;
  border-radius: var(--r-sm);
  background: var(--bg-sub);
  font-size: var(--fs-md);
}
.brow.live {
  border-left-color: var(--brand);
  background: #eef4f9;
}
/* 这一批时间到了、但老师还没点结束：橙色，提醒他该收或该关 */
.brow.timeup {
  border-left-color: #d08a2e;
  background: #fdf6ec;
}

/* 这一批的剩余时间 */
.brow .bleft {
  font-size: var(--fs-sm);
  color: #a15c00;
  font-variant-numeric: tabular-nums;
}
.brow .bleft.over {
  color: var(--err);
  font-weight: 600;
}

/* 限时输入：窄一点，不要抢「开始这一批」的注意力 */
.minbox {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-sm);
  color: #5b6673;
}
.minbox input {
  width: 58px;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  font: inherit;
  text-align: center;
}
.brow .bseq {
  font-weight: 600;
  color: #1f2937;
}
.brow .bstat {
  font-size: var(--fs-sm);
  color: #8b95a1;
}
.brow.live .bstat {
  color: var(--brand);
}

/* 选人条 */
.pickbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--line-soft);
  margin-bottom: var(--sp-2);
}

/*
 * 名单：小格子铺开，勾中的实心。
 * 已交的压暗 —— 分批时常见的是「把还没交的勾上」，
 * 一眼能跳过已交的人。
 */
.pickers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 190px;
  overflow: auto;
}
.pk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px 3px 6px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  background: #fff;
  font-size: var(--fs-sm);
  color: #3c4650;
  cursor: pointer;
  user-select: none;
}
.pk:hover {
  border-color: #b9c6d3;
}
.pk.on {
  background: #e8f1f8;
  border-color: var(--brand);
  color: var(--brand-ink, #1b4a6b);
  font-weight: 600;
}
.pk.done {
  opacity: 0.5;
}
.pk input {
  margin: 0;
  accent-color: var(--brand);
}
.pk em {
  font-style: normal;
  font-size: 10.5px;
  color: #8b95a1;
}
/* 已经排过批的：标出第几批 */
.pk em.bq {
  color: #7b8794;
}

/* 按班选：按钮上带一个数字（还剩几人），点之前就知道会勾多少 */
.clgroup {
  display: inline-flex;
  gap: 4px;
  padding-left: var(--sp-2);
  border-left: 1px solid var(--line-soft);
}
.clbtn em {
  font-style: normal;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 999px;
  background: #eef4f9;
  color: var(--brand);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.clbtn em.done {
  background: #eef7ef;
  color: var(--ok);
}

/*
 * 「未交 · N 人」的折叠开关。
 * 标题本身就是按钮 —— 比在旁边再放一个「看名单」更省地方，
 * 而且卡片标题天然是"点这里展开"的期待。
 */
.misstoggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.misstoggle:hover {
  color: #1f6feb;
}
/* 三角：定宽，展开/收起时标题不左右跳 */
.misstoggle .tri {
  display: inline-block;
  width: 10px;
  font-size: 10px;
  color: #8b95a1;
}

.linkish {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: #1f6feb;
  cursor: pointer;
  text-decoration: underline dotted;
}

.linkish:hover {
  text-decoration: underline;
}

.wtip {
  margin: var(--sp-2);
  color: #1d4ed8;
  font-style: normal;
}

.hwbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.hwpill {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}

.hwpill .cnt {
  padding: 0 var(--sp-1);
  border-radius: var(--r-lg);
  background: #eef1f3;
  color: #5a6570;
  font-size: var(--fs-xs);
}

.led {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #cbd5e1;
}

.led.on {
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.16);
}

.led.off {
  background: #94a3b8;
}

/* 左右和 .card 统一成 16（原来 12，比同页其它卡片窄 4px） */
.ctrl {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  margin-bottom: var(--sp-3);
}

.ctrl-l {
  min-width: 0;
}

.ctrl-l h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 15.5px;
}

.ctrl-l p {
  margin: 2px 0;
  font-size: var(--fs-sm);
}

.ctrl-r {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--sp-2);
  margin-bottom: 12px;
}

.st {
  padding: var(--sp-2) 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--card);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stn {
  font-size: 21px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

.stn.ok {
  color: var(--ok);
}

.stn.warn {
  color: var(--warn);
}

.stn.err {
  color: var(--err);
}

.stl {
  font-size: var(--fs-sm);
  color: var(--dim);
}

.cmt {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.miss {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  padding: var(--sp-2) 12px;
}

.missi {
  padding: 2px 8px;
  border-radius: var(--r-sm);
  background: #fbf4e9;
  border: 1px solid #dfcba8;
  color: #7a5a20;
  font-size: var(--fs-sm);
}

.missi em {
  font-style: normal;
  margin: var(--sp-1);
  color: #a08a5e;
  font-size: var(--fs-xs);
}

/* 审阅弹层比常规 wide 更宽：左边代码 + 右边渲染，两侧都得看得清 */
.modal.xwide {
  max-width: min(1480px, 96vw);
  max-height: 92vh;
}

/* 审阅：左代码 / 右渲染，下面一行说明 */
.review {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(360px, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  gap: var(--sp-2);
  height: min(68vh, 660px);
  overflow: hidden;
}

.rev-code {
  min-width: 0;
  min-height: 0;
}

/* 文件列表挤一点，把宽度让给代码 */
.rev-code :deep(.cv) {
  grid-template-columns: 158px minmax(0, 1fr);
}

.rev-run {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--line-soft);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--card);
}

.rev-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: var(--sp-2) 8px;
  border-bottom: 1px solid var(--line-soft);
  background: #fbfcff;
}

.rev-head .select {
  padding: 4px 8px;
  font-size: var(--fs-sm);
  max-width: 62%;
}

.rev-frame {
  flex: 1;
  width: 100%;
  border: none;
  background: var(--card);
  min-height: 0;
}

.npmnote {
  flex: 1;
  padding: 16px var(--sp-3);
  font-size: var(--fs-sm);
  line-height: 1.75;
  color: #92400e;
  background: #fffdf7;
  overflow: auto;
}

.rev-note {
  margin: 0;
  padding: var(--sp-1) 8px;
  border-top: 1px solid var(--line-soft);
  background: #fbfcff;
}

.perr {
  border-top: 1px solid #fecaca;
  background: #fef2f2;
  color: #b91c1c;
  padding: var(--sp-2) var(--sp-5) var(--sp-2) 8px;
  font: 11.5px/1.55 Consolas, monospace;
  white-space: pre-wrap;
  max-height: 92px;
  overflow: auto;
  position: relative;
}

.perr b {
  margin: var(--sp-1);
}

.perr-x {
  position: absolute;
  top: 2px;
  right: 4px;
  border: none;
  background: none;
  color: #b91c1c;
  cursor: pointer;
  font-size: var(--fs-md);
  line-height: 1;
}

.filenote {
  margin: 0;
  grid-column: 1 / -1;
}

.grade {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

/* 等级 + 迟交占一整行，评语和按钮在下一行 */
.gline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  width: 100%;
  padding-bottom: 2px;
  border-bottom: 1px dashed var(--line-soft);
  margin-bottom: 2px;
}

.field.inline {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
  color: #4a525a;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.check.mini {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-sm);
  color: var(--dim);
}
</style>
