import { SQL } from 'bun'
import { z } from 'zod'
import { loadControlConfig } from './config'
import { userInput } from './contract'
import { ControlStore } from './store'

try {
  const args = Bun.argv.slice(2)
  const sso = args[0] === '--sso'
  const [tenant, tenantName, login, displayName, ...roles] = sso ? args.slice(1) : args
  const config = loadControlConfig(Bun.env)
  if (!sso && !config.localLogin) throw new Error('Local operator sign-in is disabled')
  const fields = { tenant, login, displayName, roles }
  const name = z.string().trim().min(1).max(120).parse(tenantName)
  const database = new SQL(config.databaseUrl)
  try {
    const store = new ControlStore(database)
    // Local development passwords are read from standard input.
    const id = sso ? await store.createExternalUser(name, userInput.omit({ password: true }).parse(fields))
      : await store.createLocalUser(name, userInput.parse({ ...fields, password: (await Bun.stdin.text()).replace(/\r?\n$/u, '') }))
    console.log(`Created user ${id}`)
  } finally { await database.close() }
} catch {
  console.error('Could not create the user. Use [--sso] <tenant-code> <tenant-name> <login> <display-name> <role> [...roles]. Local development passwords are read from stdin.')
  process.exitCode = 1
}
