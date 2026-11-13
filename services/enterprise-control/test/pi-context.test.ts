import { expect, test } from 'bun:test'
import { createPiContext } from '../src/pi-context'

const origin = 'http://192.168.254.203:8080'
const token = 'a'.repeat(43)

test('reads only approved Pi prompts and shared knowledge through the fixed server', async () => {
  const calls: Array<{ url: string; authorization: string | null; method: string; name: unknown }> = []
  const fetcher = (async (input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: string; method: string; params: { name: unknown } }
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), method: request.method, name: request.params.name })
    expect(init?.redirect).toBe('error')
    return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'prompts/get'
      ? { messages: [{ content: { type: 'text', text: '共享工作规范' } }] }
      : { content: [{ type: 'text', text: '带路径和行号的共享资料' }] } })
  }) as typeof fetch
  const client = createPiContext({ origin, token }, fetcher)
  expect(await client.read({ kind: 'prompt' })).toBe('共享工作规范')
  expect(await client.read({ kind: 'knowledge', query: '采购收货' })).toBe('带路径和行号的共享资料')
  expect(await client.read({ kind: 'memory', query: '交付经验' })).toBe('带路径和行号的共享资料')
  expect(calls).toEqual([
    { url: origin + '/api/desktop/context/mcp', authorization: 'Bearer ' + token, method: 'prompts/get', name: 'workbench' },
    { url: origin + '/api/desktop/context/mcp', authorization: 'Bearer ' + token, method: 'tools/call', name: 'search_knowledge' },
    { url: origin + '/api/desktop/context/mcp', authorization: 'Bearer ' + token, method: 'tools/call', name: 'search_project_memory' },
  ])
})

test('rejects untrusted origins, oversized or invalid input, and never returns its server credential', async () => {
  expect(() => createPiContext({ origin: 'http://user:secret@192.168.254.203:8080', token })).toThrow()
  expect(() => createPiContext({ origin, token: 'short' })).toThrow()
  const fetcher = (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: string }
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: '资料 ' + token }] } })
  }) as typeof fetch
  const client = createPiContext({ origin, token }, fetcher)
  await expect(client.read({ kind: 'knowledge', query: 'a'.repeat(161) })).rejects.toThrow()
  await expect(client.read({ kind: 'knowledge', query: 'hello\nworld' })).rejects.toThrow()
  expect(await client.read({ kind: 'knowledge', query: '采购' })).not.toContain(token)
})

test('rejects failed, oversized, and mismatched Pi replies', async () => {
  const failure = createPiContext({ origin, token }, (async () => new Response(null, { status: 503 })) as unknown as typeof fetch)
  await expect(failure.read({ kind: 'memory', query: '采购' })).rejects.toThrow()
  const wrongId = createPiContext({ origin, token }, (async () => Response.json({ jsonrpc: '2.0', id: 'wrong', result: {} })) as unknown as typeof fetch)
  await expect(wrongId.read({ kind: 'memory', query: '采购' })).rejects.toThrow()
  const oversized = createPiContext({ origin, token }, (async () => new Response('x'.repeat(512 * 1024 + 1), {
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch)
  await expect(oversized.read({ kind: 'memory', query: '采购' })).rejects.toThrow()
})
