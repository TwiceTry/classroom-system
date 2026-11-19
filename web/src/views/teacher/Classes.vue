<template>
  <!-- ws：中栏名单 + 右栏全班流水；fixed-top：班级条和 tabs 固定，只有名单滚 -->
  <PageShell body-class="ws fixed-top">
    <template #head>
      <PageHead @reload="load">
        <template #title>班级管理 · 名单与分数</template>
        <template #sub>{{ itemsLine }}；这一页只看分，记分在各模块页 / 考勤页里做</template>
        <!--
          专属区。导出与导入分成两个按钮，和内容目录那条工具栏（⤓ 导出 / ⤒ 导入）
          保持同一套语言 —— 导出原来藏在导入弹窗里，等于「想导出得先点导入」，方向是反的。
        -->
        <template #right>
          <!--
            按钮文字压短了（「导出班级与名单」→「导出」）。
            两个长按钮在 1440 宽下就把副标题挤成一行了，页头也跟着折行。
            全称放 title，鼠标停一下就看得到，不用一直占着宽度。
          -->
          <button
            class="btn mini"
            :disabled="!hasClasses"
            @click="ioExport"
            title="把本课程所有班级与名单打成一个 zip（换机器 / 交给同事）"
          >
            ⤓ 导出
          </button>
          <button
            class="btn mini"
            @click="openIO"
            title="从一个 zip 导入班级与名单（先给逐班报告，确认后才写）"
          >
            ⤒ 导入
          </button>
          <button class="btn mini" @click="newClass">＋ 新建班级</button>
        </template>
      </PageHead>
    </template>
    <p v-if="error" class="hint err" style="margin-bottom:12px">{{ error }}</p>

    <div v-if="!classes.length" class="card">
      <div class="empty">
        还没有班级。点右上角「＋ 新建班级」，建好后在名单卡片上点「⤒ 导入名单」（支持 .xlsx / .csv，也可直接粘贴）。
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
      <button class="tab" :class="{ on: tab === 'login' }" @click="openLogin">
        登录管理
        <span v-if="login.blockedCount" class="dim">{{ login.blockedCount }} 人禁登</span>
      </button>
    </div>

    <!-- 中栏：名单 / 登录管理（主滚动区）。上面的班级条和 tabs 固定不动 -->
    <div class="scroll-body">

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
          <!--
            学生此刻停在哪个页面（课程材料 / 课堂作业·作答 / 代码练习…）。
            原来这一列是「投屏（在看）」，但投屏是偶尔才用一次的临时动作，
            而「他现在在哪个页面」是每节课都在变的实时信息，更值得占一格。
            离线时不重复写「离线」—— 左边 status 列已经说过了。
          -->
          <template v-else-if="column.key === 'page'">
            <span v-if="presenceSet.has(row.student.sid)" class="tag mute">
              {{ pageMap[row.student.sid] || '在线' }}
            </span>
            <span v-else class="dim">—</span>
          </template>
          <template v-else-if="column.key === 'total'"><b>{{ row.total }}</b></template>
          <template v-else-if="column.key === 'actions'">
            <!--
              宽屏时两个按钮写全称；视口不够宽（< 1280）时缩成 ✎ / ✕。
              不用「⋯ 菜单」是有原因的：表格容器自己 overflow: auto，
              绝对定位的浮层会被裁掉一半，点在最后一两行时根本看不到菜单。
              纯文字缩成图标没这个问题，title 里仍然有全称。
            -->
            <button class="btn mini" title="改姓名 / 学号" @click.stop="openStudent(row.student)">
              <span class="t-long">编辑</span><span class="t-short">✎</span>
            </button>
            <button class="btn mini danger" title="从名单里移除（记录保留）" @click.stop="removeStudent(row.student)">
              <span class="t-long">删除</span><span class="t-short">✕</span>
            </button>
          </template>
          <template v-else>{{ column.value ? column.value(row) : row[column.key] }}</template>
        </template>
      </DataTable>
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

      <!--
        登录方式：**按插件清单生成**，不写死。
        后端扫 auth-providers/ 目录，这里就渲染几个选项；
        往那个目录丢一个新插件，这一块自动多一项。
      -->
      <div class="lgrow">
        <label v-for="p in providers" :key="p.key" class="lgopt">
          <input
            type="radio"
            :checked="login.provider === p.key"
            :value="p.key"
            @change="setLoginMode(p.key)"
          />
          <span>
            <b>{{ p.name }}</b>
            <em class="dim mini">{{ p.desc }}</em>
          </span>
        </label>
        <p v-if="!providers.length" class="dim mini">没有可用的登录方式（插件都没加载成功，看启动日志）。</p>
      </div>

      <!--
        配置项同样由插件声明驱动：它声明 settings，这里按 type 渲染。
        没有配置项的插件（比如「学号+姓名」）整块不出现。
      -->
      <template v-if="curSettings.length">
        <h4 class="lgh4">{{ curProvider.name }} 的设置</h4>

        <div v-for="s in curSettings" :key="s.key" class="lgfield">
          <!-- 开关 -->
          <template v-if="s.type === 'bool'">
            <label class="chkrow">
              <input
                type="checkbox"
                :checked="setValOf(s.key) === true"
                @change="saveSetting(s.key, $event.target.checked)"
              />
              <span>
                <b>{{ s.label }}</b>
                <em v-if="s.hint" class="dim mini">{{ s.hint }}</em>
              </span>
            </label>
          </template>

          <!-- 多个地址（轮询分流） -->
          <template v-else-if="s.type === 'url-list'">
            <span class="lgf-label">{{ s.label }}</span>
            <div class="lgbases">
              <label v-for="(b, i) in setValOf(s.key) || []" :key="i" class="lgbase">
                <span class="dim mini">{{ i + 1 }}</span>
                <input
                  class="input"
                  :value="b"
                  placeholder="http://ip:port"
                  @input="setBase(i, $event.target.value)"
                  @blur="saveBases"
                />
                <button class="btn mini" title="删掉这个入口" @click="dropBase(i)">×</button>
              </label>
              <button class="btn mini" @click="addBase">＋ 加一个</button>
            </div>
            <p v-if="s.hint" class="dim mini">{{ s.hint }}</p>
          </template>

          <!-- 其余按单行文本处理（text / url / number / select 以后再分） -->
          <template v-else>
            <span class="lgf-label">{{ s.label }}</span>
            <input
              class="input"
              :value="setValOf(s.key) || ''"
              :placeholder="s.placeholder || ''"
              @blur="saveSetting(s.key, $event.target.value)"
            />
            <p v-if="s.hint" class="dim mini">{{ s.hint }}</p>
          </template>
        </div>
      </template>

      <p v-if="login.provider === 'kg'" class="dim mini lgwarn">
        连错 <b>3</b> 次本系统就暂停该账号登录（不会让它数到外部的 5 次上限）——
        这样最坏只是「进不了课堂系统」，而不是「学校账号被锁」。
      </p>

      <!-- 只要本班有人走账号密码，「记住的密码」这块就成立（不管是单独设的还是跟随全局） -->
      <template v-if="anyKg">

        <div class="lgcreds">
          <span class="dim mini">
            已记住 <b>{{ login.rememberedCount }}</b> 个学生的密码（加密保存，表格里点眼睛可以看原文）。
          </span>
          <button class="btn mini" :disabled="!login.rememberedCount" @click="clearCreds">
            清空全部记住的密码
          </button>
        </div>
      </template>

      <!--
        批量设置：勾几行、选个方式、应用。
        单个改直接用行内下拉，不用先勾选 —— 两种粒度都常用。
      -->
      <div class="lgbar">
        <span class="dim mini">
          已选 <b>{{ picked.size }}</b> 人
          <template v-if="!picked.size">（勾左边方框可批量设置）</template>
        </span>
        <span class="spacer"></span>
        <select v-model="batchMode" class="select" style="width: 168px" :disabled="!picked.size">
          <option value="">跟随全局（{{ providerName(login.provider) }}）</option>
          <option value="local">学号 + 姓名</option>
          <option value="kg">账号 + 密码</option>
        </select>
        <button class="btn mini primary" :disabled="!picked.size" @click="applyBatch">
          {{ batchMode ? '应用到所选' : '清掉所选覆盖' }}
        </button>
      </div>

      <table class="lgtbl">
        <thead>
          <tr>
            <th class="pickcol">
              <input
                type="checkbox"
                :checked="loginRows.length > 0 && picked.size >= loginRows.length"
                title="全选 / 全不选"
                @change="togglePickAll"
              />
            </th>
            <th>学号</th>
            <th>姓名</th>
            <!-- 按人设置：默认跟随全局，个别可以单独指定 -->
            <th class="modecol">登录方式</th>
            <!--
              只要本班有人走「账号 + 密码」就显示这列 —— 不能只看全局 mode：
              全局是学号+姓名、但有学生单独设成账号密码时，他们的密码也存在这里。
            -->
            <th v-if="anyKg">记住的密码</th>
            <th class="num">本系统失败</th>
            <th class="num">平台自报输错</th>
            <th>状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in loginRows" :key="s.sid" :class="{ picked: picked.has(s.sid) }">
            <td class="pickcol">
              <input type="checkbox" :checked="picked.has(s.sid)" @change="togglePick(s.sid)" />
            </td>
            <td class="mono">{{ s.sid }}</td>
            <td>{{ s.name }}</td>
            <!--
              登录方式。空值 = 跟随全局（下拉里直接写出全局值，省得老师切到设置页去看）。
              单独设过的那一行有个小圆点，否则分不清「跟随全局」和「恰好设成了一样」。
            -->
            <td class="modecol">
              <span v-if="isOverride(s.sid)" class="ovdot" title="这个学生单独设置过，不跟随全局"></span>
              <select
                class="select mode-sel"
                :value="overridesMap.get(s.sid) || ''"
                @change="setMode(s.sid, $event.target.value)"
              >
                <option value="">跟随全局（{{ providerName(login.provider) }}）</option>
                <option value="local">学号 + 姓名</option>
                <option value="kg">账号 + 密码</option>
              </select>
            </td>
            <!--
              记住的密码：默认打码，点眼睛才显示。
              学生忘了自己当初填的是什么、或者要核对是不是和青果一致时用。
              上一版存的是 scrypt 派生值（还原不出来），那些显示「旧记录」。
            -->
            <td v-if="anyKg" class="pwdcol">
              <span v-if="!credOf(s.sid)" class="dim">—</span>
              <span v-else class="pwdshow">
                <!-- 旧记录（scrypt 那版）看不到原文，但照样能删 -->
                <code v-if="credOf(s.sid).legacy" class="pwd-legacy" title="上一版存的是不可逆的派生值，看不到原文；学生用青果再验一次就会升级">旧记录</code>
                <!-- 明文超过格宽会被省略号截断，完整值放 title 里，悬停能看全 -->
                <code v-else :title="shownPwd.has(s.sid) ? credOf(s.sid).password : '点击右侧眼睛显示'">
                  {{ shownPwd.has(s.sid) ? credOf(s.sid).password : '••••••' }}
                </code>

                <span class="pwdops">
                  <!-- 只有能解出原文的才给眼睛；旧记录给不了 -->
                  <button
                    v-if="!credOf(s.sid).legacy"
                    class="pwdico"
                    :class="{ on: shownPwd.has(s.sid) }"
                    :aria-label="shownPwd.has(s.sid) ? '隐藏密码' : '显示密码'"
                    :title="shownPwd.has(s.sid) ? '隐藏' : '显示明文'"
                    @click="togglePwd(s.sid)"
                  >
                    <svg v-if="shownPwd.has(s.sid)" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path d="M2 2l12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                      <path d="M6.4 4.3A6.7 6.7 0 0 1 8 4.1c4 0 6.4 3.9 6.4 3.9a11 11 0 0 1-2.2 2.5M9.9 11.6a6.9 6.9 0 0 1-1.9.3c-4 0-6.4-3.9-6.4-3.9a11 11 0 0 1 2.4-2.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                    </svg>
                    <svg v-else viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path d="M1.6 8S4 4.1 8 4.1 14.4 8 14.4 8 12 11.9 8 11.9 1.6 8 1.6 8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                      <circle cx="8" cy="8" r="1.9" fill="none" stroke="currentColor" stroke-width="1.3" />
                    </svg>
                  </button>

                  <!--
                    删掉这一条记下的密码：学生下次登录要重新输入一遍（走青果核验后又会被记住）。
                    学生忘了密码、或者密码在青果那边改过导致这边一直对不上时用。
                  -->
                  <button
                    class="pwdico del"
                    aria-label="删掉记住的密码"
                    title="删掉这条记住的密码（学生下次登录要重新输入）"
                    @click="forgetOne(s)"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path d="M3.5 4.5h9M6.2 4.5V3.2h3.6v1.3M5 4.5l.6 8.2h4.8L11 4.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" />
                    </svg>
                  </button>
                </span>
              </span>
            </td>
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
            <!-- 列数：勾选 + 学号 + 姓名 + 登录方式 + (记住的密码) + 失败 + 输错 + 状态 + 操作 -->
            <td :colspan="anyKg ? 9 : 8" class="empty">这个班没有学生</td>
          </tr>
        </tbody>
      </table>
    </section>

    </div>
    </template>

    <!--
      右栏：全班流水。
      原来是三个 tab 之一 —— 想看一眼"刚才给谁加了分"就得切走名单，看完再切回来。
      记分是这一页的主线（左边名单上的分都是这里记出来的），放右栏常驻，
      改完分立刻能看到新记录，不用来回切。
      右栏只有 320px，所以筛选收成两行：一行计分项、一行搜索。
    -->
    <template #right>
      <section class="card">
        <CardHead>
          <template #title>全班流水</template>
          <template #meta>
            <!-- 「42 / 0 条」看着莫名其妙（42 条记录、0 条有效），所以分开说 -->
            <span class="dim mini">
              {{ filteredEvents.length }} 条{{ liveCount ? ' · 有效 ' + liveCount : ' · 全部已撤销' }}
            </span>
            <button
              class="btn mini"
              :disabled="!active"
              title="导出本班记分记录（xlsx，Excel 直接打开）"
              @click="exportSheet('events')"
            >
              ⤓
            </button>
          </template>
        </CardHead>

        <div class="log-tools">
          <select v-model="logItem" class="select">
            <option value="">全部计分项</option>
            <option v-for="it in items" :key="it.key" :value="it.key">{{ it.name }}</option>
          </select>
          <input v-model.trim="logQ" class="input" placeholder="搜姓名 / 学号 / 原因" />
        </div>

        <!-- 卡片撑满右栏后，列表自己滚，卡片头（标题 + 筛选）常驻 -->
        <ul class="log log-scroll">
          <li v-for="e in filteredEvents" :key="e.id" :class="{ voided: e.voided }">
            <div class="lhead">
              <b class="who">{{ nameOf(e.sid) }}</b>
              <span class="tag" :class="'tag-' + e.item">{{ itemName(e.item) }}</span>
              <b class="delta">{{ summary(e) }}</b>
              <span v-if="e.voided" class="tag mute">已撤销</span>
              <span class="spacer"></span>
              <span class="when">{{ fmt(e.createdAt) }}</span>
            </div>
            <p class="reason">{{ e.reason }}</p>
            <div class="lf">
              <span class="dim">{{ e.operator }}</span>
              <a v-for="f in e.evidence || []" :key="f.url" :href="f.url" target="_blank" rel="noopener">{{ f.name }}</a>
            </div>
          </li>
          <!-- 空态说明「什么情况下会有」，不是干巴巴一句「没有记录」 -->
          <li v-if="!filteredEvents.length" class="log-empty">
            <b>{{ events.length ? '没有符合筛选条件的记录' : '这个班还没有记分记录' }}</b>
            <span v-if="events.length">清掉上面的筛选试试，或者换个计分项。</span>
            <span v-else>在左边的名单里点 +1 / +2 / −1 记分，这里会实时出现流水。</span>
          </li>
        </ul>
      </section>
    </template>

    <!-- 学生明细（点名 / 改分都并进这个抽屉，不再单开一个页面） -->
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
  /** 全局默认用哪个插件（值就是插件 key，比如 local / kg） */
  provider: 'local',
  mode: 'local', // 旧字段，和 provider 同步，别处还在读
  verifyEachTime: false,
  kgBases: [],
  rememberedCount: 0,
  blockedCount: 0,
  students: [],
})

/* ---------------- 登录插件 ---------------- */

/**
 * 可选的登录方式（由后端按 auth-providers/ 目录扫出来）。
 *
 * 每一项除了元信息还带 settings（老师要配什么）和 values（当前值）——
 * 设置页照 settings 渲染表单，**加新插件时这里一行都不用改**。
 */
const providers = ref([])

/** 当前选中的那个插件的声明（用来渲染它的配置项） */
const curProvider = computed(() => providers.value.find((p) => p.key === login.provider) || null)

/** 只有「有配置项」的插件才渲染设置区，local 那种没得配就不占地方 */
const curSettings = computed(() => (curProvider.value && curProvider.value.settings) || [])

/** 某个配置项当前的值 */
function setValOf(key) {
  const v = (curProvider.value && curProvider.value.values) || {}
  return v[key]
}
/** 写回本地缓存的值（避免改一个字段就整表重拉） */
function patchVal(key, value) {
  const list = providers.value.map((p) => {
    if (p.key !== login.provider) return p
    return Object.assign({}, p, { values: Object.assign({}, p.values || {}, { [key]: value }) })
  })
  providers.value = list
}

/** 插件 key → 显示名（表格里「跟随全局（青果平台）」那处用） */
function providerName(key) {
  const p = providers.value.find((x) => x.key === key)
  return p ? p.name : key || '—'
}

async function loadProviders() {
  try {
    const r = await api.get('/api/settings/student-auth/providers')
    providers.value = r.providers || []
    login.provider = r.current || 'local'
    login.mode = login.provider
  } catch (e) {
    providers.value = []
  }
}

/**
 * 保存某个插件的某一项配置。
 *
 * 统一走 `providers: { [key]: { [field]: value } }` —— 加一个字段不用改后端，
 * 因为 setStudentAuth 是按 key 合并的。
 */
async function saveSetting(field, value) {
  const key = login.provider
  if (!key) return
  patchVal(field, value)
  try {
    await api.patch('/api/settings/student-auth', { providers: { [key]: { [field]: value } } })
    toast.value = '已保存'
  } catch (e) {
    toast.value = '保存失败：' + e.message
    await loadProviders()
  }
}

/**
 * 换一种登录方式。
 *
 * 只改**全局默认** —— 单独设置过的学生不受影响（他们各自按 auth_overrides 走），
 * 所以切完要提醒一句有多少人例外。
 */
async function setLoginMode(key) {
  const ovCount = overridesMap.value.size
  const p = providers.value.find((x) => x.key === key)
  try {
    await api.patch('/api/settings/student-auth', { provider: key })
    login.provider = key
    login.mode = key
    await loadLogin()
    toast.value =
      '已切换：学生现在用「' +
      ((p && p.name) || key) +
      '」登录' +
      (ovCount ? '（' + ovCount + ' 个学生单独设置过，不受影响）' : '')
  } catch (e) {
    toast.value = '切换失败：' + e.message
    await loadProviders()
  }
}

/* 多入口（url-list 类型）：一项一个输入框 + 增删 */
function addBase() {
  const list = (setValOf('bases') || []).concat([''])
  saveSetting('bases', list)
}
function setBase(i, v) {
  const list = (setValOf('bases') || []).slice()
  list[i] = v
  patchVal('bases', list)
}
async function saveBases() {
  await saveSetting('bases', (setValOf('bases') || []).filter((x) => String(x || '').trim()))
}
function dropBase(i) {
  const list = (setValOf('bases') || []).slice()
  list.splice(i, 1)
  saveSetting('bases', list)
}

/* ---------------- 按人设置登录方式 ---------------- */

/**
 * sid → 单独设置的登录方式（'local' | 'kg'）。
 * 没在这个 Map 里 = 跟随全局（login.mode）。
 *
 * 只拉「有覆盖」的那些：一个班 60 人里通常只有两三个需要单独设，
 * 逐行传一遍纯属浪费。
 */
const overridesMap = ref(new Map())
/** 勾选中的行（批量设置用） */
const picked = ref(new Set())

/** 这个学生实际用哪种方式 */
function modeOf(sid) {
  return overridesMap.value.get(sid) || login.mode
}
/** 是不是单独设过（表格里标一下，否则分不清「跟随全局」和「恰好一样」） */
function isOverride(sid) {
  return overridesMap.value.has(sid)
}
/** 班里有没有人走账号密码 —— 有才显示「记住的密码」那一列 */
const anyKg = computed(() => loginRows.value.some((s) => modeOf(s.sid) === 'kg'))

function togglePick(sid) {
  const s = new Set(picked.value)
  if (s.has(sid)) s.delete(sid)
  else s.add(sid)
  picked.value = s
}
function togglePickAll() {
  if (picked.value.size >= loginRows.value.length) picked.value = new Set()
  else picked.value = new Set(loginRows.value.map((s) => s.sid))
}

/**
 * 改一个人的登录方式。
 *
 * 传空串 = 清除覆盖（回到跟随全局）。
 * 改完立刻回写本地 Map，不整表重拉 —— 重拉会把「哪几行正显示明文密码」清空。
 */
async function setMode(sid, mode) {
  try {
    await api.put('/api/settings/student-auth/overrides', { sids: [sid], mode })
    const m = new Map(overridesMap.value)
    if (mode) m.set(sid, mode)
    else m.delete(sid)
    overridesMap.value = m
    toast.value = mode
      ? '已设为' + (mode === 'kg' ? '账号 + 密码' : '学号 + 姓名')
      : '已恢复为跟随全局'
  } catch (e) {
    toast.value = '设置失败：' + e.message
    await loadLogin()
  }
}

/** 批量应用（工具栏那个「应用」） */
async function applyBatch() {
  const sids = [...picked.value]
  if (!sids.length) return
  const mode = batchMode.value
  try {
    const r = await api.put('/api/settings/student-auth/overrides', { sids, mode })
    const m = new Map(overridesMap.value)
    for (const s of sids) {
      if (mode) m.set(s, mode)
      else m.delete(s)
    }
    overridesMap.value = m
    picked.value = new Set()
    toast.value = mode
      ? '已把 ' + sids.length + ' 个学生设为' + (mode === 'kg' ? '账号 + 密码' : '学号 + 姓名')
      : '已把 ' + sids.length + ' 个学生恢复为跟随全局'
  } catch (e) {
    toast.value = '批量设置失败：' + e.message
  }
}

/** 批量工具栏选的目标方式 */
const batchMode = ref('')

/*
 * 这里原来有 saveVerifyEach() 和 saveBases() 两个写死的方法，
 * 分别 PATCH `{ verifyEachTime }` 和 `{ kgBases }`。
 * 插件化之后配置项由插件声明，统一走 saveSetting(field, value) ——
 * 加一个配置字段不用再写一个方法。
 */

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

/**
 * 记住的密码：sid → { password, legacy }
 *
 * 单独拉一个接口而不是塞进 login-admin：
 * 那是明文，只在展开「登录管理」时才需要。
 * 默认打码（shownPwd 为空 = 全部 *），点眼睛才显示某一行。
 */
const credsMap = ref(new Map())
const shownPwd = ref(new Set())

function credOf(sid) {
  return credsMap.value.get(sid) || null
}
function togglePwd(sid) {
  const next = new Set(shownPwd.value)
  if (next.has(sid)) next.delete(sid)
  else next.add(sid)
  shownPwd.value = next
}

/**
 * 删掉某学生记住的密码。
 *
 * 什么时候用：学生忘了密码、或者他在青果那边改过密码导致这边一直对不上。
 * 删掉之后下次登录要重新输入一遍，青果核验通过又会重新记住 —— 不是不可逆操作。
 *
 * 本地直接摘掉这一行，不整表重拉：重拉会把「哪几行正显示明文」的状态清空，
 * 老师刚点开的其他行会突然合上。
 */
async function forgetOne(s) {
  const name = s.name || s.sid
  if (!window.confirm('删掉「' + name + '」记住的密码？\n\n学生下次登录要重新输入一遍（青果核验通过后会重新记住）。')) {
    return
  }
  try {
    await api.del('/api/settings/student-auth/creds/' + encodeURIComponent(s.sid))
    const m = new Map(credsMap.value)
    m.delete(s.sid)
    credsMap.value = m
    const sp = new Set(shownPwd.value)
    sp.delete(s.sid)
    shownPwd.value = sp
    login.rememberedCount = Math.max(0, Number(login.rememberedCount || 0) - 1)
    toast.value = '已删掉「' + name + '」记住的密码'
  } catch (e) {
    toast.value = '删除失败：' + e.message
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
    login.provider = r.mode === 'kg' ? 'kg' : 'local'
    login.mode = login.provider
    /* 配置项由插件声明，这一份只是给「表头提示」之类的地方快速取用 */
    await loadProviders()
    login.rememberedCount = Number(r.rememberedCount || 0)
    login.blockedCount = Number(r.blockedCount || 0)
    login.students = Array.isArray(r.students) ? r.students : []

    /* 按人设置的登录方式（只有覆盖过的才回，大多数跟随全局） */
    try {
      const ov = await api.get('/api/settings/student-auth/overrides?classId=' + activeId.value)
      const m = new Map()
      for (const it of ov.items || []) m.set(it.sid, it.mode)
      overridesMap.value = m
    } catch (e) {
      overridesMap.value = new Map()
    }
    picked.value = new Set()

    /*
     * 记住的密码（明文，按本班过滤）。
     *
     * 判断「要不要拉」不能只看全局 mode：有人单独设成 kg 时，
     * 全局是 local 也得拉 —— 那些学生的密码就存在这里。
     * 所以条件放宽成「全局是 kg，或者本班有人覆盖成 kg」。
     */
    const hasKg = login.mode === 'kg' || [...overridesMap.value.values()].includes('kg')
    if (hasKg) {
      try {
        const c = await api.get('/api/settings/student-auth/creds?classId=' + activeId.value)
        const m = new Map()
        for (const it of c.items || []) m.set(it.sid, it)
        credsMap.value = m
      } catch (e) {
        credsMap.value = new Map()
      }
    } else {
      credsMap.value = new Map()
    }
    /* 重新拉数据时全部回到打码状态 —— 别让上一次展开的行一直亮着 */
    shownPwd.value = new Set()
  } catch (e) {
    toast.value = '读不到登录管理数据：' + e.message
  }
}

/*
 * 这里原来还有一个 setLoginMode(mode)：只 PATCH `{ mode }`，
 * 和图省写死的两种方式配套。插件化之后由上面那个统一的 setLoginMode(key) 接管 ——
 * 两个同名函数会让编译直接报重复声明。
 */

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

/**
 * sid → 学生此刻停在哪个页面（「课程材料」「课堂作业·作答」…）。
 *
 * 服务端的心跳顺手带上这个（/api/presence/ping 的 page 字段），
 * 人没上报过就是空 —— 这时显示「在线」，总比显示空白好。
 */
const pageMap = computed(() => {
  const m = {}
  for (const s of presence.value.online || []) m[s.sid] = s.page || ''
  return m
})
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
  /* 「在线」比「状态」准确：这一列只有在线 / 离线两种 */
  { key: 'status', label: '在线', hint: '登录中', width: '70px', sortable: true },
  /* 原来这里是「投屏（在看）」，换成学生此刻停在哪个页面 —— 每节课都在变，信息量更大 */
  /* hint 只放短词（它跟在表头文字后面同一行），一句话的说明会撑宽列 */
  { key: 'page', label: '在哪页', width: '104px', sortable: true },
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
  /* 按页面名排序：同一页的人会聚在一起，老师一眼看出「这节课有几个人在做作业」 */
  if (key === 'page') return presenceSet.value.has(sid) ? pageMap.value[sid] || '在线' : ''
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
/**
 * 全班流水（按时间倒序）。
 *
 * 服务端 eventsOf 是**升序**（分页游标按 created_at > 翻，所以只能升着给）。
 * 但流水这种"刚刚发生了什么"的列表，最新一条必须在最上面 ——
 * 老师上完一节课去看，要看的是最后那几条，不是这节课最早的那条。
 *
 * 同一秒可能有多条（批量记分），所以时间相同时用 id 兜底，
 * 保证两次刷新顺序不会跳。
 */
const filteredEvents = computed(() => {
  const kw = logQ.value.trim()
  const list = events.value.filter((e) => {
    if (logItem.value && e.item !== logItem.value) return false
    if (!kw) return true
    return nameOf(e.sid).indexOf(kw) >= 0 || e.sid.indexOf(kw) >= 0 || (e.reason || '').indexOf(kw) >= 0
  })
  return list.sort((a, b) => {
    const d = String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    return d !== 0 ? d : String(b.id || '').localeCompare(String(a.id || ''))
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
  border-radius: var(--r-md);
  background: #f7fbfd;
  padding: 8px var(--sp-2);
}

.ip-row {
  display: flex;
  gap: var(--sp-2);
  align-items: baseline;
  padding: 2px 0;
}

.ip-k {
  flex: 0 0 56px;
  color: #6b7785;
  font-size: var(--fs-sm);
}

.import-plan .add {
  color: #1f7a55;
}

.import-plan .del {
  color: #b4400f;
}

.ip-tip {
  margin-top: 4px;
  font-size: var(--fs-xs);
}

/* 名单导入：没被采纳的行 */
.iss {
  margin: var(--sp-2) 0 0 var(--sp-4);
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
  font-size: var(--fs-sm);
}

.fbar .input {
  padding: 4px 8px;
  font-size: var(--fs-sm);
}

.fbar .dim {
  font-size: var(--fs-sm);
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
  font-size: var(--fs-xs);
  color: #c2c8ce;
}

th.on .sortmark {
  color: #1d4ed8;
}

/* 内边距交给全局的 .card.classbar（12px 16px）—— 这里只排布 */
.classbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 右栏流水的空态：说清「为什么会空」和「怎么让它有内容」 */
.log-empty {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-3) var(--sp-1);
  line-height: 1.6;
}
.log-empty b {
  font-weight: 600;
  color: var(--ink);
  font-size: var(--fs-md);
}
.log-empty span {
  font-size: var(--fs-sm);
  color: var(--dim);
}

/* 卡片撑满右栏，列表吃掉剩余高度自己滚 —— 否则流水一多就把卡片撑破，一少底边又对不齐 */
.log-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
}

/* 右栏流水的筛选：只有 320px 宽，两个控件竖着摆比并排好按 */
.log-tools {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-bottom: 8px;
}
.log-tools .select,
.log-tools .input {
  width: 100%;
}

/* 右栏窄，一条记录的头改成「谁 + 分 + 时间」压一行，原因和操作人各占一行 */
.log .lhead {
  flex-wrap: wrap;
  gap: var(--sp-2);
}

/* 操作列：宽屏写全称，窄屏缩图标（见模板里那段注释） */
.t-short {
  display: none;
}
@media (max-width: 1280px) {
  .t-long {
    display: none;
  }
  .t-short {
    display: inline;
  }
}

.classbar .pill em {
  font-style: normal;
  color: var(--dim);
  margin: var(--sp-2);
  font-size: var(--fs-sm);
}

.classbar .pill.on em {
  color: var(--brand);
}

/*
 * 内层 tab（班级名单 / 登录管理）：做成文件夹标签，和下面那张卡连成一片。
 *
 * 原来每个 tab 都是「整块灰底 + 全边框 + 11px 圆角」的独立方块，
 * 下面再放一张白卡 —— 两块之间是断的，看着像两个不相干的控件。
 * 现在：
 *   · 一条横线贯穿整行，选中的 tab 用卡片色把横线「咬」开一个口子
 *   · 卡片顶部去掉上边框和上圆角，于是 tab → 内容是一条连续的竖边
 *   · 未选中的 tab 只是文字，hover 才出浅底，不抢注意力
 */
.tabs {
  display: flex;
  gap: 2px;
  margin: var(--sp-2) 0 0;
  padding: 0 var(--sp-2);
  border-bottom: 1px solid var(--line);
}
.tab {
  position: relative;
  padding: var(--sp-2) 16px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--r-md) var(--r-md) 0 0;
  background: transparent;
  color: #5b6673;
  cursor: pointer;
  font-size: var(--fs-md);
  margin-bottom: -1px;
}
.tab:hover {
  background: var(--bg-sub);
  color: var(--ink);
}
.tab.on {
  background: var(--card);
  color: var(--brand-ink);
  font-weight: 600;
  border-color: var(--line);
  border-bottom-color: var(--card);
}
/* 贴着 tabs 的那张卡：去掉上边和上圆角，和 tab 拼成一个整体 */
.scroll-body > .card {
  border-top: none;
  border-top-left-radius: 0;
  border-top-right-radius: 0;
  margin-top: 0;
}



.log {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 62vh;
  overflow: auto;
}

.log > li {
  padding: var(--sp-2) 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--r-md);
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
  font-size: var(--fs-sm);
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

.who {
  font-size: var(--fs-md);
}

.delta {
  font-size: var(--fs-md);
  color: var(--brand-ink);
}

.reason {
  margin: var(--sp-1) 0 2px;
  font-size: 13.8px;
}

.lf {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
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
  gap: var(--sp-2);
  font-size: var(--fs-md);
  color: #475569;
}
/* 登录管理 */

/*
 * 插件配置区（按插件声明的 settings 渲染）。
 * 换了一个登录方式，它的配置项就出现在这下面 —— 没有配置项的插件整块不出现。
 */
.lgh4 {
  margin: var(--sp-4) 0 var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px dashed var(--line);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: #4a525a;
}
.lgfield {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin-bottom: var(--sp-3);
}
.lgf-label {
  font-size: var(--fs-sm);
  color: var(--sub);
}
/* 「连错 3 次就暂停」那条说明，和配置区之间留一口气 */
.lgwarn {
  margin: var(--sp-3) 0 var(--sp-4);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-sub);
  line-height: 1.6;
}

.lgrow {
  display: flex;
  gap: var(--sp-3);
  flex-wrap: wrap;
  margin: var(--sp-2) 0 8px;
}
.lgopt {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: var(--sp-2) 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--r-lg);
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
  font-size: var(--fs-md);
}
.lgtbl th,
.lgtbl td {
  text-align: left;
  padding: var(--sp-2) 8px;
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
  margin: var(--sp-2) 0 var(--sp-2);
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
  gap: var(--sp-2);
  margin: 8px 0 4px;
}
/*
 * 一行一个入口：序号 + 输入框 + 删除，**横排**。
 * 原来是竖排（旧版把标签放输入框上方），换成横排之后控件挤不下会掉行，所以显式 nowrap。
 */
.lgbase {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: nowrap;
}
.lgbase .input {
  width: 200px;
}
.lgbase .btn.mini {
  flex: none;
  padding: 0 7px;
}
/*
 * 记住的密码这一列：默认打码，点眼睛显示明文。
 * 打码用 • 而不是 * —— 等宽字体下 • 更整齐，也不会和密码里的 * 混淆。
 */
/* 160：够放「Pwd-Alpha-111」这种 13 字符的明文 + 两个 20px 图标 */
.lgtbl .pwdcol {
  width: 160px;
}

/* ---------------- 按人设置登录方式 ---------------- */

/* 批量工具栏：和下面的表格同宽，贴在表头上方 */
.lgbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-2) var(--sp-2) 0;
  margin-bottom: var(--sp-2);
  border-bottom: 1px dashed var(--line);
}
.lgbar .spacer {
  flex: 1;
}

/* 勾选列：窄，内容居中 */
.lgtbl .pickcol {
  width: 34px;
  text-align: center;
  padding-left: var(--sp-2);
  padding-right: 0;
}
.lgtbl .pickcol input {
  cursor: pointer;
  width: 14px;
  height: 14px;
}

/* 登录方式列 */
.lgtbl .modecol {
  width: 176px;
}
/* 行内的下拉比标准控件小一号 —— 它是「表格里的一个格子」，不该比同行文字重 */
.lgtbl .mode-sel {
  width: 150px;
  height: 24px;
  font-size: var(--fs-sm);
  padding: 0 6px;
}

/*
 * 单独设置过的小圆点。
 * 光看下拉分不清「跟随全局」和「恰好设成了跟全局一样」——
 * 而这两件事以后的行为不同（全局改了，前者跟着变、后者不变）。
 */
.lgtbl .ovdot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--brand);
  margin-right: 5px;
  vertical-align: middle;
}

/* 勾选中的行：浅底提示，避免"选了哪些"看不出来 */
.lgtbl tbody tr.picked {
  background: var(--brand-wash);
}
.lgtbl tbody tr.picked:hover {
  background: #e6eef4;
}
.lgtbl .pwdshow {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}
.lgtbl .pwdshow code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.2;
  color: #33414d;
  min-width: 64px;
  /*
   * 不许折行：密码一换行，行高就变，整列跟着参差（实测「Pwd-Alpha-111」
   * 会断成两行）。放不下就省略号，完整值挪到 title 里。
   */
  max-width: 104px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: all; /* 点一下能整段选中，方便复制 */
}
/* 旧记录（看不到原文）用弱一点的样式，和能看的区分开 */
.lgtbl .pwdshow code.pwd-legacy {
  color: var(--dim);
  font-family: inherit;
  font-size: var(--fs-sm);
  user-select: none;
}

/*
 * 右侧两个图标按钮（眼睛 / 删除）。
 *
 * 原来眼睛是 13px 的 emoji（👁 / 🙈）—— emoji 在 Windows / macOS / 安卓上
 * 字形和大小都不一样，同一个表格换个系统就变样；而且它自带彩色，
 * 在一列纯灰文字里很跳。这里换成内联 SVG：跟着 currentColor 走，18px 的
 * 点击区（视觉 14px），和其他行的 .btn.mini 高度也接近。
 *
 * 默认半透明、悬停才亮 —— 一行一个按钮还满色的话，13 列的表会花。
 */
.lgtbl .pwdops {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 2px;
}
.lgtbl .pwdico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: #6b7480;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}
.lgtbl .pwdico:hover {
  opacity: 1;
  background: var(--bg-sub);
  color: var(--brand-ink);
}
/* 正在显示明文时眼睛保持亮着，表示「现在能看到」 */
.lgtbl .pwdico.on {
  opacity: 1;
  color: var(--brand);
}
/* 删除用红色，但只在悬停时变红 —— 平时不抢注意力 */
.lgtbl .pwdico.del:hover {
  color: var(--err);
  background: #fbeeec;
  border-color: #e2bdb9;
}

.lgcreds {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: var(--sp-2);
  padding: var(--sp-2);
  border-top: 1px solid var(--line-soft);
}
</style>
