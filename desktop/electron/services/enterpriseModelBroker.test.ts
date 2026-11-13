// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { enterpriseBrokerEnv } from '../../../src/shared/enterpriseModels'
import type { EnterpriseErpInput } from '../../../src/shared/enterpriseErp'
import { EnterpriseModelBroker } from './enterpriseModelBroker'

const input = {
  action: 'list', providerId: 'enterprise:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa:fixture',
  modelId: 'fixture-model', sessionId: 'fixture-session',
} as const

it('provides the configured office origin only for the enterprise broker', async () => {
  const bridge = { models: async () => null, modelGrant: async () => null }
  const officeOrigin = 'http://192.168.254.203:8081'
  ;(globalThis as Record<string, unknown>).LIYUAN_DESKTOP_OFFICE_HTTP_ORIGIN = officeOrigin
  const disabled = new EnterpriseModelBroker(bridge)
  const enabled = new EnterpriseModelBroker(bridge, officeOrigin)
  const other = new EnterpriseModelBroker(bridge, 'http://192.168.254.203:8788')
  try {
    expect((await disabled.start()).LIYUAN_ENTERPRISE_OFFICE_ORIGIN).toBeUndefined()
    expect((await enabled.start()).LIYUAN_ENTERPRISE_OFFICE_ORIGIN).toBe(officeOrigin)
    expect((await other.start()).LIYUAN_ENTERPRISE_OFFICE_ORIGIN).toBeUndefined()
  } finally {
    disabled.stop()
    enabled.stop()
    other.stop()
    delete (globalThis as Record<string, unknown>).LIYUAN_DESKTOP_OFFICE_HTTP_ORIGIN
  }
})

it('does not enable an office origin when the build did not provide one', async () => {
  const bridge = { models: async () => null, modelGrant: async () => null }
  const broker = new EnterpriseModelBroker(bridge, 'http://192.168.254.203:8081')
  try {
    expect((await broker.start()).LIYUAN_ENTERPRISE_OFFICE_ORIGIN).toBeUndefined()
  } finally { broker.stop() }
})

it('validates and protects the shared context route', async () => {
  const piContext = vi.fn(async (raw: unknown) => {
    const value = raw as { kind: 'prompt' | 'memory' | 'knowledge'; query?: string }
    if (value.query === 'unbound') return null
    if (value.query === 'oversized') return { kind: 'knowledge' as const, text: 'x'.repeat(32_001) }
    return { kind: value.kind, text: '已授权的资料' }
  })
  const broker = new EnterpriseModelBroker({ models: async () => null, modelGrant: async () => null, piContext })
  const binding = await broker.start()
  const origin = binding[enterpriseBrokerEnv.origin]!
  const auth = { authorization: 'Bearer ' + binding[enterpriseBrokerEnv.secret] }
  const call = (body: unknown, headers: Record<string, string> = {}) => fetch(origin + '/pi-context', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  try {
    expect((await call({ kind: 'prompt' })).status).toBe(401)
    expect((await call({ kind: 'prompt' }, { ...auth, origin })).status).toBe(401)
    for (const value of [
      {}, { kind: 'prompt', query: 'x' }, { kind: 'memory', query: '' },
      { kind: 'knowledge', query: 'x\nx' }, { kind: 'knowledge', query: 'x'.repeat(161) },
      { kind: 'other', query: 'x' }, { kind: 'memory', query: 'x', extra: true },
    ]) expect((await call(value, auth)).status).toBe(400)
    expect(piContext).not.toHaveBeenCalled()
    expect((await call({ kind: 'knowledge', query: 'unbound' }, auth)).status).toBe(403)
    expect((await call({ kind: 'knowledge', query: 'oversized' }, auth)).status).toBe(403)
    const result = await call({ kind: 'knowledge', query: '采购' }, auth)
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ kind: 'knowledge', text: '已授权的资料' })
    expect(piContext.mock.calls.at(-1)?.[0]).toEqual({ kind: 'knowledge', query: '采购' })
    expect(await (await call({ kind: 'memory', query: '项目' }, auth)).json())
      .toEqual({ kind: 'memory', text: '已授权的资料' })
    expect(await (await call({ kind: 'prompt' }, auth)).json())
      .toEqual({ kind: 'prompt', text: '已授权的资料' })
  } finally { broker.stop() }
})

it('exposes ERP only to the authenticated loopback broker and propagates client disconnect', async () => {
  let seen!: () => void
  const started = new Promise<void>(resolve => { seen = resolve })
  let stopped!: () => void
  const stoppedAtBridge = new Promise<void>(resolve => { stopped = resolve })
  let calls = 0
  const modelErp = vi.fn(async (_input: EnterpriseErpInput, signal?: AbortSignal) => {
    if (++calls === 1) return { action: 'list' as const, environments: [] }
    seen()
    if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
    stopped()
    return null
  })
  const broker = new EnterpriseModelBroker({ models: async () => null, modelGrant: async () => null, modelErp })
  const binding = await broker.start()
  const origin = binding[enterpriseBrokerEnv.origin]!
  const auth = { authorization: `Bearer ${binding[enterpriseBrokerEnv.secret]}` }
  const call = (body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) => fetch(`${origin}/erp`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal,
  })
  try {
    expect((await call(input)).status).toBe(401)
    expect((await call(input, { ...auth, origin })).status).toBe(401)
    expect((await call({ ...input, modelGrant: 'fake-tool-controlled-grant' }, auth)).status).toBe(400)
    expect(modelErp).not.toHaveBeenCalled()
    const allowed = await call(input, auth)
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ action: 'list', environments: [] })
    const cancel = new AbortController()
    const pending = call(input, auth, cancel.signal).catch(() => null)
    await started
    cancel.abort()
    await stoppedAtBridge
    expect(await pending).toBeNull()
    expect(modelErp.mock.calls[1]?.[1]?.aborted).toBe(true)
  } finally { broker.stop() }
})
