import type { Context, Env, Hono } from 'hono'
import { html } from 'hono/html'
import { z } from 'zod'
import { ControlError } from '../contract'
import { assistantErpInput, assistantErpOutput } from '../erp/contract'
import type { ErpService } from '../erp/service'
import type { MemoryStore } from '../memory/store'
import { requireAdmin, type Actor } from '../store'
import { modelConsole, usageTable } from './console'
import { departmentInput, grantInput, membershipInput, modelContextInput, modelInput, projectInput, providerInput, userDepartmentInput } from './contract'
import { searchModelContext } from './context'
import { forwardModelRequest } from './gateway'
import type { ModelStore } from './store'

interface ModelRouteOptions<E extends Env> {
  store: ModelStore
  memory?: MemoryStore
  erp?: ErpService
  actor(c: Context<E>, deviceAllowed?: boolean): Promise<Actor>
  parse<T>(schema: z.ZodType<T>, input: unknown): T
  json<T>(c: Context<E>, schema: z.ZodType<T>): Promise<T>
  page(title: string, body: ReturnType<typeof html>): ReturnType<typeof html>
}

export function mountModelRoutes<E extends Env>(app: Hono<E>, options: ModelRouteOptions<E>) {
  const { store, actor, parse, json, page, erp } = options
  const api = app.basePath('/api/v1')
  api.get('/models/catalog', async c => {
    const catalog = await store.catalog(await actor(c), parse(z.uuid().nullable(), c.req.query('projectId') ?? null))
    return c.json(erp ? catalog : { ...catalog, models: catalog.models.map(model => ({ ...model, canQueryErp: false })) })
  })
  api.post('/models/grants', async c => c.json(await store.grant(await actor(c), await json(c, grantInput)), 201))
  const memory = options.memory
  if (memory) api.post('/models/context', async c => c.json(await searchModelContext(store, memory, await actor(c), await json(c, modelContextInput))))
  if (erp) api.post('/models/erp', async c => {
    const user = await actor(c)
    const input = await json(c, assistantErpInput)
    const policy = await store.erpPolicy(user, input)
    const verify = async () => {
      const current = await actor(c)
      const fresh = await store.erpPolicy(current, input)
      if (policy.revision !== fresh.revision) throw new ControlError(409, 'MODEL_ERP_CHANGED', '查询期间授权发生变化，请重新查询。')
      return current
    }
    if (input.action === 'list') {
      const environments = await erp.listForAssistant(user, policy)
      await verify()
      return c.json(assistantErpOutput.parse({ action: 'list', environments }))
    }
    const result = await erp.read(user, input.environmentId, input, c.req.raw.signal, verify, 'assistant')
    return c.json(assistantErpOutput.parse({ action: 'read', result }))
  })
  api.get('/model-usage/me', async c => c.json({ usage: await store.usage(await actor(c), false) }))
  api.get('/admin/models', async c => c.json(await store.admin(await actor(c, false))))
  api.get('/admin/model-usage', async c => c.json({ usage: await store.usage(await actor(c, false), true) }))
  api.post('/admin/models/providers', async c => c.json(await store.setProvider(await actor(c, false), await json(c, providerInput))))
  api.post('/admin/models/catalog', async c => c.json(await store.setModel(await actor(c, false), await json(c, modelInput))))
  api.post('/admin/model-projects', async c => c.json(await store.setProject(await actor(c, false), await json(c, projectInput))))
  api.post('/admin/model-project-memberships', async c => c.json(await store.setMembership(await actor(c, false), await json(c, membershipInput))))
  api.post('/admin/model-departments', async c => c.json(await store.setDepartment(await actor(c, false), await json(c, departmentInput))))
  api.post('/admin/model-department-assignments', async c => c.json(await store.assignDepartment(await actor(c, false), await json(c, userDepartmentInput))))
  api.post('/model-gateway/anthropic/v1/messages', c => forwardModelRequest(store, c.req.raw, 'anthropic', 'messages'))
  api.post('/model-gateway/anthropic/v1/messages/count_tokens', c => forwardModelRequest(store, c.req.raw, 'anthropic', 'count_tokens'))
  api.post('/model-gateway/openai/v1/chat/completions', c => forwardModelRequest(store, c.req.raw, 'openai', 'chat_completions'))

  app.get('/console/model-usage', async c => {
    const usage = await store.usage(await actor(c, false), false)
    return c.html(page('我的企业模型用量', html`<section>${usageTable(usage)}</section><a href="/">返回控制台</a>`))
  })
  app.get('/console/models', async c => {
    const user = await actor(c, false)
    const [data, usage] = await Promise.all([store.admin(user), store.usage(user, true)])
    return c.html(page('模型中心', modelConsole(data, usage, c.req.query('provider'), c.req.query('model'), c.req.query('project'))))
  })

  function form<T>(route: string, schema: z.ZodType<T>, fields: (params: URLSearchParams) => unknown, write: (actor: Actor, input: T) => Promise<unknown>) {
    app.post(`/console/models/${route}`, async c => {
      const user = await actor(c, false)
      requireAdmin(user)
      if (c.req.header('Content-Type')?.split(';')[0]?.toLowerCase() !== 'application/x-www-form-urlencoded') {
        throw new ControlError(400, 'FORM_REQUIRED', '请通过模型中心表单提交。')
      }
      const params = new URLSearchParams(await c.req.text())
      await write(user, parse(schema, fields(params)))
      return c.redirect('/console/models', 303)
    })
  }

  form('providers', providerInput, f => ({ id: f.get('id'), displayName: f.get('displayName'), protocol: f.get('protocol'),
    baseUrl: f.get('baseUrl'), authHeader: f.get('authHeader'), apiKey: f.get('apiKey') || undefined,
    classifications: f.getAll('classifications'), streamUsage: f.has('streamUsage'), enabled: f.has('enabled') }), store.setProvider.bind(store))
  form('catalog', modelInput, f => ({ id: f.get('id'), displayName: f.get('displayName'), providerId: f.get('providerId'), upstreamModel: f.get('upstreamModel'),
    contextWindow: Number(f.get('contextWindow')), maxOutputTokens: Number(f.get('maxOutputTokens')), capabilities: f.getAll('capabilities'),
    defaultEffort: f.get('defaultEffort') || null, allowedRoles: f.getAll('allowedRoles'), projectId: f.get('projectId') || null,
    dailyTokens: f.get('dailyTokens') ? Number(f.get('dailyTokens')) : null, softDailyTokens: f.get('softDailyTokens') ? Number(f.get('softDailyTokens')) : null,
    isDefault: f.has('isDefault'), enabled: f.has('enabled'), allowContext: f.has('allowContext'),
    allowErpRead: f.has('allowErpRead') }), store.setModel.bind(store))
  form('projects', projectInput, f => ({ id: f.get('id') || undefined, name: f.get('name'), classification: f.get('classification'), active: f.has('active') }), store.setProject.bind(store))
  form('memberships', membershipInput, f => ({ projectId: f.get('projectId'), userId: f.get('userId'),
    enabled: f.get('enabled') === 'true' ? true : f.get('enabled') === 'false' ? false : undefined }), store.setMembership.bind(store))
  form('departments', departmentInput, f => ({ id: f.get('id') || undefined, name: f.get('name') }), store.setDepartment.bind(store))
  form('department-assignments', userDepartmentInput, f => ({ userId: f.get('userId'), departmentId: f.get('departmentId') || null }), store.assignDepartment.bind(store))
}
