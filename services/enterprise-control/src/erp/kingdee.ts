import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ControlError } from '../contract'
import type { ErpEnvironment, ErpQueryTemplate } from './contract'

type Cell = string | number | boolean | null
type Row = Record<string, Cell>
const erpUnavailable = () => new ControlError(503, 'ERP_QUERY_UNAVAILABLE', '金蝶接口暂不可用，请核对该环境的接口配置和应用权限。')
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined
const own = (parent: unknown, key: string) => {
  const value = object(parent)
  return value && Object.hasOwn(value, key) ? value[key] : undefined
}

async function jsonReply(response: Response, limit: number): Promise<unknown> {
  if (!response.ok || !response.body || !response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    await response.body?.cancel().catch(() => {})
    throw erpUnavailable()
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  let count = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      count += value.byteLength
      if (count > limit) throw erpUnavailable()
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } catch { throw erpUnavailable() }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

const tokenResponse = z.object({
  access_token: z.string().min(12).max(4096).regex(/^[\x21-\x7e]+$/u),
  expires_in: z.union([z.number(), z.string().regex(/^\d{1,8}$/u).transform(Number)]).optional(),
})

function successful(value: Record<string, unknown>) {
  const { errorCode, status } = value
  return status !== false && status !== 'false' && (errorCode == null || errorCode === '' || errorCode === '0' || errorCode === 0)
}

function scalar(value: unknown, hidden: readonly string[]): Cell {
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return value
  if (typeof value !== 'string' || hidden.some(secret => value.includes(secret))) return null
  return Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')).slice(0, 400).join('')
}

export class KingdeeReadConnector {
  private token: { value: string, expiresAt: number } | undefined
  private pending: Promise<string> | undefined

  constructor(private readonly env: ErpEnvironment, private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  private getToken() {
    if (this.token && this.token.expiresAt > this.now()) return Promise.resolve(this.token.value)
    if (!this.pending) this.pending = this.obtainToken().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async obtainToken() {
    const { clientId, secret, username, accountId } = this.env.credential
    const reply = await this.fetcher(new URL('/kapi/oauth2/token', this.env.origin), { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(8_000), headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: secret, username, accountId, language: 'zh_CN', nonce: randomUUID(), timestamp: this.now() }),
    }).catch(() => { throw erpUnavailable() })
    const result = object(await jsonReply(reply, 32 * 1024))
    if (!result || !successful(result)) throw erpUnavailable()
    const token = tokenResponse.safeParse(object(result.data) ?? result)
    if (!token.success) throw erpUnavailable()
    const seconds = token.data.expires_in ?? 600
    if (!(seconds > 0 && Number.isFinite(seconds))) throw erpUnavailable()
    this.token = { value: token.data.access_token, expiresAt: this.now() + Math.max(1, Math.min(seconds - 45, 7_155)) * 1000 }
    return this.token.value
  }

  async read(template: ErpQueryTemplate, number?: string, abortSignal?: AbortSignal): Promise<{ rows: Row[], truncated: boolean }> {
    if ((template.kind === 'document') !== Boolean(number)) throw new ControlError(400, 'ERP_DOCUMENT_NUMBER_REQUIRED', '请按查询类型填写单据编号。')
    const url = new URL(template.path, this.env.origin)
    if (url.origin !== this.env.origin) throw erpUnavailable()
    for (const [key, value] of Object.entries(template.fixedParameters)) url.searchParams.set(key, value)
    if (template.numberParameter && number) url.searchParams.set(template.numberParameter, number)
    const timeout = AbortSignal.timeout(15_000)
    const signal = abortSignal ? AbortSignal.any([timeout, abortSignal]) : timeout
    const query = async (token: string) => {
      signal.throwIfAborted()
      return this.fetcher(url, { method: 'GET', redirect: 'error', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8',
          'x-acgw-identity': this.env.credential.gatewayIdentity, access_token: token },
      }).catch(() => { throw erpUnavailable() })
    }
    let token = await this.getToken()
    let reply = await query(token)
    if (reply.status === 401) {
      await reply.body?.cancel().catch(() => {})
      if (this.token?.value === token) this.token = undefined
      token = await this.getToken()
      reply = await query(token)
    }
    if (reply.status === 401 && this.token?.value === token) this.token = undefined
    const result = object(await jsonReply(reply, 256 * 1024))
    if (!result || result.status !== true || !successful(result)) throw erpUnavailable()
    if (template.kind === 'connection') return { rows: [], truncated: false }
    let records = result.data
    for (const key of template.rowPath) records = own(records, key)
    const items: unknown[] | undefined = Array.isArray(records) ? records : object(records) ? [records] : undefined
    const { numberColumn } = template
    if (!items || items.some(item => !object(item) || (numberColumn ? typeof own(item, numberColumn) !== 'string' :
      !template.columns.some(column => Object.hasOwn(item as object, column.key))))) throw erpUnavailable()
    const matching = numberColumn ? items.filter(item => own(item, numberColumn) === number) : items
    const { credential } = this.env
    const hidden = [credential.secret, credential.gatewayIdentity, token]
    return { rows: matching.slice(0, 50).map(item => Object.fromEntries(template.columns.map(column => [column.key, scalar(own(item, column.key), hidden)]))),
      truncated: matching.length > 50 }
  }
}
