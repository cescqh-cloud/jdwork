import { expect, test } from 'bun:test'
import { RedisClient, SQL } from 'bun'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { createControlApp } from '../src/app'
import { bindOidcIdentity } from '../src/identity/bind'
import { createOidcLogin, OIDC_CALLBACK_PATH, OIDC_START_PATH, redisOidcState } from '../src/identity'
import { migrate } from '../src/migrate'
import { ControlStore } from '../src/store'

const databaseUrl = Bun.env.ENTERPRISE_TEST_DATABASE_URL
const redisUrl = Bun.env.ENTERPRISE_TEST_REDIS_URL
const integration = databaseUrl && redisUrl ? test : test.skip
const unmappedIdentity = { status: 403, code: 'IDENTITY_NOT_MAPPED' }

function localTestUrl(value: string, protocol: string, disposableDatabase = false) {
  const url = new URL(value)
  if (url.hostname !== '127.0.0.1' || url.protocol !== protocol || (disposableDatabase && !url.pathname.endsWith('_test'))) {
    throw new Error('Identity integration requires a disposable loopback test instance.')
  }
  return value
}

async function signInThroughConsole(store: ControlStore, redis: RedisClient, identity: { tenant: string, issuer: string, subject: string }) {
  const origin = 'https://control.fixture.invalid'
  const config = {
    issuer: identity.issuer, clientId: 'enterprise-control', clientSecret: 'fixture-secret',
    authorizationEndpoint: 'https://identity.fixture.invalid/authorize',
    tokenEndpoint: 'https://identity.fixture.invalid/token',
    jwksUri: 'https://identity.fixture.invalid/jwks',
    redirectUri: origin + OIDC_CALLBACK_PATH,
    tokenAuthMethod: 'client_secret_basic',
  } as const
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = 'fixture-console-signer'
  let nonce: string | null = null
  const oidc = createOidcLogin(config, redisOidcState(redis), async url => {
    if (url === config.jwksUri) return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid }] })
    if (url !== config.tokenEndpoint || !nonce) return new Response(null, { status: 404 })
    const now = Math.floor(Date.now() / 1000)
    const claims = { iss: config.issuer, sub: identity.subject, aud: config.clientId, nonce, iat: now, exp: now + 180,
      roles: ['platform_admin'], email: 'other-employee@example.invalid' }
    const token = [{ alg: 'RS256', kid }, claims].map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')
    return Response.json({ id_token: token + '.' + sign('sha256', Buffer.from(token), privateKey).toString('base64url') })
  })
  const app = createControlApp(store, { origin, localLogin: false, oidc,
    async allowLoginAttempt() { return false }, notify() {}, async health() { return { redis: true } } })
  expect(await (await app.request(origin + '/')).text()).toContain(`action="${OIDC_START_PATH}"`)
  const start = await app.request(origin + OIDC_START_PATH, {
    method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ tenant: identity.tenant }),
  })
  expect(start.status).toBe(303)
  const providerUrl = new URL(start.headers.get('Location')!)
  nonce = providerUrl.searchParams.get('nonce')
  const query = new URLSearchParams({ state: providerUrl.searchParams.get('state')!, code: 'fixture-auth-code' })
  const flowCookie = start.headers.getSetCookie()[0]!.split(';', 1)[0]!
  const callback = origin + OIDC_CALLBACK_PATH + '?' + query.toString()
  const signedIn = await app.request(callback, { headers: { Cookie: flowCookie } })
  expect(signedIn.status).toBe(303)
  expect(signedIn.headers.get('Location')).toBe('/')
  const session = signedIn.headers.getSetCookie().find(cookie => cookie.startsWith('__Host-enterprise-session='))
  expect(session).toContain('HttpOnly')
  expect(session).toContain('Secure')
  expect((await app.request(callback, { headers: { Cookie: flowCookie } })).status).toBe(401)
  const headers = { Cookie: session!.split(';', 1)[0]! }
  return () => app.request(origin + '/api/v1/bootstrap', { headers })
}

integration('authenticates the console cookie only for an active account pre-authorized in the selected tenant', async () => {
  const sql = new SQL(localTestUrl(databaseUrl!, 'postgres:', true))
  const redis = new RedisClient(localTestUrl(redisUrl!, 'redis:'))
  const store = new ControlStore(sql)
  const suffix = randomUUID().slice(0, 12)
  const tenant = 'oidc-fixture-' + suffix
  const otherTenant = tenant + '-other'
  const tenantId = randomUUID()
  const otherTenantId = randomUUID()
  const userId = randomUUID()
  const otherUserId = randomUUID()
  const differentAccountId = randomUUID()
  const provider = { issuer: 'https://identity.fixture.invalid/' + suffix }
  const binding = { tenant, login: 'employee', subject: 'Employee-42' }
  const identity = { tenant, issuer: provider.issuer, subject: binding.subject }
  try {
    await migrate(sql)
    await migrate(sql)
    await redis.connect()
    await sql.begin(async trx => {
      await trx`INSERT INTO enterprise_tenants (id, slug, name) VALUES
        (${tenantId}, ${tenant}, 'OIDC fixture'), (${otherTenantId}, ${otherTenant}, 'OIDC fixture two')`
      await trx`INSERT INTO enterprise_users (tenant_id, id, login, display_name, roles) VALUES
        (${tenantId}, ${userId}, 'employee', 'Fixture Employee', ARRAY['developer']),
        (${tenantId}, ${differentAccountId}, 'second', 'Fixture Second', ARRAY['requester']),
        (${otherTenantId}, ${otherUserId}, 'employee', 'Other Fixture Employee', ARRAY['auditor'])`
    })
    expect(await bindOidcIdentity(sql, provider, binding)).toEqual({ userId, changed: true })
    expect(await bindOidcIdentity(sql, provider, binding)).toEqual({ userId, changed: false })
    await expect(bindOidcIdentity(sql, provider, { ...binding, login: 'second' })).rejects.toMatchObject({ status: 409 })
    await expect(bindOidcIdentity(sql, provider, { ...binding, login: 'unknown' })).rejects.toMatchObject({ status: 404 })
    await expect(store.signInExternal({ ...identity, tenant: otherTenant })).rejects.toMatchObject(unmappedIdentity)
    await expect(store.signInExternal({ ...identity, issuer: 'https://wrong-issuer.fixture.invalid' })).rejects.toMatchObject(unmappedIdentity)
    await expect(store.signInExternal({ ...identity, subject: 'employee-42' })).rejects.toMatchObject(unmappedIdentity)
    expect(await bindOidcIdentity(sql, provider, { ...binding, tenant: otherTenant })).toEqual({ userId: otherUserId, changed: true })
    const records = await sql<{ tenant_id: string, user_id: string, issuer: string, subject: string }[]>`
      SELECT tenant_id, user_id, issuer, subject FROM enterprise_external_identities
      WHERE tenant_id IN (${tenantId}, ${otherTenantId}) ORDER BY tenant_id
    `
    expect(records).toHaveLength(2)
    expect(records.find(row => row.tenant_id === tenantId)).toEqual({
      tenant_id: tenantId, user_id: userId, issuer: provider.issuer, subject: binding.subject,
    })
    expect(records.find(row => row.tenant_id === otherTenantId)?.user_id).toBe(otherUserId)
    const audits = await sql<{ target_id: string }[]>`SELECT target_id FROM enterprise_audit
      WHERE tenant_id IN (${tenantId}, ${otherTenantId}) AND action = 'identity.bound'`
    expect(audits.map(record => record.target_id).sort()).toEqual([userId, otherUserId].sort())

    const bootstrap = await signInThroughConsole(store, redis, identity)
    const response = await bootstrap()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ user: { id: userId, roles: ['developer'] }, device: null })
    const other = await store.signInExternal({ ...identity, tenant: otherTenant })
    expect(await store.authenticate(other.accessToken, false)).toMatchObject({ tenantId: otherTenantId, id: otherUserId, roles: ['auditor'] })

    await sql`UPDATE enterprise_users SET active = false WHERE tenant_id = ${tenantId} AND id = ${userId}`
    await expect(store.signInExternal(identity)).rejects.toMatchObject(unmappedIdentity)
    expect((await bootstrap()).status).toBe(401)
    await sql`UPDATE enterprise_tenants SET active = false WHERE id = ${otherTenantId}`
    await expect(store.signInExternal({ ...identity, tenant: otherTenant })).rejects.toMatchObject(unmappedIdentity)
    await expect(store.authenticate(other.accessToken, false)).rejects.toMatchObject({ status: 401 })
  } finally {
    redis.close()
    try {
      await sql.begin(async trx => {
        await trx`DELETE FROM enterprise_audit WHERE tenant_id IN (${tenantId}, ${otherTenantId})`
        await trx`DELETE FROM enterprise_web_sessions WHERE tenant_id IN (${tenantId}, ${otherTenantId})`
        await trx`DELETE FROM enterprise_external_identities WHERE tenant_id IN (${tenantId}, ${otherTenantId})`
        await trx`DELETE FROM enterprise_users WHERE tenant_id IN (${tenantId}, ${otherTenantId})`
        await trx`DELETE FROM enterprise_tenants WHERE id IN (${tenantId}, ${otherTenantId})`
      })
    } finally { await sql.close() }
  }
}, 20_000)

integration('stores OIDC state in Redis with a TTL and consumes it once across requests', async () => {
  const redis = new RedisClient(localTestUrl(redisUrl!, 'redis:'))
  const states = redisOidcState(redis)
  const key = randomUUID()
  try {
    await redis.connect()
    expect(await states.remember(key, 'fixture-state', 300)).toBe(true)
    expect(await states.remember(key, 'must-not-overwrite', 300)).toBe(false)
    const ttl = await redis.send('TTL', ['enterprise-control:oidc:flow:v1:' + key])
    expect(typeof ttl === 'number' && ttl > 0 && ttl <= 300).toBe(true)
    expect(await Promise.all([states.take(key), states.take(key)])).toEqual(expect.arrayContaining(['fixture-state', null]))
    expect(await states.take(key)).toBeNull()
  } finally {
    try { await states.take(key) }
    finally { redis.close() }
  }
})
