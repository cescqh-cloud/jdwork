import { expect, test } from 'bun:test'
import { enterpriseContextMcpConfig, handleEnterpriseContextMcpRequest } from './enterpriseContextMcp.js'
import type { EnterpriseContextQuery, EnterpriseModel } from '../../shared/enterpriseModels.js'
import type { EnterpriseErpQuery, EnterpriseErpResult } from '../../shared/enterpriseErp.js'

const id = 'fixture-session'
const token = 'fixture_session_secret_123456789'
const path = `/api/enterprise/context-mcp/${id}`
const url = `http://127.0.0.1:17463${path}`
const model: EnterpriseModel = {
  providerId: 'enterprise:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa:fixture', modelId: 'model', displayName: 'Fixture',
  protocol: 'openai', capabilities: ['text', 'tools'], contextWindow: 16_000, maxOutputTokens: 1000,
  defaultEffort: null, proxyEndpoint: '/api/v1/model-gateway/openai', projectId: null, isDefault: true,
  quota: { dailyTokens: null, softDailyTokens: null }, canSearchContext: true,
}

function rpc(method: string, params = {}, headers: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers,
  }, body: JSON.stringify({ jsonrpc: '2.0', method, id: 1, params }) })
}

test('registers a read-only local MCP server and retrieves only for the live authorized enterprise model', async () => {
  let selection = { providerId: model.providerId, modelId: model.modelId }
  const session = { authorize: (sid: string, key: string) => sid === id && key === token, selection: () => selection }
  const calls: EnterpriseContextQuery[] = []
  const runtime = {
    model: async (providerId: string, modelId: string) => providerId === model.providerId && modelId === model.modelId ? model : null,
    context: async (_model: EnterpriseModel, query: EnterpriseContextQuery) => {
      calls.push(query)
      return { revision: 1, modelId: model.modelId, projectId: null, memories: [], knowledge: [] }
    },
  }
  const config = JSON.parse(enterpriseContextMcpConfig(`ws://127.0.0.1:17463/sdk/${id}?token=${token}`))
  expect(config.mcpServers['liyuan-enterprise-context']).toEqual({ type: 'http', url, headers: { Authorization: `Bearer ${token}` } })
  expect(() => enterpriseContextMcpConfig(`ws://external.invalid/sdk/${id}?token=${token}`)).toThrow()
  expect((await handleEnterpriseContextMcpRequest(rpc('tools/list', {}, { origin: 'http://127.0.0.1' }), path, session, runtime)).status).toBe(403)
  expect((await handleEnterpriseContextMcpRequest(rpc('tools/list', {}, { authorization: 'Bearer other' }), path, session, runtime)).status).toBe(403)
  const tools = await handleEnterpriseContextMcpRequest(rpc('tools/list'), path, session, runtime)
  expect(tools.status).toBe(200)
  expect(tools.headers.get('cache-control')).toBe('no-store')
  expect(await tools.json()).toMatchObject({ result: { tools: [{ name: 'search', annotations: { readOnlyHint: true } }] } })
  const answer = await handleEnterpriseContextMcpRequest(rpc('tools/call', { name: 'search', arguments: { query: ' ERP ' } }), path, session, runtime)
  expect(await answer.json()).toMatchObject({ result: { content: [{ type: 'text', text: expect.stringContaining('"knowledge":[]') }] } })
  expect(calls).toEqual([{ query: 'ERP', source: 'both', limit: 4 }])
  selection = { providerId: 'personal', modelId: 'local' }
  expect((await handleEnterpriseContextMcpRequest(rpc('tools/list'), path, session, runtime)).status).toBe(403)
  expect(calls).toHaveLength(1)
})

test('exposes only read-only ERP tools for an explicitly authorized enterprise model', async () => {
  const enabled = { ...model, canSearchContext: false, canQueryErp: true }
  const projectId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  const session = { authorize: (sid: string, key: string) => sid === id && key === token, selection: () => enabled }
  const calls: unknown[] = []
  const runtime = {
    model: async () => enabled,
    context: async () => { throw new Error('Knowledge search must be disabled in this fixture') },
    erp: async (chosen: EnterpriseModel, sessionId: string, query: unknown) => {
      calls.push({ chosen, sessionId, query })
      return { action: 'list' as const, environments: [{ id: 'xh-uat', name: '星瀚测试', mode: 'test' as const,
        projects: [{ id: projectId, name: '采购项目' }], queries: [{ id: 'receipt', label: '收货查询', kind: 'document' as const, requiresNumber: true }] }] }
    },
  }
  const list = await handleEnterpriseContextMcpRequest(rpc('tools/list'), path, session, runtime)
  expect(list.status).toBe(200)
  expect(await list.json()).toMatchObject({ result: { tools: [
    { name: 'erp_list', annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'erp_read', annotations: { readOnlyHint: true, destructiveHint: false } },
  ] } })
  const result = await handleEnterpriseContextMcpRequest(rpc('tools/call', { name: 'erp_list', arguments: {} }), path, session, runtime)
  expect(await result.json()).toMatchObject({ result: { content: [{ type: 'text', text: expect.stringContaining('xh-uat') }] } })
  expect(calls).toEqual([{ chosen: enabled, sessionId: id, query: { action: 'list' } }])
  await handleEnterpriseContextMcpRequest(rpc('tools/call', { name: 'erp_read', arguments: {
    projectId, environmentId: 'xh-uat', operation: 'receipt', number: 'FIXTURE-001', path: '/kapi/fixture/other',
  } }), path, session, runtime)
  expect(calls).toHaveLength(1)
  const textOnly = { ...enabled, capabilities: ['text'] as EnterpriseModel['capabilities'] }
  expect((await handleEnterpriseContextMcpRequest(rpc('tools/list'), path, session, { ...runtime, model: async () => textOnly })).status).toBe(403)
})

test('suppresses an ERP reply if the model selection changes or the request is cancelled', async () => {
  const enabled = { ...model, canSearchContext: false, canQueryErp: true }
  let selection = { providerId: enabled.providerId, modelId: enabled.modelId }
  const session = { authorize: () => true, selection: () => selection }
  const row: EnterpriseErpResult = { action: 'list', environments: [{ id: 'xh-uat', name: 'private-fixture-label', mode: 'test', projects: [], queries: [] }] }
  const request = () => rpc('tools/call', { name: 'erp_list', arguments: {} })
  const modelLookup = { model: async () => enabled, context: async () => null }
  const stale = await handleEnterpriseContextMcpRequest(rpc('tools/list'), path, session, { ...modelLookup, model: async () => {
    selection = { providerId: 'personal', modelId: 'local' }
    return enabled
  }, erp: async () => row })
  expect(stale.status).toBe(403)

  for (const reason of ['switch', 'cancel'] as const) {
    selection = { providerId: enabled.providerId, modelId: enabled.modelId }
    const abort = new AbortController()
    let start!: (signal: AbortSignal) => void
    const started = new Promise<AbortSignal>(resolve => { start = resolve })
    let finish!: () => void
    const held = new Promise<void>(resolve => { finish = resolve })
    const runtime = { ...modelLookup, erp: async (_model: EnterpriseModel, _id: string, _query: EnterpriseErpQuery, signal?: AbortSignal) => {
      start(signal!)
      await held
      return row
    } }
    const response = handleEnterpriseContextMcpRequest(new Request(request(), { signal: abort.signal }), path, session, runtime)
    const forwarded = await started
    if (reason === 'switch') selection = { providerId: 'personal', modelId: 'local' }
    else { abort.abort(); expect(forwarded.aborted).toBe(true) }
    finish()
    const text = await (await response).text()
    expect(text).not.toContain('private-fixture-label')
    expect(text).toContain('no longer has access')
  }
})
