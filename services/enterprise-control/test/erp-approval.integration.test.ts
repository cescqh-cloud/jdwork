import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { createControlApp } from '../src/app'
import { loadErpEnvironments } from '../src/erp/contract'
import { ErpService } from '../src/erp/service'
import { migrate } from '../src/migrate'
import { ControlStore } from '../src/store'

const databaseUrl = Bun.env.ENTERPRISE_TEST_DATABASE_URL
const integration = databaseUrl ? test : test.skip

integration('ERP write plans require independent review and the actual control service denies production writes', async () => {
  const address = new URL(databaseUrl!)
  if (address.hostname !== '127.0.0.1' || !address.pathname.endsWith('_test') || !['postgres:', 'postgresql:'].includes(address.protocol)) {
    throw new Error('ERP approval test requires a disposable loopback database')
  }
  const sql = new SQL(databaseUrl!)
  const store = new ControlStore(sql)
  const tenant = `erp-approval-${randomUUID().slice(0, 8)}`
  const projectId = randomUUID()
  const password = 'fixture-erp-plan-password'
  try {
    await migrate(sql)
    const requester = await store.createLocalUser('ERP approval fixture', { tenant, login: 'requester', displayName: '发起人', password, roles: ['developer', 'it_lead'] })
    const reviewer = await store.createLocalUser('ERP approval fixture', { tenant, login: 'reviewer', displayName: '审批人', password, roles: ['it_lead'] })
    const [org] = await sql<{ id: string }[]>`SELECT id FROM enterprise_tenants WHERE slug = ${tenant}`
    const tenantId = org!.id
    await sql`INSERT INTO enterprise_projects (tenant_id, id, name, classification) VALUES (${tenantId}, ${projectId}, '采购授权', 'internal')`
    await sql`INSERT INTO enterprise_project_members (tenant_id, project_id, user_id) VALUES
      (${tenantId}, ${projectId}, ${requester}), (${tenantId}, ${projectId}, ${reviewer})`
    const scopes = [{ projectId, roles: ['developer', 'it_lead'], writeReviewRoles: ['it_lead'] }]
    const environments = loadErpEnvironments({ ENTERPRISE_ERP_ENVIRONMENTS: JSON.stringify([
      { tenant, id: 'xh-prod', name: '生产演示（未连接）', kind: 'kingdee-xh', mode: 'production', origin: 'https://fixture.invalid',
        credentialRef: 'FIXTURE_KD', scopes, queries: [{ id: 'health', label: '连接', kind: 'connection', path: '/kapi/fixture/health' }] },
      { tenant, id: 'xh-sandbox', name: '本机沙箱', kind: 'kingdee-xh', mode: 'sandbox', origin: 'http://127.0.0.1:9',
        credentialRef: 'FIXTURE_KD', scopes, queries: [{ id: 'health', label: '连接', kind: 'connection', path: '/kapi/fixture/health' }] },
    ]), FIXTURE_KD_CLIENT_ID: 'fake-client-id', FIXTURE_KD_CLIENT_SECRET: 'fake-secret', FIXTURE_KD_USERNAME: 'fake-user',
    FIXTURE_KD_ACCOUNT_ID: 'fake-account', FIXTURE_KD_GATEWAY_IDENTITY: 'fake-gateway' }, true)
    const origin = 'http://127.0.0.1:8787'
    const makeApp = (erp: ErpService) => createControlApp(store, { origin, localLogin: true, erp,
      notify() {}, async allowLoginAttempt() { return true }, async health() { return { redis: true } } })
    const app = makeApp(new ErpService(sql, environments))
    const access = async (login: string) => (await store.signIn({ tenant, login, password })).accessToken
    const user = await access('requester')
    const lead = await access('reviewer')
    const planRoot = '/api/v1/erp/environments/xh-prod/plans'
    const call = async (path: string, body?: unknown, token = user, target = app) => target.request(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const intent = { projectId, idempotencyKey: randomUUID(), object: '采购收货单', documentNumber: 'CGSH-FIXTURE-01', change: '变更演示备注', reason: '隔离测试' }
    const response = await call(planRoot, intent)
    expect(response.status).toBe(201)
    const proposal = await response.json() as { id: string, snapshotHash: string, state: string }
    expect(proposal.state).toBe('pending')
    expect(await (await call(planRoot, intent)).json()).toMatchObject({ id: proposal.id })
    expect((await call(planRoot, { ...intent, change: '另一份内容' })).status).toBe(409)
    const execute = { projectId, snapshotHash: proposal.snapshotHash, confirmEnvironment: 'xh-prod' }
    const decision = { projectId, expectedRevision: 1, decision: 'approve', note: '确认本次拟议变更' }
    const url = `${planRoot}/${proposal.id}`
    expect(await (await call(`${url}/execute`, execute)).json()).toMatchObject({ error: { code: 'ERP_WRITE_APPROVAL_REQUIRED' } })
    expect((await call(`${url}/decision`, decision)).status).toBe(403)
    const consoleUrl = `${origin}/console/erp/xh-prod/plans`
    const browserHeaders = { Cookie: `enterprise-dev-session=${lead}` }
    expect(await (await app.request(`${consoleUrl}?projectId=${projectId}`, { headers: browserHeaders })).text()).toContain('审批通过')
    const post = new URLSearchParams({ ...decision, expectedRevision: String(decision.expectedRevision) }).toString()
    Object.assign(browserHeaders, { 'Content-Type': 'application/x-www-form-urlencoded' })
    expect((await app.request(`${consoleUrl}/${proposal.id}/decision`, { method: 'POST', body: post, headers: browserHeaders })).status).toBe(403)
    expect((await app.request(`${consoleUrl}/${proposal.id}/decision`, { method: 'POST', body: post, headers: { ...browserHeaders, Origin: origin } })).status).toBe(303)
    expect(await (await call(`${url}/execute`, { ...execute, confirmEnvironment: 'xh-test' })).json()).toMatchObject({ error: { code: 'ERP_WRITE_CONFIRMATION_REQUIRED' } })
    expect(await (await call(`${url}/execute`, execute)).json()).toMatchObject({ error: { code: 'ERP_WRITE_DISABLED' } })
    expect(await (await call(`${planRoot}?projectId=${projectId}`)).json()).toMatchObject({ plans: [{ id: proposal.id, state: 'approved' }] })
    const audit = await sql<{ action: string }[]>`SELECT action FROM enterprise_audit WHERE tenant_id = ${tenantId} AND target_id = ${proposal.id}`
    expect(audit.filter(row => row.action === 'erp.write.denied')).toHaveLength(3)
    expect(audit.some(row => row.action === 'erp.plan.approved')).toBe(true)
    expect(audit.some(row => row.action === 'erp.write.started')).toBe(false)

    let dispatched = 0
    let writerStarted: (() => void) | undefined
    const waitingForWriter = new Promise<void>(resolve => { writerStarted = resolve })
    const sandboxService = new ErpService(sql, environments, { timeoutMs: 500, async execute() {
      dispatched++
      writerStarted?.()
      return new Promise<never>(() => {})
    } })
    const sandboxApp = makeApp(sandboxService)
    expect(await (await call(`${url}/execute`, execute, user, sandboxApp)).json()).toMatchObject({ error: { code: 'ERP_WRITE_DISABLED' } })
    expect(dispatched).toBe(0)
    const sandboxRoot = '/api/v1/erp/environments/xh-sandbox/plans'
    const candidate = await (await call(sandboxRoot, { ...intent, idempotencyKey: randomUUID() }, user, sandboxApp)).json() as { id: string, snapshotHash: string }
    const sandboxUrl = `${sandboxRoot}/${candidate.id}`
    expect(await (await call(`${sandboxUrl}/decision`, decision, lead, sandboxApp)).json()).toMatchObject({ state: 'approved', revision: 2 })
    const confirm = { ...execute, confirmEnvironment: 'xh-sandbox', snapshotHash: candidate.snapshotHash }
    const executing = call(`${sandboxUrl}/execute`, confirm, user, sandboxApp)
    await Promise.race([waitingForWriter, executing.then(() => { throw new Error('Sandbox write did not dispatch') })])
    expect(await (await call(`${sandboxUrl}/execute`, confirm, user, sandboxApp)).json()).toMatchObject({ state: 'executing' })
    expect(await (await executing).json()).toMatchObject({ state: 'unknown' })
    const restarted = makeApp(new ErpService(sql, environments, { async execute() { dispatched++; return 'completed' } }))
    expect(await (await call(`${sandboxUrl}/execute`, confirm, user, restarted)).json()).toMatchObject({ state: 'unknown' })
    expect(dispatched).toBe(1)
    const tryEditingSnapshot = async () => {
      await sql`UPDATE enterprise_erp_operation_plans SET snapshot_hash = ${'0'.repeat(64)} WHERE tenant_id = ${tenantId} AND id = ${candidate.id}`
    }
    await expect(tryEditingSnapshot()).rejects.toThrow('ERP operation plan snapshot is immutable')
  } finally { await sql.close() }
}, 20_000)
