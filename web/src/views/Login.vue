<template>
  <div class="login">
    <div class="box">
      <header class="head">
        <!-- 只有一门课就直接写课程名（老师一眼确认没进错），否则退回系统名 -->
        <h1>{{ courses.length === 1 ? courses[0].name : '课堂系统' }}</h1>
        <p>课堂系统 · 讲义、计分、点名与投屏</p>
      </header>

      <div class="tabs">
        <button :class="{ on: tab === 'student' }" @click="switchTab('student')">学生</button>
        <button :class="{ on: tab === 'teacher' }" @click="switchTab('teacher')">教师</button>
      </div>

      <p v-if="state.tokenExpired" class="note warn">
        登录已失效，请重新登录。登录后会自动回到刚才那一页。
      </p>

      <!--
        学生登录分两步。
        为什么：登录方式可以**按人**设置（大部分跟随全局，个别单独指定），
        所以在拿到学号之前，前端根本不知道该画"姓名"还是"密码"。
        原来一进来就问全局 mode —— 「全局学号+姓名、但这个人要账号密码」时，
        页面只显示姓名框，学生输完点登录才被告知要密码，而他没看到密码框。

        现在：填学号 → 问服务端这个人怎么登 → 再画对应表单。
      -->
      <form v-if="tab === 'student'" class="form" @submit.prevent="onStudentStep">
        <!-- 第一步：课程 + 学号 -->
        <template v-if="step === 1">
          <label class="field">
            <span>课程</span>
            <select v-model="form.courseId" class="select">
              <option value="" disabled>请选择课程</option>
              <option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
          <label class="field">
            <span>学号</span>
            <input
              v-model.trim="form.sid"
              class="input"
              placeholder="名单上的学号"
              autocomplete="off"
              @keyup.enter="probe"
            />
          </label>
          <p class="note">先填学号，下一步按你的账号要求显示对应的输入框。</p>
          <button class="btn primary" :disabled="busy || !form.courseId || !form.sid">
            {{ busy ? '正在查询…' : '下一步' }}
          </button>
        </template>

        <!-- 第二步：按查到的登录方式显示凭证 -->
        <template v-else>
          <div class="confirmed">
            <span class="mono">{{ form.sid }}</span>
            <button type="button" class="linkbtn" @click="backToStep1">改学号</button>
          </div>

          <!--
            凭证输入框：**照着插件声明的字段渲染**，不是写死的「姓名 / 密码」。
            插件的 credentials 里写几个，这里就出现几个；type 决定用不用密码框。
          -->
          <label v-for="(f, i) in fields" :key="f.key" class="field">
            <span>{{ f.label }}</span>
            <input
              :type="f.type === 'password' ? 'password' : 'text'"
              :value="credValues[f.key] || ''"
              :placeholder="f.placeholder || ''"
              :autocomplete="f.autocomplete || 'off'"
              :autofocus="i === 0"
              class="input"
              @input="credValues[f.key] = $event.target.value"
            />
          </label>

          <!--
            图形验证码。
            只有当服务端说「自动识别没过，请你来填」时才出现 ——
            平时学生完全看不到这一块，感觉和以前一样。
          -->
          <div v-if="captcha" class="capbox">
            <!-- 服务端给的话（「自动识别没能通过，请自己输入图中的字符」），灰字不是红字 -->
            <p v-if="captchaMsg" class="cap-msg">{{ captchaMsg }}</p>
            <span class="cap-label">验证码</span>
            <div class="cap-row">
              <img :src="captcha.image" alt="验证码" class="cap-img" title="看不清？点一下换一张" @click="refreshCaptcha" />
              <button type="button" class="btn mini" :disabled="captchaBusy" @click="refreshCaptcha">
                {{ captchaBusy ? '…' : '换一张' }}
              </button>
            </div>
            <input
              v-model.trim="captchaCode"
              class="input cap-input"
              maxlength="8"
              placeholder="输入图中字符"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
            />
          </div>

          <!-- 说明文字也是插件给的（每个字段的 tip / fallbackTip），系统不替它编 -->
          <template v-for="f in fields" :key="f.key + '-tip'">
            <p v-if="f.tip" class="note">{{ f.tip }}</p>
            <p v-if="f.fallbackTip" class="note tip">{{ f.fallbackTip }}</p>
          </template>

          <button class="btn primary" :disabled="busy || !canSubmit">
            {{ busy ? '正在登录…' : '进入课堂' }}
          </button>
        </template>

        <p v-if="!courses.length" class="note warn">老师还没有建课程。</p>
        <p v-if="err" class="note err">{{ err }}</p>
      </form>

      <form v-else class="form" @submit.prevent="loginTeacher">
        <label class="field">
          <span>口令</span>
          <input v-model="form.password" type="password" class="input" placeholder="教师口令" />
        </label>
        <!--
          「当前是初始口令」的提示移到了教师端（TeacherLayout）。
          原因：登录页是未登录状态，拿不到 passwordIsDefault；
          而这个字段一旦对所有人可见，就等于告诉别人「直接试默认口令」。
        -->
        <button class="btn primary" :disabled="busy || !form.password">
          {{ busy ? '正在登录…' : '进入教师端' }}
        </button>
        <p v-if="err" class="note err">{{ err }}</p>
      </form>

      <footer class="foot">
        <span>{{ courseCountText }}</span>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { applyLogin, refresh, state } from '../store'

const router = useRouter()
const route = useRoute()

const tab = ref('student')
const busy = ref(false)
const err = ref('')

// 课程清单走公开接口：登录页还没令牌，但学生得先选课程
const courses = ref([])

async function loadCourses() {
  try {
    const res = await api.get('/api/courses/public')
    courses.value = res.items || []
    if (courses.value.length && !form.courseId) form.courseId = courses.value[0].id
  } catch (e) {
    courses.value = []
  }
}

/*
 * 页脚只显示「几门课」。
 * 原来还会显示「117 人次」，但那意味着**任何人打开登录页就能知道这个学校有多少学生** ——
 * 而登录页只需要让人选一门课，人数一个用不上。接口那边也不返回它了。
 */
const courseCountText = computed(() => {
  const n = courses.value.length
  return n ? n + ' 门课' : ''
})

const form = reactive({ courseId: '', sid: '', name: '', password: '', stuPwd: '' })

/**
 * 登录方式：现在是**插件 key**（local / kg / 以后别的）。
 *
 * 注意它**不再从全局配置读**。因为可以按人设置（auth_overrides），
 * 全局值只代表"默认"，不代表这个学生 —— 必须拿到学号之后问服务端。
 * 所以初始值是空的，第二步才填。
 */
const authMode = ref('')

/**
 * 这个登录方式要填哪些字段（由插件声明，服务端在 probe 时给）。
 *
 * 每一项形如 { key:'password', label:'密码', type:'password', required:true, tip:'…' }。
 * **第二步的表单是照着它渲染的** —— 不再写「kg 就显示密码框」那种 if。
 * 加一个新插件（要工号 + 短信码、或者扫码那种一个字段都不填），这里一行都不用改。
 */
const fields = ref([])

/**
 * 学生已经填的值，按字段 key 存（{ name:'…' } 或 { password:'…' }）。
 *
 * 用普通 reactive 对象而不是每个字段一个 ref：字段是运行时才知道的，
 * 没法提前声明。
 */
const credValues = reactive({})

/** 1 = 填课程+学号；2 = 填凭证 */
const step = ref(1)

/**
 * 第一步 → 问服务端这个学号该怎么登。
 *
 * 失败不拦人：查不到就按 local 先让进（老方式能进总比卡住好），
 * 真不对后端会在第二步给出准确提示。
 */
async function probe() {
  const sid = String(form.sid || '').trim()
  if (!form.courseId || !sid) return
  busy.value = true
  err.value = ''
  try {
    const r = await api.post('/api/auth/student-probe', { sid })
    authMode.value = (r && r.provider) || 'local'
    fields.value = Array.isArray(r && r.credentials) ? r.credentials : []
    step.value = 2
    /*
     * 插件声明了 credentials: [] —— 意思是「不需要当场输任何东西」
     * （扫码、或者纯靠学号认人的方式）。那样第二步没有可填的，
     * 直接提交，别让「下一步」点完一片空白。
     */
    if (!fields.value.length) await loginStudent()
  } catch (e) {
    authMode.value = 'local'
    fields.value = [{ key: 'name', label: '姓名', type: 'text', required: true }]
    step.value = 2
  } finally {
    busy.value = false
  }
}

function backToStep1() {
  step.value = 1
  authMode.value = ''
  fields.value = []
  for (const k of Object.keys(credValues)) delete credValues[k]
  captcha.value = null
  captchaCode.value = ''
  captchaMsg.value = ''
  err.value = ''
}

/** 表单提交：第一步走 probe，第二步才真的登录 */
function onStudentStep() {
  if (step.value === 1) probe()
  else loginStudent()
}

/*
 * 第二步的提交可用性：课程和学号在第一步已经确认过，这里只看凭证填了没。
 * 出现验证码时，码也必须填 —— 否则会发一个注定 401 的请求，
 * 白白多打一次平台、多消耗对方的失败计数。
 */
const canSubmit = computed(() => {
  if (!fields.value.length) return false
  /* 插件声明为 required 的字段都得有值 */
  for (const f of fields.value) {
    if (f.required && !String(credValues[f.key] || '').trim()) return false
  }
  /* 出现验证码时，码也必须填 —— 否则发一个注定失败的请求，白打一次平台 */
  if (captcha.value && !String(captchaCode.value || '').trim()) return false
  return true
})

/* ---------------- 图形验证码 ---------------- */

/**
 * 验证码状态。
 *
 * captcha 为 null = 现在不需要学生填（首次提交、或者平台根本不要）。
 * 后端返回 { needCaptcha, challenge:{ image, handle } } 时才填上。
 */
const captcha = ref(null)
const captchaCode = ref('')
/** 验证码区自己的提示（灰字）；不是错误，别走 err */
const captchaMsg = ref('')
const captchaBusy = ref(false)

/**
 * 换一张。
 *
 * 用当前的 handle 去换 —— 服务端靠 handle 反查是哪份平台会话，
 * 所以换出来的图仍然和这次登录是同一个会话（验证码必须和会话配套）。
 */
async function refreshCaptcha() {
  if (!captcha.value || captchaBusy.value) return
  captchaBusy.value = true
  try {
    const r = await api.post('/api/auth/captcha/refresh', { handle: captcha.value.handle })
    if (r && r.ok && r.challenge) {
      captcha.value = r.challenge
      captchaCode.value = ''
      err.value = ''
    } else {
      /* 换不出来就别留个空白框：收掉，让学生重新提交一次 */
      captcha.value = null
      captchaCode.value = ''
      err.value = '验证码已过期，请重新点「进入课堂」'
    }
  } catch (e) {
    captcha.value = null
    err.value = '换验证码失败，请重新点「进入课堂」'
  } finally {
    captchaBusy.value = false
  }
}

onMounted(async () => {
  // 已登录就直接进对应的家
  if (state.role === 'teacher') router.replace('/teacher/lecture')
  else if (state.role === 'student') router.replace('/student/materials')

  /*
   * 登录页只做一件事：拿课程下拉。
   *
   * 原来这里还有一段 `if (!state.classes.length) await refresh()` ——
   * 它会在**任何人**打开登录页时拉一次 /api/bootstrap（2.48KB），
   * 而登录页的 state.classes 恒为空（游客档本来就不给班级），
   * 于是每次进来都白拉一次、拉完什么也没做。
   */
  if (!courses.value.length) await loadCourses()
  if (courses.value.length && !form.courseId) form.courseId = courses.value[0].id
  /*
   * 注意这里**不预取登录方式**。
   * 登录方式可以按人设置，没有学号之前问不出结果 ——
   * 预取回来的只是全局默认值，用它画表单就会在"个人覆盖"时画错（见文档头）。
   * 真正的询问发生在第一步点「下一步」时（probe）。
   */
})

function switchTab(t) {
  tab.value = t
  err.value = ''
}

async function loginStudent() {
  if (!canSubmit.value) return
  busy.value = true
  err.value = ''
  try {
    /*
     * 凭证按插件声明的字段平铺到请求体（{ sid, name } 或 { sid, password }）。
     * 服务端那边按同一份声明从 body 取，所以字段名只有一个来源 —— 插件的 credentials。
     */
    const payload = { sid: form.sid }
    for (const f of fields.value) {
      payload[f.key] = String(credValues[f.key] || '')
    }
    if (captcha.value) {
      payload.captcha = { code: String(captchaCode.value || '').trim(), handle: captcha.value.handle }
    }

    const res = await api.post('/api/auth/login/student', payload)

    /*
     * 要验证码 —— 这不是失败，是还差一步（后端以 200 返回）。
     * 不能当成错误处理：一抛错就会把 err 显示成红字，学生以为密码错了。
     */
    if (res && res.needCaptcha) {
      captcha.value = res.challenge || null
      captchaCode.value = ''
      /*
       * 提示走 captchaMsg（灰字），**不进 err**（红字）。
       * 「请自己输入图中的字符」不是错误，用红字会让学生以为密码错了。
       */
      captchaMsg.value = res.message || ''
      /* 图没拿到就别卡在这：收掉验证码区，让他重新提交 */
      if (!captcha.value) {
        captchaMsg.value = ''
        err.value = '验证码暂时取不到，请稍后再试'
      }
      return
    }

    applyLogin(res)
    await refresh()
    router.replace(route.query.next || '/student/materials')
  } catch (e) {
    err.value = e.message
    /*
     * 提交失败时把验证码清掉：平台那边的码通常是一次性的，
     * 同一张图再提交一次必然还是错，不如让下一次请求走「自动识别」重来。
     */
    captcha.value = null
    captchaCode.value = ''
  } finally {
    busy.value = false
  }
}

async function loginTeacher() {
  busy.value = true
  err.value = ''
  try {
    const res = await api.post('/api/auth/login/teacher', { password: form.password })
    applyLogin(res)
    await refresh()
    router.replace(route.query.next || '/teacher/lecture')
  } catch (e) {
    err.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px var(--sp-4);
  background: var(--bg);
}

.box {
  width: 100%;
  max-width: 392px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: var(--sp-5) var(--sp-5) var(--sp-4);
}

.head h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.head p {
  margin: 4px 0 0;
  font-size: var(--fs-sm);
  color: var(--dim);
}

.tabs {
  display: flex;
  gap: 0;
  margin: var(--sp-4) 0 16px;
  border-bottom: 1px solid var(--line);
}

.tabs button {
  padding: var(--sp-2) var(--sp-3) 8px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--sub);
  cursor: pointer;
  font-size: var(--fs-md);
  margin-bottom: -1px;
}

.tabs button.on {
  border-bottom-color: var(--brand);
  color: var(--ink);
  font-weight: 600;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/*
 * 登录页的输入框比全站大一档。
 *
 * 全局 --h-ctl 是 28px（表格、筛选条那些地方合适 —— 那些是一屏几十个控件，
 * 紧凑优先）。但登录页一屏只有两三个框，而且是**第一次见面**，
 * 28px 又矮又薄，手指点上去没底、眼睛也不容易聚焦。
 *
 * 38px + 大一号字 + 左右留白，是手机和桌面都舒服的尺寸。
 * 只在本页覆盖，不动全局 —— 别把表格也顶高。
 */
.form .field > span {
  display: block;
  margin-bottom: 6px;
  font-size: var(--fs-sm);
  color: #5b6673;
}

.form .input,
.form .select {
  height: 40px;
  padding: 0 var(--sp-3);
  /*
   * 16px，比正文（13.5）和区块标题（15）都大一档。
   *
   * 一是登录页就这几个框，字大点看着不费劲；
   * 二是 16px 正好躲开 iOS Safari 的坑 —— 小于 16px 的输入框一聚焦，
   * 浏览器会自动把页面放大，学生输完还得手动缩回去。
   */
  font-size: 16px;
  border-radius: var(--r-md);
}

/* 验证码那个框不需要那么高，它和图片并排 */
.form .input.cap-input {
  height: 38px;
  font-size: var(--fs-lg);
  letter-spacing: 1px;
}

.form .btn.primary {
  margin-top: 2px;
  width: 100%;
}

.note {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.65;
  color: var(--dim);
}

/*
 * 第二步顶部那条「学号 2515270201  改学号」。
 * 让学生随时能退回去改 —— 输错学号是很常见的，没有这个只能刷新页面。
 */
.confirmed {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-sub);
  font-size: var(--fs-md);
}
.confirmed .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
  color: var(--ink);
}
.linkbtn {
  margin-left: auto;
  border: none;
  background: transparent;
  padding: 0;
  color: var(--brand);
  font-size: var(--fs-sm);
  cursor: pointer;
  text-decoration: underline;
}
.linkbtn:hover {
  color: var(--brand-ink);
}

/*
 * 图形验证码。
 *
 * 图定宽高（不跟着图片原始尺寸走）—— 平台的验证码图大小不一，
 * 不定死的话每次换图整个表单会跟着跳一下。
 * 点图本身也能换：很多人第一反应就是点图，不点「换一张」。
 */
.capbox {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-sub);
  border: 1px solid var(--line);
}
.cap-msg {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--sub);
}
.cap-label {
  font-size: var(--fs-sm);
  color: var(--sub);
}
.cap-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.cap-img {
  width: 132px;
  height: 40px;
  object-fit: contain;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-strong);
  background: #fff;
  cursor: pointer;
  /* 换图时别闪一下白 */
  transition: opacity 0.12s;
}
.cap-img:hover {
  opacity: 0.85;
}
.cap-input {
  width: 132px;
  letter-spacing: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-transform: uppercase;
}

/* 「一直登不进去？」那条兜底提示：比普通说明再弱一档，别喧宾夺主 */
.note.tip {
  margin-top: calc(-1 * var(--sp-1));
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--dim);
  opacity: 0.85;
}

.note.warn {
  color: var(--warn);
}

.note.err {
  color: var(--err);
}

.foot {
  margin: var(--sp-4);
  padding: var(--sp-2);
  border-top: 1px solid var(--line-soft);
  font-size: var(--fs-xs);
  color: #a8afb6;
  min-height: 18px;
}
</style>
