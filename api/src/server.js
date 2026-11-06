#!/usr/bin/env node
/*
 * server.js —— 启动
 */
import { buildApp } from './app.js'
import { config } from './config.js'
import { dbPath } from './db/index.js'
import { closeDb, setEventHook } from './lib/repo.js'
import { schedule as scheduleSheet } from './lib/scoresheet.js'

/*
 * 记分记录一变，就把该学生目录下的分数表（总评/明细/机试/证据清单）刷一次。
 *
 * 这是派生数据（真源在数据库里），所以 fire-and-forget：
 * 不阻塞给分响应，失败只记日志。scoresheet.schedule 里有 300ms 去抖，
 * 点名一次改 60 人不会写 240 次文件。
 */
setEventHook((classId, sid) => scheduleSheet(classId, sid))

const app = await buildApp()

try {
  await app.listen({ port: config.port, host: config.host })
  app.log.info('api listening on ' + config.host + ':' + config.port)
  console.log('')
  console.log('  课堂系统 · API（Fastify + SQLite）')
  console.log('  监听：' + config.host + ':' + config.port)
  console.log('  数据库：' + dbPath())
  console.log('  健康检查：http://127.0.0.1:' + config.port + '/api/health')
  if (config.passwordIsDefault) console.log('  注意：教师口令还是默认的 teacher，记得改（data/config.json 的 teacherPassword）')
  console.log('')
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\n收到 ' + sig + '，收尾退出…')
    try {
      await app.close()
      closeDb()
    } catch (e) {
      /* ignore */
    }
    process.exit(0)
  })
}
