import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { ControlError } from '../src/contract'
import { mountPiContextRoutes } from '../src/pi-context-routes'

const route = '/api/v1/pi-context'
const device = { id: 'device-one', platform: 'win32', clientVersion: '1.0.0' }

test('shared Pi context requires the authorized tenant and a currently bound device', async () => {
  const app = new Hono()
  let actor = { tenantId: 'tenant-one', id: 'user-one', device }
  let enabled = true
  let calls = 0
  app.onError((error, c) => c.json({ error: error instanceof ControlError ? error.code : 'unknown' }, error instanceof ControlError ? error.status : 500))
  mountPiContextRoutes(app, {
    actor: async () => { if (!enabled) throw new ControlError(401, 'AUTH_REQUIRED', 'expired'); return actor },
    allowed: async value => value.tenantId === 'tenant-one',
    context: { read: async input => { calls++; return '共享内容 ' + input.kind } },
  })
  const request = (body: unknown) => app.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect(await (await request({ kind: 'knowledge', query: '采购' })).json()).toEqual({ kind: 'knowledge', text: '共享内容 knowledge' })
  expect((await request({ kind: 'knowledge', query: 'x'.repeat(161) })).status).toBe(400)
  actor = { ...actor, tenantId: 'another-tenant' }
  expect((await request({ kind: 'prompt' })).status).toBe(403)
  actor = { ...actor, tenantId: 'tenant-one', device: null as unknown as typeof device }
  expect((await request({ kind: 'prompt' })).status).toBe(403)
  enabled = false
  expect((await request({ kind: 'prompt' })).status).toBe(401)
  expect(calls).toBe(1)
})

test('a Pi result is discarded when device authorization changes during the lookup', async () => {
  const app = new Hono()
  let enabled = true
  app.onError((error, c) => c.json({ error: error instanceof ControlError ? error.code : 'unknown' }, error instanceof ControlError ? error.status : 500))
  mountPiContextRoutes(app, {
    actor: async () => {
      if (!enabled) throw new ControlError(401, 'AUTH_REQUIRED', 'expired')
      return { tenantId: 'tenant-one', id: 'user-one', device }
    },
    allowed: async () => true,
    context: { read: async () => { enabled = false; return 'PRIVATE_FIXTURE' } },
  })
  const response = await app.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'prompt' }) })
  expect(response.status).toBe(401)
  expect(await response.text()).not.toContain('PRIVATE_FIXTURE')
})
