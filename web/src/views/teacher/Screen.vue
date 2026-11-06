<template>
  <PageShell>
    <template #head>
      <PageHead>
        <template #title>投屏设置</template>
        <template #sub>开关在左侧栏底部；切到讲义、点名、计分都不会中断投屏</template>
        <template #right>
          <span class="tag" :class="s.connected ? 'ok' : 'err'">{{ s.connected ? '连接正常' : '连接断开' }}</span>
          <span class="tag" :class="s.running ? 'ok' : 'mute'">{{ s.running ? '投屏中' : '未开播' }}</span>
          <a class="btn mini" href="/watch" target="_blank" rel="noopener">打开观看页</a>
        </template>
      </PageHead>
    </template>
    <p v-if="insecureOrigin" class="hint" style="margin-bottom:12px">
      现在这个地址浏览器不给抓屏，点开始投屏会提示原因。两个办法：
      用 <code>localhost</code> 地址重开本页（<code>http://localhost:{{ here.port || '80' }}/teacher/screen</code>），
      或从「教师端」启动脚本重开（它已经放行）。讲义、计分、点名在任何地址都照常。
    </p>

    <section class="card">
      <div class="row">
        <span class="tag" :class="s.running ? 'ok' : 'mute'">
          {{ s.running ? '正在投屏 · ' + s.capW + '×' + s.capH : '未开播' }}
        </span>
        <button class="btn line" :disabled="!s.running" @click="cast.requestKey()">重推整屏</button>
        <span class="spacer"></span>
        <span class="dim">
          开关在左侧栏底部「{{ s.running ? '停止投屏' : '开始投屏' }}」；开始后请在 Chrome 弹窗里选<b>整个屏幕</b>
        </span>
      </div>
      <p class="dim" style="margin:10px 0 0">
        本页只放档位与状态。投屏由教师端常驻：切页面、翻讲义、去点名都不会断；
        停止共享（或点左侧栏的停止）后学生端自动回到占位页。
      </p>
    </section>

    <section class="card">
      <CardHead>
        <template #title>档位</template>
        <template #meta><span class="dim">随时可改，不用重新开播</span></template>
      </CardHead>
      <div class="row">
        <label class="field">采集尺寸
          <select class="select" :value="resKey" @change="onRes">
            <option value="screen">跟随设备屏幕（{{ win.screenW }}×{{ win.screenH }}）</option>
            <option value="viewport">跟随当前窗口（{{ win.w }}×{{ win.h }}）</option>
            <option value="1600x900">固定 1600×900</option>
            <option value="1280x720">固定 1280×720</option>
            <option value="1024x768">固定 1024×768</option>
          </select>
        </label>
        <label class="field">帧率
          <select class="select" :value="cfg.fps" @change="onFps">
            <option :value="8">8 fps</option>
            <option :value="12">12 fps</option>
            <option :value="15">15 fps</option>
          </select>
        </label>
        <label class="field">质量
          <select class="select" :value="cfg.quality" @change="cfg.quality = Number($event.target.value)">
            <option :value="0.7">q70（省带宽）</option>
            <option :value="0.8">q80</option>
            <option :value="0.85">q85（文字更锐）</option>
          </select>
        </label>
        <label class="field">模式
          <select class="select" :value="cfg.mode" @change="onMode">
            <option value="diff">差量（推荐）</option>
            <option value="full">整屏（仅小班）</option>
          </select>
        </label>
      </div>
      <p class="dim" style="margin:10px 0 0">
        默认即最高档：跟随设备屏幕 · 15fps · q85。判断标准：单台上行持续超过 0.8 Mbps 就降帧率或质量；
        整屏模式单台约 3–10 Mbps，只适合 10 台以内。
      </p>
      <p v-if="s.running" class="dim" style="margin:6px 0 0">
        实际采集 {{ s.capW }}×{{ s.capH }}
        <span v-if="cfg.resMode === 'viewport'">（窗口尺寸变化会自动跟随）</span>
      </p>
    </section>

    <section class="card">
      <CardHead>
        <template #title>实时状态</template>
        <template #meta><span class="dim">每秒刷新</span></template>
      </CardHead>
      <div class="metrics">
        <div class="metric"><span>在线学生</span><b>{{ s.peers }}</b></div>
        <div class="metric"><span>实际帧率</span><b>{{ s.fps }}<i>fps</i></b></div>
        <div class="metric"><span>单帧耗时</span><b>{{ s.cost }}<i>ms</i></b></div>
        <div class="metric"><span>单台上行</span><b>{{ s.perMbps.toFixed(2) }}<i>Mbps</i></b></div>
        <div class="metric"><span>合计上行</span><b>{{ s.allMbps.toFixed(2) }}<i>Mbps</i></b></div>
        <div class="metric"><span>跳帧 / 变化块</span><b>{{ s.drops }} / {{ s.blocks }}</b></div>
      </div>
      <p v-if="s.msg" class="hint" :class="s.msgType === 'err' ? 'err' : s.msgType === 'ok' ? '' : 'warn'" style="margin-top:12px">
        {{ s.msg }}
      </p>
      <p v-if="s.lastStudentAt" class="dim" style="margin:8px 0 0">最近一次学生接入：{{ s.lastStudentAt }}</p>
      <p v-if="s.running && s.hidden" class="hint warn" style="margin-top:10px">
        本页已被最小化或被其他窗口完全遮挡。投屏仍在继续（推送节奏已放进 Worker 定时器），
        但若发现画面变卡，请让本窗口保持可见（缩小放在屏幕一角即可）。
      </p>
    </section>

    <section class="card">
      <CardHead>
        <template #title>学生端地址</template>
        <template #meta><span class="dim">学生机打开这一个地址即可，无需安装</span></template>
      </CardHead>
      <div class="row" v-for="u in watchUrls" :key="u">
        <code class="url">{{ u }}</code>
        <button class="btn mini" @click="copy(u)">复制</button>
      </div>
      <p class="dim" style="margin:10px 0 0">
        kiosk 全屏写法：<code>chrome.exe --kiosk {{ watchUrls[0] }} --user-data-dir=C:\labcast\profile</code>；
        把 <code>--kiosk</code> 换成 <code>--start-fullscreen</code> 可以保留退出全屏的退路。
      </p>
    </section>

    <section class="card">
      <CardHead>
        <template #title>账号安全</template>
        <template #meta><span class="dim">改完立刻生效，不用重启服务</span></template>
      </CardHead>
      <div class="row">
        <label class="field">当前口令
          <input v-model="pwd.old" type="password" class="input" autocomplete="current-password" placeholder="现在的教师口令" />
        </label>
        <label class="field">新口令
          <input v-model="pwd.next" type="password" class="input" autocomplete="new-password" placeholder="至少 6 位" />
        </label>
        <label class="field">再输一次
          <input v-model="pwd.again" type="password" class="input" autocomplete="new-password" placeholder="确认新口令" />
        </label>
        <button class="btn" :disabled="pwd.busy" @click="savePwd">{{ pwd.busy ? '提交中…' : '修改口令' }}</button>
      </div>
      <p v-if="pwd.msg" class="dim" :style="{ margin: '10px 0 0', color: pwd.ok ? '' : '#c0392b' }">{{ pwd.msg }}</p>
      <p class="dim" style="margin:10px 0 0">
        口令存在 <code>data/config.json</code>（明文）。
        <b>已登录的设备不会立即掉线</b> —— 令牌是 JWT，跟口令无关，最多再保持 {{ pwd.tokenHours }} 小时；
        要立刻让所有设备重登，需更换 config.json 里的 <code>secret</code>。
      </p>
    </section>
  </PageShell>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive } from 'vue'
// 共用同一份实例：推流由教师端布局持有，本页只读状态、调档位
import { cast } from '../../utils/screencast'
import { state as globalState } from '../../store'
import { api } from '../../api'
import PageHead from '../../components/PageHead.vue'
import CardHead from '../../components/CardHead.vue'
import PageShell from '../../components/PageShell.vue'

const { s, cfg } = cast

// 投屏是教师权限，不按地址设卡；只有 http + 非 localhost 的源会被浏览器收走屏幕接口，
// 那种情况只提示「怎么把接口拿回来」，不禁用任何东西。
const insecureOrigin = !window.isSecureContext
// 只读一份给模板用；别叫 location，会把全局 window.location 遮蔽掉
const here = { host: window.location.host, port: window.location.port }

// 选项文字里要显示实时的屏幕/窗口尺寸，只用于展示
const win = reactive({
  screenW: window.screen.width,
  screenH: window.screen.height,
  w: window.innerWidth,
  h: window.innerHeight,
})

function syncWin() {
  win.screenW = window.screen.width
  win.screenH = window.screen.height
  win.w = window.innerWidth
  win.h = window.innerHeight
}

onMounted(() => window.addEventListener('resize', syncWin))
onUnmounted(() => window.removeEventListener('resize', syncWin))

const resKey = computed(() => (cfg.resMode === 'manual' ? cfg.maxW + 'x' + cfg.maxH : cfg.resMode))

const watchUrls = computed(() => {
  const lan = (globalState.cast && globalState.cast.lan) || []
  const port = location.port || '80'
  if (!lan.length) return [location.protocol + '//' + location.host + '/watch']
  return lan.map((ip) => 'http://' + ip + ':' + port + '/watch')
})

function onRes(e) {
  const v = e.target.value
  if (v === 'screen' || v === 'viewport') {
    cast.applyResMode(v)
    return
  }
  const [w, h] = v.split('x').map(Number)
  cast.applyResolution(w, h)
}

function onFps(e) {
  cast.applyFps(Number(e.target.value))
}

function onMode(e) {
  cfg.mode = e.target.value
  cast.requestKey()
  s.msg = cfg.mode === 'full' ? '整屏模式：每帧推整幅画面，只适合 10 台以内。' : '已切回差量模式。'
  s.msgType = cfg.mode === 'full' ? 'err' : 'ok'
}

function copy(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => {
        s.msg = '已复制：' + text
        s.msgType = 'ok'
      },
      () => alert(text)
    )
  } else {
    alert(text)
  }
}

/* ---------------- 账号安全：改教师口令 ---------------- */
const pwd = reactive({ old: '', next: '', again: '', busy: false, msg: '', ok: true, tokenHours: 12 })

async function savePwd() {
  if (pwd.busy) return
  pwd.msg = ''
  pwd.ok = true
  if (!pwd.old) {
    pwd.ok = false
    pwd.msg = '请先填当前口令'
    return
  }
  if (pwd.next.length < 6) {
    pwd.ok = false
    pwd.msg = '新口令至少 6 位'
    return
  }
  if (pwd.next !== pwd.again) {
    pwd.ok = false
    pwd.msg = '两次输入的新口令不一致'
    return
  }
  pwd.busy = true
  try {
    const j = await api.post('/api/auth/password', { oldPassword: pwd.old, newPassword: pwd.next })
    pwd.ok = true
    pwd.msg = '口令已修改 —— 下次登录请用新口令。'
    if (j && j.tokenHours) pwd.tokenHours = j.tokenHours
    pwd.old = ''
    pwd.next = ''
    pwd.again = ''
  } catch (e) {
    pwd.ok = false
    pwd.msg = (e && e.message) || '修改失败，请重试'
  } finally {
    pwd.busy = false
  }
}
</script>

<style scoped>
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}

.metric {
  background: #f7f8fc;
  border-radius: 4px;
  padding: 10px 13px;
}

.metric span {
  display: block;
  font-size: 12px;
  color: var(--dim);
}

.metric b {
  font-size: 21px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--brand-ink);
}

.metric i {
  font-style: normal;
  font-size: 12px;
  color: var(--dim);
  margin-left: 3px;
}

.url {
  flex: 1;
  min-width: 240px;
  padding: 7px 11px;
  background: #f4f6fb;
  border-radius: 8px;
  font-family: Consolas, monospace;
  font-size: 13px;
  color: #334155;
  overflow: auto;
  white-space: nowrap;
}

code {
  font-family: Consolas, monospace;
  background: #f1f4f9;
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 12.5px;
}
</style>
