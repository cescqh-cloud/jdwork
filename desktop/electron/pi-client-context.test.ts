// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkbenchContext } from './pi-client-context'

const origin = 'http://192.168.44.10:8080'
const token = 'k'.repeat(43)
const signal = new AbortController().signal

function mockTransport() {
  const bodies: { method: string, params: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', async (input: URL, init: RequestInit) => {
    expect(input.href).toBe(`${origin}/api/desktop/context/mcp`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${token}`)
    expect(headers.has('cookie')).toBe(false)
    const { jsonrpc, id, method, params } = JSON.parse(String(init.body))
    bodies.push({ method, params })
    const result = method === 'prompts/get'
      ? { messages: [{ content: { type: 'text', text: '团队规范' } }] }
      : method === 'tools/list' ? { tools: [{ name: 'search_knowledge' }, { name: 'search_project_memory' }] }
        : { content: [{ type: 'text', text: '{"status":"matched"}' }] }
    return Response.json({ jsonrpc, id, result })
  })
  return bodies
}

afterEach(() => vi.unstubAllGlobals())

describe('workbench server resources', () => {
  it('sends only the chosen prompt name or short lookup query to the exact pinned origin', async () => {
    const bodies = mockTransport()
    const context = createWorkbenchContext(origin, token, origin, signal)
    expect(await context.prompt('review')).toBe('团队规范')
    expect(await context.knowledge('  采购入库  ')).toEqual({ ok: true, text: '{"status":"matched"}' })
    expect(await context.projectMemory('交付验收')).toMatchObject({ ok: true })
    expect(await context.knowledge('完整任务\n上下文')).toMatchObject({ ok: false })
    expect(await context.projectMemory('a'.repeat(201))).toMatchObject({ ok: false })
    expect(await context.test()).toMatchObject({ ok: true })
    expect(bodies).toEqual([
      { method: 'prompts/get', params: { name: 'review' } },
      { method: 'tools/call', params: { name: 'search_knowledge', arguments: { query: '采购入库' } } },
      { method: 'tools/call', params: { name: 'search_project_memory', arguments: { query: '交付验收' } } },
      { method: 'tools/list', params: {} },
      { method: 'prompts/get', params: { name: 'workbench' } },
    ])
  })

  it('refuses a different HTTP host or port and stops using a removed connection', async () => {
    const bodies = mockTransport()
    expect(() => createWorkbenchContext('http://192.168.44.11:8080', token, origin, signal)).toThrow()
    expect(() => createWorkbenchContext('http://192.168.44.10:8081', token, origin, signal)).toThrow()
    expect(() => createWorkbenchContext(origin, 'password-fixture', origin, signal)).toThrow()
    let current = true
    const context = createWorkbenchContext(origin, token, origin, signal, () => current)
    await context.prompt('review')
    current = false
    expect(await context.knowledge('采购')).toMatchObject({ ok: false })
    await expect(context.prompt('review')).rejects.toThrow('资料连接已变更')
    expect(bodies).toHaveLength(1)
  })

  it('falls back to the project prompt only when a scenario prompt is disabled', async () => {
    const fetched = vi.fn(async (_input: URL, init: RequestInit) => {
      const { id, params } = JSON.parse(String(init.body))
      return Response.json(params.name === 'review'
        ? { jsonrpc: '2.0', id, error: { code: -32602 } }
        : { jsonrpc: '2.0', id, result: { messages: [{ content: { type: 'text', text: '项目提示词' } }] } })
    })
    vi.stubGlobal('fetch', fetched)
    expect(await createWorkbenchContext(origin, token, origin, signal).prompt('review')).toBe('项目提示词')
    expect(fetched).toHaveBeenCalledTimes(2)
    fetched.mockResolvedValue(new Response(null, { status: 401 }))
    await expect(createWorkbenchContext(origin, token, origin, signal).prompt('review')).rejects.toThrow('服务器未接受资料连接口令')
    expect(fetched).toHaveBeenCalledTimes(3)
  })
})
