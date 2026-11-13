import { randomUUID } from 'node:crypto'
import { normalizeWorkbenchOrigin } from './pi-workbench-policy'

type Text = { type?: string, text?: string }
type Result = {
  messages?: { content?: Text }[]
  content?: Text[]
  tools?: { name?: string }[]
  isError?: boolean
}

class ContextError extends Error {
  override name = 'ClientInputError'
  constructor(message: string, readonly code?: number) { super(message) }
}

const unavailable = '无法读取服务器资料，请检查连接设置和办公网络。'
export const validContextKey = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(key)

async function readJson(response: Response) {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json' || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new ContextError('服务器资料接口返回的格式无效。')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 512 * 1024) throw new ContextError('服务器资料响应超过大小限制。')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as {
      jsonrpc?: string, id?: string, result?: Result, error?: { code?: number }
    }
  } finally { await reader.cancel().catch(() => {}) }
}

export function createWorkbenchContext(origin: string, key: string, intranetOrigin: string | undefined, signal: AbortSignal,
  isCurrent = () => true) {
  const endpoint = new URL('/api/desktop/context/mcp', normalizeWorkbenchOrigin(origin, intranetOrigin))
  if (!validContextKey(key)) throw new ContextError('资料连接口令格式无效。')

  async function request(method: string, params: Record<string, unknown> = {}) {
    if (!isCurrent()) throw new ContextError('资料连接已变更，请重新发起任务。')
    const id = randomUUID()
    try {
      const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        if (response.status === 401) throw new ContextError('服务器未接受资料连接口令，请核对管理员提供的口令。')
        if (response.status === 403) throw new ContextError('当前网络无法访问服务器资料，请连接办公网。')
        if (response.status === 404) throw new ContextError('该服务器尚未开启资料连接接口。')
        throw new ContextError(unavailable)
      }
      const reply = await readJson(response)
      if (reply?.jsonrpc !== '2.0' || reply.id !== id) throw new ContextError(unavailable)
      if (reply.error) throw new ContextError(unavailable, reply.error.code)
      if (!reply.result || typeof reply.result !== 'object') throw new ContextError(unavailable)
      if (!isCurrent()) throw new ContextError('资料连接已变更，请重新发起任务。')
      return reply.result
    } catch (error) {
      if (error instanceof ContextError) throw error
      throw new ContextError(unavailable)
    }
  }

  async function prompt(kind: string) {
    const result = await request('prompts/get', { name: kind }).catch(error => {
      if (kind !== 'workbench' && error instanceof ContextError && error.code === -32602) return request('prompts/get', { name: 'workbench' })
      throw error
    })
    const content = Array.isArray(result.messages) ? result.messages[0]?.content : undefined
    if (content?.type !== 'text' || typeof content.text !== 'string' || !content.text.trim()) throw new ContextError(unavailable)
    return content.text
  }

  async function lookup(name: 'search_knowledge' | 'search_project_memory', value: string) {
    const query = typeof value === 'string' ? value.trim() : ''
    if (!query || query.length > 200 || /[\x00-\x1f\x7f]/.test(query)) return { ok: false, text: '请使用不超过 200 字的单行关键词查询。' }
    try {
      const result = await request('tools/call', { name, arguments: { query } })
      const content = Array.isArray(result.content) ? result.content[0] : undefined
      if (result.isError || content?.type !== 'text' || typeof content.text !== 'string') throw new ContextError(unavailable)
      return { ok: true, text: content.text }
    } catch (error) { return { ok: false, text: error instanceof ContextError ? error.message : unavailable } }
  }

  return {
    prompt,
    knowledge: (query: string) => lookup('search_knowledge', query),
    projectMemory: (query: string) => lookup('search_project_memory', query),
    async test() {
      const { tools } = await request('tools/list')
      if (!Array.isArray(tools) || !['search_knowledge', 'search_project_memory'].every(name => tools.some(tool => tool?.name === name))) {
        throw new ContextError('服务器资料接口未提供知识库和共享记忆查询。')
      }
      await prompt('workbench')
      return { ok: true, text: '已连接服务器知识库、项目共享记忆和提示词。' }
    },
  }
}
