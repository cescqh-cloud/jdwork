import { afterAll, beforeAll, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { migrate } from '../src/migrate'
import { startControlRuntime } from '../src/runtime'

const databaseUrl = Bun.env.ENTERPRISE_TEST_DATABASE_URL
const redisUrl = Bun.env.ENTERPRISE_TEST_REDIS_URL
const integration = databaseUrl && redisUrl ? test : test.skip
const tenant = `model-${randomUUID().slice(0, 8)}`
const origin = 'http://127.0.0.1:8787'
const password = 'local-model-fixture-only'
const upstreamKey = 'local-provider-key-do-not-return'
const reviewText = { summary: '需要补充采购报表的验收口径。', questions: ['汇总按什么时间范围？'], risks: ['待核对组织权限。'] }
const anthropicPath = '/api/v1/model-gateway/anthropic/v1/messages'
const openAiPath = '/api/v1/model-gateway/openai/v1/chat/completions'
const anthropicFrames = [
  ['message_start', { type: 'message_start', message: { id: 'fixture-1', usage: { input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 3 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '模拟推理' } }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_fixture', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"采购"}' } }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([name, data]) => `event: ${name}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`)
const openAiFrames = [
  { choices: [{ index: 0, delta: { reasoning_content: '推理' } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_fixture', arguments: '{"id":' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 14, completion_tokens: 6 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).concat('data: [DONE]\n\n')

let runtime: Awaited<ReturnType<typeof startControlRuntime>>
let upstream: Bun.Server<undefined>
let db: SQL
let adminToken: string
let adminUser: string
let engineerToken: string
let requesterToken: string
let externalToken: string
let engineerDevice: string
let engineerUser: string
let projectId: string
let departmentId: string
let mockCancelled = false
const captured: { path: string, authorization: string | null, key: string | null, beta: string | null, payload: Record<string, unknown> }[] = []

const anthropicProvider = {
  id: 'a-provider', displayName: '部门模型', protocol: 'anthropic', authHeader: 'x-api-key', classifications: ['general', 'internal'], apiKey: upstreamKey,
}
const anthropicModel = {
  id: 'department-model', displayName: '部门代码模型', providerId: 'a-provider', upstreamModel: 'mock-anthropic',
  contextWindow: 1024, maxOutputTokens: 64, capabilities: ['text', 'tools', 'reasoning'], defaultEffort: 'medium', allowedRoles: ['developer'], isDefault: true, allowContext: true,
}

function fragmented(frames: string[]) {
  const bytes = new TextEncoder().encode(frames.join(''))
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= bytes.length) { controller.close(); return }
      controller.enqueue(bytes.subarray(index, index + 11))
      index += 11
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
}

function request(path: string, accessToken?: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers = new Headers(extra)
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  return fetch(new URL(path, runtime.server.url), { method: body === undefined ? 'GET' : 'POST', headers,
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(8000) })
}

async function json<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
  const resolved = await response
  const body = await resolved.json()
  if (resolved.status !== status) throw new Error(`Expected status ${status}, got ${resolved.status}: ${JSON.stringify(body)}`)
  return body as T
}

async function waitFor<T>(read: () => T | Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 3500
  let value = await read()
  while (!ready(value) && Date.now() < deadline) {
    await Bun.sleep(35)
    value = await read()
  }
  return value
}

async function login(loginName: string, organization = tenant) {
  return (await json<{ accessToken: string }>(request('/api/v1/auth/exchange', undefined, { tenant: organization, login: loginName, password }))).accessToken
}

async function enroll(webToken: string) {
  const { challenge } = await json<{ challenge: string }>(request('/api/v1/devices/challenge', webToken, {}), 201)
  const { publicKey: edPublic, privateKey } = generateKeyPairSync('ed25519')
  const publicKey = edPublic.export({ type: 'spki', format: 'der' }).toString('base64url')
  const deviceId = randomUUID()
  const platform = 'win32'
  const clientVersion = '0.7.7'
  const signature = sign(null, Buffer.from(JSON.stringify(['enterprise-enroll-v1', challenge, deviceId, publicKey, platform, clientVersion])), privateKey).toString('base64url')
  const tokens = await json<{ accessToken: string }>(request('/api/v1/devices/enroll', undefined, { challenge, deviceId, publicKey, platform, clientVersion, signature }), 201)
  return { deviceId, token: tokens.accessToken }
}

async function grant(modelId: string, project?: string, token = engineerToken) {
  return json<{ accessToken: string, expiresAt: string, proxyEndpoint: string }>(request('/api/v1/models/grants', token,
    { modelId, projectId: project, sessionId: 'cc-haha-session-42' }), 201)
}

if (databaseUrl && redisUrl) {
  const database = new URL(databaseUrl)
  if (database.hostname !== '127.0.0.1' || !database.pathname.endsWith('_test') || new URL(redisUrl).hostname !== '127.0.0.1') {
    throw new Error('The model gateway test requires disposable loopback database and Redis instances.')
  }
  beforeAll(async () => {
    db = new SQL(databaseUrl)
    await migrate(db)
    upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      const path = new URL(req.url).pathname
      const payload = await req.json() as Record<string, unknown>
      captured.push({ path, authorization: req.headers.get('Authorization'), key: req.headers.get('x-api-key'), beta: req.headers.get('anthropic-beta'), payload })
      if (payload.model === 'mock-budget') return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(anthropicFrames[0]!)) },
        cancel() { mockCancelled = true },
      }), { headers: { 'Content-Type': 'text/event-stream' } })
      if (payload.model === 'mock-rate') return Response.json({ error: upstreamKey }, { status: 429, headers: { 'Retry-After': '4' } })
      if (payload.model === 'mock-demand-review') return Response.json({ choices: [{ message: { content: JSON.stringify(reviewText) } }],
        usage: { prompt_tokens: 77, completion_tokens: 30 } })
      if (path.endsWith('/count_tokens')) return Response.json({ input_tokens: 11 })
      if (path.endsWith('/chat/completions')) return fragmented(openAiFrames)
      return fragmented(anthropicFrames)
    } })
    const baseUrl = `${upstream.url.origin}/v1`
    runtime = await startControlRuntime({ host: '127.0.0.1', port: 0, origin, databaseUrl, redisUrl, localLogin: true,
      modelGateway: { allowLoopback: true, encryptionKey: randomBytes(32), allowedUpstreams: new Set([baseUrl]) }, demandPrecheckModel: 'demand-review' })
    adminUser = await runtime.store.createLocalUser('Model fixtures', { tenant, login: 'admin', displayName: 'Admin', password, roles: ['platform_admin'] })
    engineerUser = await runtime.store.createLocalUser('Model fixtures', { tenant, login: 'engineer', displayName: 'Engineer', password, roles: ['developer'] })
    await runtime.store.createLocalUser('Model fixtures', { tenant, login: 'requester', displayName: 'Requester', password, roles: ['requester'] })
    await runtime.store.createLocalUser('Separate tenant', { tenant: `${tenant}-separate`, login: 'engineer', displayName: 'Other engineer', password, roles: ['developer'] })
    adminToken = await login('admin')
    const engineer = await enroll(await login('engineer'))
    engineerToken = engineer.token
    engineerDevice = engineer.deviceId
    requesterToken = (await enroll(await login('requester'))).token
    externalToken = (await enroll(await login('engineer', `${tenant}-separate`))).token
    await json(request('/api/v1/admin/models/providers', adminToken, { ...anthropicProvider, baseUrl }))
    await json(request('/api/v1/admin/models/providers', adminToken, { ...anthropicProvider, id: 'o-provider', baseUrl, protocol: 'openai', authHeader: 'bearer' }))
    await json(request('/api/v1/admin/models/catalog', adminToken, anthropicModel))
    await json(request('/api/v1/admin/models/catalog', adminToken, { ...anthropicModel, id: 'openai-model', providerId: 'o-provider', upstreamModel: 'mock-openai', isDefault: false, allowContext: false }))
    await json(request('/api/v1/admin/models/catalog', adminToken, { ...anthropicModel, id: 'limited', upstreamModel: 'mock-budget', isDefault: false, dailyTokens: 1500, softDailyTokens: 1000 }))
    await json(request('/api/v1/admin/models/catalog', adminToken, { ...anthropicModel, id: 'retry-model', providerId: 'o-provider', upstreamModel: 'mock-rate', isDefault: false }))
    await json(request('/api/v1/admin/models/catalog', adminToken, { ...anthropicModel, id: 'demand-review', providerId: 'o-provider', upstreamModel: 'mock-demand-review', allowedRoles: ['requester'], isDefault: false }))
    projectId = (await json<{ id: string }>(request('/api/v1/admin/model-projects', adminToken, { name: 'Internal ERP', classification: 'internal' }))).id
    await json(request('/api/v1/admin/model-project-memberships', adminToken, { projectId, userId: engineerUser, enabled: true }))
    await json(request('/api/v1/admin/models/catalog', adminToken, { ...anthropicModel, id: 'project-model', projectId }))
    departmentId = (await json<{ id: string }>(request('/api/v1/admin/model-departments', adminToken, { name: 'Development' }))).id
    await json(request('/api/v1/admin/model-department-assignments', adminToken, { departmentId, userId: engineerUser }))
  }, 20_000)
  afterAll(async () => { await runtime?.close(); await upstream?.stop(true); await db?.close() })
}

type Catalog = { revision: number, expiresAt: string, models: { modelId: string, isDefault: boolean }[] }

integration('enforces model role, project membership, classification and organization without exposing provider credentials', async () => {
  const catalog = await json<Catalog>(request('/api/v1/models/catalog', engineerToken))
  expect(catalog.models.find(model => model.isDefault)?.modelId).toBe('department-model')
  expect(catalog.models.some(model => model.modelId === 'project-model')).toBe(false)
  expect(Date.parse(catalog.expiresAt) - Date.now()).toBeLessThanOrEqual(30_000)
  expect((await json<Catalog>(request('/api/v1/models/catalog', requesterToken))).models.map(model => model.modelId)).toEqual(['demand-review'])
  expect((await json<Catalog>(request('/api/v1/models/catalog', externalToken))).models).toEqual([])
  const projectCatalog = await json<Catalog>(request(`/api/v1/models/catalog?projectId=${projectId}`, engineerToken))
  expect(projectCatalog.models.find(model => model.isDefault)?.modelId).toBe('project-model')
  expect((await request(`/api/v1/models/catalog?projectId=${projectId}`, requesterToken)).status).toBe(403)
  expect((await request('/api/v1/models/grants', requesterToken, { modelId: 'department-model', sessionId: 'session' })).status).toBe(403)
  expect((await request('/api/v1/models/grants', engineerToken, { modelId: 'project-model', sessionId: 'session' })).status).toBe(403)
  expect((await request('/api/v1/admin/models', engineerToken)).status).toBe(401)
  expect((await request('/api/v1/admin/models', await login('requester'))).status).toBe(403)
  const admin = await request('/api/v1/admin/models', adminToken)
  expect(admin.status).toBe(200)
  const adminBody = await admin.text()
  expect(adminBody).not.toContain(upstreamKey)
  expect(adminBody).not.toContain('sealed_key')
  expect(JSON.stringify(projectCatalog)).not.toContain(upstreamKey)
  const [credential] = await db<{ sealed_key: string }[]>`SELECT p.sealed_key FROM enterprise_model_providers p JOIN enterprise_tenants t ON t.id = p.tenant_id
    WHERE t.slug = ${tenant} AND p.id = 'a-provider'`
  expect(credential?.sealed_key).toMatch(/^v1\./u)
  expect(credential?.sealed_key).not.toContain(upstreamKey)
  const html = await request('/console/models?provider=a-provider', adminToken)
  expect(html.status).toBe(200)
  const consoleBody = await html.text()
  expect(consoleBody).toContain('模型中心')
  expect(consoleBody).not.toContain(upstreamKey)
  expect((await request('/api/v1/admin/models/providers', adminToken, { ...anthropicProvider, baseUrl: `${upstream.url.origin}/different` })).status).toBe(400)
}, 15_000)

integration('streams unchanged Anthropic and OpenAI tool chunks and accounts real provider tokens by device and project', async () => {
  const a = await grant('project-model', projectId)
  expect(a.proxyEndpoint).toBe('/api/v1/model-gateway/anthropic')
  expect(Date.parse(a.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000)
  const response = await request(anthropicPath, undefined, { model: 'project-model', stream: true, max_tokens: 64,
    messages: [{ role: 'user', content: '采购工具模拟' }], tools: [{ name: 'read_fixture' }] }, { 'x-api-key': a.accessToken, 'anthropic-beta': 'fixture-beta' })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(anthropicFrames.join(''))
  expect(captured.at(-1)).toMatchObject({ path: '/v1/messages', key: upstreamKey, authorization: null, beta: 'fixture-beta',
    payload: { model: 'mock-anthropic', max_tokens: 64, tools: [{ name: 'read_fixture' }] } })
  expect(await json(request(`${anthropicPath}/count_tokens`, a.accessToken, { model: 'project-model', messages: [] }))).toEqual({ input_tokens: 11 })

  const o = await grant('openai-model')
  const openAi = await request(openAiPath, o.accessToken, { model: 'openai-model', stream: true, max_completion_tokens: 64, messages: [] })
  expect(openAi.status).toBe(200)
  expect(await openAi.text()).toBe(openAiFrames.join(''))
  expect(captured.at(-1)).toMatchObject({ path: '/v1/chat/completions', key: null, authorization: `Bearer ${upstreamKey}`,
    payload: { model: 'mock-openai', max_completion_tokens: 64, stream_options: { include_usage: true } } })
  expect((await request(openAiPath, a.accessToken, { model: 'project-model' })).status).toBe(403)
  expect((await request(openAiPath, o.accessToken, { model: 'openai-model', max_completion_tokens: 65 })).status).toBe(400)
  const usage = await json<{ usage: unknown[] }>(request('/api/v1/model-usage/me', engineerToken))
  expect(usage.usage).toEqual(expect.arrayContaining([
    expect.objectContaining({ modelId: 'project-model', projectId, departmentId, deviceId: engineerDevice, chargedTokens: '21', reportedInputTokens: '14', reportedOutputTokens: '7' }),
    expect.objectContaining({ modelId: 'openai-model', chargedTokens: '20', reportedInputTokens: '14', reportedOutputTokens: '6' }),
  ]))
  expect((await json<{ usage: unknown[] }>(request('/api/v1/model-usage/me', requesterToken))).usage).toEqual([])
}, 15_000)

integration('reserves budget across overlapping requests, cancels upstream and returns safe retry metadata', async () => {
  const limited = await grant('limited')
  const abort = new AbortController()
  const streamed = await fetch(new URL(anthropicPath, runtime.server.url), { method: 'POST', signal: abort.signal,
    headers: { Authorization: `Bearer ${limited.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'limited', stream: true, max_tokens: 64, messages: [] }) })
  expect(streamed.status).toBe(200)
  expect(streamed.headers.get('X-Enterprise-Budget-Warning')).toBe('near-limit')
  const reader = streamed.body!.getReader()
  try {
    expect((await reader.read()).done).toBe(false)
    const parallel = await request(anthropicPath, limited.accessToken, { model: 'limited', max_tokens: 64 })
    expect(parallel.status).toBe(429)
    expect((await parallel.text())).toContain('daily token allowance')
  } finally { abort.abort(); await reader.cancel().catch(() => {}) }
  expect(await waitFor(() => mockCancelled, Boolean)).toBe(true)
  const settled = await waitFor(async () => {
    const [row] = await db<{ status: string, charged: string, source: string }[]>`SELECT status, charged_tokens::text AS charged, usage_source AS source
      FROM enterprise_model_usage WHERE device_id = ${engineerDevice} AND model_id = 'limited'`
    return row
  }, row => row?.status === 'cancelled')
  expect(settled).toEqual({ status: 'cancelled', charged: '1088', source: 'reserved' })
  const retry = await grant('retry-model')
  const failed = await request(openAiPath, retry.accessToken, { model: 'retry-model' })
  expect(failed.status).toBe(429)
  expect(failed.headers.get('Retry-After')).toBe('4')
  expect(await failed.text()).not.toContain(upstreamKey)
}, 15_000)

integration('runs a real web demand precheck through the authorized gateway without sending raw credentials or issuing a desktop grant', async () => {
  const web = await login('requester')
  const draft = { title: '采购报表 api_key=fixture-secret-value', systemKey: 'ERP', category: '报表',
    businessContext: '补充采购订单状态筛选。密码为fixture-password-value', acceptanceCriteria: '按组织筛选',
    businessOwner: 'private-business-owner', attachmentRefs: [{ id: 'private-attachment', name: 'private attachment' }] }
  const created = await json<{ id: string, draftRevision: number }>(request('/api/v1/demands', web, { draft }), 201)
  const route = `/api/v1/demands/${created.id}/precheck`
  const input = { expectedDraftRevision: created.draftRevision }
  expect((await request(route, web, { ...input, modelId: 'openai-model' })).status).toBe(403)
  const before = captured.length
  const reviewed = await json<{ state: string, precheck: unknown }>(request(route, web, input))
  expect(reviewed.precheck).toMatchObject(reviewText)
  expect(reviewed.state).toBe('AI_PRECHECK')
  const sent = captured.at(-1)?.payload
  expect(sent).toMatchObject({ model: 'mock-demand-review', stream: false })
  expect(JSON.stringify(sent)).toContain('[已脱敏]')
  for (const privateValue of ['fixture-secret-value', 'fixture-password-value', 'private-business-owner', 'private-attachment', created.id]) {
    expect(JSON.stringify(sent)).not.toContain(privateValue)
  }
  expect(JSON.stringify(sent)).not.toContain('"tools"')
  expect((await json<{ precheck: unknown }>(request(route, web, input))).precheck).toEqual(reviewed.precheck)
  expect(captured.length).toBe(before + 1)
  const usage = await json<{ usage: unknown[] }>(request('/api/v1/model-usage/me', web))
  expect(usage.usage).toContainEqual(expect.objectContaining({ deviceId: null, modelId: 'demand-review', purpose: 'demand_precheck', chargedTokens: '107' }))
}, 15_000)

integration('retrieves only the currently selected model and project context, with ready citations and data classification', async () => {
  const context = '/api/v1/models/context'
  await json(request('/api/v1/admin/model-project-memberships', adminToken, { projectId, userId: adminUser, enabled: true }))
  type Revision = { id: string, revision: number }
  async function publishMemory(token: string, text: string) {
    const memory = await json<Revision>(request('/api/v1/memories/candidates', token, { scope: 'user_private', body: text, classification: 'internal' }), 201)
    return json<Revision>(request(`/api/v1/memories/${memory.id}/publish`, token, {}, { 'If-Match': `"${memory.revision}"` }))
  }
  const engineer = await publishMemory(engineerToken, '采购验收依据订单编号核对。')
  await publishMemory(requesterToken, '采购验收，另一位同事的私人偏好。')
  async function knowledge(title: string, classification: string, scope: 'enterprise_reference' | 'project_private', published: boolean) {
    const record = await json<Revision>(request('/api/v1/admin/knowledge', adminToken, { title, body: '采购验收要求核对交付证据。',
      scope, classification, projectId: scope === 'project_private' ? projectId : undefined, source: { label: '测试流程说明' } }), 201)
    return published ? json<Revision>(request(`/api/v1/admin/knowledge/${record.id}/publish`, adminToken, {}, { 'If-Match': `"${record.revision}"` })) : record
  }
  const open = await knowledge('采购验收公开规则', 'general', 'enterprise_reference', true)
  const restricted = await knowledge('采购验收受限规则', 'restricted', 'enterprise_reference', true)
  const draft = await knowledge('采购验收未发布草稿', 'general', 'enterprise_reference', false)
  const project = await knowledge('采购验收项目规则', 'internal', 'project_private', true)
  const query = { query: '采购验收', limit: 6 }
  type Context = { memories: { id: string }[], knowledge: { citation: { documentId: string, revision: number, href: string } }[] }
  const result = await json<Context>(request(context, engineerToken, { ...query, modelId: 'department-model' }))
  expect(result.memories.map(item => item.id)).toEqual([engineer.id])
  expect(result.knowledge.map(item => item.citation.documentId)).toEqual([open.id])
  const inProject = await json<Context>(request(context, engineerToken, { ...query, modelId: 'project-model', projectId }))
  const ids = inProject.knowledge.map(item => item.citation.documentId)
  expect(ids).toContain(project.id)
  expect(ids).toContain(open.id)
  expect(ids).not.toContain(draft.id)
  expect(ids).not.toContain(restricted.id)
  expect(inProject.knowledge.find(item => item.citation.documentId === project.id)?.citation.href).toBe(`/api/v1/knowledge/${project.id}?revision=${project.revision}`)
  expect((await request(context, engineerToken, { ...query, modelId: 'openai-model' })).status).toBe(403)
  expect((await request(context, adminToken, { ...query, modelId: 'project-model', projectId })).status).toBe(401)
  expect((await request(context, requesterToken, { ...query, modelId: 'project-model', projectId })).status).toBe(403)
}, 15_000)

integration('catalog policy events clear stale authorization and revocation invalidates existing grants', async () => {
  const a = await grant('project-model', projectId)
  const global = await grant('department-model')
  const initial = await json<Catalog>(request('/api/v1/models/catalog', engineerToken))
  await json(request('/api/v1/admin/model-project-memberships', adminToken, { projectId, userId: engineerUser, enabled: false }))
  const removed = await request(anthropicPath, a.accessToken, { model: 'project-model' })
  expect(removed.status).toBe(403)
  const updated = await json<Catalog>(request('/api/v1/models/catalog', engineerToken))
  expect(updated.revision).toBeGreaterThan(initial.revision)
  const timeline = await json<{ events: { type: string, revision: number }[] }>(request('/api/v1/events?cursor=0', engineerToken))
  expect(timeline.events).toContainEqual(expect.objectContaining({ type: 'model.policy.changed', revision: updated.revision }))
  await json(request('/api/v1/devices/revoke', adminToken, { deviceId: engineerDevice }))
  expect((await request(anthropicPath, global.accessToken, { model: 'department-model' })).status).toBe(401)
  expect((await request('/api/v1/models/catalog', engineerToken)).status).toBe(401)
}, 15_000)
