// 示例脚本：改这里 → 刷新页面就能看到变化
// 讲义里讲到的每个知识点，这里都应该有一段能跑起来的对照代码

const btn = document.getElementById('btn')
const out = document.getElementById('out')
let n = 0

btn.addEventListener('click', () => {
  n++
  out.textContent = '点了 ' + n + ' 次'
})
