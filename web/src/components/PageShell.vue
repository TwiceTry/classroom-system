<template>
  <!--
    页面外壳：所有页面都是「头部 + 内容区」这两段，
       · head 槽位放 <PageHead>
       · 默认槽位是内容区，自动套上 .content（内边距 / 最大宽度 / 滚动条留白都在那一处定义）
       · bodyClass 用来加修饰类，比如 <PageShell body-class="split">（左右分栏那种）
         要自己管滚动的页面（编辑器工作台）不要用它。
         -->
         <div class="page">
           <slot name="head" />
           <div class="content" :class="bodyClass">
             <slot />
           </div>
         </div>
         </template>

         <script setup>
         defineProps({
         /* 内容区的附加 class（"split" / 数组 / 对象都行） */
         bodyClass: { type: [String, Array, Object], default: '' },
         })
         </script>
