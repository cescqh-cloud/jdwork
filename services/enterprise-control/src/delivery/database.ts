import type { SQL, TransactionSQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { ControlError, type Role } from '../contract'
import { evidenceHash, type DemandSnapshot } from '../demands/contract'
import type { Actor } from '../store'
import { testOutcome, type DeliveryState, type KnowledgeReference } from './contract'
import { deliveryRuleVersion, knowledgeReferenceKey, redactDeliveryText, type DeliveryInspection, type Verdict } from './review'
import { materialState } from './materials'

export type Database = SQL | TransactionSQL

export interface DemandRow {
  tenant_id: string
  id: string
  demand_no: string
  owner_id: string | null
  state: string
  revision: number
  active_version_id: string | null
  approved_version_id: string | null
  import_confirmed: boolean
}

export interface TaskRow {
  tenant_id: string
  id: string
  demand_id: string
  approved_version_id: string
  snapshot_hash: string
  project_id: string
  assignee_id: string
  assigned_by: string
  state: DeliveryState
  revision: number
  binding_id: string | null
  latest_run_id: string | null
  accepted_run_id: string | null
  material_verified_at: Date | null
  material_invalidated_at: Date | null
  created_at: Date
  updated_at: Date
}

interface TaskAccess extends TaskRow {
  demand_no: string
  title: string
  owner_id: string | null
  project_name: string
  assignee_name: string
  project_access: boolean
  assignment_active: boolean
  approval_current: boolean
  material_device_active: boolean
}

export interface BindingRow {
  id: string
  device_id: string
  worktree_id: string
  session_id: string
  git_revision: string
  created_at: Date
}

export interface RunRow {
  id: string
  binding_id: string
  submitted_by: string
  task_revision: number
  input_hash: string
  selection_receipt: string | null
  rule_version: string
  verdict: Verdict
  manifest: DeliveryInspection['manifest']
  knowledge_refs: KnowledgeReference[]
  findings: DeliveryInspection['findings']
  created_at: Date
}

interface HistoryRow {
  revision: number
  actor_id: string
  state: DeliveryState
  action: string
  details: Record<string, unknown>
  created_at: Date
}

export const missingTask = () => new ControlError(404, 'DELIVERY_NOT_FOUND', '交付任务不存在或当前账号无权访问。')
export const denied = () => new ControlError(403, 'DELIVERY_PERMISSION_REQUIRED', '请由当前项目内有对应权限的同事操作。')
export const approvalRequired = () => new ControlError(409, 'DELIVERY_APPROVAL_REQUIRED', '仅可推进已经核对通过的当前冻结需求版本。')
export const invalidStage = () => new ControlError(409, 'DELIVERY_STAGE_CONFLICT', '当前交付阶段不允许此操作。')
export const revisionConflict = () => new ControlError(409, 'DELIVERY_REVISION_CONFLICT', '任务已在其他位置更新，请刷新后重试。')
export const isLead = (actor: Actor) => actor.roles.includes('it_lead')
export const isReviewer = (actor: Actor, task: TaskAccess) =>
  task.project_access && actor.id !== task.assignee_id && (actor.roles.includes('project_owner') || isLead(actor))
export const isDeveloper = (actor: Actor, task: TaskAccess) =>
  task.project_access && actor.id === task.assignee_id && actor.roles.some(role => role === 'developer' || role === 'project_owner')
export const canAdvance = (task: TaskAccess) => task.approval_current && task.assignment_active && task.state !== 'DELIVERED'

export async function currentActor(sql: Database, actor: Actor, lock = false): Promise<Actor> {
  const [row] = await sql<{ roles: Role[] }[]>`SELECT u.roles FROM enterprise_users u JOIN enterprise_tenants t ON t.id = u.tenant_id
    WHERE u.tenant_id = ${actor.tenantId} AND u.id = ${actor.id} AND u.active AND t.active
    ${lock ? sql`FOR UPDATE OF t` : sql``}`
  if (!row) throw new ControlError(401, 'AUTH_REQUIRED', '请重新登录工作台。')
  return { ...actor, roles: row.roles }
}

export async function readDemand(sql: Database, actor: Actor, id: string, lock = false) {
  const [row] = await sql<DemandRow[]>`SELECT tenant_id, id, demand_no, owner_id, state, revision, active_version_id, approved_version_id, import_confirmed
    FROM enterprise_demands WHERE tenant_id = ${actor.tenantId} AND id = ${id}
    ${lock ? sql`FOR UPDATE` : sql``}`
  if (!row) throw missingTask()
  return row
}

export async function verifiedDemand(sql: Database, demand: DemandRow, versionId: string | null = demand.approved_version_id) {
  if (!demand.owner_id || !demand.import_confirmed || demand.state !== 'BACKLOG' || !versionId ||
    demand.approved_version_id !== versionId || demand.active_version_id !== versionId) throw approvalRequired()
  const [version] = await sql<{ snapshot: DemandSnapshot, snapshot_hash: string }[]>`
    SELECT v.snapshot, v.snapshot_hash FROM enterprise_demand_versions v
    JOIN enterprise_demand_approvals a ON (a.tenant_id, a.demand_id, a.version_id) = (v.tenant_id, v.demand_id, v.id)
    JOIN enterprise_dingtalk_demand_instances i ON (i.tenant_id, i.instance_id, i.demand_id, i.version_id) =
      (a.tenant_id, a.instance_id, a.demand_id, a.version_id)
    WHERE v.tenant_id = ${demand.tenant_id} AND v.demand_id = ${demand.id} AND v.id = ${versionId}
      AND a.decision = 'AGREE' AND a.snapshot_hash = v.snapshot_hash AND i.state = 'AGREE' AND i.verified_at IS NOT NULL`
  if (!version || evidenceHash(version.snapshot) !== version.snapshot_hash) throw approvalRequired()
  return version
}

export async function taskRows(sql: Database, actor: Actor, id: string | null, demandId: string | null, limit: number, lock = false) {
  return await sql<TaskAccess[]>`
    SELECT t.*, d.demand_no, d.owner_id, v.snapshot #>> '{draft,title}' AS title, p.name AS project_name, u.display_name AS assignee_name,
      enterprise_context_scope_allowed(t.tenant_id, ${actor.id}::uuid, 'project_private', t.project_id) AS project_access,
      EXISTS (SELECT 1 FROM enterprise_delivery_bindings b JOIN enterprise_devices e ON e.id = b.device_id
        AND e.tenant_id = b.tenant_id AND e.user_id = b.assignee_id AND e.revoked_at IS NULL
        WHERE (b.tenant_id, b.task_id, b.id) = (t.tenant_id, t.id, t.binding_id)) AS material_device_active,
      (u.active AND u.roles && ARRAY['developer','project_owner']::text[]
        AND enterprise_context_scope_allowed(t.tenant_id, t.assignee_id, 'project_private', t.project_id)) AS assignment_active,
      (d.state = 'BACKLOG' AND d.import_confirmed AND d.owner_id IS NOT NULL
        AND d.active_version_id IS NOT DISTINCT FROM t.approved_version_id
        AND d.approved_version_id IS NOT DISTINCT FROM t.approved_version_id AND t.snapshot_hash = v.snapshot_hash
        AND EXISTS (
          SELECT 1 FROM enterprise_demand_approvals a JOIN enterprise_dingtalk_demand_instances i
          ON (i.tenant_id, i.instance_id, i.demand_id, i.version_id) = (a.tenant_id, a.instance_id, a.demand_id, a.version_id)
          WHERE (a.tenant_id, a.demand_id, a.version_id) = (t.tenant_id, t.demand_id, t.approved_version_id)
            AND a.decision = 'AGREE' AND a.snapshot_hash = t.snapshot_hash AND i.state = 'AGREE' AND i.verified_at IS NOT NULL
        )) AS approval_current
    FROM enterprise_development_tasks t
    JOIN enterprise_demands d ON (d.tenant_id, d.id) = (t.tenant_id, t.demand_id)
    JOIN enterprise_demand_versions v ON (v.tenant_id, v.demand_id, v.id) = (t.tenant_id, t.demand_id, t.approved_version_id)
    JOIN enterprise_projects p ON (p.tenant_id, p.id) = (t.tenant_id, t.project_id)
    JOIN enterprise_users u ON (u.tenant_id, u.id) = (t.tenant_id, t.assignee_id)
    WHERE t.tenant_id = ${actor.tenantId} AND (${id}::uuid IS NULL OR t.id = ${id})
      AND (${demandId}::uuid IS NULL OR t.demand_id = ${demandId})
      AND (${isLead(actor)} OR d.owner_id = ${actor.id} OR
        enterprise_context_scope_allowed(t.tenant_id, ${actor.id}::uuid, 'project_private', t.project_id))
    ORDER BY t.updated_at DESC, t.id LIMIT ${limit}
    ${lock ? sql`FOR UPDATE OF t` : sql``}`
}

export async function readTask(sql: Database, actor: Actor, id: string, lock = false) {
  const [task] = await taskRows(sql, actor, id, null, 1, lock)
  if (!task) throw missingTask()
  return task
}

export async function bindingRow(sql: Database, task: TaskRow) {
  if (!task.binding_id) return undefined
  const [binding] = await sql<BindingRow[]>`SELECT id, device_id, worktree_id, session_id, git_revision, created_at
    FROM enterprise_delivery_bindings WHERE tenant_id = ${task.tenant_id} AND task_id = ${task.id} AND id = ${task.binding_id}`
  return binding
}

export async function readRun(sql: Database, task: TaskRow, runId: string) {
  const [row] = await sql<RunRow[]>`SELECT * FROM enterprise_delivery_check_runs
    WHERE tenant_id = ${task.tenant_id} AND task_id = ${task.id} AND id = ${runId}`
  if (!row) throw missingTask()
  return row
}

export function runView(task: TaskAccess, row: RunRow, includeReceipt = false) {
  return { id: row.id, bindingId: row.binding_id, approvedVersionId: task.approved_version_id, snapshotHash: task.snapshot_hash,
    submittedBy: row.submitted_by, taskRevision: row.task_revision, inputHash: row.input_hash, ruleVersion: row.rule_version,
    verdict: row.verdict, files: row.manifest.map(({ path, sha256 }) => ({ path, sha256 })), findings: row.findings,
    stale: task.latest_run_id !== row.id || task.binding_id !== row.binding_id || !task.approval_current ||
      Boolean(task.material_invalidated_at) || row.rule_version !== deliveryRuleVersion,
    ...(includeReceipt && row.selection_receipt && !row.knowledge_refs.length ? { selectionReceipt: row.selection_receipt } : {}),
    createdAt: row.created_at.toISOString() }
}

export async function verifyKnowledge(sql: Database, actor: Actor, refs: KnowledgeReference[], projectId: string) {
  if (!refs.length) return new Set<string>()
  const rows = await sql<{ id: string, revision: number, checksum: string }[]>`SELECT k.id, k.revision, k.checksum
    FROM enterprise_knowledge_documents k WHERE k.tenant_id = ${actor.tenantId} AND k.status = 'ready'
      AND k.id = ANY(${sql.array([...new Set(refs.map(ref => ref.documentId))], 'UUID')})
      AND (k.scope <> 'project_private' OR k.project_id = ${projectId})
      AND enterprise_context_scope_allowed(k.tenant_id, ${actor.id}::uuid, k.scope, k.scope_id)`
  return new Set(rows.map(row => knowledgeReferenceKey({ documentId: row.id, revision: row.revision, checksum: row.checksum })))
}

export async function taskView(sql: Database, actor: Actor, task: TaskAccess, detail: boolean) {
  const enabled = canAdvance(task)
  const developer = enabled && isDeveloper(actor, task)
  const reviewer = enabled && isReviewer(actor, task)
  const owner = enabled && task.owner_id === actor.id
  const binding = detail && task.project_access ? await bindingRow(sql, task) : undefined
  const history = detail ? await sql<HistoryRow[]>`SELECT revision, actor_id, state, action, details, created_at
    FROM enterprise_delivery_history WHERE tenant_id = ${task.tenant_id} AND task_id = ${task.id} ORDER BY revision DESC LIMIT 100` : []
  const test = history.find(event => event.action === 'delivery.test.recorded' && event.details.runId === task.latest_run_id)
  const outcome = testOutcome.safeParse(test?.details.outcome)
  const currentOutcome = outcome.success && (outcome.data !== 'passed' || task.accepted_run_id) ? outcome.data : null
  const handedOver = history.find(event => event.action === 'delivery.delivered')
  const reviewed = history.some(event => event.action.startsWith('delivery.review.') && event.details.runId === task.latest_run_id)
  const materials = materialState(task)
  const actions = {
    bind: developer && Boolean(actor.device) && (task.state === 'ASSIGNED' || task.state === 'DEVELOPING'),
    submitChecks: developer && Boolean(actor.device) && task.state === 'DEVELOPING',
    start: developer && task.state === 'ASSIGNED' && Boolean(task.binding_id),
    startTesting: developer && task.state === 'DEVELOPING' && Boolean(task.accepted_run_id) && materials.state === 'current',
    review: reviewer && task.state === 'DEVELOPING' && Boolean(task.latest_run_id) && !reviewed && materials.state === 'current',
    recordTest: reviewer && task.state === 'TESTING',
    accept: owner && task.state === 'ACCEPTANCE' && materials.state === 'current',
    returnForRework: owner && task.state === 'ACCEPTANCE',
  }
  return {
    id: task.id, demandId: task.demand_id, demandNo: task.demand_no, title: redactDeliveryText(task.title ?? ''),
    approvedVersionId: task.approved_version_id, snapshotHash: task.snapshot_hash,
    projectId: task.project_id, projectName: task.project_name, assigneeId: task.assignee_id, assigneeName: task.assignee_name,
    state: task.state, revision: task.revision, canAdvance: enabled, permissions: actions, materials,
    latestRunId: task.project_access ? task.latest_run_id : null, acceptedRunId: task.project_access ? task.accepted_run_id : null,
    binding: binding ? { id: binding.id, deviceId: binding.device_id, worktreeId: binding.worktree_id, sessionId: binding.session_id,
      gitRevision: binding.git_revision, createdAt: binding.created_at.toISOString() } : null,
    latestTestOutcome: currentOutcome,
    deliveryRef: typeof handedOver?.details.deliveryRef === 'string' ? handedOver.details.deliveryRef : null,
    history: history.map(event => ({ revision: event.revision, actorId: event.actor_id, state: event.state, action: event.action,
      occurredAt: event.created_at.toISOString(), details: task.project_access || event.action === 'delivery.delivered' ||
        event.action === 'delivery.rework.requested' ? event.details : event.action === 'delivery.test.recorded' ? { outcome: event.details.outcome } : {} })),
    createdAt: task.created_at.toISOString(), updatedAt: task.updated_at.toISOString(),
  }
}

export async function recordHistory(sql: TransactionSQL, actor: Actor, task: TaskRow, ownerId: string | null, action: string, details: Record<string, unknown>) {
  await sql`INSERT INTO enterprise_delivery_history (tenant_id, task_id, revision, actor_id, state, action, details)
    VALUES (${task.tenant_id}, ${task.id}, ${task.revision}, ${actor.id}, ${task.state}, ${action}, ${details}::jsonb)`
  await sql`INSERT INTO enterprise_audit (id, tenant_id, actor_id, action, target_id)
    VALUES (${randomUUID()}, ${task.tenant_id}, ${actor.id}, ${action}, ${task.id})`
  const watchers = await sql<{ id: string }[]>`SELECT id FROM enterprise_users WHERE tenant_id = ${task.tenant_id} AND active
    AND (id = ${ownerId} OR 'it_lead' = ANY(roles) OR (id = ${task.assignee_id}
      AND enterprise_context_scope_allowed(${task.tenant_id}::uuid, id, 'project_private', ${task.project_id}::uuid))) ORDER BY id`
  if (!watchers.length) return
  const [head] = await sql<{ event_sequence: string }[]>`UPDATE enterprise_tenants SET event_sequence = event_sequence + ${watchers.length}
    WHERE id = ${task.tenant_id} RETURNING event_sequence::text`
  let sequence = Number(head!.event_sequence) - watchers.length
  for (const watcher of watchers) {
    await sql`INSERT INTO enterprise_events (tenant_id, sequence, event_id, user_id, event_type, resource_id, revision)
      VALUES (${task.tenant_id}, ${++sequence}, ${randomUUID()}, ${watcher.id}, ${action}, ${task.id}, ${task.revision})`
  }
}
