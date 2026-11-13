import { expect, spyOn, test } from 'bun:test'
import { enterpriseModelPaths, parseEnterpriseModelCatalog, type EnterpriseModel } from '../../shared/enterpriseModels.js'
import { EnterpriseModelRuntime, buildEnterpriseModelEnv } from '../services/enterpriseModelRuntime.js'
import type { NetworkSettings } from '../services/networkSettings.js'
import { handleEnterpriseProxyRequest } from './handler.js'

const deviceId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const cloud = 'https://company-gateway.invalid'
const broker = 'http://127.0.0.1:10000'
const sdkToken = 'local-session-fixture-secret'
const enterpriseGrant = 'isolated-rotating-model-grant'
const brokerSecret = 'x'.repeat(43)
const expires = () => new Date(Date.now() + 60_000).toISOString()
const settings: NetworkSettings = { aiRequestTimeoutMs: 1000, proxy: { mode: 'direct', url: '' } }

function modelFor(protocol: EnterpriseModel['protocol']) {
  const model = {
    providerId: 'enterprise-cloud', modelId: 'fixture-model', displayName: 'Test company model',
    protocol, capabilities: ['text', 'tools'], contextWindow: 64_000, maxOutputTokens: 1500,
    defaultEffort: null, proxyEndpoint: enterpriseModelPaths[protocol],
    projectId: null, isDefault: true, quota: { dailyTokens: 12345, softDailyTokens: null },
  }
  return parseEnterpriseModelCatalog({ models: [model], revision: 1, expiresAt: expires() }, deviceId)!
}

function fixtures(protocol: EnterpriseModel['protocol']) {
  const catalog = modelFor(protocol)
  const model = catalog.models[0]!
  const grants: Array<Record<string, unknown>> = []
  let allowed = true
  const runtime = new EnterpriseModelRuntime({ origin: broker, secret: brokerSecret }, (async (input, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${brokerSecret}`)
    expect(init?.redirect).toBe('error')
    const url = new URL(String(input))
    expect(url.origin).toBe(broker)
    if (url.pathname === '/catalog') return Response.json(allowed ? catalog : { ...catalog, models: [] })
    expect(url.pathname).toBe('/grant')
    grants.push(JSON.parse(String(init?.body)))
    return Response.json({
      origin: cloud, accessToken: enterpriseGrant, expiresAt: expires(), proxyEndpoint: model.proxyEndpoint,
    })
  }) as typeof fetch)
  const localSession = {
    authorize: (id: string, token: string | null) => id === 'session-test' && token === sdkToken,
    selection: () => ({ providerId: model.providerId, modelId: model.modelId }),
  }
  return { model, grants, runtime, localSession, revoke: () => { allowed = false } }
}

function request({
  count = false, stream = false, token = sdkToken, model = 'fixture-model', origin,
}: { count?: boolean; stream?: boolean; token?: string; model?: string; origin?: string } = {}) {
  const url = new URL(`http://127.0.0.1:17463/proxy/enterprise/session-test/v1/messages${count ? '/count_tokens' : ''}`)
  const req = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-api-key': token, 'anthropic-version': '2023-06-01',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ model, stream, max_tokens: 128, messages: [{ role: 'user', content: 'fake prompt' }] }),
  })
  return [req, url] as const
}

test('enterprise runtime hands the CLI only its loopback session credential and enforces model budgets', () => {
  const model = modelFor('openai').models[0]!
  const env = buildEnterpriseModelEnv(model, `ws://127.0.0.1:17463/sdk/session-test?token=${sdkToken}`)
  expect(env).toMatchObject({
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:17463/proxy/enterprise/session-test',
    ANTHROPIC_API_KEY: sdkToken, ANTHROPIC_MODEL: 'fixture-model',
    CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: '{"fixture-model":64000}',
    CLAUDE_CODE_MODEL_MAX_OUTPUT_TOKENS: '{"fixture-model":1500}',
  })
  expect(JSON.stringify(env)).not.toContain(enterpriseGrant)
  expect(() => buildEnterpriseModelEnv(model, 'ws://untrusted.invalid/sdk/session-test?token=fixture')).toThrow()
})

test('passes Anthropic SSE and token counts through with a fresh scoped grant for each request', async () => {
  const { runtime, localSession, grants, model } = fixtures('anthropic')
  const sse = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  const seen: string[] = []
  const upstream = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    seen.push(String(input))
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' })
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${enterpriseGrant}`)
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(JSON.parse(String(init?.body)).model).toBe(model.modelId)
    return String(input).endsWith('/count_tokens')
      ? Response.json({ input_tokens: 22 })
      : new Response(sse, { headers: { 'content-type': 'text/event-stream', 'request-id': 'upstream-1', 'set-cookie': 'drop=fixture' } })
  })
  try {
    const dispatch = (options: Parameters<typeof request>[0]) => handleEnterpriseProxyRequest(
      ...request(options), localSession, runtime, async () => settings,
    )
    const stream = await dispatch({ stream: true })
    expect(await stream.text()).toBe(sse)
    expect(stream.headers.get('request-id')).toBe('upstream-1')
    expect(stream.headers.get('set-cookie')).toBeNull()
    expect(await (await dispatch({ count: true })).json()).toEqual({ input_tokens: 22 })
    expect(seen).toEqual([`${cloud}${model.proxyEndpoint}/v1/messages`, `${cloud}${model.proxyEndpoint}/v1/messages/count_tokens`])
    expect(grants).toEqual(Array.from({ length: 2 }, () => ({
      providerId: model.providerId, modelId: model.modelId, protocol: 'anthropic', sessionId: 'session-test',
    })))
  } finally { upstream.mockRestore() }
})

test('uses the existing OpenAI Chat adapter and denies browser, model substitution and revoked policy', async () => {
  const { runtime, localSession, grants, model, revoke } = fixtures('openai')
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  const upstream = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input)).toBe(`${cloud}${model.proxyEndpoint}/v1/chat/completions`)
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${enterpriseGrant}`)
    const request = JSON.parse(String(init?.body))
    expect(request).toMatchObject({ model: model.modelId, stream: true })
    return new Response(
      chunk({ tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: 'Read', arguments: '{"file":' } }] })
      + chunk({ tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }] })
      + chunk({}, 'tool_calls') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  })
  try {
    const dispatch = (options: Parameters<typeof request>[0]) => handleEnterpriseProxyRequest(
      ...request(options), localSession, runtime, async () => settings,
    )
    for (const options of [{ token: 'browser-token' }, { model: 'other-model' }, { origin: 'http://localhost' }]) {
      expect((await dispatch(options)).status).toBe(403)
    }
    expect(upstream).not.toHaveBeenCalled()
    const response = await dispatch({ stream: true })
    expect(response.status).toBe(200)
    const output = await response.text()
    expect(output).toContain('fixture-call')
    expect(output).toContain('input_json_delta')
    expect(output).toContain('"stop_reason":"tool_use"')
    expect(output).toContain('message_stop')
    revoke()
    expect((await dispatch({ stream: true })).status).toBe(403)
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(grants).toHaveLength(1)
  } finally { upstream.mockRestore() }
})
