import type { Env, Hono } from 'hono'
import { z } from 'zod'
import { ControlError } from '../contract'
import { channel, checkInput, createReleaseInput, pauseInput, publishInput, reportInput } from './contract'
import { mountReleaseConsole } from './console'
import { contentType, json, parse, type ReleaseRoutesOptions } from './route-utils'

const page = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).max(50_000).default(0) })

export function mountReleaseRoutes<E extends Env>(app: Hono<E>, options: ReleaseRoutesOptions) {
  const { service, actor } = options
  const api = app.basePath('/api/v1')
  api.get('/admin/releases', async c => {
    const user = await actor(c, false)
    const query = parse(page, c.req.query())
    return c.json(await service.store.list(user, query.limit, query.offset))
  })
  api.get('/admin/releases/audience', async c => c.json(await service.store.audiences(await actor(c, false),
    parse(z.string().trim().max(120), c.req.query('search') ?? ''))))
  api.post('/admin/releases', async c => c.json(await service.store.create(await actor(c, false), await json(c, createReleaseInput)), 201))
  api.get('/admin/releases/:id', async c => c.json(await service.store.detail(await actor(c, false), parse(z.uuid(), c.req.param('id')))))
  api.put('/admin/releases/:id/manifest', async c => {
    const user = await actor(c, false)
    contentType(c, ['application/yaml', 'application/x-yaml', 'text/yaml', 'text/plain', 'application/octet-stream'])
    return c.json(await service.uploadManifest(user, parse(z.uuid(), c.req.param('id')), c.req.raw.body))
  })
  api.put('/admin/releases/:id/package', async c => {
    const user = await actor(c, false)
    contentType(c, ['application/octet-stream'])
    return c.json(await service.uploadInstaller(user, parse(z.uuid(), c.req.param('id')), c.req.raw))
  })
  api.post('/admin/releases/:id/publish', async c => {
    const user = await actor(c, false)
    const input = await json(c, publishInput)
    return c.json(await service.publish(user, parse(z.uuid(), c.req.param('id')), input.expectedRevision, input.testEvidence))
  })
  api.post('/admin/releases/:id/pause', async c => {
    const user = await actor(c, false)
    const input = await json(c, pauseInput)
    return c.json(await service.store.pause(user, parse(z.uuid(), c.req.param('id')), input.expectedRevision, input.reason))
  })
  api.get('/updates/key', async c => {
    if (!(await actor(c)).device) throw new ControlError(403, 'UPDATE_DEVICE_REQUIRED', 'Use an active enterprise-bound desktop device.')
    return c.json(service.key())
  })
  api.get('/updates/check', async c => c.json(await service.check(await actor(c), parse(checkInput, c.req.query()))))
  api.get('/updates/manifest/:channel', async c => {
    const user = await actor(c)
    const expected = parse(channel, c.req.param('channel'))
    const result = await service.check(user, parse(checkInput, { ...c.req.query(), channel: expected }))
    return c.json(result.candidate)
  })
  api.on(['GET', 'HEAD'], '/updates/feed/:releaseId/:filename', async c => service.feed(await actor(c),
    parse(z.uuid(), c.req.param('releaseId')), c.req.param('filename'), c.req.raw))
  api.post('/client/update-reports', async c => c.json(await service.report(await actor(c), await json(c, reportInput))))
  mountReleaseConsole(app, options)
}
