import { z } from 'zod'
import { ControlError, tokenSchema } from '../contract'
import { approvedUpstream, openKey, providerId, type ApiKind, type Protocol } from './contract'
import type { CallOutcome, ModelCall, ModelStore } from './store'
import { UsageObserver } from './usage'

const timeoutMs = 300_000
const limits = z.number().int().min(1).max(2_000_000)
const requestBody = z.looseObject({
  model: providerId, stream: z.boolean().optional(), max_tokens: limits.optional(), max_completion_tokens: limits.optional(),
  n: z.literal(1).optional(),
})
const paths = { messages: '/messages', count_tokens: '/messages/count_tokens', chat_completions: '/chat/completions' } as const

function errorResponse(protocol: Protocol, status: number, code: string, message: string, headers?: Headers) {
  const category = status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : status === 403 ? 'permission_error'
    : status >= 500 ? 'api_error' : 'invalid_request_error'
  return Response.json(protocol === 'anthropic' ? { type: 'error', error: { type: category, message } }
    : { error: { type: category, code, message } }, { status, headers })
}

function modelCredential(headers: Headers): string {
  const auth = headers.get('Authorization')
  const key = headers.get('x-api-key')
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined
  const token = tokenSchema.safeParse(bearer ?? key)
  if (!token.success || (auth !== null && !bearer) || (key && bearer && key !== bearer)) {
    throw new ControlError(401, 'MODEL_GRANT_REQUIRED', 'This request needs a short-lived model access grant.')
  }
  return token.data
}

export async function forwardModelRequest(store: ModelStore, request: Request, protocol: Protocol, kind: ApiKind): Promise<Response> {
  try {
    const token = modelCredential(request.headers)
    const contentType = request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') throw new ControlError(400, 'JSON_REQUIRED', 'Send application/json for this endpoint.')
    const value = requestBody.safeParse(await request.json().catch(() => null))
    if (!value.success) throw new ControlError(400, 'MODEL_REQUEST_INVALID', 'Supply an allowed model identifier and valid output options.')
    const payload = value.data
    if (payload.max_tokens !== undefined && payload.max_completion_tokens !== undefined) {
      throw new ControlError(400, 'MODEL_OUTPUT_LIMIT', 'Specify one output token limit.')
    }
    const call = await store.startCall(token, payload.model, protocol, kind, payload.max_completion_tokens ?? payload.max_tokens ?? null)
    return await dispatchModelCall(store, call, payload, request)
  } catch (error) {
    if (error instanceof ControlError) return errorResponse(protocol, error.status, error.code, error.message)
    return errorResponse(protocol, 503, 'MODEL_GATEWAY_UNAVAILABLE', 'The enterprise model gateway could not authorize this request.')
  }
}

export async function dispatchModelCall(store: ModelStore, call: ModelCall, payload: Record<string, unknown>, request: Pick<Request, 'signal' | 'headers' | 'url'>): Promise<Response> {
  const { kind, model } = call
  const protocol = model.protocol
  const cancelled = new AbortController()
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([request.signal, cancelled.signal, timeout])
  let status: number | null = null
  let attempted = false
  let observer = new UsageObserver(protocol, false)
  let settled: Promise<void> | undefined
  const finish = (outcome: CallOutcome) => settled ??= store.finish(call, outcome, observer.tokens, status, attempted).catch(() => {
    console.error(`Enterprise model usage could not be finalized for ${call.id}`)
  })
  const interrupted = (): CallOutcome => timeout.aborted ? 'timed_out' : signal.aborted ? 'cancelled' : 'upstream_error'
  const responseHeaders = new Headers({ 'Cache-Control': 'no-store', 'X-Request-Id': call.id, 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' })
  if (call.softLimitReached) responseHeaders.set('X-Enterprise-Budget-Warning', 'near-limit')

  try {
    const base = approvedUpstream(model.base_url, store.config)
    const upstream = new URL(`${base}${paths[kind]}`)
    const key = openKey(model.sealed_key, store.config.encryptionKey, call.tenantId, model.provider_id)
    const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' })
    headers.set(model.auth_header === 'bearer' ? 'Authorization' : 'x-api-key', model.auth_header === 'bearer' ? `Bearer ${key}` : key)
    if (protocol === 'anthropic') {
      headers.set('anthropic-version', request.headers.get('anthropic-version') ?? '2023-06-01')
      const beta = request.headers.get('anthropic-beta')
      if (beta && beta.length <= 1024) headers.set('anthropic-beta', beta)
      if (new URL(request.url).searchParams.get('beta') === 'true') upstream.searchParams.set('beta', 'true')
    }
    const body: Record<string, unknown> = { ...payload, model: model.upstream_model }
    if (kind === 'messages') {
      delete body.max_completion_tokens
      body.max_tokens = call.outputTokens
    } else if (kind === 'chat_completions') {
      if (payload.max_completion_tokens === undefined && payload.max_tokens === undefined) body.max_tokens = call.outputTokens
      if (payload.stream) {
        const supplied = body.stream_options
        const options = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? { ...supplied } as Record<string, unknown> : {}
        if (model.stream_usage) options.include_usage = true
        else delete options.include_usage
        if (Object.keys(options).length) body.stream_options = options
        else delete body.stream_options
      }
    }
    if (kind === 'count_tokens') { delete body.max_tokens; delete body.max_completion_tokens; delete body.stream }
    signal.throwIfAborted()
    attempted = true
    const result = await fetch(upstream, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal })
    status = result.status
    const media = result.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
    if (!result.ok || !result.body || (media !== 'application/json' && media !== 'text/event-stream')) {
      await result.body?.cancel().catch(() => {})
      await finish('upstream_error')
      const delay = result.headers.get('Retry-After')
      if (delay && /^[1-9]\d{0,4}$/u.test(delay)) responseHeaders.set('Retry-After', delay)
      const safeStatus = [400, 404, 413, 422, 429, 503, 529].includes(result.status) ? result.status : 502
      return errorResponse(protocol, safeStatus, 'MODEL_UPSTREAM_ERROR', `The model provider returned HTTP ${result.status}.`, responseHeaders)
    }
    responseHeaders.set('Content-Type', `${media}; charset=utf-8`)
    observer = new UsageObserver(protocol, media === 'text/event-stream')
    const reader = result.body.getReader()
    const bodyStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            observer.end()
            await finish(observer.failed ? 'upstream_error' : 'completed')
            controller.close()
          } else {
            observer.write(value)
            controller.enqueue(value)
          }
        } catch {
          await finish(interrupted())
          controller.error(new Error('The model response was interrupted.'))
        }
      },
      async cancel() {
        cancelled.abort()
        await reader.cancel().catch(() => {})
        await finish(interrupted())
      },
    })
    return new Response(bodyStream, { status, headers: responseHeaders })
  } catch {
    const outcome = interrupted()
    await finish(outcome)
    return errorResponse(protocol, outcome === 'timed_out' ? 504 : outcome === 'cancelled' ? 499 : 502,
      'MODEL_UPSTREAM_UNAVAILABLE', 'The enterprise model did not complete this request.', responseHeaders)
  }
}
