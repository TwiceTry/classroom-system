/*
 * lib/fsutil.js —— 文件系统小工具
 *
 * 为什么不用 fs.cpSync：
 *   在 Windows + Node 22.22.3 上，复制一个「58 个目录 / 240 个文件」的课程内容目录，
 *   fs.cpSync 会让整个进程直接退出，退出码 0xC0000409（STATUS_STACK_BUFFER_OVERRUN），
 *   stderr 一个字都没有 —— 表现就是「点了『复制课程』，服务没了」。
 *
 *   这不是我们的逻辑问题，是 cpSync 在这个平台上把栈搞爆了。
 *   自己用 readdir + copyFileSync 递归一遍就能稳定work，目录再深也不怕。
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 递归复制目录（同步）。
 *   · 目标目录不存在会自动创建
 *   · 只复制普通文件，跳过符号链接/设备文件（避免跟着链接绕进环里）
 *   · 返回复制的文件数
 */
export function copyDir(from, to, opts) {
  const options = opts || {}
  const maxFiles = Number(options.maxFiles || 50000) // 兜底，防止意外复制海量文件
  let count = 0

  const walk = (src, dst) => {
    let items = []
    try {
      items = fs.readdirSync(src, { withFileTypes: true })
    } catch (e) {
      return
    }
    fs.mkdirSync(dst, { recursive: true })
    for (const it of items) {
      if (count >= maxFiles) return
      const s = path.join(src, it.name)
      const d = path.join(dst, it.name)
      if (it.isDirectory()) {
        walk(s, d)
      } else if (it.isFile()) {
        try {
          fs.copyFileSync(s, d)
          count++
        } catch (e) {
          /* 单个文件失败不该让整次复制失败 */
        }
      }
      // 符号链接 / 设备文件：跳过
    }
  }

  if (!fs.existsSync(from)) return 0
  walk(from, to)
  return count
}

/** 删目录（不存在也不报错） */
export function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch (e) {
    return false
  }
}
