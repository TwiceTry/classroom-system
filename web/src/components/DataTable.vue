<template>
  <!--
    统一表格：表头（可排序）/ 行 / 空状态，三处细节只写一遍
      · 列定义：{ key, label, hint?, width?, num?, sortable?, align? }
      · 单元格：默认取 row[key]（或 column.value(row)），要自定义就用 #cell-<key> 插槽
      · 行：rowKey 取 key，rowClass 可以给函数；clickable 让整行可点（配合 @row-click）
    用法：
      <DataTable :columns="cols" :rows="list" row-key="sid" clickable
                 :empty="'没有匹配的学生'" @row-click="open">
        <template #cell-status="{ row }"><span class="tag">{{ row.online ? '在线' : '离线' }}</span></template>
        <template #cell-actions="{ row }"><button class="btn mini" @click.stop="edit(row)">编辑</button></template>
      </DataTable>
  -->
  <div class="table-wrap" :style="maxHeight ? { maxHeight: maxHeight } : null">
    <table class="grid">
      <thead>
        <tr>
          <th
            v-for="c in columns"
            :key="c.key"
            :class="[c.num ? 'num' : '', c.sortable ? 'sortable' : '', sortKey === c.key ? 'on' : '', c.thClass || '']"
            :style="c.width ? { width: c.width } : null"
            @click="c.sortable ? $emit('sort', c.key) : null"
          >
            {{ c.label }}
            <i v-if="c.sortable" class="sortmark">{{ sortKey === c.key ? (sortDir === 'desc' ? '▼' : '▲') : '' }}</i>
            <em v-if="c.hint">{{ c.hint }}</em>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(row, i) in rows"
          :key="keyOf(row, i)"
          :class="[clickable ? 'clickable' : '', clsOf(row)]"
          @click="clickable ? $emit('row-click', row) : null"
        >
          <td v-for="c in columns" :key="c.key" :class="[c.num ? 'num' : '', tdClassOf(c, row)]">
            <!-- 优先用 #cell-<key>；没有就落到通用的 #cell（动态列用它）；再没有就取 row[key] -->
            <slot :name="'cell-' + c.key" :row="row" :index="i" :column="c">
              <slot name="cell" :row="row" :index="i" :column="c">{{ textOf(c, row) }}</slot>
            </slot>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length" class="empty">{{ empty }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
const props = defineProps({
  /** [{ key, label, hint?, width?, num?, sortable?, align?, value?, tdClass?, thClass? }] */
  columns: { type: Array, required: true },
  rows: { type: Array, default: () => [] },
  /** 行 key：字段名或函数 */
  rowKey: { type: [String, Function], default: 'id' },
  /** 排序状态（受控，由父组件维护） */
  sortKey: { type: String, default: '' },
  sortDir: { type: String, default: 'asc' },
  /** 空状态文案 */
  empty: { type: String, default: '没有数据' },
  /** 整行可点（鼠标变手 + @row-click） */
  clickable: { type: Boolean, default: false },
  /** 行 class：字符串 / 数组 / 对象 / (row) => 同上 */
  rowClass: { type: [String, Array, Object, Function], default: '' },
  /** 内容区最大高度，超出滚动（例如 "62vh"） */
  maxHeight: { type: String, default: '' },
})

defineEmits(['sort', 'row-click'])

const keyOf = (row, i) => {
  if (typeof props.rowKey === 'function') return props.rowKey(row, i)
  return row && row[props.rowKey] !== undefined ? row[props.rowKey] : i
}

const clsOf = (row) => (typeof props.rowClass === 'function' ? props.rowClass(row) : props.rowClass)

/** 单元格 class 也可以是函数（按行的值决定，比如 0 分显示成浅灰） */
const tdClassOf = (c, row) => (typeof c.tdClass === 'function' ? c.tdClass(row) : c.tdClass || '')

const textOf = (c, row) => {
  if (typeof c.value === 'function') {
    const v = c.value(row)
    return v === null || v === undefined || v === '' ? '—' : v
  }
  const v = row ? row[c.key] : ''
  return v === null || v === undefined || v === '' ? '—' : v
}
</script>
