<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>班级管理 · 名单与分数</template>
        <template #sub>{{ itemsLine }}；这一页只看分，记分在各模块页 / 考勤页里做</template>
      </PageHead>
    </template>
    <p v-if="error" class="hint err" style="margin-bottom:12px">{{ error }}</p>

    <!-- 本页操作：导出 / 导入 / 新建，从页头下放（页头只留标题和全局字号） -->
    <div class="page-actions">
      <span class="dim mini">{{ classes.length ? '共 ' + classes.length + ' 个班级' : '' }}</span>
      <span class="spacer"></span>
      <button
        class="btn mini"
        :disabled="!hasClasses"
        @click="ioExport"
        title="把本课程所有班级与名单打成一个 zip（换机器 / 交给同事）"
      >
        ⤓ 导出班级与名单
      </button>
      <button
        class="btn mini"
        @click="openIO"
        title="从一个 zip 导入班级与名单（先给逐班报告，确认后才写）"
      >
        ⤒ 导入班级与名单
      </button>
      <button class="btn mini" @click="newClass">＋ 新建班级</button>
    </div>

    <div v-if="!classes.length" class="card">
      <div class="empty">
        还没有班级。点上面「＋ 新建班级」，建好后在名单卡片上点「⤒ 导入名单」（支持 .xlsx / .csv，也可直接粘贴）。
      </div>
    </div>

    <template v-else>
      <div class="card classbar">
        <button
        v-for="c in classes"
        :key="c.id"
        class="pill"
        :class="{ on: c.id === activeId }"
        @click="switchClass(c.id)"
        >
        {{ c.name }}<em>{{ c.studentCount ?? c.count ?? '' }}</em>
      </button>
      <span class="spacer"></span>
      <button v-if="active" class="btn mini" @click="renameClass">重命名</button>
      <button v-if="active" class="btn mini danger" @click="removeClass">删除班级</button>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ on: tab === 'board' }" @click="tab = 'board'">班级名单</button>
      <button class="tab" :class="{ on: tab === 'log' }" @click="tab = 'log'">
        全班流水 <span class="dim">{{ events.length }}</span>
      </button>
      <button class="tab" :class="{ on: tab === 'login' }" @click="openLogin">
        登录管理
        <span v-if="login.blockedCount" class="dim">{{ login.blockedCount }} 人禁登</span>
      </button>
    </div>

    <section v-show="tab === 'board'" class="card">
      <CardHead>
        <template #title>{{ active ? active.name : '' }}</template>
        <template #meta><span class="dim">
            {{ students.length }} 人 · 在线 {{ presence.onlineCount }} · 在看投屏 {{ presence.castingCount }} · 平均
            {{ board.totalAvg || 0 }} · 及格率 {{ board.passRate || 0 }}%
          </span></template>
        <template #right>
          <!-- 这一组都是「这个班」的操作，和页头的「整门课」分开 -->
          <button class="btn mini" :disabled="!active" @click="openStudent(null)">＋ 添加学生</button>
          <button
            class="btn mini"
            :disabled="!active"
            @click="openImport"
            title="导入这一个班的名单：支持 .xlsx / .csv，也可以直接粘贴"
          >
            ⤒ 导入名单
          </button>
          <button class="btn mini" :disabled="!active" @click="exportSheet('totals')" title="导出本班总评（xlsx，Excel 直接打开）">
            导出总评
          </button>
          <span class="dim">点一行看明细 · 在线状态每 8 秒刷新</span>
        </template>
      </CardHead>

      <!-- 筛选条：关键字 + 几个常用的「只看…」，跟排序互不影响 -->
      <FilterBar>
        <input v-model.trim="q" class="input" placeholder="搜姓名 / 学号" style="width: 150px" />
        <select v-model="fStatus" class="select">
          <option value="">状态：全部</option>
          <option value="online">只看在线</option>
          <option value="offline">只看离线</option>
        </select>
        <select v-model="fCast" class="select">
          <option value="">投屏：全部</option>
          <option value="on">只看在看</option>
        </select>
        <select v-model="fTotal" class="select">
          <option value="">总评：全部</option>
          <option value="pass">及格（≥60）</option>
          <option value="fail">不及格（&lt;60）</option>
        </select>
        <select v-model="fBonus" class="select">
          <option value="">加分：全部</option>
          <option value="has">只看有加分</option>
        </select>
        <span class="dim">{{ filtered.length }} / {{ boardList.length }} 人</span>
        <span class="spacer"></span>
        <button v-if="hasFilter" class="btn mini" @click="clearFilter">清除筛选</button>
        <span class="dim">点表头排序 · 课堂作业 / 大作业的分在各模块里打，这里只显示</span>
      </FilterBar>

      <DataTable
        :columns="cols"
        :rows="filtered"
        :row-key="(r) => r.student.sid"
        clickable
        max-height="62vh"
        :sort-key="sortKey"
        :sort-dir="sortDir"
        :empty="students.length ? '没有匹配的学生，换个筛选条件或点「清除筛选」' : '还没有名单，先「导入名单」'"
        @sort="sortBy"
        @row-click="(r) => (pickedSid = r.student.sid)"
      >
        <template #cell="{ row, index, column }">
          <template v-if="column.key === 'no'">{{ index + 1 }}</template>
          <template v-else-if="column.key === 'sid'">{{ row.student.sid }}</template>
          <template v-else-if="column.key === 'name'"><b style="font-weight: 500">{{ row.student.name }}</b></template>
          <template v-else-if="column.key === 'status'">
            <span class="tag" :class="presenceSet.has(row.student.sid) ? 'ok' : 'mute'">
              {{ presenceSet.has(row.student.sid) ? '在线' : '离线' }}
            </span>
          </template>
          <template v-else-if="column.key === 'cast'">
            <span class="tag" :class="castingSet.has(row.student.sid) ? 'ok' : 'mute'">
              {{ castingSet.has(row.student.sid) ? '在看' : '—' }}
            </span>
          </template>
          <template v-else-if="column.key === 'total'"><b>{{ row.total }}</b></template>
          <template v-else-if="column.key === 'actions'">
            <button class="btn mini" title="改姓名 / 学号" @click.stop="openStudent(row.student)">编辑</button>
            <button class="btn mini danger" title="从名单里移除（记录保留）" @click.stop="removeStudent(row.student)">删除</button>
          </template>
          <template v-else>{{ column.value ? column.value(row) : row[column.key] }}</template>
        </template>
      </DataTable>
    </section>

    <section v-show="tab === 'log'" class="card">
    <CardHead>
    <template #title>全班流水</template>
    <template #right>
      <select v-model="logItem" class="select">
        <option value="">全部计分项</option>
        <option v-for="it in items" :key="it.key" :value="it.key">{{ it.name }}</option>
      </select>
      <input v-model.trim="logQ" class="input" placeholder="搜姓名 / 学号 / 原因" style="width: 200px" />
      <button class="btn mini" :disabled="!active" @click="exportSheet('events')" title="导出本班记分记录（xlsx，Excel 直接打开）">
        导出流水
      </button>
      <span class="dim">有效 {{ liveCount }} 条</span>
    </template>
    </CardHead>

    <ul class="log">
    <li v-for="e in filteredEvents" :key="e.id" :class="{ voided: e.voided }">
      <div class="lhead">
        <span class="when">{{ fmt(e.createdAt) }}</span>
        <b class="who">{{ nameOf(e.sid) }}</b>
        <span class="tag" :class="'tag-' + e.item">{{ itemName(e.item) }}</span>
        <b class="delta">{{ summary(e) }}</b>
        <span v-if="e.voided" class="tag mute">已撤销</span>
        <span class="spacer"></span>
      </div>
      <p class="reason">{{ e.reason }}</p>
      <div class="lf">
        <span class="dim">{{ e.operator }}</span>
        <a v-for="f in e.evidence || []" :key="f.url" :href="f.url" target="_blank" rel="noopener">{{ f.name }}</a>
      </div>
    </li>
    <li v-if="!filteredEvents.length" class="empty">没有符合条件记录</li>
    </ul>
    </section>

    <!--
      登录管理：学生登录方式 + 谁被禁登 + 外部系统真实的输错次数。
      放这里而不是课程管理页 —— 老师是「按班」管人的，切个方式、放个人都在这张表上。
    -->
    <section v-show="tab === 'login'" class="card">
      <CardHead>
        <template #title>登录管理</template>
        <template #right>
          <button class="btn mini" @click="loadLogin">刷新</button>
        </template>
      </CardHead>

      <div class="lgrow">
        <label class="lgopt">
          <input v-model="login.mode" type="radio" value="local" @change="setLoginMode('local')" />
          <span>
            <b>学号 + 姓名</b>
            <em class="dim mini">和名单比对，不联网；学生只要知道学号就能进</em>
          </span>
        </label>
        <label class="lgopt">
          <input v-model="login.mode" type="radio" value="kg" @change="setLoginMode('kg')" />
          <span>
            <b>账号 + 密码</b>
            <em class="dim mini">能登上学校平台才放行；第一次核验后记住，之后本地比对</em>
          </span>
        </label>
      </div>

      <p v-if="login.mode === 'kg'" class="dim mini">
        连错 <b>3</b> 次本系统就暂停该账号登录（不会让它数到外部的 5 次上限）——
        这样最坏只是「进不了课堂系统」，而不是「学校账号被锁」。
      </p>

      <template v-if="login.mode === 'kg'">
        <label class="chkrow">
          <input v-model="login.verifyEachTime" type="checkbox" @change="saveVerifyEach" />
          <span>
            <b>每次登录都向平台核验</b>
            <em class="dim mini">
              关闭（默认）：第一次通过后记住密码，之后本地比对 ——
              学生登录快（50 毫秒级），也少消耗平台的失败次数。
              打开：每次都问平台（1 秒多），最准，但每次都在消耗它的失败计数。
              这个区别学生看不到，他只需要输账号 + 密码。
            </em>
          </span>
        </label>

        <div class="lgbases">
          <label v-for="(b, i) in login.kgBases" :key="i" class="lgbase">
            <span class="dim mini">入口 {{ i + 1 }}</span>
            <input v-model="login.kgBases[i]" class="input" placeholder="http://ip:port" @blur="saveBases" />
          </label>
        </div>
        <p class="dim mini">
          两个入口内容一样，按请求轮询分流。失败不会换另一个重试（换了也只是多消耗一次失败次数）。
        </p>

        <div class="lgcreds">
          <span class="dim mini">
            已记住 <b>{{ login.rememberedCount }}</b> 个学生的密码（存的是不可逆的派生值，不是明文）。
          </span>
          <button class="btn mini" :disabled="!login.rememberedCount" @click="clearCreds">
            清空全部记住的密码
          </button>
        </div>
      </template>

      <table class="lgtbl">
        <thead>
          <tr>
            <th>学号</th>
            <th>姓名</th>
            <th class="num">本系统失败</th>
            <th class="num">平台自报输错</th>
            <th>状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in loginRows" :key="s.sid">
            <td class="mono">{{ s.sid }}</td>
            <td>{{ s.name }}</td>
            <td class="num">{{ s.failCount || '—' }}</td>
            <td class="num">
              <span v-if="s.remoteCount">{{ s.remoteCount }}</span>
              <span v-else class="dim">—</span>
            </td>
            <td>
              <span v-if="s.manual" class="tag err">老师禁用</span>
              <span v-else-if="s.auto" class="tag warn" :title="'约 ' + untilText(s.until) + ' 自动恢复'">
                连错 {{ s.failCount }} 次
              </span>
              <span v-else class="dim">正常</span>
            </td>
            <td class="ops">
              <!-- 手动禁用的只需要一个「解除」；自动熔断的多给一个「解除禁登」 -->
              <button v-if="s.manual" class="btn mini" @click="unblockOne(s)">解除禁用</button>
              <template v-else>
                <button class="btn mini danger" @click="blockOne(s)">禁用</button>
                <button v-if="s.auto" class="btn mini" @click="unblockOne(s)">解除禁登</button>
              </template>
            </td>
          </tr>
          <tr v-if="!loginRows.length">
            <td colspan="6" class="empty">这个班没有学生</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 点名：并进这里，不再单开一个页面 -->
    </template>


    <!-- 学生明细 -->
    <StudentDrawer
    v-if="pickedRow"
    :student="pickedRow.student"
    :row="pickedRow"
    :items="items"
    readonly
    @close="pickedSid = ''"
    />

    <!-- 添加 / 编辑学生 -->
    <div v-if="editingStudent" class="mask" @click.self="editingStudent = null">
    <div class="modal">
    <div class="modal-head">
    <h3>{{ editingStudent.isNew ? '添加学生' : '编辑学生' }} · {{ active ? active.name : '' }}</h3>
    <button class="btn mini" style="margin-left: auto" @click="editingStudent = null">关闭</button>
    </div>
    <div class="modal-body">
    <label class="field">
      <span>学号</span>
      <input
      v-model.trim="studentForm.sid"
      class="input"
      placeholder="如 2025010102"
      :disabled="!editingStudent.isNew && studentForm.hasRecords"
      />
    </label>
    <p v-if="!editingStudent.isNew && studentForm.hasRecords" class="hint warn" style="margin: -2px 0 10px">
      这个学生已有记分 / 作业记录，学号不能改（姓名可以改）。
    </p>
    <label class="field">
      <span>姓名</span>
      <input v-model.trim="studentForm.name" class="input" placeholder="如 李四" @keyup.enter="saveStudent" />
    </label>
    </div>
    <div class="modal-foot">
    <span class="dim">只改名单，不动已有的记分与作业</span>
    <span class="spacer"></span>
    <button class="btn ghost" @click="editingStudent = null">取消</button>
    <button class="btn primary" :disabled="studentBusy || !studentForm.sid || !studentForm.name" @click="saveStudent">
      {{ studentBusy ? '保存中…' : '保存' }}
    </button>
    </div>
    </div>
    </div>

    <!-- 班级与名单：整门课一起搬。导出已移到页头，这里是纯导入 -->
    <ImportDialog
      v-model="cio.open"
      :title="'导入班级与名单'"
      :file-name="cio.name"
      accept=".zip"
      :busy="cio.busy"
      :error="cio.err"
      :has-report="!!cio.report"
      pick-text="⤒ 选择 zip 文件"
      template-label="⤓ 没有包？下载空模板"
      template-hint="空模板里有一个示例班 + 命名与格式说明：一个 csv = 一个班，文件名就是班名。"
      :confirm-disabled="!cio.report"
      foot-hint="点确认之前一个字节都没写"
      wide
      @pick="ioFile"
      @template="ioTemplate"
      @confirm="ioApply"
      @close="closeIO"
    >
      <template #hint>
        <p class="dim mini" style="margin-top: 0">
          一个 csv = 一个班，<b>文件名就是班名</b>（如 <code>示例1班.roster.csv</code>），三列「学号,姓名,备注」。
          照模板填好各班名单、压缩成 zip 导进来，一次把整门课配齐。
        </p>
        <p class="hint mini" style="margin-top: 0">
          只想换 <b>一个班</b> 的名单？关掉这里，用名单卡片上的「⤒ 导入名单」——那个直接吃 .xlsx / .csv，不用打包。
        </p>
      </template>

      <template #report>
        <p class="hint" style="margin: 0 0 6px">
          {{ cio.name }}：新建 <b class="add">{{ cio.report.totals.create }}</b> 个班 ·
          更新 {{ cio.report.totals.update }} 个班 ·
          新增 {{ cio.report.totals.added }} 人 · 改名 {{ cio.report.totals.renamed }} 人
          <template v-if="cio.report.totals.removed">· <b class="del">移出 {{ cio.report.totals.removed }}</b> 人</template>
        </p>
        <div class="cio-list">
          <div v-for="c in cio.report.classes" :key="c.name" class="cio-row">
            <span class="cio-name">{{ c.name }}</span>
            <span class="cio-act" :class="{ add: c.action === 'create' }">{{ c.action === 'create' ? '新建' : '已有' }}</span>
            <span class="dim">
              {{ c.before }} → <b>{{ c.after }}</b> 人 ·
              新增 {{ c.added }} · 改名 {{ c.updated }}<template v-if="c.removed"> · 移出 {{ c.removed }}</template>
            </span>
          </div>
        </div>
        <div v-if="cio.report.issues.length" class="hint warn" style="margin-top: 8px">
          <b>有 {{ cio.report.issues.length }} 处有问题（相关班可能少人）：</b>
          <ul class="iss">
            <li v-for="(it, i) in cio.report.issues.slice(0, 8)" :key="i">{{ it.cls }}：<template v-if="it.line">第 {{ it.line }} 行 </template>{{ it.msg }}</li>
          </ul>
        </div>
        <p v-if="cio.report.notInPack && cio.report.notInPack.length" class="dim mini">
          包里没有这些班，本地保留不动：{{ cio.report.notInPack.join('、') }}
        </p>

        <div class="row" style="margin-top: 10px">
          <label class="check"><input v-model="cio.mode" type="radio" value="merge" /> 合并（名单只增不减，推荐）</label>
          <label class="check"><input v-model="cio.mode" type="radio" value="replace" /> 整体替换（名单同步成包里的）</label>
        </div>
        <p class="dim mini">整体替换只换名单，已有记分记录不删。</p>
      </template>
    </ImportDialog>

    <!-- 导入名单 -->
    <div v-if="importing" class="mask" @click.self="importing = false">
    <div class="modal">
    <div class="modal-head">
    <h3>导入名单 · {{ active ? active.name : '' }}</h3>
    <button class="btn mini" style="margin-left: auto" @click="importing = false">关闭</button>
    </div>
    <div class="modal-body">
    <div class="row" style="margin-bottom: 10px">
      <button class="btn mini" @click="downloadTemplate" title="3 列：学号,姓名,备注（xlsx，Excel 直接打开）">
        下载空模板
      </button>
      <!--
        disabled 之前判的是 active.students —— 那个字段从来没被赋值（classes 里只有 count），
        所以这个按钮一直是灰的，老师永远点不了。改成看页面上真实的名单数组。
      -->
      <button class="btn mini" @click="downloadCurrent" :disabled="!students.length" title="导出本班现有名单（xlsx），改完再传回来">
        下载当前名单
      </button>
      <span class="dim">表格按「学号,姓名,备注」填，存成 .xlsx 或 .csv 都行</span>
    </div>
    <div class="row" style="margin-bottom: 12px">
      <button class="btn mini" @click="fileInput.click()">选择 .xlsx / .csv</button>
      <input ref="fileInput" type="file" accept=".xlsx,.csv,.txt" style="display: none" @change="onFile" />
      <span class="dim">也可以把名单直接粘到下面</span>
    </div>
    <textarea
    v-model="pasteText"
    class="textarea"
    style="width: 100%; box-sizing: border-box"
    rows="7"
    placeholder="每行一条：学号 姓名（或 1,2025010101,张三 / 表格里直接复制粘贴）"
    @input="parsePaste"
    ></textarea>

    <div class="row" style="margin-top: 12px">
    <label class="check"><input v-model="importMode" type="radio" value="merge" /> 追加（保留原有同学）</label>
    <label class="check"><input v-model="importMode" type="radio" value="replace" /> 覆盖本班名单</label>
    </div>

    <p v-if="parsed.length || (report && report.counts)" class="hint" style="margin-top: 10px">
    解析到 <b>{{ report && report.counts ? report.counts.parsed : parsed.length }}</b> 人<template v-if="sheetName">（{{ sheetName }}）</template><template v-if="parsed.length">：{{ previewNames }}</template>}
    </p>

    <!-- 服务端干跑：这一步只算不写 -->
    <div v-if="checking" class="hint" style="margin-top: 8px">正在核对名单…</div>
    <div v-if="report && report.counts" class="import-plan" style="margin-top: 8px">
      <div class="ip-row">
        <span class="ip-k">变更</span>
        <span>
          新增 <b class="add">{{ report.counts.added }}</b> 人 ·
          改名 {{ report.counts.updated }} 人 ·
          不变 {{ report.counts.unchanged }} 人
          <template v-if="report.counts.removed">· <b class="del">移出 {{ report.counts.removed }}</b> 人</template>
        </span>
      </div>
      <div class="ip-row">
        <span class="ip-k">班级人数</span>
        <span>{{ report.currentCount }} → <b>{{ report.currentCount + report.counts.added - report.counts.removed }}</b> 人</span>
      </div>
      <div v-if="report.details && report.details.updated.length" class="ip-row">
        <span class="ip-k">改名</span>
        <span class="dim">{{ report.details.updated.map((r) => r.sid + '：' + (r.from || '（空）') + ' → ' + r.to).join('、') }} <template v-if="report.counts.updated > report.details.updated.length">等 {{ report.counts.updated }} 人</template></span>
      </div>
      <div v-if="report.details && report.details.removed.length" class="ip-row">
        <span class="ip-k">移出</span>
        <span class="del">{{ report.details.removed.map((r) => r.name + '（' + r.sid + '）').join('、') }} <template v-if="report.counts.removed > report.details.removed.length">等 {{ report.counts.removed }} 人</template></span>
      </div>
      <div class="ip-tip dim">核对无误再点右下角「确认导入」——这一步之前一个字节都没写。</div>
    </div>

    <div v-if="issues.length" class="hint warn" style="margin-top: 8px">
    <b>有 {{ issues.length }} 行没被采纳（不会导入，改好再传）：</b>
    <ul class="iss">
      <li v-for="(it, i) in issues.slice(0, 8)" :key="i">
        第 {{ it.line }} 行：{{ it.msg }}<span v-if="it.raw" class="dim">（{{ it.raw }}）</span>
      </li>
    </ul>
    <span v-if="issues.length > 8" class="dim">…… 还有 {{ issues.length - 8 }} 行</span>
    </div>
    <p v-if="!parsed.length && !issues.length" class="hint warn" style="margin-top: 10px">还没解析到学生：选一个表格文件，或粘贴「学号 姓名」列表。</p>
    <p v-if="importError" class="hint err" style="margin-top: 8px">{{ importError }}</p>
    </div>
    <div class="modal-foot">
    <span class="dim">覆盖只换名单，不删已有记分记录</span>
    <span class="spacer"></span>
    <button class="btn ghost" @click="importing = false">取消</button>
    <button
      class="btn primary"
      :disabled="!report || checking || importingBusy || (!parsed.length && !sheetFile)"
      @click="doImport"
    >
      {{
        importingBusy
          ? '导入中…'
          : report
            ? '确认导入（' + (report.counts ? report.counts.parsed : parsed.length) + ' 人）'
            : '先选名单'
      }}
    </button>
    </div>
    </div>
    </div>

    <Toast :text="toast" @close="toast = ''" />
  </PageShell>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import StudentDrawer from '../../components/StudentDrawer.vue'
import Toast from '../../components/Toast.vue'
import { currentClassId, setClassId } from '../../utils/classSel'
import { api, download, getCourse, getToken } from '../../api'
import { refresh, state } from '../../store'
import { rowsToRosterDetailed, textToRows } from '../../utils/roster'
import { loadScheme } from '../../utils/scheme'
import PageHead from '../../components/PageHead.vue'
import CardHead from '../../components/CardHead.vue'
import FilterBar from '../../components/FilterBar.vue'
import PageShell from '../../components/PageShell.vue'
import DataTable from '../../components/DataTable.vue'
import ImportDialog from '../../components/ImportDialog.vue'

const classes = computed(() => state.classes)
const courseId = computed(() => getCourse())
const hasClasses = computed(() => classes.value.length > 0)
const courseName = ref('') // 当前课程名（打开「班级与名单」时顺手取一次）
const items = computed(() => state.items)
const mainItems = computed(() => state.items.filter((i) => !i.extra))

/* 顶部的「考勤 10 + 互动 10 + …」按当前方案现算，改分值不用改代码 */
const itemsLine = computed(() => {
  const parts = state.items.map((i) => (i.short || i.name) + ' ' + i.full)
  return parts.length ? parts.join(' + ') : '还没有考核项'
})

const route = useRoute()
const activeId = ref(localStorage.getItem('scores-class') || '')
// 老链接 /teacher/rollcall 会重定向到这里并带上 ?tab=rollcall
const tab = ref(['board', 'log', 'login'].indexOf(route.query.tab) >= 0 ? route.query.tab : 'board')

/* ---------------- 登录管理 ---------------- */
const login = reactive({
  mode: 'local',
  verifyEachTime: false,
  kgBases: [],
  rememberedCount: 0,
  blockedCount: 0,
  students: [],
})

/** 改「每次登录都核验」 */
async function saveVerifyEach() {
  try {
    await api.patch('/api/settings/student-auth', { verifyEachTime: login.verifyEachTime })
    toast.value = login.verifyEachTime
      ? '已开启：每次登录都向平台核验'
      : '已关闭：记住密码后本地比对'
  } catch (e) {
    toast.value = '保存失败：' + e.message
    await loadLogin()
  }
}

/** 改平台入口（两个内容一样，轮询分流） */
async function saveBases() {
  try {
    await api.patch('/api/settings/student-auth', { kgBases: login.kgBases })
    toast.value = '入口已保存'
  } catch (e) {
    toast.value = '保存失败：' + e.message
    await loadLogin()
  }
}

/** 清空所有记住的密码（学生改过密码、或怀疑泄露时用） */
async function clearCreds() {
  if (!window.confirm('清空所有学生记住的密码？\n\n学生下次登录会重新核验一次，不影响成绩。')) return
  try {
    const r = await api.del('/api/settings/student-auth/creds')
    login.rememberedCount = 0
    toast.value = '已清空 ' + (r.removed || 0) + ' 条记住的密码'
    await loadLogin()
  } catch (e) {
    toast.value = '清空失败：' + e.message
  }
}

/** 有问题的排前面：老师打开这一页就是要看谁出事了 */
const loginRows = computed(() => {
  const list = (login.students || []).slice()
  const score = (s) => (s.manual ? 3 : 0) + (s.auto ? 2 : 0) + (s.failCount || 0) + (s.remoteCount || 0)
  list.sort((a, b) => score(b) - score(a) || String(a.sid).localeCompare(String(b.sid)))
  return list
})

function untilText(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!(ms > 0)) return '已到期'
  const h = Math.floor(ms / 3600000)
  return h >= 1 ? h + ' 小时后' : Math.round(ms / 60000) + ' 分钟后'
}

function openLogin() {
  tab.value = 'login'
  loadLogin()
}

async function loadLogin() {
  if (!activeId.value) return
  try {
    const r = await api.get('/api/classes/' + activeId.value + '/login-admin')
    login.mode = r.mode === 'kg' ? 'kg' : 'local'
    login.verifyEachTime = r.verifyEachTime === true
    login.kgBases = Array.isArray(r.kgBases) ? r.kgBases : []
    login.rememberedCount = Number(r.rememberedCount || 0)
    login.blockedCount = Number(r.blockedCount || 0)
    login.students = Array.isArray(r.students) ? r.students : []
  } catch (e) {
    toast.value = '读不到登录管理数据：' + e.message
  }
}

/** 切登录方式：和课程管理页是同一个配置，改哪边都一样 */
async function setLoginMode(mode) {
  try {
    await api.patch('/api/settings/student-auth', { mode, verifyEachTime: login.verifyEachTime })
    toast.value = '已切换：学生现在用' + (mode === 'kg' ? '账号 + 密码' : '学号 + 姓名') + '登录'
    await loadLogin()
  } catch (e) {
    toast.value = '切换失败：' + e.message
    await loadLogin()
  }
}

/* 切班级时如果正停在登录管理页，跟着刷新那份数据 */
watch(activeId, () => {
  if (tab.value === 'login') loadLogin()
})

async function blockOne(s) {
  if (!window.confirm('禁止「' + s.name + '（' + s.sid + '）」登录？\n\n他会立刻登不进来，直到你解除。')) return
  try {
    await api.post('/api/classes/' + activeId.value + '/students/' + encodeURIComponent(s.sid) + '/login-block', {})
    toast.value = '已禁止 ' + s.name + ' 登录'
    await loadLogin()
  } catch (e) {
    toast.value = '操作失败：' + e.message
  }
}

async function unblockOne(s) {
  try {
    await api.del('/api/classes/' + activeId.value + '/students/' + encodeURIComponent(s.sid) + '/login-block')
    toast.value = '已解除 ' + s.name + ' 的禁登，失败次数也清零了'
    await loadLogin()
  } catch (e) {
    toast.value = '操作失败：' + e.message
  }
}
const q = ref('')
const error = ref('')
const toast = ref('')
const data = ref({ class: {}, students: [], board: { list: [] }, events: [] })

const pickedSid = ref('')


// 学生在场状态：只用于「班级里谁现在开着页面」的显示，不参与任何计分/考勤逻辑
const presence = ref({ onlineCount: 0, castingCount: 0, online: [], casting: [] })
const presenceSet = computed(() => new Set((presence.value.online || []).map((s) => s.sid)))
const castingSet = computed(() => new Set((presence.value.casting || []).map((s) => s.sid)))
let presenceTimer = null

const active = computed(() => classes.value.find((c) => c.id === activeId.value) || classes.value[0] || null)
const students = computed(() => data.value.students || [])
const board = computed(() => data.value.board || { list: [], totalAvg: 0, passRate: 0 })
const events = computed(() =>
  (data.value.events || []).map((e) => Object.assign({ summaryText: e.summary || '' }, e))
)


/* ---------------- 评分表的排序 / 筛选 ----------------
 * 排序只在浏览器里做（服务端给的还是按学号排的那一份），所以切换列不会多发请求；
 * 默认「学号升序」，点表头换方向，再点同一列反过来，并列时固定按学号收尾，
 * 免得分数一样的人每 8 秒刷新一次就换位置。
 */

const boardList = computed(() => board.value.list || [])

/* 评分表的列：前几列固定，中间是方案里的各项（动态），最后加分 / 总评 / 操作 */
const cols = computed(() => [
  { key: 'no', label: '#', width: '42px', num: true, tdClass: 'dim' },
  { key: 'sid', label: '学号', width: '110px', sortable: true, tdClass: 'dim' },
  { key: 'name', label: '姓名', width: '90px', sortable: true },
  { key: 'status', label: '状态', hint: '登录中', width: '78px', sortable: true },
  { key: 'cast', label: '投屏', hint: '在看', width: '78px', sortable: true },
  ...mainItems.value.map((it) => ({
    key: it.key,
    label: it.short,
    hint: String(it.full),
    num: true,
    sortable: true,
    value: (r) => scoreOf(r, it.key),
    tdClass: (r) => ({ none: !scoreOf(r, it.key) }),
  })),
  { key: 'bonus', label: '加分', hint: '5', num: true, sortable: true, value: (r) => scoreOf(r, 'bonus'), tdClass: (r) => ({ none: !scoreOf(r, 'bonus') }) },
  { key: 'total', label: '总评', hint: '100', num: true, sortable: true, value: (r) => r.total, tdClass: (r) => ['big', r.total >= 60 ? 'ok' : 'bad'] },
  { key: 'actions', label: '', width: '116px', tdClass: 'rowact' },
])

const sortKey = ref('sid')
const sortDir = ref('asc')

const fStatus = ref('') // '' | online | offline
const fCast = ref('') // '' | on
const fTotal = ref('') // '' | pass | fail
const fBonus = ref('') // '' | has

const hasFilter = computed(
  () => !!(q.value.trim() || fStatus.value || fCast.value || fTotal.value || fBonus.value)
)

// 学号里有数字，用 numeric 比较才不会被字符串序坑（2025010102 排在 20250101010 前）
const collator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' })

function sortBy(key) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else {
    sortKey.value = key
    sortDir.value = 'asc'
  }
}

function clearFilter() {
  q.value = ''
  fStatus.value = ''
  fCast.value = ''
  fTotal.value = ''
  fBonus.value = ''
}

/** 一行在某列上的排序值：数字列给数字（按大小比），其余给字符串（按拼音比） */
function sortVal(r, key) {
  const sid = r.student.sid
  if (key === 'sid') return sid
  if (key === 'name') return r.student.name || ''
  if (key === 'status') return presenceSet.value.has(sid) ? '在线' : '离线'
  if (key === 'cast') return castingSet.value.has(sid) ? '在看' : ''
  if (key === 'total') return Number(r.total) || 0
  return Number(scoreOf(r, key)) || 0 // 各计分项 + 加分
}

const filtered = computed(() => {
  const kw = q.value.trim()
  const list = boardList.value.filter((r) => {
    const sid = r.student.sid
    if (kw && r.student.name.indexOf(kw) < 0 && sid.indexOf(kw) < 0) return false
    const online = presenceSet.value.has(sid)
    if (fStatus.value === 'online' && !online) return false
    if (fStatus.value === 'offline' && online) return false
    if (fCast.value === 'on' && !castingSet.value.has(sid)) return false
    const total = Number(r.total) || 0
    if (fTotal.value === 'pass' && total < 60) return false
    if (fTotal.value === 'fail' && total >= 60) return false
    if (fBonus.value === 'has' && !(Number(scoreOf(r, 'bonus')) > 0)) return false
    return true
  })
  const dir = sortDir.value === 'desc' ? -1 : 1
  const key = sortKey.value
  return list.sort((a, b) => {
    const va = sortVal(a, key)
    const vb = sortVal(b, key)
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : collator.compare(String(va), String(vb))
    if (c !== 0) return c * dir
    return collator.compare(a.student.sid, b.student.sid)
  })
})

const liveCount = computed(() => events.value.filter((e) => !e.voided).length)

const logItem = ref('')
const logQ = ref('')
const filteredEvents = computed(() => {
  const kw = logQ.value.trim()
  return events.value.filter((e) => {
    if (logItem.value && e.item !== logItem.value) return false
    if (!kw) return true
    return nameOf(e.sid).indexOf(kw) >= 0 || e.sid.indexOf(kw) >= 0 || (e.reason || '').indexOf(kw) >= 0
  })
})

const pickedRow = computed(() => (board.value.list || []).find((r) => r.student.sid === pickedSid.value) || null)

onMounted(async () => {
  loadScheme() // 抽屉里的「去模块评分」要按方案来，深链进来也不会错
  // 跟着侧栏选的班走（属于当前课程才用），否则落第一个
  if (currentClassId.value && classes.value.some((c) => c.id === currentClassId.value)) {
    activeId.value = currentClassId.value
  }
  if (!activeId.value && classes.value.length) activeId.value = classes.value[0].id
  if (activeId.value) setClassId(activeId.value)
  if (activeId.value) await load()
  document.addEventListener('keydown', onKey)
  document.addEventListener('visibilitychange', onVisible)
  presenceTimer = setInterval(() => {
    if (!document.hidden) loadPresence()
  }, 8000)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('visibilitychange', onVisible)
  if (presenceTimer) clearInterval(presenceTimer)
})

function onVisible() {
  if (!document.hidden) loadPresence()
}

async function loadPresence() {
  if (!activeId.value) return
  try {
    presence.value = await api.get('/api/classes/' + activeId.value + '/presence')
  } catch (e) {
    /* 状态显示失败不打扰记分，等下一轮 */
  }
}

/* ---------------- 读 ---------------- */

async function load() {
  if (!activeId.value) return
  error.value = ''
  try {
    const res = await api.get('/api/classes/' + activeId.value + '/scores')
    // 服务端返回的 events 只有原始字段，摘要在这里按需算
    data.value = res
    loadPresence()
  } catch (e) {
    error.value = e.message
  }
}

function switchClass(id) {
  activeId.value = id
  localStorage.setItem('scores-class', id)
  setClassId(id) // 侧栏的班级跟着变
  pickedSid.value = ''
  load()
}

async function newClass() {
  const name = window.prompt('新班级名称：', '示例' + (classes.value.length + 1) + '班')
  if (name === null) return
  try {
    const res = await api.post('/api/classes', { name })
    await refresh()
    switchClass(res.class.id)
    toast.value = '已新建班级：' + res.class.name
  } catch (e) {
    alert(e.message)
  }
}

async function renameClass() {
  if (!active.value) return
  const name = window.prompt('新的班级名称：', active.value.name)
  if (!name || name === active.value.name) return
  try {
    await api.patch('/api/classes/' + active.value.id, { name })
    await refresh()
    toast.value = '已改名'
  } catch (e) {
    alert(e.message)
  }
}

async function removeClass() {
  if (!active.value) return
  if (!window.confirm('删除「' + active.value.name + '」？该班的记分记录会一起删除，且不可恢复。')) return
  try {
    await api.del('/api/classes/' + active.value.id)
    const gone = activeId.value
    await refresh()
    activeId.value = classes.value.length ? classes.value[0].id : ''
    localStorage.setItem('scores-class', activeId.value)
    data.value = { class: {}, students: [], board: { list: [] }, events: [] }
    if (activeId.value) await load()
    toast.value = '已删除班级'
  } catch (e) {
    alert(e.message)
  }
}

/* ---------------- 记分 ---------------- */

/* ---------- 名单增删改：这一页就是班级管理，名单直接在这儿维护 ---------- */
const editingStudent = ref(null) // { isNew }
const studentBusy = ref(false)
const studentForm = reactive({ sid: '', name: '', hasRecords: false, origin: '' })

function openStudent(stu) {
  if (!active.value) return
  const isNew = !stu
  editingStudent.value = { isNew }
  studentForm.sid = isNew ? '' : stu.sid
  studentForm.name = isNew ? '' : stu.name
  studentForm.origin = isNew ? '' : stu.sid
  studentForm.hasRecords = isNew ? false : events.value.some((e) => e.sid === stu.sid)
}

async function saveStudent() {
  if (!active.value || !editingStudent.value) return
  studentBusy.value = true
  error.value = ''
  try {
    if (editingStudent.value.isNew) {
      const res = await api.post('/api/classes/' + activeId.value + '/roster', {
        mode: 'merge',
        students: [{ sid: studentForm.sid, name: studentForm.name }],
      })
      toast.value = '已添加 ' + studentForm.name + '（本班 ' + res.total + ' 人）'
    } else {
      const res = await api.patch(
        '/api/classes/' + activeId.value + '/students/' + encodeURIComponent(studentForm.origin),
        { sid: studentForm.sid, name: studentForm.name }
      )
      toast.value = res.renamed ? '已把学号改成 ' + res.student.sid : '已更新 ' + res.student.name
    }
    editingStudent.value = null
    await refresh()
    await load()
  } catch (e) {
    error.value = e.message
  } finally {
    studentBusy.value = false
  }
}

async function removeStudent(stu) {
  if (!stu) return
  if (!window.confirm('把 ' + stu.name + '（' + stu.sid + '）从名单里移除？\n\n他的记分记录与目录都会保留，只是不再出现在名单里。')) return
  error.value = ''
  try {
    await api.del('/api/classes/' + activeId.value + '/students/' + encodeURIComponent(stu.sid))
    toast.value = '已移除 ' + stu.name
    await refresh()
    await load()
  } catch (e) {
    error.value = e.message
  }
}

function scoreOf(row, key) {
  const hit = (row.rows || []).find((x) => x.item.key === key)
  return hit ? hit.score : 0
}

function nameOf(sid) {
  const s = students.value.find((x) => x.sid === sid)
  return s ? s.name : sid
}

function itemName(key) {
  const it = items.value.find((x) => x.key === key)
  return it ? it.short : key
}

function summary(e) {
  if (e.summaryText) return e.summaryText
  if (e.item === 'homework') return '等级 ' + e.grade + (e.late ? ' · 迟交' : '')
  if (e.item === 'exam') return '卷面 ' + e.raw
  if (e.item === 'project') {
    const s = Object.keys(e.dims || {}).reduce((a, k) => a + (Number(e.dims[k]) || 0), 0)
    return '量规 ' + Math.round(s * 10) / 10
  }
  return (e.delta > 0 ? '+' : '') + (e.delta || 0) + ' 分' + (e.kind ? '（' + e.kind + '）' : '')
}

function fmt(iso) {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 导出总评 / 流水（服务端出 xlsx；kind = totals | events） */
function exportSheet(kind) {
  if (!active.value) return
  const suffix = kind === 'events' ? '记分记录' : '总评'
  download('/api/classes/' + active.value.id + '/export?kind=' + kind, (active.value.name || '班级') + '-' + suffix + '.xlsx')
}

/* ---------------- 导入名单 ---------------- */

/* 班级与名单（整门课一起搬） */
const cio = reactive({ open: false, busy: false, err: '', name: '', report: null, mode: 'merge' })
let ioBuf = null

async function openIO() {
  cio.open = true
  courseName.value = courseId.value
  try {
    const r = await api.get('/api/courses')
    const hit = (r.items || []).find((c) => c.id === courseId.value)
    if (hit) courseName.value = hit.name + (hit.semester ? ' · ' + hit.semester : '')
  } catch (e) {
    /* 取不到就用课程 id 显示，不影响导入导出 */
  }
  cio.err = ''
  cio.report = null
  cio.name = ''
  cio.mode = 'merge'
  ioBuf = null
}

function closeIO() {
  cio.open = false
  cio.report = null
  cio.err = ''
  ioBuf = null
}

function ioExport() {
  if (!courseId.value) return
  download('/api/courses/' + encodeURIComponent(courseId.value) + '/classes.zip', 'classes.zip')
  toast.value = '正在导出班级与名单…'
}

function ioTemplate() {
  if (!courseId.value) return
  download('/api/courses/' + encodeURIComponent(courseId.value) + '/classes/template.zip', 'classes-template.zip')
  toast.value = '模板已下载：填好各班名单，压缩成 zip 再导进来'
}

/** 文件由 ImportDialog 的隐藏 input 选好后 emit 过来 */
async function ioFile(f) {
  if (!f || !courseId.value) return
  cio.busy = true
  cio.err = ''
  cio.name = f.name
  try {
    ioBuf = await f.arrayBuffer()
    const res = await fetch('/api/courses/' + encodeURIComponent(courseId.value) + '/classes/inspect', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, getToken() ? { Authorization: 'Bearer ' + getToken() } : {}),
      body: ioBuf,
    })
    const j = await res.json().catch(() => null)
    if (!res.ok) throw new Error((j && j.error) || '解析失败（' + res.status + '）')
    cio.report = j
    cio.mode = 'merge'
  } catch (err) {
    cio.err = err.message
  } finally {
    cio.busy = false
  }
}

async function ioApply() {
  if (!courseId.value || !ioBuf) return
  cio.busy = true
  cio.err = ''
  try {
    const res = await fetch(
      '/api/courses/' + encodeURIComponent(courseId.value) + '/classes/apply?mode=' + cio.mode,
      {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, getToken() ? { Authorization: 'Bearer ' + getToken() } : {}),
        body: ioBuf,
      }
    )
    const j = await res.json().catch(() => null)
    if (!res.ok) throw new Error((j && j.error) || '导入失败（' + res.status + '）')
    closeIO()
    toast.value =
      '导入完成：' +
      j.totals.classes +
      ' 个班（新建 ' +
      j.totals.created +
      '）· 新增 ' +
      j.totals.added +
      ' 人 · 改名 ' +
      j.totals.renamed +
      ' 人' +
      (j.totals.removed ? ' · 移出 ' + j.totals.removed + ' 人' : '')
    await load()
  } catch (err) {
    cio.err = err.message
  } finally {
    cio.busy = false
  }
}

const importing = ref(false)
const importingBusy = ref(false)
const importMode = ref('merge')
const pasteText = ref('')
const parsed = ref([])
const importError = ref('')
const fileInput = ref(null)

const issues = ref([]) // 表格里没被采纳的行（行号 + 原因）
const report = ref(null) // 服务端干跑结果（新增 / 改名 / 移出 / 班级人数）
const sheetFile = ref(null) // 直接从表格（xlsx / csv）导入时，留一份原始文件
const sheetName = ref('')
const checking = ref(false) // 正在问服务端要报告

const previewNames = computed(() => {
  const names = parsed.value.slice(0, 8).map((s) => s.name)
  return names.join('、') + (parsed.value.length > 8 ? ' …' : '')
})

function openImport() {
  importing.value = true
  parsed.value = []
  issues.value = []
  report.value = null
  sheetFile.value = null
  sheetName.value = ''
  pasteText.value = ''
  importError.value = ''
}

/*
 * 原来这里有 rosterCsv() 和 saveText()：在前端拼 CSV 再触发下载。
 * 名单与模板改成服务端出 xlsx 之后，这两个函数就没有调用方了，已删。
 * （拼 CSV 的问题：学号是长数字，进 Excel 变科学计数法；中文姓名还可能乱码。）
 */

/** 空模板：只有表头 + 两行示例，照着填 */
/**
 * 模板与名单都改成 xlsx（由服务端生成）。
 *
 * 为什么不再前端拼 CSV：
 *   · 学号是长数字，CSV 进 Excel 会变成科学计数法（2.02E+09），老师一排序就毁
 *   · 中文姓名在部分 Excel 上还会乱码
 *   · xlsx 能把学号列锁成文本，列宽也排好了
 * 服务端已有 ExcelJS（读名单用它），生成也用它，一份实现。
 */
function downloadTemplate() {
  if (!active.value) return
  download('/api/classes/' + active.value.id + '/roster/template.xlsx', '名单模板.xlsx')
}

/** 当前名单：导出本班的，改完再传回来（改名字、加人、删人） */
function downloadCurrent() {
  if (!active.value) return
  download('/api/classes/' + active.value.id + '/roster.xlsx', (active.value.name || '班级') + '-名单.xlsx')
}

function parsePaste() {
  importError.value = ''
  applyRows(textToRows(pasteText.value))
}

/** 统一入口：二维数组 → 名单 + 问题清单 → 再问服务端要干跑报告 */
function applyRows(rows) {
  const res = rowsToRosterDetailed(rows)
  parsed.value = res.list
  issues.value = res.issues || []
  if (!parsed.value.length && !issues.value.length) importError.value = ''
  refreshReport()
}

/** 问服务端「这批名单落下去会变成什么样」，一个字节都不写 */
async function refreshReport() {
  report.value = null
  if (!active.value || !parsed.value.length) return
  checking.value = true
  importError.value = ''
  try {
    report.value = await api.post('/api/classes/' + active.value.id + '/roster/inspect', {
      mode: importMode.value,
      students: parsed.value.map((s) => ({ sid: s.sid, name: s.name })),
    })
  } catch (e) {
    importError.value = e.message
    report.value = null
  } finally {
    checking.value = false
  }
}

/**
 * 选表格文件：直接传给服务端解析（.xlsx 用 exceljs，.csv 按逗号/制表符切），
 * 名单规则只维护一份，前端那份解析器只留给「粘贴文本」用。
 */
async function onFile(e) {
  const file = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!file) return
  importError.value = ''
  packErrLikeIssuesClear()
  sheetFile.value = file
  sheetName.value = file.name
  await uploadSheet()
}

function packErrLikeIssuesClear() {
  issues.value = []
  report.value = null
  parsed.value = []
}

/** 把表格传给服务端：不带 apply=1 就是干跑 */
async function uploadSheet() {
  if (!active.value || !sheetFile.value) return
  checking.value = true
  importError.value = ''
  try {
    const res = await postSheet(false)
    report.value = res
    issues.value = res.issues || []
  } catch (err) {
    importError.value = err.message
    issues.value = (err.errors || []).map((msg, i) => ({ line: i + 1, msg, raw: '' }))
    report.value = null
  } finally {
    checking.value = false
  }
}

/** 传表格（apply=true 时真写） */
async function postSheet(apply) {
  const token = getToken()
  const url =
    '/api/classes/' +
    active.value.id +
    '/roster/sheet?mode=' +
    importMode.value +
    (apply ? '&apply=1' : '')
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: sheetFile.value,
  })
  let data = null
  try {
    data = await res.json()
  } catch (e) {
    data = null
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || '解析失败（' + res.status + '）')
    err.errors = (data && data.errors) || []
    throw err
  }
  return data
}

async function doImport() {
  if (!active.value) return
  if (!sheetFile.value && !parsed.value.length) return
  importingBusy.value = true
  importError.value = ''
  try {
    if (sheetFile.value) {
      const r = await postSheet(true)
      importing.value = false
      const bits = ['新增 ' + (r.counts ? r.counts.added : 0) + ' 人']
      if (r.counts && r.counts.updated) bits.push('改名 ' + r.counts.updated + ' 人')
      if (r.counts && r.counts.removed) bits.push('移出 ' + r.counts.removed + ' 人')
      toast.value = '导入完成：' + bits.join('，') + '，本班共 ' + r.total + ' 人'
      sheetFile.value = null
      sheetName.value = ''
      await refresh()
      await load()
      return
    }
    const body = {
      mode: importMode.value,
      students: parsed.value.map((s) => ({ sid: s.sid, name: s.name })),
    }
    const res = await api.post('/api/classes/' + active.value.id + '/roster/apply', body)
    importing.value = false
    const bits = ['新增 ' + (res.counts ? res.counts.added : 0) + ' 人']
    if (res.counts && res.counts.updated) bits.push('改名 ' + res.counts.updated + ' 人')
    if (res.counts && res.counts.removed) bits.push('移出 ' + res.counts.removed + ' 人')
    toast.value = '导入完成：' + bits.join('，') + '，本班共 ' + res.total + ' 人'
    await refresh()
    await load()
  } catch (e) {
    importError.value = e.message
  } finally {
    importingBusy.value = false
  }
}

/* 切换「追加 / 覆盖」会让「移出」数字变化，重新问一次服务端 */
watch(importMode, () => {
  if (!importing.value) return
  if (sheetFile.value) uploadSheet()
  else if (parsed.value.length) refreshReport()
})

/* ---------------- 快捷键 ---------------- */

function onKey(e) {
  if (e.key !== 'Escape') return
  if (importing.value) importing.value = false
  else pickedSid.value = ''
}
</script>

<style scoped>
/* 名单干跑报告 */
.import-plan {
  border: 1px solid var(--line);
  border-left: 3px solid #2f7d92;
  border-radius: 4px;
  background: #f7fbfd;
  padding: 8px 10px;
}

.ip-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 2px 0;
}

.ip-k {
  flex: 0 0 56px;
  color: #6b7785;
  font-size: 12px;
}

.import-plan .add {
  color: #1f7a55;
}

.import-plan .del {
  color: #b4400f;
}

.ip-tip {
  margin-top: 4px;
  font-size: 11.5px;
}

/* 名单导入：没被采纳的行 */
.iss {
  margin: 6px 0 0 18px;
  max-height: 140px;
  overflow: auto;
}

.iss li {
  margin: 2px 0;
}

/* 筛选条：紧贴表头，压扁一点，别喧宾夺主 */
.fbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.fbar .select {
  padding: 4px 8px;
  font-size: 12.5px;
}

.fbar .input {
  padding: 4px 8px;
  font-size: 12.5px;
}

.fbar .dim {
  font-size: 12px;
}

/* 表头点了就排序：箭头常驻但浅，排序中的那列高亮 */
th.sortable {
  cursor: pointer;
  user-select: none;
}

th.sortable:hover {
  background: #eef2f7;
  color: #1d4ed8;
}

th.sortable.on {
  color: #1d4ed8;
}

th .sortmark {
  margin-left: 3px;
  font-style: normal;
  font-size: 10px;
  color: #c2c8ce;
}

th.on .sortmark {
  color: #1d4ed8;
}

.classbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 16px;
}

.classbar .pill em {
  font-style: normal;
  color: var(--dim);
  margin-left: 6px;
  font-size: 12px;
}

.classbar .pill.on em {
  color: var(--brand);
}

.tabs {
  display: flex;
  gap: 8px;
  margin: 4px 0 0;
}

.tab {
  padding: 8px 18px;
  border: 1px solid var(--line);
  border-bottom: none;
  border-radius: 11px 11px 0 0;
  background: #eef1f7;
  color: #475569;
  cursor: pointer;
  font-size: 14px;
}

.tab.on {
  background: #fff;
  color: var(--brand-ink);
  font-weight: 600;
}

.log {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 62vh;
  overflow: auto;
}

.log > li {
  padding: 10px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  margin-bottom: 8px;
}

.log > li.voided {
  opacity: 0.62;
  background: #fafafa;
}

.lhead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.when {
  font-size: 12.5px;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

.who {
  font-size: 14px;
}

.delta {
  font-size: 14px;
  color: var(--brand-ink);
}

.reason {
  margin: 5px 0 2px;
  font-size: 13.8px;
}

.lf {
  display: flex;
  gap: 10px;
  font-size: 12.5px;
  color: var(--dim);
}

.lf a {
  color: var(--brand);
}

.tag-attend {
  background: #eef2ff;
  color: #4338ca;
}
.tag-interact {
  background: #fff7ed;
  color: var(--warn);
}
.tag-homework {
  background: #ecfeff;
  color: #0e7490;
}
.tag-exam {
  background: #fef2f2;
  color: var(--err);
}
.tag-project {
  background: #f5f3ff;
  color: #6d28d9;
}
.tag-bonus {
  background: #ecfdf5;
  color: var(--ok);
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
  color: #475569;
}
/* 登录管理 */
.lgrow {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin: 6px 0 8px;
}
.lgopt {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  cursor: pointer;
  flex: 1 1 260px;
}
.lgopt span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.lgopt em {
  font-style: normal;
}
.lgtbl {
  width: 100%;
  border-collapse: collapse;
  margin-top: 8px;
  font-size: 13px;
}
.lgtbl th,
.lgtbl td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line-soft);
}
.lgtbl th {
  font-weight: 600;
  color: var(--text-dim);
}
.lgtbl .num {
  text-align: right;
  width: 110px;
}
.lgtbl .mono {
  font-family: ui-monospace, Consolas, monospace;
}
.lgtbl .ops {
  text-align: right;
  white-space: nowrap;
}
.lgtbl .ops .btn {
  margin-left: 4px;
}
.chkrow {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: 10px 0 6px;
  cursor: pointer;
}
.chkrow span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.chkrow em {
  font-style: normal;
}
.lgbases {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 8px 0 4px;
}
.lgbase {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.lgbase .input {
  width: 220px;
}
.lgcreds {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line-soft);
}
</style>
