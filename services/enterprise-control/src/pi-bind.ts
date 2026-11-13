import { SQL } from 'bun'
import { loadControlConfig } from './config'
import { PiAuthenticator } from './pi-auth'
import { ControlStore } from './store'

try {
  const [login, subject, ...extra] = Bun.argv.slice(2)
  if (!login || !subject || extra.length) throw new Error('Invalid arguments')
  const config = loadControlConfig(Bun.env)
  if (!config.piAuth) throw new Error('Pi identity is not configured')
  const token = (await Bun.stdin.text()).replace(/\r?\n$/u, '')
  const database = new SQL(config.databaseUrl)
  try {
    const store = new ControlStore(database, new PiAuthenticator(config.piAuth))
    const result = await store.bindPiUser({ kind: 'token', value: token }, { login, subject })
    console.log(result.changed ? '原工作台身份已绑定。' : '该身份已经绑定。')
  } finally { await database.close() }
} catch {
  console.error('身份绑定失败。请核对管理员口令、工作台身份、已有账号和企业服务配置。')
  process.exitCode = 1
}
