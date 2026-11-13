import type { Context, Env, Hono } from 'hono'
import type { html } from 'hono/html'
import { z } from 'zod'
import type { Actor } from '../store'
import { assignInput, bindInput, checkInput, materialVerificationInput, readDeliveryRevision, reviewInput, transitionInput } from './contract'
import { mountDeliveryConsole } from './console'
import type { DeliveryStore } from './store'

interface DeliveryRouteOptions<E extends Env> {
  store: DeliveryStore
  actor(c: Context<E>, deviceAllowed?: boolean): Promise<Actor>
  parse<T>(schema: z.ZodType<T>, input: unknown): T
  json<T>(c: Context<E>, schema: z.ZodType<T>): Promise<T>
  page?(title: string, body: ReturnType<typeof html>): ReturnType<typeof html>
  notify?(tenantId: string, userId: string | null): void
}

export function mountDeliveryRoutes<E extends Env>(app: Hono<E>, options: DeliveryRouteOptions<E>) {
  const { store, actor, parse, json, notify } = options
  const api = app.basePath('/api/v1')
  const id = z.uuid()
  const limit = z.coerce.number().int().min(1).max(100)

  async function changed(c: Context<E>, user: Actor, work: Promise<Awaited<ReturnType<DeliveryStore['get']>>>, status: 200 | 201 = 200) {
    const task = await work
    notify?.(user.tenantId, null)
    c.header('ETag', `"${task.revision}"`)
    return c.json(task, status)
  }
  api.get('/deliveries', async c => c.json({ items: await store.list(await actor(c), parse(id.optional(), c.req.query('demandId')),
    parse(limit, c.req.query('limit') ?? '30')) }))
  api.get('/deliveries/assignment-options', async c => c.json(await store.assignmentOptions(await actor(c), parse(id, c.req.query('demandId')))))
  api.post('/demands/:id/assign', async c => {
    const user = await actor(c)
    return changed(c, user, store.assign(user, parse(id, c.req.param('id')), await json(c, assignInput)), 201)
  })
  api.get('/deliveries/:id', async c => {
    const task = await store.get(await actor(c), parse(id, c.req.param('id')))
    c.header('ETag', `"${task.revision}"`)
    return c.json(task)
  })
  api.post('/deliveries/:id/bind', async c => {
    const user = await actor(c)
    return changed(c, user, store.bind(user, parse(id, c.req.param('id')), readDeliveryRevision(c.req.header('If-Match')), await json(c, bindInput)))
  })
  api.post('/deliveries/:id/checks', async c => {
    const user = await actor(c)
    const result = await store.check(user, parse(id, c.req.param('id')), readDeliveryRevision(c.req.header('If-Match')),
      await json(c, checkInput), parse(id.optional(), c.req.header('Idempotency-Key')))
    notify?.(user.tenantId, null)
    c.header('ETag', `"${result.task.revision}"`)
    return c.json(result, 201)
  })
  api.get('/deliveries/:id/checks/:runId', async c => c.json(await store.getCheck(await actor(c),
    parse(id, c.req.param('id')), parse(id, c.req.param('runId')))))
  api.post('/deliveries/:id/materials', async c => {
    const user = await actor(c)
    const result = await store.verifyMaterials(user, parse(id, c.req.param('id')), readDeliveryRevision(c.req.header('If-Match')),
      await json(c, materialVerificationInput))
    if (result.changed) notify?.(user.tenantId, null)
    c.header('ETag', `"${result.task.revision}"`)
    return c.json(result.task)
  })
  api.post('/deliveries/:id/reviews', async c => {
    const user = await actor(c)
    return changed(c, user, store.review(user, parse(id, c.req.param('id')), readDeliveryRevision(c.req.header('If-Match')), await json(c, reviewInput)))
  })
  api.post('/deliveries/:id/transition', async c => {
    const user = await actor(c)
    return changed(c, user, store.transition(user, parse(id, c.req.param('id')), readDeliveryRevision(c.req.header('If-Match')), await json(c, transitionInput)))
  })
  if (options.page) mountDeliveryConsole(app, { store, actor, parse, page: options.page, notify })
}
