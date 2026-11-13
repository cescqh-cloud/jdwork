import { randomUUID } from 'node:crypto'
import type { Context, Env, Hono } from 'hono'
import { html } from 'hono/html'
import { z } from 'zod'
import { ControlError } from '../contract'
import type { Actor } from '../store'
import { erpExecuteInput, erpKey, erpPlanDecision, erpPlanInput, runErpQueryInput } from './contract'
import type { ErpService } from './service'

interface ErpRouteOptions<E extends Env> {
  service: ErpService
  actor(c: Context<E>, deviceAllowed?: boolean): Promise<Actor>
  parse<T>(schema: z.ZodType<T>, input: unknown): T
  json<T>(c: Context<E>, schema: z.ZodType<T>): Promise<T>
  page(title: string, body: ReturnType<typeof html>): ReturnType<typeof html>
}

const modeLabel = { sandbox: '沙箱', test: '测试', production: '生产' }
const planLabel = { pending: '待独立审批', approved: '审批通过 · 未执行', rejected: '已驳回', executing: '执行确认中',
  completed: '已执行', unknown: '结果待人工核实', failed: '执行失败' }
const uuid = z.uuid()

export function mountErpRoutes<E extends Env>(app: Hono<E>, { service, actor, parse, json, page }: ErpRouteOptions<E>) {
  const api = app.basePath('/api/v1/erp')
  api.get('/environments', async c => c.json({ environments: await service.list(await actor(c)) }))
  api.post('/environments/:id/read', async c => {
    const user = await actor(c)
    return c.json(await service.read(user, parse(erpKey, c.req.param('id')), await json(c, runErpQueryInput), c.req.raw.signal, () => actor(c)))
  })
  api.get('/environments/:id/plans', async c => c.json(await service.plans.list(await actor(c), parse(erpKey, c.req.param('id')), parse(uuid, c.req.query('projectId')))))
  api.post('/environments/:id/plans', async c => c.json(await service.plans.create(await actor(c), parse(erpKey, c.req.param('id')), await json(c, erpPlanInput)), 201))
  api.post('/environments/:id/plans/:planId/decision', async c => c.json(await service.plans.decide(await actor(c, false),
    parse(erpKey, c.req.param('id')), parse(uuid, c.req.param('planId')), await json(c, erpPlanDecision))))
  api.post('/environments/:id/plans/:planId/execute', async c => c.json(await service.plans.execute(await actor(c, false),
    parse(erpKey, c.req.param('id')), parse(uuid, c.req.param('planId')), await json(c, erpExecuteInput))))

  app.get('/console/erp', async c => {
    const environments = await service.list(await actor(c, false))
    return c.html(page('金蝶只读查询', html`<p><a href="/">返回控制台</a></p>
      <p>按已授权项目查询金蝶接口。采购收货等业务查询需填完整单据编号。</p>
      ${environments.length ? environments.map(env => html`<section><h2>${env.name} · ${modeLabel[env.mode]}</h2>
        ${env.queries.map(query => html`<form method="post" action="/console/erp/${env.id}">
          <h3>${query.label}</h3><input type="hidden" name="operation" value="${query.id}">
          <label>项目<select name="projectId" required>${env.projects.map(project => html`<option value="${project.id}">${project.name}</option>`)}</select></label>
          ${query.requiresNumber ? html`<label>单据编号<input name="number" required maxlength="80" autocomplete="off"></label>` : ''}
          <button>${query.kind === 'connection' ? '测试连接' : '查询'}</button></form>`)}
        ${env.projects.filter(project => project.writeApprovalEnabled).map(project => html`<p><a href="/console/erp/${env.id}/plans?projectId=${project.id}">ERP 写操作审批 · ${project.name}</a></p>`)}</section>`)
        : html`<p>暂无已授权的金蝶查询环境。</p>`}`))
  })
  app.post('/console/erp/:id', async c => {
    const user = await actor(c, false)
    const form = await c.req.parseBody().catch(() => { throw new ControlError(400, 'INVALID_INPUT', '请核对查询条件。') })
    const input = parse(runErpQueryInput, { projectId: form.projectId, operation: form.operation, number: form.number || undefined })
    const result = await service.read(user, parse(erpKey, c.req.param('id')), input, c.req.raw.signal, () => actor(c, false))
    const { query, rows } = result
    return c.html(page(query.label, html`<p><a href="/console/erp">返回金蝶查询</a></p><section>
      <h2>${result.environmentName} · ${modeLabel[result.mode]}</h2><p>查询时间 ${result.checkedAt}</p>
      ${query.kind === 'connection' ? html`<p>接口连通</p>` : rows.length ? html`<p>返回 ${rows.length} 条${result.truncated ? '（已达展示上限）' : ''}</p>
        <div class="table-scroll"><table><thead><tr>${query.columns.map(column => html`<th>${column.title}</th>`)}</tr></thead>
          <tbody>${rows.map(row => html`<tr>${query.columns.map(column => html`<td>${row[column.key] == null ? '—' : String(row[column.key])}</td>`)}</tr>`)}</tbody></table></div>`
        : html`<p>本次查询未返回匹配记录。</p>`}<p>查询编号 ${result.requestId}</p></section>`))
  })

  app.get('/console/erp/:id/plans', async c => {
    const user = await actor(c, false)
    const id = parse(erpKey, c.req.param('id'))
    const { environment, project, canRequest, plans } = await service.plans.list(user, id, parse(uuid, c.req.query('projectId')))
    return c.html(page('ERP 写操作审批', html`<p><a href="/console/erp">返回金蝶查询</a></p><section>
      <h2>${environment.name} · ${modeLabel[environment.mode]} · ${project.name}</h2>
      <p>申请会冻结本次变更内容，由同项目的独立审批人处理。当前连接只开放查询，审批通过后由获授权人员处理。</p>
      ${canRequest ? html`<form method="post" action="/console/erp/${id}/plans">
        <input type="hidden" name="projectId" value="${project.id}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}">
        <label>业务对象<input name="object" required maxlength="100"></label>
        <label>单据编号<input name="documentNumber" required maxlength="80"></label>
        <label>变更内容<textarea name="change" required maxlength="1200" rows="3"></textarea></label>
        <label>申请原因<textarea name="reason" required maxlength="1200" rows="2"></textarea></label>
        <button>提交 ERP 写操作申请</button></form>` : ''}</section>
      <section><h2>申请记录</h2>${plans.length ? plans.map(plan => html`<details>
        <summary>${plan.snapshot.object} · ${plan.snapshot.documentNumber} · ${planLabel[plan.state]}</summary>
        <p>提交时间 ${plan.createdAt}</p><p>变更内容</p><pre>${plan.snapshot.change}</pre><p>申请原因</p><pre>${plan.snapshot.reason}</pre>
        ${plan.decisionNote ? html`<p>审批意见 ${plan.decisionNote}</p>` : ''}
        ${plan.canReview ? html`<form method="post" action="/console/erp/${id}/plans/${plan.id}/decision">
          <input type="hidden" name="projectId" value="${project.id}"><input type="hidden" name="expectedRevision" value="${plan.revision}">
          <label>审批意见<textarea name="note" required maxlength="400" rows="2"></textarea></label>
          <button name="decision" value="approve">审批通过</button><button class="secondary" name="decision" value="reject">驳回</button></form>` : ''}</details>`)
        : html`<p>暂无申请。</p>`}</section>`))
  })
  app.post('/console/erp/:id/plans', async c => {
    const user = await actor(c, false)
    const id = parse(erpKey, c.req.param('id'))
    const input = parse(erpPlanInput, await c.req.parseBody().catch(() => null))
    await service.plans.create(user, id, input)
    return c.redirect(`/console/erp/${id}/plans?projectId=${input.projectId}`, 303)
  })
  app.post('/console/erp/:id/plans/:planId/decision', async c => {
    const user = await actor(c, false)
    const id = parse(erpKey, c.req.param('id'))
    const form = await c.req.parseBody().catch(() => { throw new ControlError(400, 'INVALID_INPUT', '请核对审批内容。') })
    const input = parse(erpPlanDecision, { ...form, expectedRevision: Number(form.expectedRevision) })
    await service.plans.decide(user, id, parse(uuid, c.req.param('planId')), input)
    return c.redirect(`/console/erp/${id}/plans?projectId=${input.projectId}`, 303)
  })
}
