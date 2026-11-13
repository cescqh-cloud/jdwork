import { randomUUID } from 'node:crypto'
import type { Env, Hono } from 'hono'
import { html } from 'hono/html'
import { z } from 'zod'
import { ControlError } from '../contract'
import { confirmImportInput, draftInput, editDemand, identityInput, precheckInput, processCode, submitInput, templateInput,
  type DemandDraft, type DemandState, type FieldMap, type FieldName } from './contract'
import { parse, type DemandRoutesOptions } from './route-utils'

const base = '/console/demands'
const labels: Record<DemandState, string> = { DRAFT: '草稿', AI_PRECHECK: '已预审', SUBMITTING: '准备送审', SUBMIT_FAILED: '送审待核查',
  PENDING: '钉钉审批中', IMPORT_REVIEW: '导入待确认', BACKLOG: '已进入需求池', REJECTED: '已驳回', CANCELLED: '已撤销', CHANGE_REQUEST: '变更草稿' }
const fieldLabels: Record<FieldName, string> = { title: '需求名称', systemKey: '涉及系统', category: '需求类型', businessContext: '现状与问题',
  expectedValue: '预期收益', acceptanceCriteria: '验收要求', businessOwner: '业务责任人', priority: '期望时间或紧急程度', attachmentRefs: '附件引用',
  demandNo: '需求编号', precheckSummary: '预审摘要', versionRef: '工作台版本标识' }

const css = `main.demand-main{max-width:1120px}main.demand-main nav,.demand-actions{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin:.8rem 0}
.demand-form{display:grid;gap:1rem}.demand-form label{font-weight:500}.demand-form input,.demand-form textarea,.demand-form select{width:100%;font:inherit}
.demand-form textarea,.demand-form select{padding:.65rem;border:1px solid #8d9bab;border-radius:6px}.demand-form textarea{min-height:100px;resize:vertical}
.demand-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:.8rem}.demand-muted{color:#526676}.demand-badge{display:inline-block;padding:.12rem .55rem;border-radius:999px;background:#e7f2ee;color:#184e3d}
.demand-notice{background:#fcf6e5;border-color:#e2ce97}.demand-form details,.demand-view details{padding:.7rem 0}.demand-form summary,.demand-view summary{cursor:pointer;font-weight:600}
.demand-view pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:.25rem 0}.demand-view dt{font-weight:600}.demand-view dd{margin:.25rem 0 1rem}
.demand-main button{width:fit-content}.demand-form fieldset{border:1px solid #d7e0e8;border-radius:6px;margin:0}.demand-form fieldset label{display:flex;gap:.4rem;align-items:center}.demand-form input[type=checkbox]{width:auto}`

function layout(title: string, content: ReturnType<typeof html>, admin = false) {
  return html`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title} · 企业研发工作台</title><link rel="stylesheet" href="/console.css"><link rel="stylesheet" href="${base}/style.css"></head>
    <body><main class="demand-main"><header><a href="/">企业控制台</a><h1>${title}</h1><nav>
      <a href="${base}">全部需求</a><a href="${base}?view=backlog">需求池</a>${admin ? html`<a href="${base}/settings">钉钉审批设置</a>` : ''}
    </nav></header>${content}</main></body></html>`
}

function draftFields(draft: DemandDraft) {
  return html`<label>需求名称<input name="title" value="${draft.title}" maxlength="160"></label>
    <div class="demand-grid">
      <label>涉及系统<input name="systemKey" value="${draft.systemKey}" maxlength="80" placeholder="如 星瀚、SRM"></label>
      <label>需求类型<input name="category" value="${draft.category}" maxlength="80" placeholder="如 报表、流程优化"></label>
    </div>
    <label>现状与问题<textarea name="businessContext" maxlength="5000">${draft.businessContext}</textarea></label>
    <details><summary>补充收益、验收要求和附件</summary>
      <label>预期收益<textarea name="expectedValue" maxlength="2000">${draft.expectedValue}</textarea></label>
      <label>验收要求<textarea name="acceptanceCriteria" maxlength="2000">${draft.acceptanceCriteria}</textarea></label>
      <div class="demand-grid"><label>业务责任人<input name="businessOwner" value="${draft.businessOwner}" maxlength="120"></label>
      <label>期望时间或紧急程度<input name="priority" value="${draft.priority}" maxlength="80"></label></div>
      <label>附件引用（JSON，可留空）<textarea name="attachmentRefs">${draft.attachmentRefs.length ? JSON.stringify(draft.attachmentRefs) : ''}</textarea></label>
    </details>`
}

function jsonField(value: unknown, name: string, fallback: unknown) {
  if (value === '' || value === undefined) return fallback
  try { return JSON.parse(String(value)) as unknown }
  catch { throw new ControlError(400, 'DEMAND_INPUT_INVALID', `请检查 ${name} 的格式。`) }
}

function readDraft(data: Record<string, unknown>) {
  return parse(draftInput, {
    title: data.title, systemKey: data.systemKey, category: data.category, businessContext: data.businessContext,
    expectedValue: data.expectedValue, acceptanceCriteria: data.acceptanceCriteria, businessOwner: data.businessOwner,
    priority: data.priority, attachmentRefs: jsonField(data.attachmentRefs, '附件引用', []),
  })
}

const optionalNonempty = z.string().trim().min(1).max(120).optional()
const admin = (user: { roles: string[] }) => user.roles.includes('platform_admin')
const lead = (user: { roles: string[] }) => user.roles.includes('it_lead')
const createAllowed = (user: { roles: string[] }) => user.roles.some(role => ['requester', 'developer', 'project_owner', 'it_lead', 'platform_admin'].includes(role))
const detailPath = (id: string) => `${base}/${id}`

function reviewLines(title: string, lines: string[]) {
  return lines.length ? html`<h3>${title}</h3><ul>${lines.map(line => html`<li>${line}</li>`)}</ul>` : ''
}

function mappingFields(mapping: FieldMap) {
  return Object.entries(fieldLabels).map(([key, label]) => html`<div class="demand-grid">
    <label>${label}<input name="field.${key}.name" maxlength="120" value="${mapping[key as FieldName]?.name ?? ''}" placeholder="钉钉表单字段名称"></label>
    <label>组件 ID（可选）<input name="field.${key}.id" maxlength="192" value="${mapping[key as FieldName]?.id ?? ''}"></label>
  </div>`)
}

function readMapping(data: Record<string, unknown>) {
  const fieldMap = Object.fromEntries(Object.keys(fieldLabels).flatMap(key => {
    const name = data[`field.${key}.name`]
    const id = data[`field.${key}.id`]
    return typeof name === 'string' && name.trim() ? [[key, { name, ...(typeof id === 'string' && id.trim() ? { id: id.trim() } : {}) }]] : []
  }))
  return parse(templateInput, { processCode: data.processCode, label: data.label, fieldMap, submitEnabled: data.submitEnabled === 'yes',
    importEnabled: data.importEnabled === 'yes', approverOptions: jsonField(data.approverOptions, '自选审批节点', []),
    expectedRevision: data.expectedRevision ? Number(data.expectedRevision) : null })
}

export function mountDemandConsole<E extends Env>(app: Hono<E>, { service, actor }: DemandRoutesOptions) {
  app.get(`${base}/style.css`, c => c.text(css, 200, { 'Content-Type': 'text/css; charset=utf-8' }))
  app.get(base, async c => {
    const user = await actor(c, false)
    const backlog = c.req.query('view') === 'backlog'
    const offset = parse(z.coerce.number().int().min(0).max(50_000).default(0), c.req.query('offset'))
    const { demands } = await service.store.list(user, backlog, 30, offset)
    const link = (position: number) => `${base}?${new URLSearchParams({ view: backlog ? 'backlog' : 'all', offset: String(position) })}`
    return c.html(layout(backlog ? '需求池' : '需求中心', html`
      <p>审批通过的版本进入需求池等待排期。ERP、SQL 等操作按各自的授权流程处理。</p>
      ${createAllowed(user) ? html`<nav><a href="${base}/new">新建需求</a></nav>` : ''}
      <section><div class="table-scroll"><table><thead><tr><th>需求编号</th><th>需求名称</th><th>状态</th><th>来源</th><th>最近更新</th></tr></thead>
      <tbody>${demands.map(demand => html`<tr><td><a href="${detailPath(demand.id)}">${demand.demandNo}</a></td>
        <td>${demand.title || '未命名需求'}</td><td><span class="demand-badge">${labels[demand.state]}</span></td>
        <td>${demand.origin === 'DINGTALK' ? '钉钉导入' : '工作台发起'}</td><td>${demand.updatedAt.slice(0, 10)}</td></tr>`)}</tbody></table></div>
        ${demands.length ? '' : html`<p>当前范围内暂无需求。</p>`}
      </section><nav>${offset ? html`<a href="${link(Math.max(0, offset - 30))}">上一页</a>` : ''}
        ${demands.length === 30 ? html`<a href="${link(offset + 30)}">下一页</a>` : ''}</nav>`, admin(user)))
  })

  app.get(`${base}/new`, async c => {
    const user = await actor(c, false)
    if (!createAllowed(user)) throw new ControlError(403, 'DEMAND_CREATE_DENIED', '当前角色没有新建需求权限。')
    return c.html(layout('新建需求', html`<section><p>可以先保存草稿。预审前请补齐需求名称、涉及系统、类型和问题描述。</p>
      <form class="demand-form" method="post" action="${base}/new">${draftFields(draftInput.parse({}))}<button>保存草稿</button></form></section>`, admin(user)))
  })
  app.post(`${base}/new`, async c => {
    const user = await actor(c, false)
    return c.redirect(detailPath(await service.store.create(user, readDraft(await c.req.parseBody()))), 303)
  })

  app.get(`${base}/settings`, async c => {
    const user = await actor(c, false)
    const { templates } = await service.store.adminTemplates(user)
    const login = parse(z.string().trim().toLowerCase().max(120), c.req.query('login') ?? '')
    const [{ users }, capabilities] = await Promise.all([service.adminIdentities(user, login), service.capabilities(user)])
    const blank = { processCode: '', label: '', fieldMap: {}, submitEnabled: false, importEnabled: false, approverOptions: [], revision: 0 }
    return c.html(layout('钉钉审批设置', html`<section><h2>连接状态</h2>
      <p>钉钉 OA ${capabilities.oaConfigured ? '已配置' : '待服务端配置'} · 事件回调 ${capabilities.callbackConfigured ? '已配置' : '待配置'} · AI 预审 ${capabilities.aiPrecheckConfigured ? '已配置' : '待配置'}</p></section>
      <section><h2>审批模板</h2><p>只启用已授权的模板。发起审批时按钉钉原有流程办理，工作台版本标识请映射到专用的文本字段。</p>
      ${[...templates, blank].map(item => html`<details><summary>${item.label || '新增模板'}</summary>
        <form class="demand-form" method="post" action="${base}/settings/template">
          <div class="demand-grid"><label>模板名称<input name="label" value="${item.label}" required maxlength="120"></label>
          <label>模板 processCode<input name="processCode" value="${item.processCode}" required maxlength="120" ${item.revision ? html`readonly` : ''}></label></div>
          <input type="hidden" name="expectedRevision" value="${item.revision || ''}">
          <label><input type="checkbox" name="submitEnabled" value="yes" ${item.submitEnabled ? html`checked` : ''}>允许从工作台发起</label>
          <label><input type="checkbox" name="importEnabled" value="yes" ${item.importEnabled ? html`checked` : ''}>允许从钉钉导入</label>
          <details><summary>钉钉表单字段映射</summary>${mappingFields(item.fieldMap)}</details>
          <details><summary>模板自选审批节点</summary><label>节点和允许选择的人员（JSON）<textarea name="approverOptions">${JSON.stringify(item.approverOptions, null, 2)}</textarea></label></details>
          <button>保存模板</button>
        </form>
        ${item.importEnabled && capabilities.oaConfigured ? html`<form class="demand-actions" method="post" action="${base}/settings/scan">
          <input type="hidden" name="processCode" value="${item.processCode}"><label>补查小时数 <input type="number" name="lookbackHours" min="1" max="24" value="2"></label><button>补查已授权审批单</button></form>` : ''}
      </details>`)}</section>
      <section><h2>发起人身份映射</h2><form class="demand-actions" method="get" action="${base}/settings">
        <label>按工作台账号查找<input name="login" value="${login}" maxlength="120"></label><button>查找</button></form>
        ${capabilities.oaConfigured ? html`<p>最多显示 50 个账号。填入同一组织内的钉钉用户 ID 和部门 ID。</p>
          ${users.map(user => html`<details><summary>${user.displayName} · ${user.login} · ${user.staffId ? '已绑定' : '待绑定'}</summary>
            <form class="demand-form" method="post" action="${base}/settings/identity"><input type="hidden" name="userId" value="${user.userId}">
              <label>钉钉用户 ID<input name="staffId" value="${user.staffId ?? ''}" required maxlength="192"></label>
              <label>钉钉部门 ID<input type="number" name="departmentId" min="-1" value="${user.departmentId ?? ''}" required></label><button>保存身份映射</button>
            </form></details>`)}` : html`<p>连接配置完成后即可设置身份映射。</p>`}
      </section>`, true))
  })
  app.post(`${base}/settings/template`, async c => {
    await service.store.saveTemplate(await actor(c, false), readMapping(await c.req.parseBody()))
    return c.redirect(`${base}/settings`, 303)
  })
  app.post(`${base}/settings/identity`, async c => {
    const user = await actor(c, false)
    const data = await c.req.parseBody()
    await service.saveIdentity(user, parse(identityInput, { userId: data.userId, staffId: data.staffId, departmentId: Number(data.departmentId) }))
    return c.redirect(`${base}/settings`, 303)
  })
  app.post(`${base}/settings/scan`, async c => {
    const user = await actor(c, false)
    const data = await c.req.parseBody()
    const code = parse(processCode, data.processCode)
    const hours = parse(z.coerce.number().int().min(1).max(24), data.lookbackHours)
    const cursor = parse(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), data.cursor)
    const until = parse(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), data.until)
    const result = await service.scan(user, code, hours, cursor, until)
    return c.html(layout('审批单补查', html`<section><p>本页有 ${result.queued} 条实例进入核对队列。请在需求中心查看导入结果。</p>
      ${result.nextToken !== null ? html`<form class="demand-actions" method="post" action="${base}/settings/scan">
        <input type="hidden" name="processCode" value="${code}"><input type="hidden" name="lookbackHours" value="${hours}">
        <input type="hidden" name="cursor" value="${result.nextToken}"><input type="hidden" name="until" value="${result.until}"><button>补查下一页</button></form>` : ''}</section>`, admin(user)), 202)
  })

  app.get(`${base}/:id`, async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    const [item, capabilities, templates] = await Promise.all([service.store.get(user, id), service.capabilities(user), service.store.userTemplates(user)])
    const own = item.ownerId === user.id
    const canEdit = item.draft && ((own && createAllowed(user)) || (lead(user) && item.state === 'IMPORT_REVIEW'))
    const canSubmit = own && item.precheck && capabilities.oaConfigured && !['SUBMITTING', 'PENDING', 'IMPORT_REVIEW'].includes(item.state) &&
      item.submission?.state !== 'UNCONFIRMED' && (!item.activeVersion || item.unsubmittedChanges || item.submission?.state === 'DECLINED')
    const title = item.title || '未命名需求'
    const approval = item.approval
    return c.html(layout(title, html`<section class="demand-view"><p>${item.demandNo} · <span class="demand-badge">${labels[item.state]}</span></p>
      ${item.unsubmittedChanges ? html`<p class="demand-muted">当前草稿有修改，已送审的版本保留原内容。</p>` : ''}
      ${item.submission?.state === 'UNCONFIRMED' ? html`<p>钉钉是否建单尚待核查，核查前无法再次送审。</p>` : ''}
      ${item.submission?.state === 'DECLINED' ? html`<p>本次送审未发出或被钉钉拒绝。请核对审批设置后重新送审。</p>` : ''}
      ${item.submission?.errorCode === 'DINGTALK_SNAPSHOT_MISMATCH' ? html`<p>钉钉返回的表单和工作台送审快照不一致。请在钉钉核对实例后补查。</p>` : ''}
      ${approval ? html`<p>钉钉实例 ${approval.instanceId} · ${approval.decision ? ({ AGREE: '已核对同意', REFUSE: '已核对驳回', TERMINATED: '已核对撤销' }[approval.decision.result]) : '待钉钉确认'}</p>` : ''}
      ${(own || lead(user)) && (item.state === 'PENDING' || item.state === 'IMPORT_REVIEW' || item.submission?.state === 'UNCONFIRMED') ? html`
        <form method="post" action="${detailPath(id)}/reconcile"><button class="secondary">补查审批状态</button></form>` : ''}
      ${item.activeVersion ? html`<details><summary>查看送审版本 ${item.activeVersion.versionNo}</summary>
        <dl><dt>名称</dt><dd>${item.activeVersion.snapshot.draft.title}</dd><dt>现状与问题</dt><dd><pre>${item.activeVersion.snapshot.draft.businessContext}</pre></dd>
        <dt>预期收益</dt><dd><pre>${item.activeVersion.snapshot.draft.expectedValue}</pre></dd><dt>验收要求</dt><dd><pre>${item.activeVersion.snapshot.draft.acceptanceCriteria}</pre></dd></dl>
        <code>${item.activeVersion.snapshotHash}</code></details>` : ''}
      ${item.approvedVersion && item.approvedVersion.id !== item.activeVersion?.id ? html`<p>需求池保留已批准版本 ${item.approvedVersion.versionNo}。</p>` : ''}</section>
      ${canEdit && item.draft ? html`<section><h2>当前草稿</h2><form class="demand-form" method="post" action="${detailPath(id)}/edit">
        <input type="hidden" name="expectedDraftRevision" value="${item.draftRevision}">${draftFields(item.draft)}<button>保存草稿</button></form></section>` : ''}
      ${item.precheck ? html`<section class="demand-view"><h2>AI 预审</h2><pre>${item.precheck.summary}</pre>
        ${reviewLines('待确认问题', item.precheck.questions)}${reviewLines('风险与影响', item.precheck.risks)}</section>`
        : canEdit ? html`<section><h2>AI 预审</h2>${item.validation?.missing.length ? html`<p>请补齐 ${item.validation.missing.map(field => fieldLabels[field]).join('、')}。</p>` : ''}
        ${!capabilities.aiPrecheckConfigured ? html`<p>预审模型待配置。</p>` : !item.validation?.missing.length ? html`<form method="post" action="${detailPath(id)}/precheck">
          <input type="hidden" name="expectedDraftRevision" value="${item.draftRevision}"><button>开始 AI 预审</button></form>` : ''}</section>` : ''}
      ${canSubmit ? html`<section><h2>发起钉钉审批</h2>
        ${templates.templates.length ? templates.templates.map(template => html`<form class="demand-form" method="post" action="${detailPath(id)}/submit">
          <input type="hidden" name="idempotencyKey" value="${randomUUID()}"><input type="hidden" name="expectedDraftRevision" value="${item.draftRevision}">
          <input type="hidden" name="processCode" value="${template.processCode}">
          ${template.approverOptions.map(node => html`<fieldset><legend>${node.label}</legend>${node.allowedUserIds.map(userId => html`
            <label><input type="checkbox" name="approver.${node.actionerKey}" value="${userId}">${userId}</label>`)}</fieldset>`)}
          <button>提交「${template.label}」审批</button></form>`) : html`<p>请管理员配置可发起的审批模板。</p>`}</section>` : ''}
      ${lead(user) && item.state === 'IMPORT_REVIEW' ? html`<section class="demand-notice"><h2>确认导入</h2>
        <p>请补齐草稿，并让管理员映射钉钉发起人。补填的内容保留在草稿，原审批仍对应钉钉表单的快照。</p>
        <form method="post" action="${detailPath(id)}/confirm-import"><input type="hidden" name="expectedRevision" value="${item.revision}"><button>确认导入</button></form></section>` : ''}`, admin(user)))
  })

  app.post(`${base}/:id/edit`, async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    const data = await c.req.parseBody()
    const form = parse(editDemand, { expectedDraftRevision: Number(data.expectedDraftRevision), draft: readDraft(data) })
    await service.store.edit(user, id, form.expectedDraftRevision, form.draft)
    return c.redirect(detailPath(id), 303)
  })
  app.post(`${base}/:id/precheck`, async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    const data = await c.req.parseBody()
    const form = parse(precheckInput, { expectedDraftRevision: Number(data.expectedDraftRevision), modelId: parse(optionalNonempty, data.modelId) })
    await service.precheck(user, id, form.expectedDraftRevision, form.modelId, c.req.raw.signal)
    return c.redirect(detailPath(id), 303)
  })
  app.post(`${base}/:id/submit`, async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    const data = await c.req.parseBody({ all: true })
    const selections = Object.entries(data).filter(([name]) => name.startsWith('approver.')).map(([name, ids]) => ({
      actionerKey: name.slice('approver.'.length), actionerUserIds: Array.isArray(ids) ? ids : [ids],
    }))
    await service.submit(user, id, parse(submitInput, { expectedDraftRevision: Number(data.expectedDraftRevision), processCode: data.processCode,
      idempotencyKey: data.idempotencyKey, approverSelections: selections }))
    return c.redirect(detailPath(id), 303)
  })
  app.post(`${base}/:id/reconcile`, async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    await service.scheduleReconcile(user, id)
    return c.redirect(detailPath(id), 303)
  })
  app.post(`${base}/:id/confirm-import`, async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    const data = await c.req.parseBody()
    const form = parse(confirmImportInput, { expectedRevision: Number(data.expectedRevision), ownerId: data.ownerId })
    await service.store.confirmImport(user, id, form.expectedRevision, form.ownerId)
    return c.redirect(detailPath(id), 303)
  })
}
