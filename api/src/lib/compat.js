/*
 * compat.js —— 浏览器兼容性兜底：最低版本 + 绿色版 Chrome 的分发
 *
 * 为什么在服务端：兜底页出现在**登录之前**，也出现在浏览器连框架都跑不起来的时候，
 * 所以「有没有本地绿色版、下载地址是什么、找不到时找谁」这些信息不能写死在前端，
 * 得由服务器说了算（换机器、换机房的部署方式不一样）。
 *
 * 绿色版放哪儿：`downloads/`（跟系统一起拷到机房，离线可用）。
 *   · 认 `chrome109.zip` / `.7z` / `.exe` 这种固定名
 *   · 也认带版本号的便携版原名，比如 `Chrome-109.0.5414.168-x64-1.15.2-Win7.exe`——
 *     这是那个便携包自己的命名（名字里的 Win7 是打包者的说法，不代表系统还支持 Win7），
 *     老师手里那份就是这个名字，不用为了放进来改名
 * 没有本地文件时，可以用 `web/public/compat.json` 的 `downloadUrl` 指向内网共享；
 * 两样都没有就只显示 `contact`（向任课老师索取）。
 */

/** 固定文件名（优先级最高） */

import fs from 'fs'
import path from 'path'
import { config } from '../config.js'

/*
 * 应用根目录（仓库根）。
 *
 * 这里原本写的是 `config.appDir` —— 但 config 里**没有这个字段**
 * （只有 dataDir / uploadDir / webDist / courseDir）。
 * `path.join(undefined, 'downloads')` 会直接抛 ERR_INVALID_ARG_TYPE，
 * 于是 findBundle() 一调就崩、readCfg() 也在构造候选路径时崩，
 * 整个 /api/compat 和绿色版下载都拿不到东西。
 * 用 dataDir 的上一级推——它就是应用根。
 */
const APP_DIR = path.dirname(config.dataDir)

const BUNDLE_NAMES = ['chrome109.zip', 'chrome109.7z', 'chrome109.exe']
/** 带版本号的便携版：Chrome-109.0.5414.168-x64-1.15.2-Win7.exe */
const BUNDLE_RE = /^chrome[-_ ]?109[\w.\-]*\.(exe|zip|7z)$/i

function readCfg() {
  const cands = [
    path.join(APP_DIR, 'web', 'dist', 'compat.json'),
    path.join(APP_DIR, 'web', 'public', 'compat.json'),
  ]
  for (const f of cands) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'))
    } catch (e) {
      /* 换下一个 */
    }
  }
  return { minChrome: 109 }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch (e) {
    return false
  }
}

/** 找到绿色版文件（绝对路径；找不到返回 ''） */
function findBundle() {
  const dir = path.join(APP_DIR, 'downloads')
  for (const name of BUNDLE_NAMES) {
    const f = path.join(dir, name)
    if (isFile(f)) return f
  }
  let list = []
  try {
    list = fs.readdirSync(dir)
  } catch (e) {
    return ''
  }
  for (const name of list) {
    if (BUNDLE_RE.test(name) && isFile(path.join(dir, name))) return path.join(dir, name)
  }
  return ''
}

/** exe / zip / 7z → 类型 + 「下完怎么用」 */
function kindOf(file) {
  const ext = path.extname(file || '').toLowerCase()
  if (ext === '.zip') return { kind: 'zip', tip: '下载后解压到任意目录，双击 chrome.exe 打开本系统即可；不需要安装，也不影响原有的浏览器。' }
  if (ext === '.7z') return { kind: '7z', tip: '下载后用 7-Zip 解压到任意目录，双击 chrome.exe 打开本系统即可；不需要安装。' }
  return { kind: 'exe', tip: '下载后双击运行即可（绿色便携版：不写系统目录、不改默认浏览器、不影响原有的浏览器）。' }
}

/** 给 /api/compat 用的整包信息 */
function info() {
  const cfg = readCfg()
  const bundle = findBundle()
  const url = String(cfg.downloadUrl || '').trim()
  const meta = kindOf(bundle)
  return {
    minChrome: Number(cfg.minChrome) || 109,
    available: !!bundle,
    filename: bundle ? path.basename(bundle) : '',
    sizeMB: bundle ? Math.round(fs.statSync(bundle).size / 1024 / 1024) : 0,
    kind: bundle ? meta.kind : '',
    tip: bundle ? meta.tip : '',
    downloadUrl: url || (bundle ? '/download/chrome109' : ''),
    contact: cfg.contact || '请向任课老师索取 Chrome 109 绿色版（解压即用，不需要安装）',
  }
}

export { readCfg, findBundle, info, kindOf, BUNDLE_NAMES, BUNDLE_RE }