import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { loadControlConfig } from '../src/config'
import { migrate } from '../src/migrate'
import { startControlRuntime } from '../src/runtime'

const databaseUrl = Bun.env.ENTERPRISE_TEST_DATABASE_URL
const redisUrl = Bun.env.ENTERPRISE_TEST_REDIS_URL
const integration = databaseUrl && redisUrl ? test : test.skip
const queryRoot = '/api/v1/erp/environments'
const fixtureSecret = 'fake-kingdee-app-secret'
const consoleOrigin = 'http://127.0.0.1:8787'

integration('queries only registered ERP operations for current members and audits the result without recording business fields', async () => {
  const database = new URL(databaseUrl!)
  const redis = new URL(redisUrl!)
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.1' ||
      !database.pathname.endsWith('_test') || redis.hostname !== '127.0.0.1') throw new Error('ERP test requires disposable loopback services')
  const sql = new SQL(databaseUrl!)
  const slug = `erp-fixture-${randomUUID().slice(0, 8)}`
  const projectId = randomUUID()
  const secondProject = randomUUID()
  const billNumber = 'CGSH-FIXTURE-00001'
  let releaseResponse: (() => void) | undefined
  let startedResponse: (() => void) | undefined
  const waitingForRequest = new Promise<void>(resolve => { startedResponse = resolve })
  const holdResponse = new Promise<void>(resolve => { releaseResponse = resolve })
  const tokens: string[] = []
  const upstreamRequests: { method: string, path: string, token: string | null, number: string | null }[] = []
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/kapi/oauth2/token' && request.method === 'POST') {
      const input = await request.json() as Record<string, unknown>
      if (input.client_id !== 'erp-fixture-app' || input.client_secret !== fixtureSecret || input.accountId !== 'fixture-account') return new Response(null, { status: 403 })
      const token = `fake-token-${tokens.length + 1}`
      tokens.push(token)
      return Response.json({ status: true, data: { access_token: token, expires_in: 300 } })
    }
    const token = request.headers.get('access_token')
    const number = url.searchParams.get('number')
    upstreamRequests.push({ method: request.method, path: url.pathname, token, number })
    if (request.method !== 'GET' || request.headers.get('x-acgw-identity') !== 'fake-gateway-identity') return new Response(null, { status: 403 })
    if (token === tokens[0]) return new Response(null, { status: 401 })
    if (url.pathname === '/kapi/fixture/health') return Response.json({ status: true })
    if (url.pathname === '/kapi/fixture/receipt' && url.searchParams.get('org') === 'fixture') {
      if (number === 'HOLD-FOR-REVOCATION') { startedResponse?.(); await holdResponse }
      if (number === 'BROKEN-SCHEMA') return Response.json({ status: true, data: { changed: [] } })
      return Response.json({ status: true, data: { rows: [
        { number, state: '待收货', unexpected: 'must-not-leave-adapter', note: fixtureSecret },
        { number: 'ANOTHER-ORDER', state: '已完成' },
      ] } })
    }
    return new Response(null, { status: 404 })
  } })
  const scopes = [{ projectId, roles: ['developer'] }]
  const queries = [
    { id: 'health', label: '连通性测试', kind: 'connection', path: '/kapi/fixture/health' },
    { id: 'receipt', label: '采购收货查询', kind: 'document', path: '/kapi/fixture/receipt', numberParameter: 'number', numberColumn: 'number',
      fixedParameters: { org: 'fixture' }, rowPath: ['rows'], columns: [{ key: 'number', title: '单据编号' }, { key: 'state', title: '状态' }, { key: 'note', title: '备注' }] },
  ]
  let runtime: Awaited<ReturnType<typeof startControlRuntime>> | undefined
  try {
    await migrate(sql)
    const config = loadControlConfig({ ENTERPRISE_ORIGIN: consoleOrigin, ENTERPRISE_DATABASE_URL: databaseUrl, ENTERPRISE_REDIS_URL: redisUrl,
      ENTERPRISE_LOCAL_LOGIN: 'true', ENTERPRISE_ERP_ENVIRONMENTS: JSON.stringify([{ tenant: slug, id: 'xh-test', name: '星瀚测试环境',
        kind: 'kingdee-xh', mode: 'test', origin: upstream.url.origin, credentialRef: 'FIXTURE_KD', scopes, queries }]),
      FIXTURE_KD_CLIENT_ID: 'erp-fixture-app', FIXTURE_KD_CLIENT_SECRET: fixtureSecret, FIXTURE_KD_USERNAME: 'fixture-erp-user',
      FIXTURE_KD_ACCOUNT_ID: 'fixture-account', FIXTURE_KD_GATEWAY_IDENTITY: 'fake-gateway-identity',
    })
    runtime = await startControlRuntime({ ...config, port: 0 })
    const password = 'erp-fixture-password'
    const member = await runtime.store.createLocalUser('ERP fixture', { tenant: slug, login: 'engineer', displayName: 'ERP engineer', password, roles: ['developer'] })
    await runtime.store.createLocalUser('ERP fixture', { tenant: slug, login: 'admin', displayName: 'ERP administrator', password, roles: ['platform_admin'] })
    await runtime.store.createLocalUser('Other ERP fixture', { tenant: `${slug}-other`, login: 'engineer', displayName: 'Other engineer', password, roles: ['developer'] })
    const [tenant] = await sql<{ id: string }[]>`SELECT id FROM enterprise_tenants WHERE slug = ${slug}`
    const tenantId = tenant!.id
    await sql`INSERT INTO enterprise_projects (tenant_id, id, name, classification) VALUES
      (${tenantId}, ${projectId}, '采购集成', 'internal'), (${tenantId}, ${secondProject}, '其他项目', 'internal')`
    await sql`INSERT INTO enterprise_project_members (tenant_id, project_id, user_id) VALUES (${tenantId}, ${projectId}, ${member})`
    const localUrl = runtime.server.url
    const access = (login: string, tenant = slug) => runtime!.store.signIn({ login, tenant, password })
    const { accessToken } = await access('engineer')
    const { accessToken: admin } = await access('admin')
    const { accessToken: outsider } = await access('engineer', `${slug}-other`)
    function call(path: string, body?: unknown, token = accessToken) {
      return fetch(new URL(path, localUrl), { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(6000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    }
    const operation = { projectId, operation: 'receipt', number: billNumber }
    const visible = await call(queryRoot)
    expect(visible.status).toBe(200)
    expect(await visible.json()).toMatchObject({ environments: [{ id: 'xh-test', mode: 'test', projects: [{ id: projectId, name: '采购集成' }],
      queries: [{ id: 'health', requiresNumber: false }, { id: 'receipt', requiresNumber: true }] }] })
    for (const token of [admin, outsider]) {
      expect(await (await call(queryRoot, undefined, token)).json()).toEqual({ environments: [] })
      expect((await call(`${queryRoot}/xh-test/read`, operation, token)).status).toBe(404)
    }
    expect((await call(`${queryRoot}/xh-test/read`, { ...operation, projectId: secondProject })).status).toBe(404)
    expect((await call(`${queryRoot}/xh-test/read`, { ...operation, path: '/invalid' })).status).toBe(400)
    expect((await call(`${queryRoot}/xh-test/read`, { ...operation, number: undefined })).status).toBe(400)
    expect(upstreamRequests).toHaveLength(0)

    const result = await call(`${queryRoot}/xh-test/read`, operation)
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ environmentId: 'xh-test', operation: 'receipt', rows: [{ number: billNumber, state: '待收货', note: null }], truncated: false })
    expect(upstreamRequests).toEqual(tokens.map(token => ({ token, method: 'GET', path: '/kapi/fixture/receipt', number: billNumber })))
    expect(tokens).toHaveLength(2)
    const console = await call('/console/erp')
    expect(console.status).toBe(200)
    expect(await console.text()).toContain('采购收货查询')
    const queryForm = new URLSearchParams({ projectId, operation: 'health', number: '' })
    const webResult = await fetch(new URL('/console/erp/xh-test', localUrl), { method: 'POST', body: queryForm,
      headers: { Origin: consoleOrigin, Cookie: `enterprise-dev-session=${accessToken}` }, signal: AbortSignal.timeout(5000) })
    expect(webResult.status).toBe(200)
    expect(await webResult.text()).toContain('接口连通')
    expect(tokens).toHaveLength(2)
    expect((await call(`${queryRoot}/xh-test/read`, { ...operation, number: 'BROKEN-SCHEMA' })).status).toBe(503)

    const revocation = call(`${queryRoot}/xh-test/read`, { ...operation, number: 'HOLD-FOR-REVOCATION' })
    await Promise.race([waitingForRequest, revocation.then(() => { throw new Error('ERP request did not reach the fixture') })])
    await sql`DELETE FROM enterprise_project_members WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND user_id = ${member}`
    releaseResponse?.()
    expect((await revocation).status).toBe(404)
    const audit = await sql<{ outcome: string, returned_count: number | null }[]>`SELECT * FROM enterprise_erp_activity
      WHERE tenant_id = ${tenantId} AND actor_id = ${member} ORDER BY occurred_at`
    expect(audit.filter(row => row.outcome === 'succeeded').map(row => row.returned_count)).toEqual([1, 0])
    expect(audit.some(row => row.outcome === 'failed')).toBe(true)
    expect(audit.at(-1)?.outcome).toBe('denied')
    expect(JSON.stringify(audit)).not.toContain(billNumber)
    expect(JSON.stringify(audit)).not.toContain(fixtureSecret)
  } finally {
    releaseResponse?.()
    await runtime?.close()
    await upstream.stop(true)
    await sql.close()
  }
}, 25_000)
