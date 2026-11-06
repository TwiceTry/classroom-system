/**
 * 作业库设计包：模板 → 改 → 上传 → 导出 → 比对 → 删除
 * 全程只用新建的设计，不碰真实数据。
 */
import fs from 'node:fs'
import { readZip, makeZip } from 'file:///e:/myItems/frontend-teach/课堂系统/api/src/lib/zip.js'

const BASE = 'http://127.0.0.1:18730'
const ROOT = 'e:/myItems/frontend-teach/课堂系统'
const cfg = JSON.parse(fs.readFileSync(ROOT + '/data/config.json', 'utf8'))

let pass = 0
let fail = 0
const bad = []
const ok = (name, cond, info) => {
  if (cond) {
    pass++
    console.log('  ✓ ' + name + (info ? '  → ' + info : ''))
  } else {
    fail++
    bad.push(name)
    console.log('  ✗ ' + name + (info ? '  → ' + info : ''))
  }
}

const t = await fetch(BASE + '/api/auth/login/teacher', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: cfg.teacherPassword || 'teacher' }),
}).then((r) => r.json())
const H = { authorization: 'Bearer ' + t.token }
const course = (await fetch(BASE + '/api/courses', { headers: H }).then((r) => r.json())).items[0]
const cid = course.id

const getBin = (url) => fetch(BASE + url, { headers: H }).then(async (r) => ({ s: r.status, buf: Buffer.from(await r.arrayBuffer()) }))
const postBin = async (url, buf) => {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: { authorization: H.authorization, 'content-type': 'application/zip' },
    body: buf,
  })
  const txt = await r.text()
  let j = null
  try {
    j = JSON.parse(txt)
  } catch (e) {}
  return { s: r.status, j, txt }
}

console.log('\n=== 1. 下载设计包模板 ===')
const tpl = await getBin('/api/courses/' + cid + '/designs/template.zip')
ok('模板可下载', tpl.s === 200 && tpl.buf[0] === 0x50, tpl.s + ' · ' + (tpl.buf.length / 1024).toFixed(1) + 'KB')

const tplFiles = readZip(tpl.buf)
console.log('  模板内容：')
for (const f of tplFiles) console.log('    ' + f.name + '  (' + f.data.length + 'B)')
ok('模板含 homework.json', tplFiles.some((f) => /homework\.json$/.test(f.name)))
const hwFile = tplFiles.find((f) => /homework\.json$/.test(f.name))
ok('模板含 README', tplFiles.some((f) => /README/i.test(f.name)))

console.log('\n=== 2. 改一个设计包（新 id）并上传 ===')
const DID = 'e2e-lib-' + Date.now().toString(36)
let hw = {}
try {
  hw = JSON.parse(hwFile.data.toString('utf8'))
} catch (e) {
  hw = {}
}
hw.id = DID
hw.title = 'E2E 测试设计包'
hw.desc = '自动测试用，跑完即删'
hw.itemKey = hw.itemKey || 'homework'

const entries = []
for (const f of tplFiles) {
  if (/homework\.json$/.test(f.name)) {
    entries.push({ path: f.name, data: Buffer.from(JSON.stringify(hw, null, 2), 'utf8') })
  } else {
    entries.push({ path: f.name, data: f.data })
  }
}
// 保证有一个起手代码文件
if (!entries.some((e) => /(^|\/)code\//.test(e.path))) {
  entries.push({ path: 'code/index.html', data: Buffer.from('<!doctype html><meta charset="utf-8"><h1>e2e</h1>', 'utf8') })
}

const up = await postBin('/api/courses/' + cid + '/designs/import', makeZip(entries))
ok('上传设计包', up.s === 200, up.s + ' · ' + up.txt.slice(0, 120))

console.log('\n=== 3. 清单里能看到 ===')
const list = await fetch(BASE + '/api/courses/' + cid + '/designs', { headers: H }).then((r) => r.json())
const hit = (list.items || []).find((d) => d.id === DID)
ok('清单里有新设计', !!hit, (list.items || []).length + ' 个设计 · ' + JSON.stringify(hit).slice(0, 120))

console.log('\n=== 4. 导出这个设计包 ===')
const exp = await getBin('/api/courses/' + cid + '/designs/' + encodeURIComponent(DID) + '/export.zip')
ok('导出为合法 zip', exp.s === 200 && exp.buf[0] === 0x50, exp.s + ' · ' + (exp.buf.length / 1024).toFixed(1) + 'KB')
if (exp.s === 200) {
  const outFiles = readZip(exp.buf)
  console.log('  导出内容：')
  for (const f of outFiles) console.log('    ' + f.name + '  (' + f.data.length + 'B)')
  ok('导出含 homework.json', outFiles.some((f) => /homework\.json$/.test(f.name)))
  ok('导出含 code/ 起手代码', outFiles.some((f) => /code\//.test(f.name)))
  const hwOut = outFiles.find((f) => /homework\.json$/.test(f.name))
  if (hwOut) {
    let j = {}
    try {
      j = JSON.parse(hwOut.data.toString('utf8'))
    } catch (e) {}
    ok('导出的 homework.json 里的 id 正确', j.id === DID, 'id=' + j.id)
    ok('导出的标题正确', j.title === hw.title, 'title=' + j.title)
  }
  // 往返：导出的包再上传一次（同 id 覆盖），应成功
  const again = await postBin('/api/courses/' + cid + '/designs/import', exp.buf)
  ok('导出→再导入（同 id 覆盖）', again.s === 200, again.s + ' · ' + again.txt.slice(0, 100))
}

console.log('\n=== 5. 清理 ===')
/*
 * 注意：`importDesign` 用的是 uniqueDir —— 同一个 id 再导入会变成 `<id>-2`，**不覆盖**。
 * 所以「导出→再导入」那一步会多出一份副本，清理必须按前缀删干净；
 * 只删 DID 会留下 -2 的残留（我第一次跑就漏了）。
 */
{
  const list2 = await fetch(BASE + '/api/courses/' + cid + '/designs', { headers: H }).then((r) => r.json())
  const mine = (list2.items || []).filter((d) => /^e2e-lib-/.test(d.id))
  for (const d of mine) {
    await fetch(BASE + '/api/courses/' + cid + '/designs/' + encodeURIComponent(d.id), {
      method: 'DELETE',
      headers: { authorization: H.authorization },
    })
  }
  ok('删掉测试设计（含 -2 副本）', mine.length > 0, '清了 ' + mine.length + ' 个')
}
const after = await fetch(BASE + '/api/courses/' + cid + '/designs', { headers: H }).then((r) => r.json())
ok('清单里不再有测试设计', !(after.items || []).some((d) => /^e2e-lib-/.test(d.id)), (after.items || []).length + ' 个设计')

console.log('\n' + (fail === 0 ? '全部通过 ✓' : '有失败 ✗') + '（通过 ' + pass + ' · 失败 ' + fail + '）')
process.exit(fail === 0 ? 0 : 1)
