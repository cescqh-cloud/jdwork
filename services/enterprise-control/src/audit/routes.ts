import type { Context, Env, Hono } from 'hono'
import { html } from 'hono/html'
import type { z } from 'zod'
import { ControlError } from '../contract'
import type { Actor } from '../store'
import { auditCategory, auditCategoryLabels, auditFilter, auditQuery, type AuditEntry } from './contract'
import { auditExportLimit, type AuditStore } from './store'

interface AuditRoutes<E extends Env> {
  store: AuditStore
  actor(c: Context<E>, deviceAllowed?: boolean): Promise<Actor>
  parse<T>(schema: z.ZodType<T>, input: unknown): T
  json<T>(c: Context<E>, schema: z.ZodType<T>): Promise<T>
  page(title: string, body: ReturnType<typeof html>): ReturnType<typeof html>
}

function csv(entries: AuditEntry[]) {
  const rows = [['occurred_at_utc', 'category', 'action', 'label', 'actor_id', 'target_id', 'event_id', 'source']]
  for (const item of entries) rows.push([item.occurredAt, item.category, item.action, item.label, item.actorId ?? '', item.targetId, item.id, item.source])
  return '\uFEFF' + rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n'
}

function download<E extends Env>(c: Context<E>, result: Awaited<ReturnType<AuditStore['export']>>) {
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', 'attachment; filename="enterprise-audit.csv"')
  c.header('X-Audit-Export-Truncated', String(result.truncated))
  return c.body(csv(result.entries))
}

export function mountAuditRoutes<E extends Env>(app: Hono<E>, { store, actor, parse, json, page }: AuditRoutes<E>) {
  const api = app.basePath('/api/v1/admin/audit')
  api.get('/', async c => c.json(await store.list(await actor(c, false), parse(auditQuery, c.req.query()))))
  api.post('/export', async c => download(c, await store.export(await actor(c, false), await json(c, auditFilter))))

  app.get('/console/audit', async c => {
    const { filters, entries, nextCursor } = await store.list(await actor(c, false), parse(auditQuery, c.req.query()))
    const query = new URLSearchParams(filters)
    const firstPage = query.toString()
    if (nextCursor) query.set('cursor', nextCursor)
    return c.html(page('操作审计', html`<p><a href="/">返回控制台</a></p>
      <section><h2>按日期和模块筛选</h2>
        <form method="get" action="/console/audit" class="field-pair">
          <label>起始日期（UTC）<input type="date" name="from" value="${filters.from}" required></label>
          <label>结束日期（UTC）<input type="date" name="to" value="${filters.to}" required></label>
          <label><span id="audit-module-label">模块</span><select name="category" aria-labelledby="audit-module-label">${auditCategory.options.map(category => html`<option value="${category}" ${category === filters.category ? 'selected' : ''}>${auditCategoryLabels[category]}</option>`)}</select></label>
          <button>查询</button>
        </form>
        <p>每次最多导出 ${auditExportLimit} 条符合筛选条件的记录。审计页只展示操作、时间和内部标识。</p>
        <form method="post" action="/console/audit/export">
          <input type="hidden" name="from" value="${filters.from}"><input type="hidden" name="to" value="${filters.to}">
          <input type="hidden" name="category" value="${filters.category}"><button class="secondary">导出脱敏 CSV</button>
        </form>
      </section>
      <section><h2>审计记录</h2>
        ${entries.length ? html`<div class="table-scroll"><table><thead><tr><th>时间（UTC）</th><th>模块</th><th>操作</th><th>操作人标识</th><th>对象标识</th></tr></thead>
          <tbody>${entries.map(item => html`<tr><td><time datetime="${item.occurredAt}">${item.occurredAt.slice(0, 19).replace('T', ' ')}</time></td>
            <td>${auditCategoryLabels[item.category]}</td><td>${item.label}</td>
            <td>${item.actorId ? html`<span title="${item.actorId}">${item.actorId.slice(0, 8)}</span>` : '系统'}</td>
            <td><span title="${item.targetId}">${item.targetId.slice(0, 8)}</span></td></tr>`)}</tbody></table></div>` : html`<p>这段日期没有符合条件的记录。</p>`}
        <p>${c.req.query('cursor') ? html`<a href="/console/audit?${firstPage}">回到第一页</a> ` : ''}
          ${nextCursor ? html`<a href="/console/audit?${query.toString()}">下一页</a>` : ''}</p>
      </section>`))
  })
  app.post('/console/audit/export', async c => {
    const user = await actor(c, false)
    const input = parse(auditFilter, await c.req.parseBody().catch(() => { throw new ControlError(400, 'INVALID_INPUT', '请核对导出日期与模块。') }))
    return download(c, await store.export(user, input))
  })
}
