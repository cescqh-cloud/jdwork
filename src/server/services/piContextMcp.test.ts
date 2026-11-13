import { expect, test } from 'bun:test'
import { handlePiContextMcpRequest, piContextMcpConfig } from './piContextMcp.js'

const id = 'fixture-session'
const token = 'fixture_session_secret_123456789'
const path = `/api/pi-context-mcp/${id}`
const url = `http://127.0.0.1:17463${path}`
const selection = { providerId: 'personal-provider', modelId: 'personal-model' }

function rpc(method: string, params = {}, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request(url, { method: 'POST', signal, headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers,
  }, body: JSON.stringify({ jsonrpc: '2.0', method, id: 1, params }) })
}

test('personal models receive only the authorized shared knowledge tools', async () => {
  const calls: string[] = []
  const session = { authorize: (sid: string, value: string | null) => sid === id && value === token, selection: () => selection }
  const runtime = { piContext: async (input: { kind: string }) => {
    calls.push(input.kind)
    return { kind: input.kind, text: input.kind === 'prompt' ? '共享规范' : '真实来源：采购单' }
  } }
  const config = JSON.parse(piContextMcpConfig(`ws://127.0.0.1:17463/sdk/${id}?token=${token}`))
  expect(config.mcpServers['liyuan-shared-context'].url).toBe(url)
  const list = await handlePiContextMcpRequest(rpc('tools/list'), path, session, runtime)
  expect(await list.json()).toMatchObject({ result: { tools: [
    { name: 'search_workbench_knowledge', annotations: { readOnlyHint: true } },
    { name: 'search_workbench_memory', annotations: { readOnlyHint: true } },
  ] } })
  const result = await handlePiContextMcpRequest(rpc('tools/call', { name: 'search_workbench_knowledge', arguments: { query: '采购' } }), path, session, runtime)
  expect(await result.json()).toMatchObject({ result: { content: [{ type: 'text', text: '真实来源：采购单' }] } })
  expect(calls).toEqual(['prompt', 'prompt', 'knowledge'])
  expect((await handlePiContextMcpRequest(rpc('tools/list', {}, { origin: 'http://untrusted.invalid' }), path, session, runtime)).status).toBe(403)
  expect((await handlePiContextMcpRequest(rpc('tools/list', {}, { authorization: 'Bearer wrong' }), path, session, runtime)).status).toBe(403)
  expect((await handlePiContextMcpRequest(rpc('tools/list'), path, {
    ...session,
    selection: () => ({ providerId: 'enterprise:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa:fixture', modelId: 'fixture' }),
  }, runtime)).status).toBe(403)
})

test('results are not returned after a model switch, cancellation, or lost authorization', async () => {
  let current = { ...selection }
  let allow = true
  const session = { authorize: () => allow, selection: () => current }
  for (const scenario of ['switch', 'cancel', 'revoke'] as const) {
    current = { ...selection }
    allow = true
    let release!: () => void
    let started!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const startedSignal = new Promise<void>(resolve => { started = resolve })
    const runtime = { piContext: async (input: { kind: string }) => {
      if (input.kind === 'prompt') return { kind: 'prompt', text: '共享规范' }
      started()
      await pending
      return { kind: input.kind, text: 'PRIVATE_FIXTURE' }
    } }
    const abort = new AbortController()
    const result = handlePiContextMcpRequest(rpc('tools/call', { name: 'search_workbench_memory', arguments: { query: '经验' } }, {}, abort.signal), path, session, runtime)
    await startedSignal
    if (scenario === 'switch') current = { providerId: 'another', modelId: 'model' }
    if (scenario === 'cancel') abort.abort()
    if (scenario === 'revoke') allow = false
    release()
    expect(await (await result).text()).not.toContain('PRIVATE_FIXTURE')
  }
})

test('falls back to builtin kingdee knowledge when remote context is offline or unbound', async () => {
  const session = { authorize: (sid: string, value: string | null) => sid === id && value === token, selection: () => selection }
  const offlineRuntime = { piContext: async () => null }
  const result = await handlePiContextMcpRequest(rpc('tools/call', { name: 'search_workbench_knowledge', arguments: { query: 'OperationServiceHelper' } }), path, session, offlineRuntime)
  const jsonResult = await result.json()
  expect(jsonResult.result.content[0].text).toContain('OperationServiceHelper')
})
