import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { loadControlConfig } from '../src/config'
import { migrate } from '../src/migrate'
import { startControlRuntime } from '../src/runtime'

const databaseUrl = Bun.env.ENTERPRISE_TEST_DATABASE_URL
const redisUrl = Bun.env.ENTERPRISE_TEST_REDIS_URL
const integration = databaseUrl && redisUrl ? test : test.skip
const route = '/api/v1/models/erp'

integration('the assistant can only read opted-in test queries with its current model grant and project access', async () => {
  const database = new URL(databaseUrl!)
  if (database.hostname !== '127.0.0.1' || !database.pathname.endsWith('_test') || new URL(redisUrl!).hostname !== '127.0.0.1') {
    throw new Error('The ERP assistant test requires disposable loopback services.')
  }
  const sql = new SQL(databaseUrl!)
  const tenant = `assistant-erp-${randomUUID().slice(0, 8)}`
  const projectId = randomUUID()
  const restricted = randomUUID()
  const other = randomUUID()
  const number = 'CGSH-FIXTURE-ASSISTANT'
  const pendingNumber = 'CGSH-FIXTURE-REVOKE'
  const secret = 'fake-assistant-erp-secret'
  const calls: Array<{ method: string, path: string, number: string | null }> = []
  const pending = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/kapi/oauth2/token') return Response.json({ status: true, data: { access_token: 'fixture-erp-access-token', expires_in: 600 } })
    const number = url.searchParams.get('number')
    calls.push({ method: request.method, path: url.pathname, number })
    if (number === pendingNumber) {
      pending.resolve()
      await release.promise
    }
    return Response.json({ status: true, data: { rows: Array.from({ length: 12 }, () => ({
      number, state: '待收货', note: secret, hidden: 'not in the projection',
    })) } })
  } })
  const origin = 'http://127.0.0.1:8787'
  const baseUrl = `${upstream.url.origin}/v1`
  const scopes = [projectId, restricted, other].map(projectId => ({ projectId, roles: ['developer'] }))
  const queries = [
    { id: 'health', kind: 'connection', label: '测试连接', path: '/kapi/fixture/health' },
    { id: 'receipt', kind: 'document', label: '采购收货查询', path: '/kapi/fixture/receipt', allowAssistant: true,
      numberParameter: 'number', numberColumn: 'number', rowPath: ['rows'],
      columns: [{ key: 'number', title: '单号' }, { key: 'state', title: '状态' }, { key: 'note', title: '备注' }] },
  ]
  const testEnv = { tenant, id: 'xh-test', name: '星瀚测试', kind: 'kingdee-xh', mode: 'test', origin: upstream.url.origin,
    credentialRef: 'FIXTURE_XH', scopes, queries }
  const production = { ...testEnv, id: 'xh-prod', mode: 'production', origin: 'https://erp-production.invalid',
    queries: queries.map(query => ({ ...query, allowAssistant: false })) }
  const env = {
    ENTERPRISE_ORIGIN: origin, ENTERPRISE_DATABASE_URL: databaseUrl, ENTERPRISE_REDIS_URL: redisUrl, ENTERPRISE_LOCAL_LOGIN: 'true',
    ENTERPRISE_ERP_ENVIRONMENTS: JSON.stringify([testEnv, production]),
    ENTERPRISE_MODEL_UPSTREAMS: baseUrl, ENTERPRISE_MODEL_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    FIXTURE_XH_CLIENT_ID: 'fixture-app', FIXTURE_XH_CLIENT_SECRET: secret, FIXTURE_XH_USERNAME: 'fixture-user',
    FIXTURE_XH_ACCOUNT_ID: 'fixture-account', FIXTURE_XH_GATEWAY_IDENTITY: 'fixture-gateway',
  }
  let runtime: Awaited<ReturnType<typeof startControlRuntime>> | undefined
  try {
    await migrate(sql)
    runtime = await startControlRuntime({ ...loadControlConfig(env), port: 0 })
    const password = 'assistant-fixture-password'
    const member = await runtime.store.createLocalUser('ERP assistant fixture', { tenant, login: 'engineer', displayName: 'ERP engineer', password, roles: ['developer'] })
    await runtime.store.createLocalUser('ERP assistant fixture', { tenant, login: 'admin', displayName: 'ERP administrator', password, roles: ['platform_admin'] })
    const { accessToken: admin } = await runtime.store.signIn({ tenant, login: 'admin', password })
    const { accessToken: web } = await runtime.store.signIn({ tenant, login: 'engineer', password })
    const [org] = await sql<{ id: string }[]>`SELECT id FROM enterprise_tenants WHERE slug = ${tenant}`
    await sql`INSERT INTO enterprise_projects (tenant_id, id, name, classification) VALUES
      (${org!.id}, ${projectId}, '采购测试', 'internal'), (${org!.id}, ${restricted}, '受限项目', 'restricted'), (${org!.id}, ${other}, '其他项目', 'internal')`
    await sql`INSERT INTO enterprise_project_members (tenant_id, project_id, user_id) VALUES
      (${org!.id}, ${projectId}, ${member}), (${org!.id}, ${restricted}, ${member})`
    function call(path: string, token?: string, body?: unknown) {
      return fetch(new URL(path, runtime!.server.url), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) })
    }
    const challengeReply = await call('/api/v1/devices/challenge', web, {})
    expect(challengeReply.status).toBe(201)
    const { challenge } = await challengeReply.json() as { challenge: string }
    const key = generateKeyPairSync('ed25519')
    const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
    const deviceId = randomUUID(), platform = 'win32', clientVersion = '0.7.7'
    const signature = sign(null, Buffer.from(JSON.stringify(['enterprise-enroll-v1', challenge, deviceId, publicKey, platform, clientVersion])), key.privateKey).toString('base64url')
    const enrolled = await call('/api/v1/devices/enroll', undefined, { challenge, deviceId, publicKey, platform, clientVersion, signature })
    expect(enrolled.status).toBe(201)
    const { accessToken: device } = await enrolled.json() as { accessToken: string }
    const providerId = 'erp-fixture-model-provider', modelId = 'erp-fixture-model', sessionId = 'erp-fixture-session'
    expect((await call('/api/v1/admin/models/providers', admin, { id: providerId, displayName: '仅测试模型', protocol: 'openai',
      baseUrl, authHeader: 'bearer', classifications: ['general', 'internal'], apiKey: 'fixture-provider-key' })).status).toBe(200)
    const model = { id: modelId, providerId, upstreamModel: 'fixture-model', displayName: 'ERP fixture model', capabilities: ['text', 'tools'],
      contextWindow: 16_000, maxOutputTokens: 1000, allowedRoles: ['developer'] }
    const saveModel = (allowErpRead?: boolean) => call('/api/v1/admin/models/catalog', admin, { ...model, allowErpRead })
    expect((await saveModel()).status).toBe(200)
    const grant = await call('/api/v1/models/grants', device, { modelId, sessionId })
    expect(grant.status).toBe(201)
    const { accessToken: modelGrant } = await grant.json() as { accessToken: string }
    const list = { action: 'list', providerId, modelId, sessionId, modelGrant }
    expect((await call(route, device, list)).status).toBe(403)
    expect((await saveModel(true)).status).toBe(200)
    expect(await (await call('/api/v1/models/catalog', device)).json()).toMatchObject({ models: [{ modelId, canQueryErp: true }] })
    expect((await call(route, web, list)).status).toBe(401)
    expect((await call(route, device, { ...list, sessionId: 'another-session' })).status).toBe(401)
    expect((await call(route, device, { ...list, providerId: 'another-provider' })).status).toBe(403)
    const discovery = await call(route, device, list)
    expect(discovery.status).toBe(200)
    expect(await discovery.json()).toEqual({ action: 'list', environments: [{ id: 'xh-test', name: '星瀚测试', mode: 'test',
      projects: [{ id: projectId, name: '采购测试' }], queries: [{ id: 'receipt', label: '采购收货查询', kind: 'document', requiresNumber: true }] }] })
    const read = { ...list, action: 'read', projectId, environmentId: 'xh-test', operation: 'receipt', number }
    expect((await call(route, device, { ...read, environmentId: 'xh-prod' })).status).toBe(404)
    expect((await call(route, device, { ...read, operation: 'health' })).status).toBe(404)
    expect((await call(route, device, { ...read, projectId: restricted })).status).toBe(403)
    expect((await call(route, device, { ...read, projectId: other })).status).toBe(403)
    expect((await call(route, device, { ...read, path: '/kapi/unregistered/path' })).status).toBe(400)
    await sql`INSERT INTO enterprise_project_members (tenant_id, project_id, user_id) VALUES (${org!.id}, ${other}, ${member})`
    const scoped = await call('/api/v1/models/grants', device, { modelId, sessionId, projectId })
    expect(scoped.status).toBe(201)
    const { accessToken: scopedGrant } = await scoped.json() as { accessToken: string }
    const scopedList = await call(route, device, { ...list, modelGrant: scopedGrant })
    expect(scopedList.status).toBe(200)
    expect(await scopedList.json()).toMatchObject({ environments: [{ projects: [{ id: projectId }] }] })
    expect((await call(route, device, { ...read, modelGrant: scopedGrant, projectId: other })).status).toBe(403)
    expect(calls).toEqual([])

    const response = await call(route, device, read)
    expect(response.status).toBe(200)
    const body = await response.json() as { action: string, result: { requestId: string, rows: unknown[] } }
    expect(body).toMatchObject({ action: 'read', result: { projectId, environmentId: 'xh-test', mode: 'test', operation: 'receipt',
      truncated: true, rows: Array.from({ length: 10 }, () => ({ number, state: '待收货', note: null })) } })
    expect(calls).toEqual([{ method: 'GET', path: '/kapi/fixture/receipt', number }])
    const slow = call(route, device, { ...read, number: pendingNumber })
    await Promise.race([pending.promise, slow.then(() => { throw new Error('The read did not reach the ERP fixture.') })])
    expect((await saveModel(false)).status).toBe(200)
    release.resolve()
    expect((await slow).status).toBe(403)
    const audit = await sql<{ request_id: string, outcome: string, returned_count: number | null }[]>`
      SELECT request_id, outcome, returned_count FROM enterprise_erp_activity WHERE tenant_id = ${org!.id} ORDER BY occurred_at`
    expect(audit).toEqual([{ request_id: body.result.requestId, outcome: 'succeeded', returned_count: 10 },
      { request_id: expect.any(String), outcome: 'denied', returned_count: null }])
  } finally {
    release.resolve()
    await runtime?.close()
    await upstream.stop(true)
    await sql.close()
  }
}, 25_000)
