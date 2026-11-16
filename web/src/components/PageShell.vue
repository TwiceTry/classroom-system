<template>
  <!--
    页面外壳：所有页面都是「头部 + 内容区」。

    ── 两种内容布局 ─────────────────────────────────────
    ① 单栏（默认，各页现在的写法）
         <PageShell><div>…</div></PageShell>
       内容区自己滚（.content { overflow: auto }）。

    ② 三栏工作区（body-class="ws"）
         <PageShell body-class="ws">
           <template #left>  目录 / 文件列表 / 菜单      </template>
           <div>             正文（默认槽）              </div>
           <template #right> 状态 / 历史记录             </template>
           <template #foot>  其他信息                    </template>
         </PageShell>

       布局：
         ┌──────────────────────────────────────┐
         │ 页头                                  │
         ├──────┬──────────────────┬────────────┤
         │ 左    │ 中（必须）        │ 右（可选） │
         │ 目录  │ 正文              │ 状态/历史  │
         ├──────┴──────────────────┴────────────┤
         │ 脚（可选）                             │
         └──────────────────────────────────────┘

       **三块各自滚动**：中栏是主内容，长；左右两栏高度跟着内容区，
       内部溢出自己滚，不跟着中栏一起滚 —— 目录要一直看得见，
       否则滚到第 20 段时想换一节还得先滚回顶。

       列宽用 CSS 变量，页面可以覆盖：
         .content.ws { --ws-left: 260px; --ws-right: 300px; }

       左右栏都可以不给（只给 #right 就是「正文 + 右侧信息」两栏）。
  -->
  <div class="page">
    <slot name="head" />
    <div
      class="content"
      :class="[
        bodyClass,
        {
          'has-left': !!$slots.left,
          'has-right': !!$slots.right,
          'has-foot': !!$slots.foot,
        },
      ]"
    >
      <aside v-if="$slots.left" class="ws-left"><slot name="left" /></aside>
      <section class="ws-main"><slot /></section>
      <aside v-if="$slots.right" class="ws-right"><slot name="right" /></aside>
      <footer v-if="$slots.foot" class="ws-foot"><slot name="foot" /></footer>
    </div>
  </div>
</template>

<script setup>
defineProps({
  /* 内容区的附加 class（"split" / "fit" / "ws" / 数组 / 对象都行） */
  bodyClass: { type: [String, Array, Object], default: '' },
})
</script>
