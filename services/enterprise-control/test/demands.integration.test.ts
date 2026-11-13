import { afterAll, beforeAll, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { ControlError, type Role } from '../src/contract'
import { migrate } from '../src/migrate'
import type { Actor } from '../src/store'
import { createDingTalkCallback } from '../src/demands/callback'
import { draftInput, evidenceHash, type DemandDraft, type TemplateInput } from '../src/demands/contract'
import { DingTalkDispatchError, type DingTalkCreateRequest, type DingTalkInstance, type DingTalkTransport } from '../src/demands/dingtalk'
import { mountDemandRoutes } from '../src/demands/routes'
import { DemandService, type DemandPrechecker } from '../src/demands/service'
import { DemandStore } from '../src/demands/store'
import { encryptedEvent, fixtureCallback } from './demands-fixtures'

const address = Bun.env.ENTERPRISE_TEST_DATABASE_URL
let database: SQL
if (address) {
  const url = new URL(address)
  if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test')) throw new Error('Use a disposable loopback Postgres database ending in _test.')
  beforeAll(async () => { database = new SQL(address); await migrate(database) }, 15_000)
  afterAll(async () => { await database?.close({ timeout: 2 }) })
}
const integration = address ? test : test.skip

const corp = 'corp-fixture'
const code = 'PROC-WORKBENCH'
const versionLabel = '工作台版本标识'
const template: TemplateInput = {
  processCode: code, label: '信息化提案', submitEnabled: true, importEnabled: true, expectedRevision: null,
  fieldMap: { title: { name: '需求名称' }, systemKey: { name: '涉及系统' }, category: { name: '需求类型' }, businessContext: { name: '现状与问题' },
    versionRef: { name: versionLabel, id: 'Field-version' }, expectedValue: { name: '预期收益' } },
  approverOptions: [{ actionerKey: 'lead-node', label: '业务负责人', allowedUserIds: ['oa-reviewer'] }],
}
const draft = draftInput.parse({ title: '采购报表', systemKey: '星瀚', category: '报表',
  businessContext: '记录供应商交付率', expectedValue: '每周自动汇总',
  acceptanceCriteria: '包含边界日期', businessOwner: 'fixture-person', attachmentRefs: [{ id: 'file-fixture', name: '说明.md' }] })
type View = Awaited<ReturnType<DemandStore['get']>>
type SavedDraft = View & { draftMutation: { idempotencyKey: string; draftRevision: number } }
type List = Awaited<ReturnType<DemandStore['list']>>
type Submission = Awaited<ReturnType<DemandService['submit']>>

async function expected<T>(response: Response | Promise<Response>, status: number) {
  const reply = await response
  const body = await reply.text()
  if (reply.status !== status) throw new Error(`Expected HTTP ${status}, received ${reply.status}: ${body}`)
  return JSON.parse(body) as T
}

async function fixture(precheck?: DemandPrechecker | null) {
  const tenant = randomUUID()
  const slug = `m3-${tenant.slice(0, 8)}`
  const anotherTenant = randomUUID()
  await database`INSERT INTO enterprise_tenants (id, slug, name) VALUES (${tenant}, ${slug}, 'OA fixture'),
    (${anotherTenant}, ${`${slug}-other`}, 'Another fixture')`
  const users: Record<string, Actor> = {}
  async function user(name: string, role: Role, tenantId = tenant) {
    const id = randomUUID()
    await database`INSERT INTO enterprise_users (tenant_id, id, login, display_name, roles)
      VALUES (${tenantId}, ${id}, ${name}, ${name}, ${database.array([role], 'TEXT')})`
    users[name] = { id, tenantId, displayName: name, roles: [role], expiresAt: new Date(Date.now() + 60_000), device: null }
    return id
  }
  const owner = await user('owner', 'requester')
  const other = await user('other', 'requester')
  const reviewer = await user('reviewer', 'approver')
  await user('platform', 'platform_admin')
  await user('lead', 'it_lead')
  await user('foreign', 'it_lead', anotherTenant)

  const known = new Map<string, DingTalkInstance>()
  const requests: DingTalkCreateRequest[] = []
  const reads: string[] = []
  const lists: Array<Parameters<DingTalkTransport['list']>[0]> = []
  const prechecks: Array<Parameters<DemandPrechecker>[0]> = []
  const behavior = { create: 'normal' as 'normal' | 'lost' | 'denied' }
  const transport: DingTalkTransport = {
    async create(input) {
      requests.push(structuredClone(input))
      if (behavior.create === 'denied') throw new DingTalkDispatchError('DECLINED')
      const instanceId = `created-${requests.length}`
      known.set(instanceId, { instanceId, processCode: input.processCode, state: 'RUNNING', title: '已建钉钉审批',
        originatorUserId: input.originatorUserId, finishedAt: null, approverUserIds: ['oa-reviewer'],
        form: input.formComponentValues.map(field => ({ ...field, id: field.name === versionLabel ? 'Field-version' : undefined })) })
      if (behavior.create === 'lost') throw new DingTalkDispatchError('UNCONFIRMED')
      return { instanceId }
    },
    async get(id) {
      reads.push(id)
      const row = known.get(id)
      if (!row) throw new Error('Fixture instance is not visible')
      return structuredClone(row)
    },
    async list(input) {
      lists.push(input)
      return { ids: [...known.values()].filter(row => row.processCode === input.processCode &&
        (!input.userIds || input.userIds.includes(row.originatorUserId))).map(row => row.instanceId), nextToken: null }
    },
  }
  const store = new DemandStore(database)
  const service = new DemandService(store, { connections: new Map([[slug, { corpId: corp, transport, callback: createDingTalkCallback(fixtureCallback) }]]),
    precheck: precheck === null ? undefined : async input => {
      prechecks.push(input)
      return precheck ? precheck(input) : { summary: '需补充统计规则\nCookie: fixture-model-secret', questions: ['日期口径是什么？'], risks: ['供应商范围需要核对'] }
    } })
  const app = new Hono()
  app.onError((error, c) => {
    if (error instanceof ControlError) return c.json({ code: error.code, message: error.message }, error.status)
    throw error
  })
  mountDemandRoutes(app, { service, actor: async c => {
    const actor = users[c.req.header('x-fixture-user') ?? '']
    if (!actor) throw new ControlError(401, 'AUTH_REQUIRED', 'Fixture sign-in is required.')
    return actor
  } })
  const api = (path: string, role = 'owner', method = 'GET', body?: unknown) => app.request(`/api/v1${path}`, {
    method, headers: { 'x-fixture-user': role, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  async function putIdentity(userId: string, staffId: string) {
    return expected(api('/admin/demands/identities', 'platform', 'PUT', { userId, staffId, departmentId: 101 }), 200)
  }
  async function configure() {
    await expected(api('/admin/demands/templates', 'platform', 'PUT', template), 200)
    await putIdentity(owner, 'oa-owner')
    await putIdentity(reviewer, 'oa-reviewer')
  }
  const create = (value: Partial<DemandDraft> = draft) => expected<View>(api('/demands', 'owner', 'POST', { draft: value }), 201)
  const review = (id: string, expectedDraftRevision = 1) => expected<View>(api(`/demands/${id}/precheck`, 'owner', 'POST', { expectedDraftRevision }), 200)
  const attempt = (expectedDraftRevision = 1, idempotencyKey = randomUUID()) => ({ expectedDraftRevision, idempotencyKey, processCode: code,
    approverSelections: [{ actionerKey: 'lead-node', actionerUserIds: ['oa-reviewer'] }] })
  const detail = (id: string, role = 'owner') => expected<View>(api(`/demands/${id}`, role), 200)
  const backlog = (role = 'owner') => expected<List>(api('/demands/backlog', role), 200)
  async function notify(instanceId: string, type: 'start' | 'finish' | 'terminate', eventId: string, options: { corpId?: string, processCode?: string } = {}) {
    const sealed = encryptedEvent({ EventType: 'bpms_instance_change', CorpId: options.corpId ?? corp, eventId, processInstanceId: instanceId,
      processCode: options.processCode ?? code, type, result: 'agree' })
    return app.request(`/api/v1/integrations/dingtalk/${slug}/callback?${new URLSearchParams(sealed.query)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sealed.body),
    })
  }
  async function cycle(times = 1) {
    for (let count = 0; count < times; count++) expect((await service.runOnce()).deferred).toBe(0)
  }
  return { app, api, owner, other, tenant, service, users, known, requests, reads, lists, prechecks, behavior, configure, putIdentity,
    create, review, attempt, detail, backlog, notify, cycle }
}

integration('draft saves return durable receipts, prevent duplicate creation and reject stale edits', async () => {
  const f = await fixture()
  const firstRequest = { draft, idempotencyKey: randomUUID() }
  const [first, repeated] = await Promise.all([
    expected<SavedDraft>(f.api('/demands', 'owner', 'POST', firstRequest), 201),
    expected<SavedDraft>(f.api('/demands', 'owner', 'POST', firstRequest), 201),
  ])
  expect(repeated.id).toBe(first.id)
  expect(repeated.draftMutation).toEqual({ idempotencyKey: firstRequest.idempotencyKey, draftRevision: 1 })
  expect((await expected<List>(f.api('/demands'), 200)).demands).toHaveLength(1)
  expect((await f.api('/demands', 'owner', 'POST', { ...firstRequest, draft: { ...draft, title: '重复请求改了正文' } })).status).toBe(409)

  const item = `/demands/${first.id}`
  const change = { draft: { ...draft, title: '本机草稿已恢复' }, expectedDraftRevision: 1, idempotencyKey: randomUUID() }
  const saved = await expected<SavedDraft>(f.api(item, 'owner', 'PATCH', change), 200)
  expect(saved.draftMutation).toEqual({ idempotencyKey: change.idempotencyKey, draftRevision: 2 })
  const stale = await expected<{ code: string }>(f.api(item, 'owner', 'PATCH', { ...change, idempotencyKey: randomUUID() }), 409)
  expect(stale.code).toBe('DEMAND_DRAFT_CONFLICT')
  expect((await f.api(item, 'other', 'PATCH', change)).status).toBe(404)
  const laterDraft = { ...draft, title: '另一处保存了第三稿' }
  await expected<View>(f.api(item, 'owner', 'PATCH', { draft: laterDraft, expectedDraftRevision: 2 }), 200)
  const recovered = await expected<SavedDraft>(f.api(item, 'owner', 'PATCH', change), 200)
  expect(recovered.draftMutation).toEqual(saved.draftMutation)
  expect(recovered.draftRevision).toBe(3)
  expect(recovered.draft).toEqual(laterDraft)
  expect((await f.detail(first.id)).activeVersion).toBeNull()
  expect(f.requests).toHaveLength(0)

  const [audit] = await database<{ creates: number; edits: number }[]>`SELECT
    COUNT(*) FILTER (WHERE action = 'demand.created')::int AS creates,
    COUNT(*) FILTER (WHERE action = 'demand.draft.changed')::int AS edits
    FROM enterprise_audit WHERE tenant_id = ${f.tenant} AND target_id = ${first.id}`
  expect(audit).toEqual({ creates: 1, edits: 2 })
})

integration('HTTP demand lifecycle freezes evidence and enters backlog only after verified OA agreement', async () => {
  const f = await fixture()
  await f.configure()
  const incomplete = await f.create({ title: '草稿' })
  expect((await f.api(`/demands/${incomplete.id}/precheck`, 'owner', 'POST', { expectedDraftRevision: 1 })).status).toBe(409)
  expect(f.prechecks).toHaveLength(0)
  const initial = await f.create()
  expect((await f.api(`/demands/${initial.id}`, 'other')).status).toBe(404)
  expect((await f.api(`/demands/${initial.id}`, 'foreign')).status).toBe(404)
  expect((await f.api(`/demands/${initial.id}`, 'platform')).status).toBe(404)
  expect((await f.api('/admin/demands/templates', 'owner')).status).toBe(403)
  expect((await f.api(`/demands/${initial.id}/submit`, 'owner', 'POST', f.attempt())).status).toBe(409)
  const reviewed = await f.review(initial.id)
  expect(reviewed.state).toBe('AI_PRECHECK')
  expect(reviewed.precheck?.summary).toContain('[已脱敏]')
  expect(reviewed.precheck?.summary).not.toContain('fixture-model-secret')
  expect(f.prechecks[0]?.demandId).toBe(initial.id)
  expect(f.prechecks[0]?.draft).toMatchObject({ businessOwner: '', attachmentRefs: [] })
  expect(JSON.stringify(f.prechecks[0]?.draft)).not.toMatch(/fixture-(?:secret|bearer|person)/u)
  const denied = { ...f.attempt(), approverSelections: [{ actionerKey: 'lead-node', actionerUserIds: ['oa-owner'] }] }
  expect((await f.api(`/demands/${initial.id}/submit`, 'owner', 'POST', denied)).status).toBe(400)

  const submit = f.attempt()
  const [first, second] = await Promise.all([
    expected<Submission>(f.api(`/demands/${initial.id}/submit`, 'owner', 'POST', submit), 202),
    expected<Submission>(f.api(`/demands/${initial.id}/submit`, 'owner', 'POST', submit), 202),
  ])
  expect(first.versionId).toBe(second.versionId)
  expect([first.reused, second.reused].filter(Boolean)).toHaveLength(1)
  expect((await f.api(`/demands/${initial.id}/submit`, 'owner', 'POST', { ...submit, expectedDraftRevision: 2 })).status).toBe(409)
  expect((await f.api(`/demands/${initial.id}/submit`, 'owner', 'POST', f.attempt())).status).toBe(409)
  expect(first.demand.activeVersion?.snapshotHash).toBe(evidenceHash(first.demand.activeVersion?.snapshot))
  expect(f.requests).toHaveLength(0)
  await Promise.all([f.cycle(), f.cycle()])
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toMatchObject({ RequestId: submit.idempotencyKey, originatorUserId: 'oa-owner', deptId: 101,
    targetSelectActioners: [{ actionerKey: 'lead-node', actionerUserIds: ['oa-reviewer'] }] })
  expect(f.requests[0]).not.toHaveProperty('approvers')
  expect((await f.detail(initial.id)).state).toBe('PENDING')

  const updated = await expected<View>(f.api(`/demands/${initial.id}`, 'owner', 'PATCH', {
    expectedDraftRevision: 1, draft: { ...draft, title: '新增付款状态列' },
  }), 200)
  expect(updated.draftRevision).toBe(2)
  expect(updated.unsubmittedChanges).toBe(true)
  expect(updated.activeVersion?.snapshot.draft.title).toBe(draft.title)
  expect((await f.api(`/demands/${initial.id}`, 'owner', 'PATCH', { expectedDraftRevision: 1, draft })).status).toBe(409)
  const tryChangingVersion = async () => {
    await database`UPDATE enterprise_demand_versions SET snapshot_hash = ${'f'.repeat(64)} WHERE tenant_id = ${f.tenant} AND id = ${first.versionId}`
  }
  await expect(tryChangingVersion()).rejects.toThrow('Frozen demand evidence')

  expect((await f.notify('created-1', 'finish', 'status-1', { corpId: 'foreign-corp' })).status).toBe(403)
  expect((await f.notify('created-1', 'finish', 'status-1')).status).toBe(200)
  expect((await f.notify('created-1', 'finish', 'status-1')).status).toBe(200)
  await f.cycle()
  expect((await f.detail(initial.id)).state).toBe('PENDING')
  expect((await f.backlog()).demands).toHaveLength(0)
  expect((await f.detail(initial.id, 'reviewer')).draft).toBeNull()
  expect((await f.detail(initial.id, 'reviewer')).activeVersion).toBeNull()
  f.known.get('created-1')!.state = 'AGREE'
  const approvedBody = f.known.get('created-1')!.form.find(field => field.name === '现状与问题')!
  const originalBody = approvedBody.value
  approvedBody.value = '变动的钉钉表单'
  expect((await f.notify('created-1', 'finish', 'status-mismatched-form')).status).toBe(200)
  await f.cycle()
  expect((await f.detail(initial.id)).submission?.errorCode).toBe('DINGTALK_SNAPSHOT_MISMATCH')
  expect((await f.backlog()).demands).toHaveLength(0)
  approvedBody.value = originalBody
  expect((await f.notify('created-1', 'finish', 'status-2')).status).toBe(200)
  await f.cycle()
  const approved = await f.detail(initial.id)
  expect(approved.state).toBe('BACKLOG')
  expect(approved.approval?.decision?.snapshotHash).toBe(first.demand.activeVersion?.snapshotHash)
  expect(approved.approvedVersion?.id).toBe(first.versionId)
  expect(approved.draft?.title).toBe('新增付款状态列')
  expect((await f.backlog()).demands[0]?.title).toBe(draft.title)
  expect((await f.backlog('lead')).demands).toHaveLength(1)
  expect((await f.backlog('foreign')).demands).toHaveLength(0)
  const [decisions] = await database<{ count: number }[]>`SELECT count(*)::int AS count FROM enterprise_demand_approvals WHERE tenant_id = ${f.tenant}`
  expect(decisions?.count).toBe(1)
  f.known.get('created-1')!.state = 'TERMINATED'
  expect((await f.notify('created-1', 'terminate', 'status-late')).status).toBe(200)
  await f.cycle()
  expect((await f.detail(initial.id)).state).toBe('BACKLOG')

  await f.review(initial.id, 2)
  const resubmitted = await expected<Submission>(f.api(`/demands/${initial.id}/submit`, 'owner', 'POST', f.attempt(2)), 202)
  expect(resubmitted.versionId).not.toBe(first.versionId)
  expect(resubmitted.demand.approvedVersion?.id).toBe(first.versionId)
  await f.cycle()
  f.known.get('created-2')!.state = 'REFUSE'
  expect((await f.notify('created-2', 'finish', 'status-3')).status).toBe(200)
  await f.cycle()
  const rejected = await f.detail(initial.id)
  expect(rejected.state).toBe('REJECTED')
  expect(rejected.approvedVersion?.id).toBe(first.versionId)
  expect(rejected.approval?.decision?.result).toBe('REFUSE')
  const console = await f.app.request(`/console/demands/${initial.id}`, { headers: { 'x-fixture-user': 'owner' } })
  expect(console.status).toBe(200)
  expect(await console.text()).toContain('需求池保留已批准版本 1')
}, 20_000)

integration('unknown create result is reconciled by template, originator, and exact frozen form without another create', async () => {
  const f = await fixture()
  await f.configure()
  f.behavior.create = 'lost'
  const item = await f.create()
  await f.review(item.id)
  const submit = f.attempt()
  const result = await expected<Submission>(f.api(`/demands/${item.id}/submit`, 'owner', 'POST', submit), 202)
  await f.cycle()
  expect(f.requests).toHaveLength(1)
  const pending = await f.detail(item.id)
  expect(pending.state).toBe('SUBMIT_FAILED')
  expect(pending.submission?.state).toBe('UNCONFIRMED')
  expect((await f.api(`/demands/${item.id}/submit`, 'owner', 'POST', f.attempt())).status).toBe(409)
  const retry = await expected<Submission>(f.api(`/demands/${item.id}/submit`, 'owner', 'POST', submit), 202)
  expect(retry.versionId).toBe(result.versionId)
  expect(retry.reused).toBe(true)

  const actual = structuredClone(f.known.get('created-1')!)
  f.known.get('created-1')!.form.find(field => field.name === '现状与问题')!.value = '被改动的正文'
  await expected<View>(f.api(`/demands/${item.id}/reconcile`, 'owner', 'POST'), 202)
  await f.cycle()
  expect(f.lists[0]).toMatchObject({ processCode: code, userIds: ['oa-owner'] })
  expect((await f.detail(item.id)).submission?.state).toBe('UNCONFIRMED')
  f.known.set('created-1', actual)
  f.known.set('duplicate-1', { ...actual, instanceId: 'duplicate-1' })
  const due = () => database`UPDATE enterprise_demand_submissions SET next_check_at = now() WHERE tenant_id = ${f.tenant} AND demand_id = ${item.id}`
  await due()
  await f.cycle()
  expect((await f.detail(item.id)).submission?.state).toBe('UNCONFIRMED')
  f.known.delete('duplicate-1')
  f.known.get('created-1')!.state = 'AGREE'
  await due()
  await f.cycle()
  const recovered = await f.detail(item.id)
  expect(recovered.state).toBe('BACKLOG')
  expect(recovered.approvedVersion?.id).toBe(result.versionId)
  expect(recovered.approval?.instanceId).toBe('created-1')
  expect(f.requests).toHaveLength(1)
}, 20_000)

integration('verified external imports require mapping, lead confirmation, and compensate for missing events', async () => {
  const f = await fixture()
  await f.configure()
  f.known.set('outside-scope', { instanceId: 'outside-scope', processCode: 'PROC-PRIVATE', state: 'AGREE', title: '不在授权范围',
    originatorUserId: 'oa-owner', finishedAt: null, approverUserIds: [], form: [] })
  expect((await f.notify('outside-scope', 'finish', 'external-out', { processCode: 'PROC-PRIVATE' })).status).toBe(200)
  await f.cycle()
  expect(f.reads).not.toContain('outside-scope')
  expect((await f.api('/admin/demands/templates/PROC-PRIVATE/scan', 'platform', 'POST', {})).status).toBe(403)

  f.known.set('external-1', { instanceId: 'external-1', processCode: code, state: 'AGREE', title: '钉钉已有报表需求',
    originatorUserId: 'oa-unknown', finishedAt: null, approverUserIds: [], form: [{ name: '需求名称', value: '钉钉已有报表需求' }] })
  const scan = await expected<{ queued: number }>(f.api(`/admin/demands/templates/${code}/scan`, 'platform', 'POST', {}), 202)
  expect(scan.queued).toBe(1)
  await f.cycle()
  const items = await expected<List>(f.api('/demands', 'lead'), 200)
  const imported = items.demands[0]!
  expect(imported).toMatchObject({ state: 'IMPORT_REVIEW', origin: 'DINGTALK', ownerId: null })
  const snapshot = (await f.detail(imported.id, 'lead')).activeVersion
  expect(snapshot?.snapshot.draft.businessContext).toBe('')
  expect((await f.backlog('lead')).demands).toHaveLength(0)
  expect((await f.api(`/demands/${imported.id}/confirm-import`, 'owner', 'POST', { expectedRevision: imported.revision })).status).toBe(403)
  await expected<View>(f.api(`/demands/${imported.id}`, 'lead', 'PATCH', { expectedDraftRevision: 1, draft }), 200)
  const patched = await f.detail(imported.id, 'lead')
  expect((await f.api(`/demands/${imported.id}/confirm-import`, 'lead', 'POST', { expectedRevision: patched.revision })).status).toBe(409)
  await f.putIdentity(f.other, 'oa-unknown')
  expect((await f.api(`/demands/${imported.id}/confirm-import`, 'lead', 'POST', { expectedRevision: patched.revision, ownerId: f.owner })).status).toBe(409)
  const accepted = await expected<View>(f.api(`/demands/${imported.id}/confirm-import`, 'lead', 'POST', { expectedRevision: patched.revision }), 200)
  expect(accepted.state).toBe('BACKLOG')
  expect(accepted.ownerId).toBe(f.other)
  expect(accepted.approvedVersion?.snapshotHash).toBe(snapshot?.snapshotHash)
  expect(accepted.approvedVersion?.snapshot.draft.businessContext).toBe('')
  expect(accepted.draft?.businessContext).toBe(draft.businessContext)
  expect(accepted.unsubmittedChanges).toBe(true)
  expect((await f.detail(imported.id, 'other')).state).toBe('BACKLOG')
  expect((await f.notify('external-1', 'start', 'external-late')).status).toBe(200)
  await f.cycle()
  expect((await f.backlog('lead')).demands).toHaveLength(1)

  f.known.set('external-2', { instanceId: 'external-2', processCode: code, state: 'RUNNING', title: 'OA 申请', originatorUserId: 'oa-owner',
    finishedAt: null, approverUserIds: [], form: [{ name: '需求名称', value: 'OA 申请' }, { name: '涉及系统', value: '星瀚' },
      { name: '需求类型', value: '报表' }, { name: '现状与问题', value: '合规数据查询' }] })
  expect((await f.notify('external-2', 'start', 'external-start')).status).toBe(200)
  await f.cycle()
  const visible = await expected<List>(f.api('/demands'), 200)
  expect(visible.demands[0]).toMatchObject({ state: 'PENDING', origin: 'DINGTALK' })
  f.known.get('external-2')!.state = 'TERMINATED'
  await database`UPDATE enterprise_dingtalk_demand_instances SET next_check_at = now() WHERE tenant_id = ${f.tenant} AND instance_id = 'external-2'`
  await f.cycle()
  expect((await f.detail(visible.demands[0]!.id)).state).toBe('CANCELLED')
  expect((await f.backlog()).demands).toHaveLength(0)
}, 20_000)

integration('model absence is visible, and an in-flight precheck never overwrites a changed draft', async () => {
  const unavailable = await fixture(null)
  const item = await unavailable.create()
  expect((await unavailable.api(`/demands/${item.id}/precheck`, 'owner', 'POST', { expectedDraftRevision: 1 })).status).toBe(503)
  expect((await unavailable.detail(item.id)).state).toBe('DRAFT')
  let release!: () => void
  let start!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { start = resolve })
  const f = await fixture(async () => { start(); await pending; return { summary: 'fixture answer', questions: [], risks: [] } })
  const review = await f.create()
  const result = f.api(`/demands/${review.id}/precheck`, 'owner', 'POST', { expectedDraftRevision: 1 })
  await entered
  await expected<View>(f.api(`/demands/${review.id}`, 'owner', 'PATCH', { expectedDraftRevision: 1, draft: { ...draft, title: '新修订' } }), 200)
  release()
  expect((await result).status).toBe(409)
  expect((await f.detail(review.id)).precheck).toBeNull()
}, 20_000)

integration('precheck redacts obvious credentials and OA cannot receive a draft with credentials', async () => {
  const f = await fixture()
  await f.configure()
  const item = await f.create({ ...draft, title: '采购报表 SQL 密码: fixture-secret',
    businessContext: '记录供应商交付率\nAuthorization: Bearer fixture-bearer' })
  const reviewed = await f.review(item.id)
  expect(reviewed.precheck?.summary).toContain('[已脱敏]')
  expect(f.prechecks[0]?.draft.title).toContain('[已脱敏]')
  expect(f.prechecks[0]?.draft.businessContext).toContain('[已脱敏]')
  expect(JSON.stringify(f.prechecks[0]?.draft)).not.toMatch(/fixture-(?:secret|bearer|person)/u)
  const failure = await expected<{ code: string }>(f.api(`/demands/${item.id}/submit`, 'owner', 'POST', f.attempt()), 409)
  expect(failure.code).toBe('DEMAND_CREDENTIALS_IN_DRAFT')
  await f.cycle()
  expect(f.requests).toHaveLength(0)
  expect((await f.detail(item.id)).activeVersion).toBeNull()
}, 20_000)
