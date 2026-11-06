<template>
  <!--
    导入窗口的**外壳**：标题 / 说明 / 选文件 / 下载模板 / 错误 / 底部按钮。
    「报告长什么样」「选中后写什么」由各页面通过 slot 自己决定 ——
    课程包、内容目录、方案三处的报告结构完全不同，强行统一只会变成一堆 v-if。

    这套外壳解决的是另一类重复：
      · 空态文案 + 「⤒ 选择文件」「⤓ 没有包？下载空模板」的位置和顺序
      · 错误提示（单条 + 多条列表）
      · 底部「取消 / 确认」与禁用条件
      · 隐藏的 <input type=file>（每处各写一个很容易漏 accept 或漏重置 value）

    模板按钮只在传了 templateLabel 时出现，并且总在「选择文件」旁边 ——
    这是上次定的规矩：模板属于导入流程，不该出现在页头当独立功能。
  -->
  <Teleport to="body">
    <div v-if="modelValue" class="mask" @click.self="close">
      <div class="modal" :class="{ wide }">
        <div class="modal-head">
          <!-- 标题带上文件名：选中之后要能一眼确认「我在导哪个包」 -->
          <h3>{{ fileName ? title + '：' + fileName : title }}</h3>
          <button class="btn mini" style="margin-left: auto" @click="close">关闭</button>
        </div>

        <div class="modal-body form">
          <slot name="error">
            <p v-if="error" class="hint err">{{ error }}</p>
            <ul v-if="errors && errors.length" class="imp-errs">
              <li v-for="e in errors.slice(0, 12)" :key="e">{{ e }}</li>
              <li v-if="errors.length > 12" class="dim">…另有 {{ errors.length - 12 }} 条</li>
            </ul>
          </slot>

          <!-- 还没选文件：说清要交什么，模板就在旁边的按钮上 -->
          <template v-if="!hasReport">
            <slot name="hint">
              <p class="dim mini" style="margin-top: 0">{{ hint }}</p>
            </slot>
            <div class="row" style="margin-bottom: 10px">
              <button class="btn mini primary" :disabled="busy" @click="pickFile">{{ pickText }}</button>
              <button
                v-if="templateLabel"
                class="btn mini"
                :disabled="busy || templateDisabled"
                @click="$emit('template')"
              >
                {{ templateLabel }}
              </button>
            </div>
            <p v-if="templateHint" class="dim mini" style="margin-bottom: 0">{{ templateHint }}</p>
          </template>

          <!-- 上传进度（课程包那种大文件用得上） -->
          <slot name="progress"></slot>

          <!-- 报告：各页面自己的形状 -->
          <slot v-if="hasReport" name="report"></slot>
        </div>

        <div class="modal-foot">
          <span v-if="footHint" class="dim mini">{{ footHint }}</span>
          <span class="spacer"></span>
          <!--
            默认是「取消 + 确认导入」。
            课程包导入有三种策略（另建一份 / 整体替换 / 按此导入），
            它用 #actions 覆盖这里，外壳其余部分照样复用。
          -->
          <slot name="actions">
            <button class="btn" @click="close">取消</button>
            <button class="btn primary" :disabled="confirmDisabled || busy" @click="$emit('confirm')">
              {{ confirmText }}
            </button>
          </slot>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 放在 Teleport 外面：开关弹窗时不重建，选中同一个文件也能再次触发 change -->
  <input ref="fileEl" type="file" :accept="accept" style="display: none" @change="onFile" />
</template>

<script setup>
import { ref } from 'vue'

defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '导入' },
  /** 选中文件名：非空时标题会自动变成「导入 xx：文件名」 */
  fileName: { type: String, default: '' },
  /** 空态说明（用 #hint 插槽可以放更长的说明） */
  hint: { type: String, default: '' },
  accept: { type: String, default: '.zip' },
  busy: { type: Boolean, default: false },
  /** 单条错误 */
  error: { type: String, default: '' },
  /** 多条错误（课程包那种逐条列的） */
  errors: { type: Array, default: () => [] },
  /** 有没有报告：false = 空态，true = 显示 #report */
  hasReport: { type: Boolean, default: false },
  pickText: { type: String, default: '⤒ 选择文件' },
  /** 传了才显示模板按钮 */
  templateLabel: { type: String, default: '' },
  templateHint: { type: String, default: '' },
  templateDisabled: { type: Boolean, default: false },
  confirmText: { type: String, default: '确认导入' },
  confirmDisabled: { type: Boolean, default: false },
  footHint: { type: String, default: '' },
  wide: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'close', 'pick', 'template', 'confirm'])

const fileEl = ref(null)

function close() {
  emit('update:modelValue', false)
  emit('close')
}

function pickFile() {
  if (fileEl.value) fileEl.value.value = ''
  fileEl.value && fileEl.value.click()
}

function onFile(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (f) emit('pick', f)
}
</script>

<style scoped>
/* 多条错误清单（以前课程包弹窗里那份，别人没有就自己带一份，不依赖页面样式） */
.imp-errs {
  margin: 0 0 10px;
  padding-left: 18px;
  max-height: 160px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  color: #b91c1c;
}
</style>
