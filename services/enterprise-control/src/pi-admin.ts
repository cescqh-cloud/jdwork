import { SQL } from 'bun'
import { loadControlConfig } from './config'
import { PiAuthenticator } from './pi-auth'
import { ControlStore } from './store'

try {
  const [tenantName, login, displayName, ...extra] = Bun.argv.slice(2)
  if (!tenantName || !login || !displayName || extra.length) throw new Error('Invalid arguments')
  const config = loadControlConfig(Bun.env)
  if (!config.piAuth) throw new Error('Pi identity is not configured')
  const token = (await Bun.stdin.text()).replace(/\r?\n$/u, '')
  const database = new SQL(config.databaseUrl)
  try {
    const store = new ControlStore(database, new PiAuthenticator(config.piAuth))
    await store.bindPiAdministrator({ kind: 'token', value: token }, { tenantName, login, displayName })
    console.log('原工作台管理员身份已绑定。')
  } finally { await database.close() }
} catch {
  console.error('管理员绑定失败。请核对原工作台口令、组织、已有账户角色及企业服务配置。')
  process.exitCode = 1
}
