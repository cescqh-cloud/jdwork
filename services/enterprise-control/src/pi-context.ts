import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { ControlError } from './contract'

const query = z.string().trim().min(1).max(160).refine(value => !/[\x00-\x1f\x7f]/u.test(value))
export const piContextInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prompt') }),
  z.strictObject({ kind: z.literal('knowledge'), query }),
  z.strictObject({ kind: z.literal('memory'), query }),
])
export type PiContextInput = z.infer<typeof piContextInput>

const unavailable = () => new ControlError(503, 'PI_CONTEXT_UNAVAILABLE', '无法读取工作台共享资料。')
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function privateIpv4(hostname: string) {
  if (isIP(hostname) !== 4) return false
  const [first, second] = hostname.split('.').map(Number)
  return first === 10 || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel().catch(() => {})
    throw unavailable()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > 512 * 1024) throw unavailable()
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as unknown
  } finally { await reader.cancel().catch(() => {}) }
}

export function createPiContext(options: { origin: string; token: string; allowLoopback?: boolean }, fetcher: typeof fetch = fetch) {
  const url = new URL(options.origin)
  const loopback = options.allowLoopback && ['127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.origin !== options.origin || url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && (privateIpv4(url.hostname) || loopback)))
    || !/^[A-Za-z0-9_-]{43,128}$/u.test(options.token)) throw new Error('Invalid Pi context configuration')
  const endpoint = new URL('/api/desktop/context/mcp', url)

  return {
    async read(input: PiContextInput, signal?: AbortSignal): Promise<string> {
      const parsed = piContextInput.safeParse(input)
      if (!parsed.success) throw new ControlError(400, 'PI_CONTEXT_INVALID', '共享资料查询格式无效。')
      const id = randomUUID()
      const item = parsed.data
      const method = item.kind === 'prompt' ? 'prompts/get' : 'tools/call'
      const params = item.kind === 'prompt' ? { name: 'workbench' } : {
        name: item.kind === 'knowledge' ? 'search_knowledge' : 'search_project_memory',
        arguments: { query: item.query },
      }
      try {
        const deadline = AbortSignal.timeout(12_000)
        const response = await fetcher(endpoint, {
          method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
          headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        })
        const reply = await boundedJson(response)
        if (!isRecord(reply) || reply.jsonrpc !== '2.0' || reply.id !== id || !isRecord(reply.result) || reply.error) throw unavailable()
        const result = reply.result
        const content = item.kind === 'prompt' && Array.isArray(result.messages) && isRecord(result.messages[0])
          ? result.messages[0].content : Array.isArray(result.content) ? result.content[0] : undefined
        if (result.isError || !isRecord(content) || content.type !== 'text' || typeof content.text !== 'string'
          || !content.text.trim() || content.text.length > 32_000) throw unavailable()
        return content.text.replaceAll(options.token, '[已隐藏]')
      } catch {
        throw unavailable()
      }
    },
  }
}
