import { SQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { loadControlConfig } from '../config'
import { ControlError, loginName, tenantSlug } from '../contract'
import type { OidcConfig } from './config'
import { oidcSubject } from './login'

const bindingInput = z.strictObject({ tenant: tenantSlug, login: loginName, subject: oidcSubject })

export async function bindOidcIdentity(database: SQL, provider: Pick<OidcConfig, 'issuer'>, input: unknown) {
  const { tenant, login, subject } = bindingInput.parse(input)
  return database.begin(async sql => {
    const [user] = await sql<{ tenant_id: string, id: string }[]>`
      SELECT u.tenant_id, u.id FROM enterprise_users u JOIN enterprise_tenants t ON t.id = u.tenant_id
      WHERE t.slug = ${tenant} AND u.login = ${login} AND u.active AND t.active
      FOR SHARE OF u, t
    `
    if (!user) throw new ControlError(404, 'IDENTITY_USER_NOT_FOUND', '请先在该组织开通对应账号。')
    const [inserted] = await sql<{ user_id: string }[]>`
      INSERT INTO enterprise_external_identities (tenant_id, user_id, issuer, subject)
      VALUES (${user.tenant_id}, ${user.id}, ${provider.issuer}, ${subject})
      ON CONFLICT (tenant_id, issuer, subject) DO NOTHING RETURNING user_id
    `
    if (!inserted) {
      const [existing] = await sql<{ user_id: string }[]>`
        SELECT user_id FROM enterprise_external_identities
        WHERE tenant_id = ${user.tenant_id} AND issuer = ${provider.issuer} AND subject = ${subject}
      `
      if (existing?.user_id !== user.id) throw new ControlError(409, 'IDENTITY_BINDING_EXISTS', '此身份已绑定到该组织的其他账号。')
      return { userId: user.id, changed: false }
    }
    await sql`INSERT INTO enterprise_audit (id, tenant_id, action, target_id)
      VALUES (${randomUUID()}, ${user.tenant_id}, 'identity.bound', ${user.id})`
    return { userId: user.id, changed: true }
  })
}

if (import.meta.main) {
  try {
    const [tenant, login, subject, ...extra] = Bun.argv.slice(2)
    if (extra.length) throw new Error('Unexpected arguments')
    const { databaseUrl, oidc } = loadControlConfig(Bun.env)
    if (!oidc) throw new Error('OIDC is disabled')
    const database = new SQL(databaseUrl)
    try {
      const result = await bindOidcIdentity(database, oidc, { tenant, login, subject })
      console.log(result.changed ? '企业登录身份已预授权。' : '企业登录身份已绑定到该账号。')
    } finally { await database.close() }
  } catch (error) {
    console.error(error instanceof ControlError ? error.message : '绑定失败。请检查组织代码、内部登录名、身份服务的 sub 标识、服务配置和数据库迁移。')
    process.exitCode = 1
  }
}
