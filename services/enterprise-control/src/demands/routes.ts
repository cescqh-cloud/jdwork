import type { Env, Hono } from 'hono'
import { z } from 'zod'
import { ControlError, tenantSlug } from '../contract'
import { confirmImportInput, editDemand, identityInput, newDemand, precheckInput, processCode, submitInput, templateInput } from './contract'
import { body, parse, type DemandRoutesOptions } from './route-utils'
import { mountDemandConsole } from './console'

const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).max(50_000).default(0) })
export const scanInput = z.strictObject({ lookbackHours: z.number().int().min(1).max(24).default(2),
  cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), until: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() })

export function mountDemandRoutes<E extends Env>(app: Hono<E>, options: DemandRoutesOptions) {
  const { service, actor } = options
  const api = app.basePath('/api/v1')
  api.get('/demands/status', async c => c.json(await service.capabilities(await actor(c))))
  api.get('/demands/templates', async c => c.json(await service.store.userTemplates(await actor(c))))
  api.get('/demands/backlog', async c => {
    const user = await actor(c)
    const query = parse(pageQuery, c.req.query())
    return c.json(await service.store.list(user, true, query.limit, query.offset))
  })
  api.get('/demands', async c => {
    const user = await actor(c)
    const query = parse(pageQuery, c.req.query())
    return c.json(await service.store.list(user, false, query.limit, query.offset))
  })
  api.post('/demands', async c => {
    const user = await actor(c)
    const { draft, idempotencyKey } = await body(c, newDemand)
    const result = await service.store.createDraft(user, draft, idempotencyKey)
    const item = await service.store.get(user, result.id)
    return c.json({ ...item, ...(idempotencyKey ? { draftMutation: { idempotencyKey, draftRevision: result.draftRevision } } : {}) }, 201)
  })
  api.get('/demands/:id', async c => c.json(await service.store.get(await actor(c), parse(z.uuid(), c.req.param('id')))))
  api.get('/demands/:id/versions/:versionId', async c => c.json(await service.store.version(await actor(c),
    parse(z.uuid(), c.req.param('id')), parse(z.uuid(), c.req.param('versionId')))))
  api.patch('/demands/:id', async c => {
    const user = await actor(c)
    const id = parse(z.uuid(), c.req.param('id'))
    const { draft, expectedDraftRevision, idempotencyKey } = await body(c, editDemand)
    const result = await service.store.edit(user, id, expectedDraftRevision, draft, idempotencyKey)
    const item = await service.store.get(user, id)
    return c.json({ ...item, ...(idempotencyKey ? { draftMutation: { idempotencyKey, draftRevision: result.draftRevision } } : {}) })
  })
  api.post('/demands/:id/precheck', async c => {
    const user = await actor(c)
    const input = await body(c, precheckInput)
    return c.json(await service.precheck(user, parse(z.uuid(), c.req.param('id')), input.expectedDraftRevision, input.modelId, c.req.raw.signal))
  })
  api.post('/demands/:id/submit', async c => {
    const user = await actor(c)
    return c.json(await service.submit(user, parse(z.uuid(), c.req.param('id')), await body(c, submitInput)), 202)
  })
  api.post('/demands/:id/reconcile', async c => c.json(await service.scheduleReconcile(await actor(c), parse(z.uuid(), c.req.param('id'))), 202))
  api.post('/demands/:id/confirm-import', async c => {
    const user = await actor(c)
    const id = parse(z.uuid(), c.req.param('id'))
    const input = await body(c, confirmImportInput)
    await service.store.confirmImport(user, id, input.expectedRevision, input.ownerId)
    return c.json(await service.store.get(user, id))
  })

  api.get('/admin/demands/templates', async c => c.json(await service.store.adminTemplates(await actor(c, false))))
  api.put('/admin/demands/templates', async c => c.json(await service.store.saveTemplate(await actor(c, false), await body(c, templateInput))))
  api.get('/admin/demands/identities', async c => c.json(await service.adminIdentities(await actor(c, false),
    parse(z.string().trim().toLowerCase().max(120), c.req.query('login') ?? ''))))
  api.put('/admin/demands/identities', async c => c.json(await service.saveIdentity(await actor(c, false), await body(c, identityInput))))
  api.post('/admin/demands/templates/:processCode/scan', async c => {
    const user = await actor(c, false)
    const input = await body(c, scanInput)
    return c.json(await service.scan(user, parse(processCode, c.req.param('processCode')), input.lookbackHours, input.cursor, input.until), 202)
  })
  api.post('/integrations/dingtalk/:tenantSlug/callback', async c => {
    const signatures = [...(c.req.queries('signature') ?? []), ...(c.req.queries('msg_signature') ?? [])]
    const timestamp = c.req.queries('timestamp') ?? []
    const nonce = c.req.queries('nonce') ?? []
    if (!signatures.length || new Set(signatures).size !== 1 || timestamp.length !== 1 || nonce.length !== 1) {
      throw new ControlError(403, 'INVALID_DINGTALK_CALLBACK', 'The DingTalk callback could not be verified.')
    }
    return c.json(await service.callback(parse(tenantSlug, c.req.param('tenantSlug')), { signature: signatures[0], timestamp: timestamp[0], nonce: nonce[0] },
      await c.req.json().catch(() => undefined)))
  })

  mountDemandConsole(app, options)
}
