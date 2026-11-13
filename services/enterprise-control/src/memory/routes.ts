import type { Context, Env, Hono } from 'hono'
import type { html } from 'hono/html'
import { z } from 'zod'
import type { Actor } from '../store'
import { candidateInput, editKnowledgeInput, editMemoryInput, MemoryRevisionConflict, newKnowledgeInput, readCursor, readRevision, searchInput } from './contract'
import { mountMemoryConsole } from './console'
import { limitKnowledgeUpload, readKnowledgeUpload } from './import'
import type { MemoryStore } from './store'

interface MemoryRouteOptions<E extends Env> {
  store: MemoryStore
  actor(c: Context<E>, deviceAllowed?: boolean): Promise<Actor>
  parse<T>(schema: z.ZodType<T>, input: unknown): T
  json<T>(c: Context<E>, schema: z.ZodType<T>): Promise<T>
  page?(title: string, body: ReturnType<typeof html>): ReturnType<typeof html>
}

const listLimit = z.coerce.number().int().min(1).max(100)
const citedRevision = z.coerce.number().int().min(1).max(2_147_483_647).optional()

async function reply<E extends Env>(c: Context<E>, work: Promise<{ revision: number }>, status: 200 | 201 = 200) {
  try {
    const result = await work
    c.header('ETag', `"${result.revision}"`)
    return c.json(result, status)
  } catch (error) {
    if (!(error instanceof MemoryRevisionConflict)) throw error
    c.header('ETag', `"${error.current.revision}"`)
    return c.json({ error: { code: error.code, message: error.message }, current: error.current, submitted: error.submitted }, 409)
  }
}

export function mountMemoryRoutes<E extends Env>(app: Hono<E>, options: MemoryRouteOptions<E>) {
  const { store, actor, parse, json } = options
  const api = app.basePath('/api/v1')
  api.get('/memories/scopes', async c => c.json(await store.availableScopes(await actor(c))))
  api.get('/memories/candidates', async c => c.json({ items: await store.candidates(await actor(c), parse(listLimit, c.req.query('limit') ?? '30')) }))
  api.post('/memories/candidates', async c => reply(c, store.createCandidate(await actor(c), await json(c, candidateInput),
    parse(z.uuid().optional(), c.req.header('Idempotency-Key'))), 201))
  api.post('/memories/search', async c => c.json(await store.search(await actor(c), await json(c, searchInput))))
  api.get('/memories/changes', async c => c.json(await store.changes(await actor(c), readCursor(c.req.query('cursor')))))
  api.get('/memories/:id', async c => reply(c, store.get(await actor(c), parse(z.uuid(), c.req.param('id')))))
  api.patch('/memories/:id', async c => reply(c, store.update(await actor(c), parse(z.uuid(), c.req.param('id')),
    readRevision(c.req.header('If-Match')), await json(c, editMemoryInput))))
  api.delete('/memories/:id', async c => reply(c, store.remove(await actor(c), parse(z.uuid(), c.req.param('id')),
    readRevision(c.req.header('If-Match')))))
  api.post('/memories/:id/publish', async c => reply(c, store.publish(await actor(c), parse(z.uuid(), c.req.param('id')),
    readRevision(c.req.header('If-Match')))))

  api.post('/knowledge/search', async c => c.json(await store.searchKnowledge(await actor(c), await json(c, searchInput))))
  api.get('/knowledge/:id', async c => reply(c, store.getKnowledge(await actor(c), parse(z.uuid(), c.req.param('id')),
    parse(citedRevision, c.req.query('revision')))))
  api.get('/admin/knowledge', async c => c.json({ items: await store.listKnowledge(await actor(c, false),
    parse(listLimit, c.req.query('limit') ?? '30')) }))
  api.post('/admin/knowledge', async c => reply(c, store.createKnowledge(await actor(c, false), await json(c, newKnowledgeInput)), 201))
  api.use('/admin/knowledge/import', limitKnowledgeUpload)
  api.post('/admin/knowledge/import', async c => {
    const result = await store.importProjectKnowledge(await actor(c, false), await readKnowledgeUpload(c.req.raw))
    return c.json(result, result.items.some(item => item.created) ? 201 : 200)
  })
  api.get('/admin/knowledge/:id', async c => reply(c, store.getManagedKnowledge(await actor(c, false), parse(z.uuid(), c.req.param('id')))))
  api.patch('/admin/knowledge/:id', async c => reply(c, store.updateKnowledge(await actor(c, false), parse(z.uuid(), c.req.param('id')),
    readRevision(c.req.header('If-Match')), await json(c, editKnowledgeInput))))
  api.delete('/admin/knowledge/:id', async c => reply(c, store.removeKnowledge(await actor(c, false), parse(z.uuid(), c.req.param('id')),
    readRevision(c.req.header('If-Match')))))
  api.post('/admin/knowledge/:id/publish', async c => reply(c, store.publishKnowledge(await actor(c, false), parse(z.uuid(), c.req.param('id')),
    readRevision(c.req.header('If-Match')))))
  if (options.page) mountMemoryConsole(app, { store, actor, parse, page: options.page })
}
