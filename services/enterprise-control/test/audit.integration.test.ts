import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { migrate } from '../src/migrate'
import { startControlRuntime } from '../src/runtime'

const databaseUrl = Bun.env.ENTERPRISE_TEST_DATABASE_URL
const redisUrl = Bun.env.ENTERPRISE_TEST_REDIS_URL
const integration = databaseUrl && redisUrl ? test : test.skip
const origin = 'http://127.0.0.1:8787'
const api = '/api/v1/admin/audit'
const date = '2001-02-03'
const range = `from=${date}&to=${date}`

integration('authorizes metadata-only audit by role and tenant, paginates precisely, and records CSV exports', async () => {
  const address = new URL(databaseUrl!)
  if (address.hostname !== '127.0.0.1' || !address.pathname.endsWith('_test') || !['postgres:', 'postgresql:'].includes(address.protocol) ||
      new URL(redisUrl!).hostname !== '127.0.0.1') throw new Error('Audit integration requires disposable loopback services')
  const sql = new SQL(databaseUrl!)
  const slug = `audit-fixture-${randomUUID().slice(0, 8)}`
  const password = 'audit-fixture-password-only'
  let runtime: Awaited<ReturnType<typeof startControlRuntime>> | undefined
  try {
    await migrate(sql)
    runtime = await startControlRuntime({ origin, localLogin: true, databaseUrl: databaseUrl!, redisUrl: redisUrl!, host: '127.0.0.1', port: 0 })
    const auditor = await runtime.store.createLocalUser('Audit fixture', { tenant: slug, login: 'auditor', password, displayName: 'Fixture auditor', roles: ['auditor'] })
    const employee = await runtime.store.createLocalUser('Audit fixture', { tenant: slug, login: 'developer', password, displayName: 'Fixture developer', roles: ['developer'] })
    const foreign = await runtime.store.createLocalUser('Other fixture', { tenant: `${slug}-other`, login: 'admin', password, displayName: 'Foreign administrator', roles: ['platform_admin'] })
    const [org] = await sql<{ id: string }[]>`SELECT id FROM enterprise_tenants WHERE slug = ${slug}`
    const [other] = await sql<{ id: string }[]>`SELECT id FROM enterprise_tenants WHERE slug = ${`${slug}-other`}`
    const [first, second, queryId, otherId, hiddenId, hiddenTarget, projectId] = Array.from({ length: 7 }, () => randomUUID()) as [string, string, string, string, string, string, string]
    const marker = 'fixture-secret-must-not-be-in-export'
    await sql`INSERT INTO enterprise_audit (id, tenant_id, actor_id, action, target_id, occurred_at) VALUES
      (${first}, ${org!.id}, ${employee}, 'models.provider.saved', ${randomUUID()}, ${`${date}T06:20:00.123997Z`}::timestamptz),
      (${second}, ${org!.id}, ${employee}, 'demand.approval.changed', ${randomUUID()}, ${`${date}T06:20:00.123996Z`}::timestamptz),
      (${otherId}, ${other!.id}, ${foreign}, 'device.revoked', ${randomUUID()}, ${`${date}T06:20:00.123999Z`}::timestamptz),
      (${hiddenId}, ${org!.id}, ${employee}, ${marker}, ${hiddenTarget}, ${`${date}T03:30:00Z`}::timestamptz)`
    await sql`INSERT INTO enterprise_projects (id, tenant_id, name, classification) VALUES (${projectId}, ${org!.id}, ${marker}, 'restricted')`
    await sql`INSERT INTO enterprise_erp_activity (request_id, tenant_id, actor_id, project_id, environment_id, operation_key, outcome, returned_count, occurred_at)
      VALUES (${queryId}, ${org!.id}, ${employee}, ${projectId}, ${marker}, ${marker}, 'succeeded', 1, ${`${date}T05:20:00Z`}::timestamptz)`
    const store = runtime.store
    const base = runtime.server.url
    const login = (login: string, tenant = slug) => store.signIn({ tenant, login, password })
    const auditorToken = (await login('auditor')).accessToken
    const employeeToken = (await login('developer')).accessToken
    const foreignToken = (await login('admin', `${slug}-other`)).accessToken
    const challenge = await store.issueChallenge(await store.authenticate(auditorToken, false))
    const key = generateKeyPairSync('ed25519')
    const deviceId = randomUUID()
    const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
    const tuple = ['enterprise-enroll-v1', challenge.challenge, deviceId, publicKey, 'win32', '0.7.7']
    const { tokens } = await store.enroll({ challenge: challenge.challenge, deviceId, publicKey, platform: 'win32', clientVersion: '0.7.7',
      signature: sign(null, Buffer.from(JSON.stringify(tuple)), key.privateKey).toString('base64url') })
    const call = (path: string, token = auditorToken, init: RequestInit = {}) => fetch(new URL(path, base), { ...init, redirect: 'manual',
      signal: AbortSignal.timeout(6000), headers: { Authorization: `Bearer ${token}`, ...init.headers } })
    expect((await call(`${api}?${range}`, employeeToken)).status).toBe(403)
    expect((await call(`${api}?${range}`, tokens.accessToken)).status).toBe(401)
    const page = await call(`${api}?${range}&limit=1`)
    expect(page.status).toBe(200)
    const result = await page.json() as { entries: unknown[], nextCursor: string }
    expect(result.entries).toMatchObject([{ id: first, category: 'models', action: 'models.provider.saved', actorId: employee }])
    expect(result.nextCursor).toBeTruthy()
    expect(await (await call(`${api}?${range}&cursor=${result.nextCursor}`)).json()).toMatchObject({ entries: [
      { id: second, category: 'demands' }, { id: queryId, category: 'erp', action: 'erp.query.succeeded' }, { id: hiddenId, action: 'other.recorded' },
    ], nextCursor: null })
    expect((await call(`${api}?${range}&category=erp&cursor=${result.nextCursor}`)).status).toBe(400)
    expect((await call(`${api}?from=2000-01-01&to=${date}`)).status).toBe(400)
    expect((await call(`${api}?from=0000-01-01&to=0000-01-01`)).status).toBe(400)
    const otherList = await call(`${api}?${range}`, foreignToken)
    expect(await otherList.json()).toMatchObject({ entries: [{ id: otherId }], nextCursor: null })
    const view = await call(`/console/audit?${range}&category=erp`)
    expect(view.status).toBe(200)
    const html = await view.text()
    expect(html).toContain('金蝶查询成功')
    expect(html).not.toContain(marker)
    expect(await (await call('/')).text()).toContain('/console/audit')
    expect(await (await call('/', employeeToken)).text()).not.toContain('/console/audit')
    const form = new URLSearchParams({ from: date, to: date, category: 'erp' })
    expect((await fetch(new URL('/console/audit/export', base), { method: 'POST', body: form,
      headers: { Cookie: `enterprise-dev-session=${auditorToken}` }, signal: AbortSignal.timeout(5000) })).status).toBe(403)
    const csv = await call(`${api}/export`, auditorToken, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: date, to: date }) })
    expect(csv.status).toBe(200)
    expect(csv.headers.get('Content-Disposition')).toContain('attachment')
    expect(csv.headers.get('X-Audit-Export-Truncated')).toBe('false')
    const text = await csv.text()
    expect(text).toContain('erp.query.succeeded')
    expect(text).toContain('other.recorded')
    expect(text).not.toContain(marker)
    expect(text).not.toContain(otherId)
    const exports = await sql<{ actor_id: string }[]>`SELECT actor_id FROM enterprise_audit WHERE tenant_id = ${org!.id} AND action = 'audit.exported'`
    expect(exports.map(row => row.actor_id)).toEqual([auditor])
  } finally {
    await runtime?.close()
    await sql.close()
  }
}, 25_000)
