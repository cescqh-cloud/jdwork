import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { createHash, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { html } from 'hono/html'
import type { z } from 'zod'
import { ControlError } from '../src/contract'
import { mountMemoryRoutes } from '../src/memory/routes'
import { MemoryStore } from '../src/memory/store'
import { migrate } from '../src/migrate'
import type { Actor } from '../src/store'

const databaseUrl = Bun.env.ENTERPRISE_TEST_DATABASE_URL
const integration = databaseUrl ? test : test.skip

function memoryApp(store: MemoryStore, identities: Record<string, Actor>) {
  function parse<T>(schema: z.ZodType<T>, input: unknown) {
    const result = schema.safeParse(input)
    if (!result.success) throw new ControlError(400, 'INVALID_INPUT', 'Invalid fixture input')
    return result.data
  }
  const app = new Hono()
  app.onError((error, c) => error instanceof ControlError ? c.json({ error: { code: error.code } }, error.status) : c.body(null, 500))
  mountMemoryRoutes(app, {
    store, parse, async actor(c, deviceAllowed = true) {
      const user = identities[c.req.header('Authorization')?.slice('Bearer '.length) ?? '']
      if (!user || (!deviceAllowed && user.device)) throw new ControlError(401, 'AUTH_REQUIRED', 'Login required')
      return user
    },
    async json(c, schema) { return parse(schema, await c.req.json()) },
    page(title, body) { return html`<main><h1>${title}</h1>${body}</main>` },
  })
  return app
}

async function withMemoryFixture(run: (context: {
  sql: SQL, store: MemoryStore, alice: Actor, reviewer: Actor, admin: Actor, outsider: Actor, otherTenant: Actor,
  projectId: string, departmentId: string, otherDepartmentId: string,
}) => Promise<void>) {
  const url = new URL(databaseUrl!)
  if (url.hostname !== '127.0.0.1' || !['postgres:', 'postgresql:'].includes(url.protocol) || !url.pathname.endsWith('_test')) {
    throw new Error('Memory integration requires a disposable loopback database')
  }
  const sql = new SQL(databaseUrl!)
  const tenantId = randomUUID()
  const otherTenantId = randomUUID()
  const projectId = randomUUID()
  const departmentId = randomUUID()
  const otherDepartmentId = randomUUID()
  function member(displayName: string, roles: Actor['roles'], tenant = tenantId): Actor {
    return { tenantId: tenant, id: randomUUID(), displayName, roles, device: null, expiresAt: new Date(Date.now() + 30_000) }
  }
  const alice = member('Alice', ['developer'])
  const reviewer = member('Reviewer', ['project_owner', 'it_lead'])
  const admin = member('Admin', ['platform_admin'])
  const outsider = member('Other Department', ['developer'])
  const otherTenant = member('Other Tenant', ['platform_admin'], otherTenantId)
  try {
    await migrate(sql)
    await sql.begin(async trx => {
      await trx`INSERT INTO enterprise_tenants (id, slug, name) VALUES
        (${tenantId}, ${'memory-fixture-' + tenantId.slice(0, 8)}, 'Memory fixture'),
        (${otherTenantId}, ${'memory-fixture-' + otherTenantId.slice(0, 8)}, 'Another fixture')`
      await trx`INSERT INTO enterprise_departments (tenant_id, id, name) VALUES
        (${tenantId}, ${departmentId}, 'Fixture department'), (${tenantId}, ${otherDepartmentId}, 'Other department')`
      for (const actor of [alice, reviewer, admin, outsider, otherTenant]) {
        const department = actor === outsider ? otherDepartmentId : actor === otherTenant ? null : departmentId
        await trx`INSERT INTO enterprise_users (tenant_id, id, login, display_name, roles, department_id)
          VALUES (${actor.tenantId}, ${actor.id}, ${actor.id}, ${actor.displayName}, ${trx.array(actor.roles, 'TEXT')}, ${department})`
      }
      await trx`INSERT INTO enterprise_projects (tenant_id, id, name, classification)
        VALUES (${tenantId}, ${projectId}, 'Fixture project', 'internal')`
      await trx`INSERT INTO enterprise_project_members (tenant_id, project_id, user_id)
        VALUES (${tenantId}, ${projectId}, ${alice.id}), (${tenantId}, ${projectId}, ${reviewer.id})`
    })
    await run({ sql, store: new MemoryStore(sql), alice, reviewer, admin, outsider, otherTenant, projectId, departmentId, otherDepartmentId })
  } finally {
    try {
      await sql.begin(async trx => {
        await trx`DELETE FROM enterprise_context_changes WHERE tenant_id IN (${tenantId}, ${otherTenantId})`
        await trx`DELETE FROM enterprise_context_visibility WHERE tenant_id IN (${tenantId}, ${otherTenantId})`
        await trx`DELETE FROM enterprise_memory_versions WHERE tenant_id IN (${tenantId}, ${otherTenantId})`
        await trx`DELETE FROM enterprise_memory_records WHERE tenant_id IN (${tenantId}, ${otherTenantId})`
        await trx`DELETE FROM enterprise_knowledge_documents WHERE tenant_id IN (${tenantId}, ${otherTenantId})`
        await trx`DELETE FROM enterprise_audit WHERE tenant_id IN (${tenantId}, ${otherTenantId})`
        await trx`DELETE FROM enterprise_project_members WHERE tenant_id = ${tenantId}`
        await trx`DELETE FROM enterprise_projects WHERE tenant_id = ${tenantId}`
        await trx`DELETE FROM enterprise_users WHERE tenant_id IN (${tenantId}, ${otherTenantId})`
        await trx`DELETE FROM enterprise_departments WHERE tenant_id = ${tenantId}`
        await trx`DELETE FROM enterprise_tenants WHERE id IN (${tenantId}, ${otherTenantId})`
      })
    } finally { await sql.close() }
  }
}

integration('isolates private and shared candidates, enforces reviews and conflicts, and replays only authorized tombstones', async () => {
  await withMemoryFixture(async ({ sql, store, alice, reviewer, admin, outsider, otherTenant, projectId, departmentId, otherDepartmentId }) => {
    const personal = await store.createCandidate(alice, { scope: 'user_private', body: '采购单据 fixture private format' })
    const personalActive = await store.publish(alice, personal.id, personal.revision)
    expect((await store.search(alice, { query: 'fixture private format' })).items.map(row => row.id)).toContain(personal.id)
    await expect(store.get(admin, personal.id)).rejects.toMatchObject({ status: 404 })
    expect((await store.search(admin, { query: 'fixture private format' })).items).toEqual([])
    expect((await store.search(otherTenant, { query: 'fixture private format' })).items).toEqual([])
    const edits = await Promise.allSettled([
      store.update(alice, personal.id, personalActive.revision, { body: '采购单据格式 A' }),
      store.update(alice, personal.id, personalActive.revision, { body: '采购单据格式 B' }),
    ])
    expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const conflict = edits.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(conflict.reason).toMatchObject({ status: 409, code: 'MEMORY_REVISION_CONFLICT', current: { revision: personalActive.revision + 1 } })
    expect(conflict.reason.submitted.body).toMatch(/采购单据格式 [AB]/u)

    const project = await store.createCandidate(alice, { scope: 'project_private', projectId, body: '采购收货单 项目业务事实',
      sourceRef: { sessionId: 'fixture-local-session', messageRefs: ['fixture-message'] } })
    expect((await store.candidates(reviewer)).map(row => row.id)).toContain(project.id)
    expect((await store.candidates(admin)).map(row => row.id)).not.toContain(project.id)
    expect((await store.search(reviewer, { query: '收货单' })).items).toEqual([])
    await expect(store.publish(alice, project.id, project.revision)).rejects.toMatchObject({ status: 403 })
    const projectActive = await store.publish(reviewer, project.id, project.revision)
    expect((await store.search(alice, { query: '项目业务事实' }, { modelProjectId: null, classifications: ['internal'] })).items).toEqual([])
    expect((await store.search(alice, { query: '项目业务事实' }, { modelProjectId: projectId, classifications: ['general'] })).items).toEqual([])
    expect((await store.search(alice, { query: '项目业务事实' }, { modelProjectId: projectId, classifications: ['internal'] })).items.map(row => row.id))
      .toEqual([project.id])
    expect((await store.get(reviewer, project.id)).sourceRef).toBeNull()
    expect((await store.get(alice, project.id)).sourceRef).toMatchObject({ sessionId: 'fixture-local-session' })
    const projectPage = await store.changes(alice, 0)
    expect(projectPage.changes).toContainEqual(expect.objectContaining({ operation: 'upsert', id: project.id }))
    expect((await store.changes(reviewer, 0)).changes.map(change => change.id)).toEqual([project.id])
    expect((await store.changes(outsider, 0)).changes).toEqual([])

    await sql`DELETE FROM enterprise_project_members WHERE tenant_id = ${alice.tenantId} AND project_id = ${projectId} AND user_id = ${alice.id}`
    const durable = await sql<{ user_id: string, reason: string }[]>`SELECT user_id, reason FROM enterprise_context_changes
      WHERE tenant_id = ${alice.tenantId} AND resource_id = ${project.id} AND operation = 'tombstone'`
    expect(durable).toEqual([{ user_id: alice.id, reason: 'access_revoked' }])
    const afterRevoke = await store.changes(alice, projectPage.cursor)
    expect(afterRevoke.changes).toContainEqual(expect.objectContaining({ operation: 'tombstone', reason: 'access_revoked', id: project.id }))
    expect(JSON.stringify(afterRevoke)).not.toContain('项目业务事实')
    expect(await store.changes(alice, projectPage.cursor)).toEqual(afterRevoke)
    expect((await store.changes(outsider, 0)).changes).toEqual([])
    await expect(store.get(alice, project.id)).rejects.toMatchObject({ status: 404 })
    await sql`INSERT INTO enterprise_project_members (tenant_id, project_id, user_id) VALUES (${alice.tenantId}, ${projectId}, ${alice.id})`
    const granted = await store.changes(alice, afterRevoke.cursor)
    expect(granted.changes).toContainEqual(expect.objectContaining({ operation: 'upsert', id: project.id, revision: projectActive.revision }))
    expect((await store.changes(alice, 0)).changes.some(change => change.operation === 'upsert' && change.id === project.id)).toBe(true)
    await sql`UPDATE enterprise_projects SET active = false WHERE tenant_id = ${alice.tenantId} AND id = ${projectId}`
    const archived = await store.changes(alice, granted.cursor)
    expect(archived.changes).toContainEqual(expect.objectContaining({ operation: 'tombstone', reason: 'access_revoked', id: project.id }))
    expect((await store.search(reviewer, { query: '采购收货单' })).items).toEqual([])
    await sql`UPDATE enterprise_projects SET active = true WHERE tenant_id = ${alice.tenantId} AND id = ${projectId}`
    const reopened = await store.changes(alice, archived.cursor)
    expect(reopened.changes).toContainEqual(expect.objectContaining({ operation: 'upsert', id: project.id, revision: projectActive.revision }))

    const team = await store.createCandidate(alice, { scope: 'team_shared', departmentId, body: '同部门报表核对规则' })
    await store.publish(reviewer, team.id, team.revision)
    expect((await store.search(outsider, { query: '报表核对' })).items).toEqual([])
    const teamPage = await store.changes(alice, reopened.cursor)
    expect(teamPage.changes).toContainEqual(expect.objectContaining({ operation: 'upsert', id: team.id }))
    await sql`UPDATE enterprise_users SET department_id = ${otherDepartmentId} WHERE tenant_id = ${alice.tenantId} AND id = ${alice.id}`
    const moved = await store.changes(alice, teamPage.cursor)
    expect(moved.changes).toContainEqual(expect.objectContaining({ operation: 'tombstone', reason: 'access_revoked', id: team.id }))
    await store.remove(reviewer, project.id, projectActive.revision)
    const removed = await store.changes(alice, moved.cursor)
    expect(removed.changes).toContainEqual(expect.objectContaining({ operation: 'tombstone', reason: 'deleted', id: project.id }))
  })
}, 20_000)

integration('filters before search, resolves citations only for ready knowledge, and retires expired entries', async () => {
  await withMemoryFixture(async ({ sql, store, alice, admin, outsider, projectId, departmentId, otherDepartmentId }) => {
    const expiring = await store.createCandidate(alice, { scope: 'user_private', body: '到期后自动清除的记忆',
      expiresAt: new Date(Date.now() + 60_000).toISOString() })
    await store.publish(alice, expiring.id, expiring.revision)
    const live = await store.changes(alice, 0)
    expect(live.changes).toContainEqual(expect.objectContaining({ operation: 'upsert', id: expiring.id }))
    await sql`UPDATE enterprise_memory_records SET expires_at = now() - interval '1 second'
      WHERE tenant_id = ${alice.tenantId} AND id = ${expiring.id}`
    expect((await store.search(alice, { query: '自动清除' })).items).toEqual([])
    const expired = await store.changes(alice, live.cursor)
    expect(expired.changes).toContainEqual(expect.objectContaining({ operation: 'tombstone', reason: 'expired', id: expiring.id }))

    const draft = await store.createKnowledge(admin, { scope: 'team_shared', departmentId, title: 'ERP 采购收货单手册',
      body: '采购收货单要核对组织编码。ERP receipt records must match the receiving department.',
      source: { label: 'Fixture ERP Handbook', url: 'https://docs.fixture.invalid/erp/receipt?section=7' } })
    expect((await store.searchKnowledge(alice, { query: '收货单' })).items).toEqual([])
    await expect(store.getKnowledge(alice, draft.id)).rejects.toMatchObject({ status: 404 })
    const ready = await store.publishKnowledge(admin, draft.id, draft.revision)
    const results = await store.searchKnowledge(alice, { query: '收货单' })
    expect(results.items).toContainEqual(expect.objectContaining({ id: draft.id, title: draft.title,
      citation: expect.objectContaining({ documentId: draft.id, revision: ready.revision, checksum: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      matchedTerms: expect.arrayContaining(['收货单']) }))
    expect((await store.searchKnowledge(alice, { query: 'receipt' })).items.map(row => row.id)).toEqual([draft.id])
    expect((await store.searchKnowledge(alice, { query: 'receipt' }, { modelProjectId: null, classifications: ['general'] })).items).toEqual([])
    expect((await store.searchKnowledge(alice, { query: 'receipt' }, { modelProjectId: null, classifications: ['internal'] })).items.map(row => row.id))
      .toEqual([draft.id])
    expect((await store.searchKnowledge(outsider, { query: '收货单' })).items).toEqual([])
    await expect(store.getKnowledge(outsider, draft.id)).rejects.toMatchObject({ status: 404 })
    await expect(store.createKnowledge(admin, { scope: 'project_private', projectId, title: 'Forbidden project handbook',
      body: 'Should not be stored by a non-member.', source: { label: 'Fixture' } })).rejects.toMatchObject({ status: 403 })
    const knowledgePage = await store.changes(alice, expired.cursor)
    expect(knowledgePage.changes).toContainEqual(expect.objectContaining({ resourceType: 'knowledge', id: draft.id, operation: 'upsert' }))
    const edited = await store.updateKnowledge(admin, draft.id, ready.revision, { scope: 'enterprise_reference', title: '新 ERP 手册' })
    const unpublished = await store.changes(alice, knowledgePage.cursor)
    expect(unpublished.changes).toContainEqual(expect.objectContaining({ resourceType: 'knowledge', id: draft.id, operation: 'tombstone', reason: 'unpublished' }))
    expect(JSON.stringify(unpublished)).not.toContain('采购收货单')
    await sql`UPDATE enterprise_users SET department_id = ${otherDepartmentId} WHERE tenant_id = ${admin.tenantId} AND id = ${admin.id}`
    expect((await store.searchKnowledge(alice, { query: '收货单' })).items).toEqual([])
    const published = await store.publishKnowledge(admin, draft.id, edited.revision)
    expect((await store.getKnowledge(outsider, draft.id, published.revision)).title).toBe('新 ERP 手册')
    await expect(store.getKnowledge(outsider, draft.id, ready.revision)).rejects.toMatchObject({ status: 410, code: 'KNOWLEDGE_CITATION_STALE' })
  })
}, 20_000)

integration('serves the memory HTTP contract with If-Match, safe idempotency and input rejection', async () => {
  await withMemoryFixture(async ({ store, alice, admin, projectId, departmentId }) => {
    const app = memoryApp(store, { 'alice-fixture': alice, 'admin-fixture': admin })
    const root = '/api/v1/memories'
    const authorization = { Authorization: 'Bearer alice-fixture' }
    const candidate = { scope: 'user_private', body: '报表筛选记忆 fixture' }
    const idempotency = { 'Idempotency-Key': randomUUID() }
    const request = (path: string, method: string, body: unknown, extra: Record<string, string> = {}) =>
      app.request(path, { method, body: JSON.stringify(body), headers: { ...authorization, 'Content-Type': 'application/json', ...extra } })

    expect((await app.request(root + '/changes')).status).toBe(401)
    const scopes = await app.request(root + '/scopes', { headers: authorization })
    expect(await scopes.json()).toMatchObject({ projects: [{ id: projectId }], department: { id: departmentId } })
    const adminScopes = await app.request(root + '/scopes', { headers: { Authorization: 'Bearer admin-fixture' } })
    expect(await adminScopes.json()).toMatchObject({ projects: [], department: { id: departmentId } })
    const initial = await request(root + '/candidates', 'POST', candidate, idempotency)
    expect(initial.status).toBe(201)
    expect(initial.headers.get('ETag')).toBe('"1"')
    const created = await initial.json() as { id: string }
    const repeated = await request(root + '/candidates', 'POST', candidate, idempotency)
    expect(await repeated.json()).toMatchObject({ id: created.id, revision: 1 })
    const wrongRetry = await request(root + '/candidates', 'POST', { ...candidate, body: '不同候选' }, idempotency)
    expect(wrongRetry.status).toBe(409)
    expect(await wrongRetry.json()).toMatchObject({ error: { code: 'MEMORY_IDEMPOTENCY_CONFLICT' } })
    expect((await request(root + '/candidates', 'POST', candidate, { 'Idempotency-Key': randomUUID() })).status).toBe(409)
    const badInput = await request(root + '/candidates', 'POST', { ...candidate, body: 'access_token=synthetic-test-secret' })
    expect(badInput.status).toBe(400)
    expect(await badInput.json()).toMatchObject({ error: { code: 'MEMORY_SENSITIVE_CONTENT' } })

    const path = root + '/' + created.id
    expect((await request(path, 'PATCH', { body: '未提供版本' })).status).toBe(400)
    const updated = await request(path, 'PATCH', { body: '最新的内容' }, { 'If-Match': '"1"' })
    expect(updated.status).toBe(200)
    expect(updated.headers.get('ETag')).toBe('"2"')
    const conflicted = await request(path, 'PATCH', { body: '保留的本次改动' }, { 'If-Match': '"1"' })
    expect(conflicted.status).toBe(409)
    expect(conflicted.headers.get('ETag')).toBe('"2"')
    expect(await conflicted.json()).toMatchObject({ error: { code: 'MEMORY_REVISION_CONFLICT' },
      current: { revision: 2, body: '最新的内容' }, submitted: { revision: 1, body: '保留的本次改动' } })
    expect((await app.request(path, { headers: { Authorization: 'Bearer admin-fixture' } })).status).toBe(404)
  })
}, 20_000)

integration('supports script-free memory review and knowledge publishing with the same ACL', async () => {
  await withMemoryFixture(async ({ store, alice, reviewer, admin, outsider, projectId, departmentId }) => {
    const app = memoryApp(store, { alice, reviewer, admin, outsider })
    function get(url: string, user: string) {
      return app.request(url, { headers: { Authorization: 'Bearer ' + user } })
    }
    function form(url: string, user: string, values: Record<string, string>) {
      const data = new FormData()
      for (const [key, value] of Object.entries(values)) data.set(key, value)
      return app.request(url, { method: 'POST', headers: { Authorization: 'Bearer ' + user }, body: data })
    }
    expect(await (await get('/console/memories', 'alice')).text()).toContain('新增候选记忆')
    const memory = await form('/console/memories/candidates', 'alice', {
      scope: 'project_private', projectId, body: '采购收货单示例 <script>fixture</script>',
    })
    expect(memory.status).toBe(303)
    const memoryPath = memory.headers.get('Location')!
    expect((await get(memoryPath, 'admin')).status).toBe(404)
    const review = await (await get(memoryPath, 'reviewer')).text()
    expect(review).toContain('审核发布')
    expect(review).toContain('&lt;script&gt;fixture&lt;/script&gt;')
    expect(review).not.toContain('<script>fixture</script>')
    expect((await form(memoryPath + '/publish', 'reviewer', { revision: '1' })).status).toBe(303)
    expect(await (await form('/console/memories/search', 'alice', { query: '采购收货单' })).text()).toContain('采购收货单示例')

    expect(await (await get('/console/knowledge', 'admin')).text()).toContain('登记知识')
    expect(await (await get('/console/knowledge', 'outsider')).text()).not.toContain('登记知识')
    const knowledge = await form('/console/knowledge/new', 'admin', { scope: 'team_shared', departmentId,
      title: '测试 ERP 收货手册', body: 'ERP 收货前复核收货部门。', sourceLabel: '测试部门资料', sourceUrl: 'https://docs.fixture.invalid/guide' })
    expect(knowledge.status).toBe(303)
    const managePath = knowledge.headers.get('Location')!
    const detailPath = managePath.replace(/\/edit$/u, '')
    expect((await get(detailPath, 'alice')).status).toBe(404)
    expect((await form(detailPath + '/publish', 'admin', { revision: '1' })).status).toBe(303)
    expect(await (await get(detailPath, 'alice')).text()).toContain('复核收货部门')
    expect((await get(detailPath, 'outsider')).status).toBe(404)
  })
}, 20_000)

integration('imports approved UTF-8 project files as scoped drafts, keeps provenance and deduplicates a retry', async () => {
  await withMemoryFixture(async ({ sql, store, alice, reviewer, admin, outsider, otherTenant, projectId }) => {
    const app = memoryApp(store, { alice, reviewer, admin, outsider, otherTenant,
      desktopReviewer: { ...reviewer, device: { id: randomUUID(), platform: 'win32', clientVersion: '0.7.7' } } })
    const api = '/api/v1/admin/knowledge'
    const console = '/console/knowledge'
    const document = '# 收货导入规则\r\n\r\n先核对批次追溯码。'
    const bytes = Buffer.from('\uFEFF' + document)
    const files = [
      new File([bytes], '收货导入规则.md', { type: 'text/markdown' }),
      new File(['异常收货录入规则。'], '收货异常.txt', { type: 'text/plain' }),
    ]
    function request(url: string, user: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers)
      headers.set('Authorization', 'Bearer ' + user)
      return app.request(url, { ...init, headers })
    }
    function importFiles(user: string, items: File[], path = api + '/import', project = projectId) {
      const form = new FormData()
      form.set('projectId', project)
      form.set('classification', 'internal')
      items.forEach(item => form.append('files', item))
      return request(path, user, { method: 'POST', body: form })
    }
    const home = await (await request(console, 'reviewer')).text()
    expect(home).toContain('批量导入项目资料')
    expect(home).toContain('multiple')
    expect(await (await request(console, 'alice')).text()).not.toContain('批量导入项目资料')
    for (const user of ['alice', 'admin', 'outsider', 'otherTenant']) {
      expect((await importFiles(user, files)).status).toBe(403)
    }
    expect((await importFiles('desktopReviewer', files)).status).toBe(401)
    expect((await importFiles('reviewer', files, api + '/import', randomUUID())).status).toBe(403)

    const concurrent = await Promise.all([importFiles('reviewer', files), importFiles('reviewer', files)])
    expect(concurrent.map(response => response.status).sort()).toEqual([200, 201])
    const first = concurrent.find(response => response.status === 201)!
    const { items } = await first.json() as { items: { created: boolean, document: { id: string } }[] }
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ created: true, document: { title: '收货导入规则', projectId, scope: 'project_private', status: 'draft',
      revision: 1, indexRevision: null, source: { label: '收货导入规则.md', file: { name: '收货导入规则.md', format: 'markdown',
        sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, lines: 3 } } } })
    expect(items[0]?.document).not.toHaveProperty('body')
    const id = items[0]!.document.id
    expect(await concurrent.find(response => response.status === 200)!.json()).toMatchObject({
      items: items.map(item => ({ created: false, document: { id: item.document.id } })),
    })
    expect((await request('/api/v1/knowledge/' + id, 'alice')).status).toBe(404)
    expect((await store.searchKnowledge(alice, { query: '批次追溯码' })).items).toEqual([])
    expect((await request(api + '/' + id, 'alice')).status).toBe(403)
    expect(await (await request(api + '/' + id, 'reviewer')).json()).toMatchObject({ body: document.replaceAll('\r\n', '\n') })

    const repeat = await importFiles('reviewer', files)
    expect(repeat.status).toBe(200)
    expect(await repeat.json()).toMatchObject({ items: items.map(item => ({ created: false, document: { id: item.document.id } })) })
    const confirm = await importFiles('reviewer', files, console + '/import')
    expect(confirm.status).toBe(200)
    expect(await confirm.text()).toContain('已有资料')
    const conflict = await importFiles('reviewer', [new File(['另一份材料。'], '新资料.md'),
      new File(['与已导入资料同名但内容不同。'], '收货导入规则.md')])
    expect(conflict.status).toBe(409)
    expect((await store.listKnowledge(reviewer)).map(item => item.id).sort()).toEqual(items.map(item => item.document.id).sort())
    const moveScope = await request(api + '/' + id, 'reviewer', { method: 'PATCH', headers: { 'If-Match': '"1"', 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'enterprise_reference' }) })
    expect(moveScope.status).toBe(403)

    const edit = await request(api + '/' + id, 'reviewer', { method: 'PATCH', headers: { 'If-Match': '"1"', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { label: '核对后的文件来源' } }) })
    expect(edit.status).toBe(200)
    expect(await edit.json()).toMatchObject({ revision: 2, source: { label: '核对后的文件来源', file: { name: '收货导入规则.md' } } })
    const publish = await request(console + '/' + id + '/publish', 'reviewer', { method: 'POST', body: new URLSearchParams({ revision: '2' }) })
    expect(publish.status).toBe(303)
    const result = await store.searchKnowledge(alice, { query: '批次追溯码' })
    expect(result.items[0]).toMatchObject({ id, revision: 3, indexRevision: 3, source: { file: { format: 'markdown' } },
      citation: { documentId: id, revision: 3, checksum: expect.stringMatching(/^[a-f0-9]{64}$/u) } })
    expect((await request('/api/v1/knowledge/' + id, 'outsider')).status).toBe(404)
    expect((await request('/api/v1/knowledge/' + id, 'otherTenant')).status).toBe(404)
    await sql`INSERT INTO enterprise_project_members (tenant_id, project_id, user_id) VALUES (${admin.tenantId}, ${projectId}, ${admin.id})`
    expect((await importFiles('admin', [new File(['同项目管理员可维护项目材料。'], '管理员补充.txt')])).status).toBe(201)
    await sql`DELETE FROM enterprise_project_members WHERE tenant_id = ${reviewer.tenantId} AND project_id = ${projectId} AND user_id = ${reviewer.id}`
    expect((await request(api + '/' + id, 'reviewer')).status).toBe(404)
    expect((await importFiles('reviewer', files)).status).toBe(403)
  })
}, 20_000)

integration('rejects malformed or mixed invalid imports atomically without rendering uploaded text as HTML', async () => {
  await withMemoryFixture(async ({ store, reviewer, projectId }) => {
    const app = memoryApp(store, { reviewer })
    const path = '/console/knowledge/import'
    function form(items: File[]) {
      const body = new FormData()
      body.set('projectId', projectId)
      items.forEach(item => body.append('files', item))
      return app.request(path, { method: 'POST', headers: { Authorization: 'Bearer reviewer' }, body })
    }
    const valid = new File(['核对 <script>fixture</script> 与真实材料。'], '项目证据.txt')
    const badInputs = [
      [],
      [valid, new File(['无效格式'], '材料.pdf', { type: 'application/pdf' })],
      [valid, new File([Uint8Array.from([0xff, 0xfe, 0x00, 0x5a])], '损坏.txt')],
      [valid, new File(['正文\u0000内容'], '二进制.md')],
      [valid, new File(['\r\n\t '], '空文件.txt')],
      [valid, new File(['不同文字'], '项目证据.TXT')],
      [valid, new File(['另一个文件'], '../目录上层.txt')],
      [valid, new File(['access_token=fixture-only-placeholder'], '脱敏前.txt')],
      Array.from({ length: 9 }, (_, index) => new File(['示例文本'], `材料${index}.txt`)),
    ]
    for (const files of badInputs) expect((await form(files)).status).toBe(400)
    expect((await form([valid, new File(['采购'.repeat(4000)], '过大.txt')])).status).toBe(413)
    expect(await store.listKnowledge(reviewer)).toEqual([])
    const accepted = await form([valid])
    expect(accepted.status).toBe(201)
    const result = await accepted.text()
    expect(result).toContain('待发布')
    expect(result).toContain('项目证据')
    expect(result).not.toContain('fixture</script>')
  })
}, 20_000)
