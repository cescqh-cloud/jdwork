import type { Context, Env, Hono } from 'hono'
import { html } from 'hono/html'
import { z } from 'zod'
import type { Actor } from '../store'
import { assignInput, reviewInput, transitionInput, type DeliveryState } from './contract'
import type { DeliveryStore } from './store'

const home = '/console/deliveries'
const taskId = z.uuid()
const taskRevision = z.coerce.number().int().min(1).max(2_147_483_647)
const stateLabels: Record<DeliveryState, string> = {
  ASSIGNED: '已分配', DEVELOPING: '开发中', TESTING: '测试中', ACCEPTANCE: '待业务验收', DELIVERED: '已交付',
}
const testLabels = { passed: '已通过', failed: '失败', skipped: '已跳过', blocked: '阻塞', not_run: '未运行' } as const
const verdictLabels = { PASS: '通过', WARN: '待核对', BLOCK: '阻断' } as const
const eventLabels: Record<string, string> = {
  'delivery.assigned': '分配任务', 'delivery.binding.changed': '绑定工作树', 'delivery.development.started': '开始开发',
  'delivery.check.completed': '提交材料检查', 'delivery.review.accepted': '独立复审通过', 'delivery.review.rework': '复审要求整改',
  'delivery.materials.changed': '材料变更，原检查已失效',
  'delivery.testing.started': '开始测试', 'delivery.test.recorded': '登记测试结果',
  'delivery.rework.requested': '业务退回整改', 'delivery.delivered': '业务验收并记录交付',
}

interface Options<E extends Env> {
  store: DeliveryStore
  actor(c: Context<E>, deviceAllowed?: boolean): Promise<Actor>
  parse<T>(schema: z.ZodType<T>, input: unknown): T
  page(title: string, body: ReturnType<typeof html>): ReturnType<typeof html>
  notify?(tenantId: string, userId: string | null): void
}

function hiddenRevision(revision: number) {
  return html`<input type="hidden" name="revision" value="${revision}">`
}

function transitionForm(path: string, revision: number, action: string, button: string) {
  return html`<form method="post" action="${path}/transition">${hiddenRevision(revision)}
    <input type="hidden" name="action" value="${action}"><button>${button}</button></form>`
}

function testLabel(value: unknown) {
  return typeof value === 'string' && Object.hasOwn(testLabels, value) ? testLabels[value as keyof typeof testLabels] : '待登记'
}

function formTransition(form: Record<string, unknown>) {
  switch (form.action) {
    case 'record_test':
      return { action: form.action, outcome: form.outcome, note: form.note,
        evidence: form.evidenceLabel || form.evidenceSha256 ? [{ label: form.evidenceLabel, sha256: form.evidenceSha256 }] : undefined }
    case 'accept':
      return { action: form.action, deliveryRef: form.deliveryRef, note: form.note }
    case 'return_for_rework':
      return { action: form.action, note: form.note }
    default:
      return { action: form.action }
  }
}

export function mountDeliveryConsole<E extends Env>(app: Hono<E>, options: Options<E>) {
  const { store, actor, parse, page, notify } = options
  app.get(home, async c => {
    const user = await actor(c, false)
    const [items, queue] = await Promise.all([
      store.list(user), user.roles.includes('it_lead') ? store.assignmentQueue(user) : Promise.resolve([]),
    ])
    return c.html(page('开发交付', html`
      ${user.roles.includes('it_lead') ? html`<section><h2>待分配的已批准需求</h2>
        ${queue.length ? html`<ul>${queue.map(item => html`<li>
          <a href="${home}/assign?demandId=${item.demandId}">${item.demandNo} · ${item.title}</a>
        </li>`)}</ul>` : html`<p>暂无待分配需求。</p>`}</section>` : ''}
      <section><h2>交付任务</h2>${items.length ? html`<ul>${items.map(item => html`
        <li><a href="${home}/${item.id}">${item.demandNo} · ${item.title}</a> · ${item.projectName} · ${stateLabels[item.state]}</li>
      `)}</ul>` : html`<p>暂无可查看的任务。</p>`}</section>`))
  })
  app.get(home + '/assign', async c => {
    const user = await actor(c, false)
    const demand = await store.assignmentOptions(user, parse(taskId, c.req.query('demandId')))
    return c.html(page('分配开发任务', html`
      <section><h2>${demand.demandNo} · ${demand.title}</h2><p>已批准版本</p><code>${demand.approvedVersionId}</code></section>
      ${demand.projects.length ? demand.projects.map(project => html`<form class="login" method="post" action="${home}/assign">
        <h2>${project.name}</h2><input type="hidden" name="demandId" value="${demand.demandId}">
        <input type="hidden" name="approvedVersionId" value="${demand.approvedVersionId}">
        <input type="hidden" name="expectedDemandRevision" value="${demand.expectedDemandRevision}">
        <input type="hidden" name="projectId" value="${project.id}">
        <label>实施人<select name="assigneeId" required>${project.members.map(member =>
          html`<option value="${member.id}">${member.displayName}</option>`)}</select></label><button>分配任务</button>
      </form>`) : html`<p>请先设置有效项目和项目成员。</p>`}
      <a href="${home}">返回开发交付</a>`))
  })
  app.post(home + '/assign', async c => {
    const user = await actor(c, false)
    const form = await c.req.parseBody()
    const input = parse(assignInput, { approvedVersionId: form.approvedVersionId, projectId: form.projectId,
      assigneeId: form.assigneeId, expectedDemandRevision: parse(taskRevision, form.expectedDemandRevision) })
    const task = await store.assign(user, parse(taskId, form.demandId), input)
    notify?.(user.tenantId, null)
    return c.redirect(home + '/' + task.id, 303)
  })
  app.get(home + '/:id', async c => {
    const user = await actor(c, false)
    const task = await store.get(user, parse(taskId, c.req.param('id')))
    const path = home + '/' + task.id
    const permissions = task.permissions
    return c.html(page(task.title || '开发交付', html`
      <section><h2>${task.demandNo} · ${stateLabels[task.state]}</h2>
        <p>${task.projectName} · 实施人 ${task.assigneeName} · 修订 ${task.revision}</p>
        <p>冻结版本</p><code>${task.approvedVersionId}</code>
        <p>测试结果 ${testLabel(task.latestTestOutcome)}</p>
        ${task.materials.state === 'unverified' ? html`<p>等待绑定设备核验当前材料。</p>` : ''}
        ${task.materials.state === 'changed' ? html`<p>材料已变化，需重新检查并复审。</p>` : ''}
        ${task.deliveryRef ? html`<p>交付参考</p><code>${String(task.deliveryRef)}</code>` : ''}
        ${!task.canAdvance && task.state !== 'DELIVERED' ? html`<p>请核对当前批准版本及项目授权后继续。</p>` : ''}
        ${task.binding ? html`<p>已绑定工作树 · 提交版本</p><code>${task.binding.gitRevision}</code>` : ''}
      </section>
      ${task.latestRunId ? html`<section><a href="${path}/checks/${task.latestRunId}">打开当前检查与复审</a></section>` : ''}
      ${permissions.start ? transitionForm(path, task.revision, 'start', '开始开发') : ''}
      ${permissions.startTesting ? transitionForm(path, task.revision, 'start_testing', '进入测试') : ''}
      ${permissions.recordTest ? html`<form class="login" method="post" action="${path}/transition">${hiddenRevision(task.revision)}
        <h2>登记独立测试</h2><input type="hidden" name="action" value="record_test">
        <label>测试结果<select name="outcome">
          ${Object.entries(testLabels).filter(([outcome]) => outcome !== 'passed' || task.materials.state === 'current')
            .map(([outcome, label]) => html`<option value="${outcome}"${outcome === 'not_run' ? html` selected` : ''}>${label}</option>`)}
        </select></label>
        <label>证据名称<input name="evidenceLabel" maxlength="160"></label>
        <label>证据校验值<input name="evidenceSha256" maxlength="64" pattern="[a-f0-9]{64}"></label>
        <label>测试说明<textarea name="note" rows="4" cols="36" maxlength="1000" required></textarea></label>
        <p>登记通过时填写证据名称和 SHA-256 校验值。</p><button>保存测试结果</button>
      </form>` : ''}
      ${permissions.accept ? html`<form class="login" method="post" action="${path}/transition">${hiddenRevision(task.revision)}
        <h2>业务验收</h2><input type="hidden" name="action" value="accept">
        <label>交付参考<input name="deliveryRef" maxlength="240" required></label>
        <label>验收说明<textarea name="note" rows="4" cols="36" maxlength="1000" required></textarea></label><button>确认验收并记录交付</button>
      </form>` : ''}
      ${permissions.returnForRework ? html`<form class="login" method="post" action="${path}/transition">${hiddenRevision(task.revision)}
        <input type="hidden" name="action" value="return_for_rework">
        <label>整改说明<textarea name="note" rows="4" cols="36" maxlength="1000" required></textarea></label>
        <button class="secondary">退回整改</button>
      </form>` : ''}
      <section><h2>进度记录</h2><ul>${task.history.map(event => html`<li>
        ${eventLabels[event.action] ?? event.action} · ${event.occurredAt}
        ${task.binding && event.action === 'delivery.check.completed' && typeof event.details.runId === 'string'
          ? html`<a href="${path}/checks/${event.details.runId}">查看该次检查</a>` : ''}
        ${typeof event.details.note === 'string' ? html`<p>${event.details.note}</p>` : ''}</li>`)}</ul></section>
      <a href="${home}">返回开发交付</a>`))
  })
  app.get(home + '/:id/checks/:runId', async c => {
    const user = await actor(c, false)
    const id = parse(taskId, c.req.param('id'))
    const runId = parse(taskId, c.req.param('runId'))
    const [task, run] = await Promise.all([store.get(user, id), store.getCheck(user, id, runId)])
    const path = home + '/' + task.id
    return c.html(page('材料检查与复审', html`
      <section><h2>${verdictLabels[run.verdict]}</h2><p>检查规则 ${run.ruleVersion} · 输入修订 ${run.taskRevision}</p>
        ${run.stale ? html`<p>此检查已经过时，请查看当前材料。</p>` : ''}
        ${!run.stale && task.materials.state === 'unverified' ? html`<p>等待绑定设备核验当前材料。</p>` : ''}
        <p>输入校验值</p><code>${run.inputHash}</code>
      </section>${run.findings.map(finding => html`<section>
        <h2>${verdictLabels[finding.status]} · ${finding.ruleId}</h2><p>${finding.message}</p><p>${finding.guidance}</p>
        ${finding.evidence.length ? html`<ul>${finding.evidence.map(item =>
          html`<li>${item.path}${item.line ? ` · 第 ${item.line} 行` : ''}</li>`)}</ul>` : ''}
      </section>`)}
      ${run.review ? html`<section><h2>${run.review.decision === 'ACCEPT' ? '独立复审通过' : '复审要求整改'}</h2>
        <p>${run.review.reviewedAt}</p><p>${run.review.note}</p></section>` : ''}
      ${task.permissions.review && !run.stale && !run.review ? html`<form class="login" method="post" action="${path}/review">
        <h2>提交独立复审</h2>${hiddenRevision(task.revision)}<input type="hidden" name="runId" value="${run.id}">
        <label>复审说明<textarea name="note" rows="4" cols="36" maxlength="1000" required></textarea></label>
        ${run.verdict === 'WARN' ? html`<label><input name="acknowledgeWarnings" type="checkbox">已人工核对待确认项</label>` : ''}
        ${run.verdict !== 'BLOCK' ? html`<button name="decision" value="ACCEPT">复审通过</button>` : ''}
        <button name="decision" value="REWORK" class="secondary">要求整改</button>
      </form>` : ''}<a href="${path}">返回交付任务</a>`))
  })
  app.post(home + '/:id/review', async c => {
    const user = await actor(c, false)
    const id = parse(taskId, c.req.param('id'))
    const form = await c.req.parseBody()
    const input = parse(reviewInput, { runId: form.runId, decision: form.decision, note: form.note, acknowledgeWarnings: form.acknowledgeWarnings === 'on' })
    await store.review(user, id, parse(taskRevision, form.revision), input)
    notify?.(user.tenantId, null)
    return c.redirect(home + '/' + id, 303)
  })
  app.post(home + '/:id/transition', async c => {
    const user = await actor(c, false)
    const id = parse(taskId, c.req.param('id'))
    const form = await c.req.parseBody()
    await store.transition(user, id, parse(taskRevision, form.revision), parse(transitionInput, formTransition(form)))
    notify?.(user.tenantId, null)
    return c.redirect(home + '/' + id, 303)
  })
}
