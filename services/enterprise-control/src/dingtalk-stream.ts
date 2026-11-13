import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { tenantSlug } from './contract'
import type { DingTalkEvent } from './demands/callback'
import { dingTalkId, processCode } from './demands/contract'
import { instanceId } from './demands/dingtalk'

const configSchema = z.object({ tenant: tenantSlug, corpId: dingTalkId, appKey: dingTalkId, appSecret: z.string().min(1).max(1024) })
export type DingTalkStreamConfig = z.infer<typeof configSchema>
const gateway = 'https://api.dingtalk.com/v1.0/gateway/connections/open'
const gatewayReply = z.object({ endpoint: z.url().max(500), ticket: z.string().regex(/^[\x21-\x7e]{8,4096}$/u) })
const streamHeaders = z.object({ messageId: dingTalkId, topic: z.string().max(180).optional(),
  eventType: z.string().max(120).optional(), eventCorpId: dingTalkId.optional(), eventId: dingTalkId.optional(),
  connectionId: z.string().max(192).optional(), time: z.string().max(30).optional(), appId: z.string().max(192).optional() })
const streamFrame = z.object({ type: z.enum(['SYSTEM', 'EVENT']), headers: streamHeaders, data: z.string().max(200_000).default('{}') })
const approvalBody = z.object({ eventId: dingTalkId.optional(), CorpId: dingTalkId.optional(), corpId: dingTalkId.optional(),
  processCode, processInstanceId: instanceId, type: z.enum(['start', 'finish', 'terminate']) })
const capacity = 8
type Frame = z.infer<typeof streamFrame>
type TicketFetch = (url: string, init: RequestInit) => Promise<Response>

export function loadDingTalkStream(env: Record<string, string | undefined>): DingTalkStreamConfig | undefined {
  const enable = env.ENTERPRISE_DINGTALK_STREAM
  if (enable === undefined || enable === 'false' || enable === '') return undefined
  if (enable !== 'true') throw new Error('ENTERPRISE_DINGTALK_STREAM must be true or false')
  const configuration = configSchema.safeParse({ tenant: env.ENTERPRISE_DINGTALK_TENANT, corpId: env.ENTERPRISE_DINGTALK_CORP_ID,
    appKey: env.ENTERPRISE_DINGTALK_APP_KEY, appSecret: env.ENTERPRISE_DINGTALK_APP_SECRET })
  if (!configuration.success) throw new Error('DingTalk Stream requires complete enterprise application credentials')
  return configuration.data
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return undefined }
}

async function requestSocketUrl(config: DingTalkStreamConfig, signal: AbortSignal, fetcher: TicketFetch) {
  const response = await fetcher(gateway, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: config.appKey, clientSecret: config.appSecret, ua: '', subscriptions: [{ type: 'EVENT', topic: '*' }] }),
  })
  if (!response.ok || !response.body || !response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    await response.body?.cancel().catch(() => {})
    throw new Error('DingTalk Stream registration unavailable')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 16_384) throw new Error('DingTalk Stream registration response exceeds the limit')
      text += decoder.decode(value, { stream: true })
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const { endpoint, ticket } = gatewayReply.parse(parseJson(text + decoder.decode()))
  const url = new URL(endpoint)
  if (url.protocol !== 'wss:' || url.hostname !== 'wss-open-connection.dingtalk.com' || url.port || url.pathname !== '/connect' ||
      url.username || url.password || url.search || url.hash) throw new Error('DingTalk Stream returned an unsupported endpoint')
  url.searchParams.set('ticket', ticket)
  return url
}

type Outcome = 'SUCCESS' | 'LATER'
type Ingester = (tenant: string, event: DingTalkEvent) => Promise<void>
type Report = (status: 'connected' | 'retrying') => void
interface StreamOptions {
  fetcher?: TicketFetch
  createSocket?: (url: URL) => WebSocket
  retryDelay?: (attempt: number) => number
  report?: Report
}

async function receiveApproval(config: DingTalkStreamConfig, frame: Frame, ingest: Ingester): Promise<Outcome> {
  const { headers } = frame
  if (headers.eventType !== 'bpms_instance_change' || headers.eventCorpId !== config.corpId) return 'SUCCESS'
  const body = approvalBody.safeParse(parseJson(frame.data))
  if (!body.success) return 'LATER'
  const value = body.data
  if ([value.CorpId, value.corpId].some(id => id !== undefined && id !== config.corpId)) return 'SUCCESS'
  const eventId = value.eventId ?? headers.eventId
  if (!eventId) return 'LATER'
  await ingest(config.tenant, { eventId, corpId: config.corpId, processCode: value.processCode, instanceId: value.processInstanceId, type: value.type })
  return 'SUCCESS'
}

function consume(socket: WebSocket, config: DingTalkStreamConfig, signal: AbortSignal, ingest: Ingester, pending: Set<Promise<void>>, report: Report) {
  return new Promise<void>(resolve => {
    let ended = false
    let timer = setTimeout(finish, 12_000)

    function finish() {
      if (ended) return
      ended = true
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      socket.removeEventListener('open', opened)
      socket.removeEventListener('message', message)
      socket.removeEventListener('close', finish)
      socket.removeEventListener('error', finish)
      try { if (socket.readyState <= WebSocket.OPEN) socket.close() } catch { /* The socket may already be closing. */ }
      resolve()
    }

    function touch() { clearTimeout(timer); timer = setTimeout(finish, 180_000) }
    function opened() { touch(); report('connected') }
    function send(headers: Record<string, string | undefined>, data: string) {
      if (ended || socket.readyState !== WebSocket.OPEN) return
      try { socket.send(JSON.stringify({ code: 200, headers: { ...headers, contentType: 'application/json' }, message: 'OK', data })) }
      catch { finish() }
    }

    function message(event: MessageEvent<unknown>) {
      if (ended || typeof event.data !== 'string' || Buffer.byteLength(event.data, 'utf8') > 256 * 1024) return
      const parsed = streamFrame.safeParse(parseJson(event.data))
      if (!parsed.success) return
      touch()
      const frame = parsed.data
      if (frame.type === 'SYSTEM') {
        if (frame.headers.topic === 'ping' || frame.headers.topic === 'disconnect') send(frame.headers, frame.data)
        if (frame.headers.topic === 'disconnect') finish()
        return
      }
      const acknowledge = (status: Outcome) => send({ messageId: frame.headers.messageId }, JSON.stringify({ status }))
      if (pending.size >= capacity) { acknowledge('LATER'); return }
      const job = receiveApproval(config, frame, ingest).then(acknowledge, () => acknowledge('LATER')).finally(() => pending.delete(job))
      pending.add(job)
    }

    socket.addEventListener('open', opened)
    socket.addEventListener('message', message)
    socket.addEventListener('close', finish)
    socket.addEventListener('error', finish)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

/** An authenticated outbound stream only supplies hints. The demand worker verifies instance status via its normal OA API. */
export function startDingTalkStream(config: DingTalkStreamConfig, ingest: Ingester, options: StreamOptions = {}) {
  const controller = new AbortController()
  const pending = new Set<Promise<void>>()
  const createSocket = options.createSocket ?? (url => new WebSocket(url))
  const retryDelay = options.retryDelay ?? (attempt => Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6) + Math.floor(Math.random() * 1000)))
  let lastStatus: Parameters<Report>[0] | undefined
  const report: Report = status => {
    if (status === lastStatus) return
    lastStatus = status
    options.report?.(status)
  }
  const run = (async () => {
    let attempt = 0
    while (!controller.signal.aborted) {
      const started = Date.now()
      try {
        const url = await requestSocketUrl(config, controller.signal, options.fetcher ?? fetch)
        if (controller.signal.aborted) break
        await consume(createSocket(url), config, controller.signal, ingest, pending, report)
      } catch { /* Provider response bodies, tickets and credentials never reach application logs. */ }
      if (controller.signal.aborted) break
      report('retrying')
      if (Date.now() - started >= 60_000) attempt = 0
      await delay(retryDelay(attempt++), undefined, { signal: controller.signal }).catch(() => {})
    }
  })()
  return async () => { controller.abort(); await run; await Promise.allSettled(pending) }
}
