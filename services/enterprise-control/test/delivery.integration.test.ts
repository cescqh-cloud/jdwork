import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { Hono } from 'hono'
import { html } from 'hono/html'
import type { z } from 'zod'
import { ControlError } from '../src/contract'
import { bodyHash, draftInput, evidenceHash, type DemandSnapshot } from '../src/demands/contract'
import { mountDeliveryRoutes } from '../src/delivery/routes'
import { DeliveryStore } from '../src/delivery/store'
import { migrate } from '../src/migrate'
import type { Actor } from '../src/store'

const databaseUrl = Bun.env.ENTERPRISE_TEST_DATABASE_URL
const integration = databaseUrl ? test : test.skip

async function withDeliveryFixture(run: (fixture: {
  sql: SQL, store: DeliveryStore, lead: Actor, business: Actor, developer: Actor, reviewer: Actor, outsider: Actor, foreignLead: Actor,
  projectId: string, approved: { id: string, versionId: string, demandNo: string, snapshotHash: string }, pendingId: string,
  signingKey: KeyObject,
}) => Promise<void>) {
  const url = new URL(databaseUrl!)
  if (url.hostname !== '127.0.0.1' || !['postgres:', 'postgresql:'].includes(url.protocol) || !url.pathname.endsWith('_test')) {
    throw new Error('Delivery integration requires a disposable loopback database')
  }
  const sql = new SQL(databaseUrl!)
  const tenantId = randomUUID()
  const foreignId = randomUUID()
  const projectId = randomUUID()
  const deviceId = randomUUID()
  const key = generateKeyPairSync('ed25519')
  function actor(displayName: string, roles: Actor['roles'], organization = tenantId): Actor {
    return { tenantId: organization, id: randomUUID(), displayName, roles, device: null, expiresAt: new Date(Date.now() + 60_000) }
  }
  const lead = actor('Lead', ['it_lead'])
  const business = actor('Business', ['requester'])
  const developer = { ...actor('Developer', ['developer']), device: { id: deviceId, platform: 'win32' as const, clientVersion: '0.7.7' } }
  const reviewer = actor('Reviewer', ['project_owner'])
  const outsider = actor('Unassigned', ['developer'])
  const foreignLead = actor('Foreign Lead', ['it_lead'], foreignId)
  const id = randomUUID()
  const pendingId = randomUUID()
  const versionId = randomUUID()
  const draft = draftInput.parse({ title: '采购收货验收', systemKey: 'ERP', category: '报表', businessContext: '核对采购收货字段',
    acceptanceCriteria: '收货组织和采购组织字段一致' })
  try {
    await migrate(sql)
    const approved = await sql.begin(async trx => {
      await trx`INSERT INTO enterprise_tenants (id, slug, name) VALUES
        (${tenantId}, ${'delivery-fixture-' + tenantId.slice(0, 8)}, 'Delivery fixture'),
        (${foreignId}, ${'delivery-fixture-' + foreignId.slice(0, 8)}, 'Second fixture')`
      for (const user of [lead, business, developer, reviewer, outsider, foreignLead]) {
        await trx`INSERT INTO enterprise_users (tenant_id, id, login, display_name, roles)
          VALUES (${user.tenantId}, ${user.id}, ${user.id}, ${user.displayName}, ${trx.array(user.roles, 'TEXT')})`
      }
      await trx`INSERT INTO enterprise_devices (id, tenant_id, user_id, public_key, platform, client_version)
        VALUES (${deviceId}, ${tenantId}, ${developer.id}, ${key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')}, 'win32', '0.7.7')`
      await trx`INSERT INTO enterprise_projects (tenant_id, id, name, classification) VALUES (${tenantId}, ${projectId}, 'Delivery project', 'internal')`
      await trx`INSERT INTO enterprise_project_members (tenant_id, project_id, user_id)
        VALUES (${tenantId}, ${projectId}, ${developer.id}), (${tenantId}, ${projectId}, ${reviewer.id})`
      const [demand] = await trx<{ demand_no: string }[]>`INSERT INTO enterprise_demands (tenant_id, id, owner_id, draft, state, origin)
        VALUES (${tenantId}, ${id}, ${business.id}, ${draft}::jsonb, 'DRAFT', 'WORKBENCH') RETURNING demand_no`
      await trx`INSERT INTO enterprise_demands (tenant_id, id, owner_id, draft, state, origin)
        VALUES (${tenantId}, ${pendingId}, ${business.id}, ${draft}::jsonb, 'PENDING', 'WORKBENCH')`
      const snapshot: DemandSnapshot = { format: 1, demandId: id, demandNo: demand!.demand_no, versionId, versionNo: 1,
        draftRevision: 1, origin: 'WORKBENCH', draft, precheck: null }
      const snapshotHash = evidenceHash(snapshot)
      const instanceId = 'fixture-instance-' + id
      await trx`INSERT INTO enterprise_demand_versions (tenant_id, demand_id, id, version_no, draft_revision, submitted_by, snapshot, snapshot_hash, body_hash)
        VALUES (${tenantId}, ${id}, ${versionId}, 1, 1, ${business.id}, ${snapshot}::jsonb, ${snapshotHash}, ${bodyHash(draft)})`
      await trx`INSERT INTO enterprise_dingtalk_demand_instances (tenant_id, instance_id, corp_id, process_code, demand_id, version_id,
          originator_user_id, state, verified_at)
        VALUES (${tenantId}, ${instanceId}, 'fixture-org', 'FIXTURE-APPROVAL', ${id}, ${versionId}, 'fixture-owner', 'AGREE', now())`
      await trx`INSERT INTO enterprise_demand_approvals (tenant_id, instance_id, demand_id, version_id, decision, snapshot_hash)
        VALUES (${tenantId}, ${instanceId}, ${id}, ${versionId}, 'AGREE', ${snapshotHash})`
      await trx`UPDATE enterprise_demands SET state = 'BACKLOG', active_version_id = ${versionId}, approved_version_id = ${versionId}
        WHERE tenant_id = ${tenantId} AND id = ${id}`
      return { id, versionId, demandNo: demand!.demand_no, snapshotHash }
    })
    await run({ sql, store: new DeliveryStore(sql), lead, business, developer, reviewer, outsider, foreignLead, projectId, approved, pendingId, signingKey: key.privateKey })
  } finally { await sql.close() }
}

function materials(demandNo: string, content = '核对收货组织。') {
  return { files: [{ path: 'request.md', text: ['---', 'id: ' + demandNo, 'title: 采购收货验收', 'kind: report',
    'acceptanceCriteria: [收货组织和采购组织字段一致]', '---', content].join('\n') }] }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function checksum(files: { path: string, text: string }[]) {
  return digest(JSON.stringify([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(file => [file.path, digest(file.text)])))
}

function signed<T extends { files: { path: string, text: string }[] }>(
  task: Awaited<ReturnType<DeliveryStore['get']>>, key: KeyObject, input: T,
) {
  const binding = task.binding!
  const values = ['delivery-material-selection-v1', binding.deviceId, task.id, task.approvedVersionId, binding.id, binding.gitRevision, checksum(input.files)]
  return { ...input, selectionReceipt: sign(null, Buffer.from(JSON.stringify(values)), key).toString('base64url') }
}

async function checked(store: DeliveryStore, actor: Actor, task: Awaited<ReturnType<DeliveryStore['get']>>,
  key: KeyObject, input: Parameters<DeliveryStore['check']>[3], requestId?: string) {
  const result = await store.check(actor, task.id, task.revision, signed(task.binding ? task : await store.get(actor, task.id), key, input), requestId)
  const verification = await store.verifyMaterials(actor, task.id, result.task.revision, { runId: result.run.id, checksum: checksum(input.files) })
  return { ...result, task: verification.task }
}

integration('invalidates accepted material when the selected worktree changes and independently checks the corrected revision', async () => {
  await withDeliveryFixture(async ({ sql, store, lead, developer, reviewer, outsider, projectId, approved, signingKey }) => {
    let task = await store.assign(lead, approved.id, { approvedVersionId: approved.versionId, expectedDemandRevision: 1, projectId, assigneeId: developer.id })
    task = await store.bind(developer, task.id, task.revision, { worktreeId: 'fixture-worktree', sessionId: 'fixture-session', gitRevision: 'a'.repeat(40) })
    task = await store.transition(developer, task.id, task.revision, { action: 'start' })
    const firstInput = materials(approved.demandNo)
    const legacy = await store.check(developer, task.id, task.revision, firstInput)
    expect(legacy.task.materials.state).toBe('unverified')
    await expect(store.review(reviewer, task.id, legacy.task.revision, { runId: legacy.run.id, decision: 'ACCEPT', note: 'Old client' }))
      .rejects.toMatchObject({ code: 'DELIVERY_MATERIALS_UNVERIFIED' })
    const first = await checked(store, developer, legacy.task, signingKey, firstInput)
    const once = await store.verifyMaterials(developer, task.id, first.task.revision, { runId: first.run.id, checksum: checksum(firstInput.files) })
    expect(once).toMatchObject({ changed: false, task: { revision: first.task.revision, materials: { state: 'current' } } })
    task = await store.review(reviewer, task.id, first.task.revision, { runId: first.run.id, decision: 'ACCEPT', note: 'Checked old file' })
    task = await store.transition(developer, task.id, task.revision, { action: 'start_testing' })
    const correction = materials(approved.demandNo, '修正了材料正文。')
    const changed = { runId: first.run.id, checksum: checksum(correction.files) }
    await expect(store.verifyMaterials(outsider, task.id, task.revision, changed)).rejects.toMatchObject({ status: 404 })
    const priorRevision = task.revision
    const invalidated = await store.verifyMaterials(developer, task.id, priorRevision, changed)
    expect(invalidated.task).toMatchObject({ state: 'DEVELOPING', latestRunId: first.run.id, acceptedRunId: null, materials: { state: 'changed' } })
    expect((await store.getCheck(reviewer, task.id, first.run.id)).stale).toBe(true)
    await expect(store.transition(reviewer, task.id, priorRevision, { action: 'record_test', outcome: 'passed', note: 'Stale test' }))
      .rejects.toMatchObject({ code: 'DELIVERY_REVISION_CONFLICT' })
    await expect(store.review(reviewer, task.id, invalidated.task.revision, { runId: first.run.id, decision: 'ACCEPT', note: 'Stale review' }))
      .rejects.toMatchObject({ code: 'DELIVERY_REVIEW_STALE' })
    const receipt = signed(task, signingKey, correction)
    const checkId = randomUUID()
    const racing = await Promise.allSettled([
      store.check(developer, task.id, invalidated.task.revision, receipt, checkId),
      store.check(developer, task.id, invalidated.task.revision, signed(task, signingKey, materials(approved.demandNo, '竞争修订。')), randomUUID()),
    ])
    expect(racing.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(racing.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'DELIVERY_REVISION_CONFLICT' } })
    const current = await store.get(developer, task.id)
    const report = await store.getCheck(reviewer, task.id, current.latestRunId!)
    expect(report).toMatchObject({ verdict: 'PASS', stale: false })
    expect(report.inputHash).not.toBe(first.run.inputHash)
    expect(report.selectionReceipt).toBeUndefined()
    expect((await store.getCheck(developer, task.id, report.id)).selectionReceipt).toBeTruthy()
    await sql`UPDATE enterprise_development_tasks SET material_verified_at = now() - interval '1 hour'
      WHERE tenant_id = ${developer.tenantId} AND id = ${task.id}`
    expect((await store.get(developer, task.id)).materials.state).toBe('unverified')
    await expect(store.review(reviewer, task.id, current.revision, { runId: report.id, decision: 'ACCEPT', note: 'Disconnected worktree' }))
      .rejects.toMatchObject({ code: 'DELIVERY_MATERIALS_UNVERIFIED' })
    await sql`UPDATE enterprise_devices SET revoked_at = now() WHERE id = ${developer.device!.id}`
    await expect(store.verifyMaterials(developer, task.id, current.revision, { runId: report.id, checksum: null }))
      .rejects.toMatchObject({ status: 403 })
  })
}, 25_000)

integration('requires verified approval and current project authority; invalidates advancement after a change request', async () => {
  await withDeliveryFixture(async ({ sql, store, lead, business, developer, reviewer, outsider, foreignLead, projectId, approved, pendingId }) => {
    const input = { approvedVersionId: approved.versionId, expectedDemandRevision: 1, projectId, assigneeId: developer.id }
    expect(await store.assignmentOptions(lead, approved.id)).toMatchObject({ approvedVersionId: approved.versionId,
      projects: [{ id: projectId, members: expect.arrayContaining([expect.objectContaining({ id: developer.id }), expect.objectContaining({ id: reviewer.id })]) }] })
    await expect(store.assign(business, approved.id, input)).rejects.toMatchObject({ status: 403 })
    await expect(store.assign(foreignLead, approved.id, input)).rejects.toMatchObject({ status: 404 })
    await expect(store.assign(lead, pendingId, input)).rejects.toMatchObject({ status: 409, code: 'DELIVERY_APPROVAL_REQUIRED' })
    await expect(store.assign(lead, approved.id, { ...input, assigneeId: outsider.id })).rejects.toMatchObject({ status: 403 })
    await expect(store.assign(lead, approved.id, { ...input, expectedDemandRevision: 2 })).rejects.toMatchObject({ status: 409 })
    const task = await store.assign(lead, approved.id, input)
    expect(task).toMatchObject({ state: 'ASSIGNED', approvedVersionId: approved.versionId, snapshotHash: approved.snapshotHash })
    expect((await store.assign(lead, approved.id, input)).id).toBe(task.id)
    await expect(store.get(outsider, task.id)).rejects.toMatchObject({ status: 404 })
    await expect(store.get(foreignLead, task.id)).rejects.toMatchObject({ status: 404 })
    const refs = { worktreeId: 'fixture-worktree', sessionId: 'fixture-session', gitRevision: 'a'.repeat(40) }
    await expect(store.bind({ ...developer, device: null }, task.id, 1, refs)).rejects.toMatchObject({ status: 403 })
    const bound = await store.bind(developer, task.id, 1, refs)
    expect(bound.binding).toMatchObject(refs)
    expect((await store.get(business, task.id)).binding).toBeNull()
    expect((await store.get(lead, task.id)).binding).toBeNull()
    await sql`DELETE FROM enterprise_project_members WHERE tenant_id = ${lead.tenantId} AND project_id = ${projectId} AND user_id = ${developer.id}`
    await expect(store.get(developer, task.id)).rejects.toMatchObject({ status: 404 })
    expect((await store.get(lead, task.id)).canAdvance).toBe(false)
    await sql`INSERT INTO enterprise_project_members (tenant_id, project_id, user_id) VALUES (${lead.tenantId}, ${projectId}, ${developer.id})`
    expect((await store.get(lead, task.id)).canAdvance).toBe(true)
    await sql`UPDATE enterprise_demands SET state = 'CHANGE_REQUEST', revision = revision + 1
      WHERE tenant_id = ${lead.tenantId} AND id = ${approved.id}`
    expect((await store.get(lead, task.id)).canAdvance).toBe(false)
    await expect(store.transition(developer, task.id, bound.revision, { action: 'start' }))
      .rejects.toMatchObject({ status: 409, code: 'DELIVERY_APPROVAL_REQUIRED' })
  })
}, 20_000)

integration('rechecks fixed materials independently and requires test evidence and business acceptance to deliver', async () => {
  await withDeliveryFixture(async ({ sql, store, lead, business, developer, reviewer, outsider, projectId, approved, signingKey }) => {
    let task = await store.assign(lead, approved.id, { approvedVersionId: approved.versionId, expectedDemandRevision: 1, projectId, assigneeId: developer.id })
    const refs = { worktreeId: 'fixture-worktree', sessionId: 'fixture-session', gitRevision: 'b'.repeat(40) }
    const competing = await Promise.allSettled([
      store.bind(developer, task.id, task.revision, refs),
      store.bind(developer, task.id, task.revision, { ...refs, gitRevision: 'c'.repeat(40) }),
    ])
    expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(competing.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'DELIVERY_REVISION_CONFLICT' } })
    task = await store.get(developer, task.id)
    task = await store.transition(developer, task.id, task.revision, { action: 'start' })
    expect(task.state).toBe('DEVELOPING')
    const broken = await checked(store, developer, task, signingKey, { files: [{ path: 'request.md', text: '# Missing required structure' }] })
    expect(broken.run.verdict).toBe('BLOCK')
    await expect(store.review(developer, task.id, broken.task.revision, { runId: broken.run.id, decision: 'ACCEPT', note: 'Self review' }))
      .rejects.toMatchObject({ status: 403 })
    await expect(store.review(reviewer, task.id, broken.task.revision, { runId: broken.run.id, decision: 'ACCEPT', note: 'Must be blocked' }))
      .rejects.toMatchObject({ status: 409 })
    task = await store.review(reviewer, task.id, broken.task.revision, { runId: broken.run.id, decision: 'REWORK', note: '补齐验收材料' })
    const key = randomUUID()
    const clean = materials(approved.demandNo, '核对收货组织。[业务说明](https://docs.fixture.invalid/guide)')
    const warning = await checked(store, developer, task, signingKey, clean, key)
    expect(warning.run.verdict).toBe('WARN')
    expect((await store.check(developer, task.id, task.revision, signed(task, signingKey, clean), key)).run.id).toBe(warning.run.id)
    expect((await store.getCheck(reviewer, task.id, broken.run.id)).stale).toBe(true)
    await expect(store.getCheck(business, task.id, warning.run.id)).rejects.toMatchObject({ status: 404 })
    await expect(store.getCheck(outsider, task.id, warning.run.id)).rejects.toMatchObject({ status: 404 })
    await expect(store.review(reviewer, task.id, warning.task.revision, { runId: warning.run.id, decision: 'ACCEPT', note: '需要确认警告' }))
      .rejects.toMatchObject({ status: 409 })
    task = await store.review(reviewer, task.id, warning.task.revision, { runId: warning.run.id, decision: 'ACCEPT', acknowledgeWarnings: true, note: '人工核对了业务说明' })
    expect((await store.getCheck(reviewer, task.id, warning.run.id)).review).toMatchObject({ decision: 'ACCEPT', acknowledgedWarnings: true })
    task = await store.transition(developer, task.id, task.revision, { action: 'start_testing' })
    expect(task.state).toBe('TESTING')
    task = await store.transition(reviewer, task.id, task.revision, { action: 'record_test', outcome: 'not_run', note: '待执行验证' })
    expect(task.state).toBe('TESTING')
    await expect(store.transition(developer, task.id, task.revision, { action: 'record_test', outcome: 'passed', note: 'Self test' }))
      .rejects.toMatchObject({ status: 403 })
    await expect(store.transition(reviewer, task.id, task.revision, { action: 'record_test', outcome: 'passed', note: '缺少证据' }))
      .rejects.toMatchObject({ status: 400 })
    const evidence = [{ label: '本机模拟验收记录', sha256: 'f'.repeat(64) }]
    task = await store.transition(reviewer, task.id, task.revision, { action: 'record_test', outcome: 'passed', note: '独立测试记录', evidence })
    expect(task.state).toBe('ACCEPTANCE')
    await expect(store.transition(lead, task.id, task.revision, { action: 'accept', deliveryRef: 'handover-1', note: 'Wrong actor' }))
      .rejects.toMatchObject({ status: 403 })
    task = await store.transition(business, task.id, task.revision, { action: 'return_for_rework', note: '再核对一个业务边界' })
    expect(task).toMatchObject({ state: 'DEVELOPING', acceptedRunId: null, latestTestOutcome: null })
    await expect(store.transition(developer, task.id, task.revision, { action: 'start_testing' })).rejects.toMatchObject({ status: 409 })
    const fixed = await checked(store, developer, task, signingKey, materials(approved.demandNo, '已核对组织边界条件。'))
    expect(fixed.run.verdict).toBe('PASS')
    task = await store.review(reviewer, task.id, fixed.task.revision, { runId: fixed.run.id, decision: 'ACCEPT', note: '独立复审完成' })
    task = await store.transition(developer, task.id, task.revision, { action: 'start_testing' })
    task = await store.transition(reviewer, task.id, task.revision, { action: 'record_test', outcome: 'passed', note: '复测证据', evidence })
    task = await store.transition(business, task.id, task.revision, { action: 'accept', deliveryRef: 'handover-2', note: '验收确认' })
    expect(task).toMatchObject({ state: 'DELIVERED', latestTestOutcome: 'passed', deliveryRef: 'handover-2' })
    expect(task.history.map(event => event.action)).toContain('delivery.delivered')
    expect(await sql`SELECT state FROM enterprise_demands WHERE tenant_id = ${lead.tenantId} AND id = ${approved.id}`).toEqual([{ state: 'BACKLOG' }])
    await expect((async () => {
      await sql`UPDATE enterprise_delivery_check_runs SET verdict = 'PASS' WHERE tenant_id = ${lead.tenantId}
        AND task_id = ${task.id} AND id = ${broken.run.id}`
    })()).rejects.toThrow('Delivery evidence is immutable')
  })
}, 25_000)

integration('mounts the Web assignment, review, test and acceptance around the device API', async () => {
  await withDeliveryFixture(async ({ store, lead, business, developer, reviewer, outsider, projectId, approved, signingKey }) => {
    const app = new Hono()
    const actors: Record<string, Actor> = { lead, business, developer, reviewer, outsider, webDeveloper: { ...developer, device: null } }
    function parse<T>(schema: z.ZodType<T>, input: unknown) {
      const result = schema.safeParse(input)
      if (!result.success) throw new ControlError(400, 'INVALID_INPUT', 'Invalid fixture input')
      return result.data
    }
    app.onError((error, c) => error instanceof ControlError ? c.json({ error: { code: error.code } }, error.status) : c.body(null, 500))
    mountDeliveryRoutes(app, {
      store, parse, async actor(c, allowDevice = true) {
        const user = actors[c.req.header('Authorization')?.slice('Bearer '.length) ?? '']
        if (!user || (!allowDevice && user.device)) throw new ControlError(401, 'AUTH_REQUIRED', 'Login required')
        return user
      },
      async json(c, schema) { return parse(schema, await c.req.json()) },
      page(title, body) { return html`<main><h1>${title}</h1>${body}</main>` },
    })
    function get(path: string, user: string) {
      return app.request(path, { headers: { Authorization: 'Bearer ' + user } })
    }
    function post(path: string, user: string, input: unknown, revision?: number) {
      const headers = new Headers({ Authorization: 'Bearer ' + user, 'Content-Type': 'application/json' })
      if (revision !== undefined) headers.set('If-Match', '"' + revision + '"')
      return app.request(path, { method: 'POST', body: JSON.stringify(input), headers })
    }
    function form(path: string, user: string, values: Record<string, string>) {
      return app.request(path, { method: 'POST', body: new URLSearchParams(values), headers: { Authorization: 'Bearer ' + user } })
    }
    expect(await (await get('/console/deliveries', 'lead')).text()).toContain(approved.demandNo)
    const assignPath = '/console/deliveries/assign'
    expect(await (await get(assignPath + '?demandId=' + approved.id, 'lead')).text()).toContain('实施人')
    const assignment = await form(assignPath, 'lead', { demandId: approved.id, approvedVersionId: approved.versionId,
      expectedDemandRevision: '1', projectId, assigneeId: developer.id })
    expect(assignment.status).toBe(303)
    const web = assignment.headers.get('Location')!
    const api = web.replace('/console', '/api/v1')
    const refs = { worktreeId: 'web-fixture-worktree', sessionId: 'web-fixture-session', gitRevision: 'e'.repeat(40) }
    expect((await post(api + '/bind', 'developer', refs)).status).toBe(400)
    const binding = await post(api + '/bind', 'developer', refs, 1)
    expect(binding.status).toBe(200)
    expect(binding.headers.get('ETag')).toBe('"2"')
    expect((await form(web + '/transition', 'webDeveloper', { revision: '2', action: 'start' })).status).toBe(303)
    const checkMaterials = materials(approved.demandNo)
    const check = await post(api + '/checks', 'developer', signed(await store.get(developer, api.split('/').at(-1)!), signingKey, checkMaterials), 3)
    expect(check.status).toBe(201)
    const result = await check.json() as { run: { id: string } }
    const report = web + '/checks/' + result.run.id
    expect(await (await get(report, 'reviewer')).text()).toContain('等待绑定设备核验')
    expect((await post(api + '/materials', 'reviewer', { runId: result.run.id, checksum: checksum(checkMaterials.files) }, 4)).status).toBe(403)
    expect((await post(api + '/materials', 'developer', { runId: result.run.id, checksum: checksum(checkMaterials.files) }, 4)).status).toBe(200)
    expect(await (await get(report, 'reviewer')).text()).toContain('提交独立复审')
    expect((await get(report, 'business')).status).toBe(404)
    expect((await form(web + '/review', 'reviewer', { revision: '4', runId: result.run.id, decision: 'ACCEPT', note: '本机独立复审' })).status).toBe(303)
    expect((await form(web + '/transition', 'webDeveloper', { revision: '5', action: 'start_testing' })).status).toBe(303)
    expect(await (await get(web, 'reviewer')).text()).toContain('登记独立测试')
    expect((await form(web + '/transition', 'reviewer', { revision: '6', action: 'record_test', outcome: 'passed',
      evidenceLabel: '测试证据', evidenceSha256: 'a'.repeat(64), note: '本机测试记录' })).status).toBe(303)
    expect(await (await get(web, 'business')).text()).toContain('确认验收并记录交付')
    expect((await form(web + '/transition', 'business', { revision: '7', action: 'accept',
      deliveryRef: 'fixture-handoff', note: '已确认 <script>fixture</script>' })).status).toBe(303)
    const done = await (await get(web, 'business')).text()
    expect(done).toContain('已交付')
    expect(done).toContain('&lt;script&gt;fixture&lt;/script&gt;')
    expect(done).not.toContain('web-fixture-session')
    expect((await get(api, 'outsider')).status).toBe(404)
  })
}, 20_000)

integration('stops advancement when a cited knowledge version is withdrawn and allows remediation', async () => {
  await withDeliveryFixture(async ({ sql, store, lead, developer, reviewer, projectId, approved, signingKey }) => {
    const documentId = randomUUID()
    const checksum = 'c'.repeat(64)
    await sql`INSERT INTO enterprise_knowledge_documents
      (tenant_id, id, owner_id, scope, title, body, source, classification, checksum, status, revision, index_revision)
      VALUES (${lead.tenantId}, ${documentId}, ${lead.id}, 'enterprise_reference', 'Fixture source', 'synthetic evidence',
        ${{ label: 'Fixture source' }}::jsonb, 'internal', ${checksum}, 'ready', 1, 1)`
    let task = await store.assign(lead, approved.id, { approvedVersionId: approved.versionId, expectedDemandRevision: 1, projectId, assigneeId: developer.id })
    task = await store.bind(developer, task.id, task.revision, { worktreeId: 'fixture-worktree', sessionId: 'fixture-session', gitRevision: 'a'.repeat(40) })
    task = await store.transition(developer, task.id, task.revision, { action: 'start' })
    const check = await checked(store, developer, task, signingKey, { ...materials(approved.demandNo),
      knowledgeRefs: [{ documentId, revision: 1, checksum }] })
    expect(check.run.verdict).toBe('PASS')
    task = await store.review(reviewer, task.id, check.task.revision, { runId: check.run.id, decision: 'ACCEPT', note: '核对已发布引用' })
    task = await store.transition(developer, task.id, task.revision, { action: 'start_testing' })
    await sql`UPDATE enterprise_knowledge_documents SET status = 'draft', revision = 2, index_revision = NULL
      WHERE tenant_id = ${lead.tenantId} AND id = ${documentId}`
    expect((await store.getCheck(reviewer, task.id, check.run.id)).stale).toBe(true)
    await expect(store.transition(reviewer, task.id, task.revision, { action: 'record_test', outcome: 'passed',
      note: '引用已经撤回', evidence: [{ label: 'Fixture', sha256: 'a'.repeat(64) }] }))
      .rejects.toMatchObject({ status: 409, code: 'DELIVERY_REVIEW_STALE' })
    const blocked = await store.transition(reviewer, task.id, task.revision, { action: 'record_test', outcome: 'blocked', note: '需要更新引用' })
    expect(blocked).toMatchObject({ state: 'DEVELOPING', acceptedRunId: null, latestTestOutcome: 'blocked' })
  })
}, 20_000)
