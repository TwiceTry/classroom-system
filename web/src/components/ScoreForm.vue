<template>
  <div class="mask" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-head">
        <div style="min-width: 0">
          <h3>{{ item.name }} · {{ student.name }}</h3>
          <p class="dim" style="margin: 2px 0 0">{{ item.hint }}</p>
        </div>
        <button class="btn mini" style="margin-left: auto" @click="$emit('close')">关闭</button>
      </div>

      <div class="modal-body">
        <!-- 预设：一键填好最常见的几种情况 -->
        <div v-if="item.presets" class="presets">
          <button
            v-for="p in item.presets"
            :key="p.label"
            class="pill"
            :class="{ on: presetHit === p.label }"
            @click="applyPreset(p)"
          >
            {{ p.label }}<em v-if="deltaOfKind(p.kind)" class="pv">{{ deltaOfKind(p.kind) }}</em>
          </button>
        </div>

        <!-- 考勤 / 互动 / 加分：加减分 -->
        <div v-if="item.mode === 'base' || item.mode === 'acc'" class="row">
          <label class="field" style="flex: 1">
            <span>本次加减分</span>
            <input v-model.number="delta" type="number" step="1" class="input" />
          </label>
          <label v-if="item.key === 'attend'" class="field">
            <span>类型</span>
            <select v-model="kind" class="select">
              <option value="出勤">出勤</option>
              <option value="迟到">迟到</option>
              <option value="早退">早退</option>
              <option value="缺勤">缺勤</option>
              <option value="请假">请假</option>
            </select>
          </label>
        </div>

        <!-- 课堂作业：等级 + 迟交 -->
        <div v-if="item.mode === 'avg'">
          <label class="field" style="margin-bottom: 8px">
            <span>
              本次权重
              <em class="mini">默认 1；越大越吃重（评多次时按权重加权平均）</em>
            </span>
            <input v-model.number="weight" class="input" type="number" min="0.1" max="20" step="0.5" style="width: 120px" />
          </label>
          <div class="presets">
            <button
              v-for="g in item.grades"
              :key="g.key"
              class="pill"
              :class="{ on: grade === g.key }"
              @click="grade = g.key"
            >
              {{ g.name }}
            </button>
          </div>
          <label class="check">
            <input v-model="late" type="checkbox" />
            迟交（按 {{ item.lateFactor * 100 }}% 折算）
          </label>
        </div>

        <!-- 期末机试：卷面分 -->
        <div v-if="item.mode === 'raw'" class="row">
          <label class="field" style="flex: 1">
            <span>卷面分（0–{{ item.rawFull }}）</span>
            <input v-model.number="raw" type="number" min="0" :max="item.rawFull" class="input" />
          </label>
          <div class="calc">
            折算后 <b>{{ rawScore }}</b> / {{ item.full }}
          </div>
        </div>

        <!-- 大作业：量规逐项 -->
        <div v-if="item.mode === 'rubric'" class="rubric">
          <label v-for="d in item.dims" :key="d.key" class="field">
            <span>{{ d.name }}（满分 {{ d.full }}）</span>
            <input v-model.number="dims[d.key]" type="number" min="0" :max="d.full" class="input" />
          </label>
          <div class="calc rubric-total">
            合计 <b>{{ rubricTotal }}</b> / {{ item.full }}
          </div>
        </div>

        <label class="field" style="margin-top: 14px">
          <span>{{ item.reasonLabel }} <em class="req">必填</em></span>
          <textarea v-model="reason" class="textarea" rows="2" :placeholder="placeholder"></textarea>
        </label>

        <!-- 证据（可选）：作业截图、试卷、项目压缩包 -->
        <div v-if="item.key !== 'attend' && item.key !== 'interact' && item.key !== 'bonus'" class="evi">
          <div class="row">
            <b style="font-size: 13px">证据（可选）</b>
            <input ref="fileInput" type="file" style="display: none" @change="upload" />
            <button class="btn mini" :disabled="uploading" @click="fileInput.click()">
              {{ uploading ? '上传中…' : '上传文件' }}
            </button>
            <span class="dim">证据与这条记录绑定，学生端也能看到文件名</span>
          </div>
          <ul v-if="evidence.length" class="files">
            <li v-for="(f, i) in evidence" :key="f.url">
              <a :href="f.url" target="_blank" rel="noopener">{{ f.name }}</a>
              <button class="btn mini danger" @click="evidence.splice(i, 1)">移除</button>
            </li>
          </ul>
        </div>

        <p v-if="err" class="hint err" style="margin-top: 12px">{{ err }}</p>
        <p v-if="item.mode === 'base' && item.key === 'attend'" class="hint" style="margin-top: 12px">
          默认全勤 10 分，只记异常：缺勤 −2，迟到 / 早退 −1；缺勤满 3 次本项计 0（迟到早退 2 次折算 1 次）。
        </p>
      </div>

      <div class="modal-foot">
        <span class="dim">操作人：{{ operator }}</span>
        <span class="spacer"></span>
        <button class="btn ghost" @click="$emit('close')">取消</button>
        <button class="btn primary" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '记录这一笔' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { api } from '../api'

const props = defineProps({
  classId: { type: String, required: true },
  item: { type: Object, required: true },
  student: { type: Object, required: true },
  operator: { type: String, default: '教师' },
})
const emit = defineEmits(['close', 'done'])

const delta = ref(props.item.presets && props.item.presets.length ? props.item.presets[0].delta : 1)

/** 这次记的类型按方案该扣多少（缺勤 −perAbsent、迟到/早退 −perLate）—— 预设按钮上显示它 */
function deltaOfKind(k) {
  const p = (props.item.rule && props.item.rule.params) || {}
  if (!k) return 0
  const absent = (p.zeroRule && p.zeroRule.kind) || '缺勤'
  if (k === absent) return -(p.perAbsent === undefined ? 2 : Number(p.perAbsent) || 0)
  if (k === '迟到' || k === '早退') return -(p.perLate === undefined ? 1 : Number(p.perLate) || 0)
  return 0
}
const kind = ref('出勤')
const grade = ref('A')
const weight = ref(1)
const late = ref(false)
const raw = ref(80)
const dims = ref({})
const reason = ref('')
const evidence = ref([])
const err = ref('')
const busy = ref(false)
const uploading = ref(false)
const fileInput = ref(null)

for (const d of props.item.dims || []) dims.value[d.key] = 0

const presetHit = computed(() => {
  const hit = (props.item.presets || []).find((p) => p.delta === delta.value && (!p.kind || p.kind === kind.value))
  return hit ? hit.label : ''
})

const rawScore = computed(() => {
  const v = Number(raw.value) || 0
  return Math.round(v * (props.item.factor || 0) * 10) / 10
})

const rubricTotal = computed(() => {
  let s = 0
  for (const d of props.item.dims || []) s += Math.min(Number(dims.value[d.key]) || 0, d.full)
  return Math.round(s * 10) / 10
})

const placeholder = computed(() => {
  if (props.item.key === 'attend') return '如：第 5 周周一第 3 节，迟到 10 分钟'
  if (props.item.key === 'interact') return '如：答出 v-if 与 v-for 同元素时的优先级问题'
  if (props.item.key === 'homework') return '如：第 05 课 当堂练 · 温度转换器'
  if (props.item.key === 'exam') return '如：6 题合计 88 分'
  if (props.item.key === 'project') return '如：项目名 + 各维度扣分点'
  return '写清加分理由'
})

function applyPreset(p) {
  // 类型已知就按方案算（改了「缺勤一次扣几分」，这里立刻跟着变）
  delta.value = p.kind ? deltaOfKind(p.kind) : p.delta
  if (p.kind) kind.value = p.kind
}

async function upload(e) {
  const file = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!file) return
  if (file.size > 6 * 1024 * 1024) {
    err.value = '文件不能超过 6MB'
    return
  }
  uploading.value = true
  err.value = ''
  try {
    const dataUrl = await readAsDataURL(file)
    const res = await api.post('/api/teacher/upload', { name: file.name, dataUrl })
    evidence.value.push({ name: file.name, url: res.url })
  } catch (e2) {
    err.value = e2.message
  } finally {
    uploading.value = false
  }
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(new Error('读取文件失败'))
    fr.readAsDataURL(file)
  })
}

async function submit() {
  err.value = ''
  if (!String(reason.value).trim()) {
    err.value = '「' + props.item.reasonLabel + '」必填：每次加减分都要有原因'
    return
  }
  const payload = {
    sid: props.student.sid,
    item: props.item.key,
    reason: String(reason.value).trim(),
    evidence: evidence.value,
  }
  if (props.item.mode === 'base' || props.item.mode === 'acc') {
    if (props.item.mode === 'avg') payload.weight = Number(weight.value) || 1
  payload.delta = Number(delta.value)
    payload.kind = props.item.key === 'attend' ? kind.value : ''
    // 出勤 / 请假是 0 分但要留痕，所以带类型时允许；其余必须非零
    if (!payload.delta && !payload.kind) {
      err.value = '分值必须是非零数字'
      return
    }
  } else if (props.item.mode === 'avg') {
    payload.grade = grade.value
    payload.late = late.value
  } else if (props.item.mode === 'raw') {
    payload.raw = Number(raw.value)
  } else if (props.item.mode === 'rubric') {
    payload.dims = Object.assign({}, dims.value)
  }

  busy.value = true
  try {
    // 写操作由本组件自己发起：错误提示就在表单里，不用绕回父组件
    const res = await api.post('/api/classes/' + props.classId + '/events', payload)
    emit('done', res)
  } catch (e2) {
    err.value = e2.message
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
/* 预设按钮上的扣分（跟着方案里的「缺勤一次扣」走） */
.presets .pill .pv {
  margin-left: 4px;
  font-style: normal;
  font-size: 11px;
  opacity: 0.62;
  font-variant-numeric: tabular-nums;
}

.presets {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.check {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  color: #475569;
  margin-bottom: 6px;
}

.calc {
  font-size: 14px;
  color: var(--sub);
}

.calc b {
  color: var(--brand-ink);
  font-size: 19px;
}

.rubric {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}

.rubric-total {
  grid-column: 1 / -1;
}

.req {
  font-style: normal;
  padding: 0 6px;
  border-radius: 4px;
  background: #fee2e2;
  color: var(--err);
  font-size: 11.5px;
}

.evi {
  margin-top: 14px;
  padding: 11px 12px;
  border: 1px dashed #cbd5e1;
  border-radius: 4px;
  background: #fbfcff;
}

.files {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 13.5px;
}

.files li {
  display: flex;
  align-items: center;
  gap: 10px;
}
</style>
