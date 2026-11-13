import type { SQL, TransactionSQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { ControlError, verifyDeviceProof } from '../contract'
import type { Actor } from '../store'
import type { AssignInput, BindInput, CheckInput, MaterialVerificationInput, ReviewInput, TransitionInput } from './contract'
import {
  approvalRequired, bindingRow, currentActor, denied, invalidStage, isDeveloper, isLead, isReviewer, missingTask, readDemand, readRun,
  readTask, recordHistory, revisionConflict, runView, taskRows, taskView, verifiedDemand, verifyKnowledge, type Database, type RunRow, type TaskRow,
} from './database'
import { deliveryRuleVersion, inspectDeliveryFiles, knowledgeReferenceKey, redactDeliveryText } from './review'
import { materialChecksum, requireCurrentMaterials, selectionPayload } from './materials'

type AccessTask = Awaited<ReturnType<typeof readTask>>
type TaskPatch = Partial<Pick<TaskRow, 'state' | 'binding_id' | 'latest_run_id' | 'accepted_run_id' | 'material_verified_at' | 'material_invalidated_at'>>

function assertRevision(task: TaskRow, revision: number) {
  if (task.revision !== revision) throw revisionConflict()
}

function requireStage(task: TaskRow, stage: TaskRow['state']) {
  if (task.state !== stage) throw invalidStage()
}

async function requireDevice(sql: TransactionSQL, actor: Actor, task: AccessTask) {
  if (!actor.device || !isDeveloper(actor, task)) throw denied()
  const [device] = await sql<{ id: string, public_key: string }[]>`SELECT id, public_key FROM enterprise_devices WHERE id = ${actor.device.id}
    AND tenant_id = ${actor.tenantId} AND user_id = ${actor.id} AND revoked_at IS NULL`
  if (!device) throw denied()
  return device
}

async function revise(sql: TransactionSQL, actor: Actor, task: AccessTask, patch: TaskPatch, action: string, details: Record<string, unknown> = {}) {
  const next = { ...task, ...patch }
  const [saved] = await sql<TaskRow[]>`UPDATE enterprise_development_tasks SET state = ${next.state}, binding_id = ${next.binding_id},
    latest_run_id = ${next.latest_run_id}, accepted_run_id = ${next.accepted_run_id}, material_verified_at = ${next.material_verified_at},
    material_invalidated_at = ${next.material_invalidated_at}, revision = revision + 1, updated_at = now()
    WHERE tenant_id = ${task.tenant_id} AND id = ${task.id} AND revision = ${task.revision} RETURNING *`
  if (!saved) throw revisionConflict()
  await recordHistory(sql, actor, saved, task.owner_id, action, details)
  return { ...task, ...saved }
}

async function verifyRunReferences(sql: Database, actor: Actor, task: AccessTask, run: RunRow) {
  const permitted = await verifyKnowledge(sql, actor, run.knowledge_refs, task.project_id)
  return run.knowledge_refs.every(ref => permitted.has(knowledgeReferenceKey(ref)))
}

async function requireAcceptedRun(sql: TransactionSQL, actor: Actor, task: AccessTask) {
  if (!task.accepted_run_id || task.latest_run_id !== task.accepted_run_id) {
    throw new ControlError(409, 'DELIVERY_REVIEW_REQUIRED', '请先提交当前材料并完成独立复审。')
  }
  const run = await readRun(sql, task, task.accepted_run_id)
  if (run.binding_id !== task.binding_id || run.rule_version !== deliveryRuleVersion || run.verdict === 'BLOCK' ||
    !await verifyRunReferences(sql, { ...actor, id: task.assignee_id }, task, run)) {
    throw new ControlError(409, 'DELIVERY_REVIEW_STALE', '当前材料、规则或引用已变化，请重新检查和复审。')
  }
  requireCurrentMaterials(task)
  return run
}

export class DeliveryStore {
  constructor(private readonly database: SQL) {}

  async assignmentQueue(actor: Actor) {
    const db = this.database
    const viewer = await currentActor(db, actor)
    if (!isLead(viewer)) throw denied()
    const rows = await db<{ id: string, demand_no: string, title: string }[]>`SELECT d.id, d.demand_no, v.snapshot #>> '{draft,title}' AS title
      FROM enterprise_demands d JOIN enterprise_demand_versions v ON (v.tenant_id, v.demand_id, v.id) =
        (d.tenant_id, d.id, d.approved_version_id)
      JOIN enterprise_demand_approvals a ON (a.tenant_id, a.demand_id, a.version_id) = (v.tenant_id, v.demand_id, v.id)
      JOIN enterprise_dingtalk_demand_instances i ON (i.tenant_id, i.instance_id, i.demand_id, i.version_id) =
        (a.tenant_id, a.instance_id, a.demand_id, a.version_id)
      WHERE d.tenant_id = ${actor.tenantId} AND d.state = 'BACKLOG' AND d.active_version_id = d.approved_version_id
        AND d.import_confirmed AND d.owner_id IS NOT NULL AND a.decision = 'AGREE' AND a.snapshot_hash = v.snapshot_hash
        AND i.state = 'AGREE' AND i.verified_at IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM enterprise_development_tasks t WHERE (t.tenant_id, t.demand_id, t.approved_version_id) = (d.tenant_id, d.id, v.id)
        ) ORDER BY d.updated_at DESC, d.id LIMIT 50`
    return rows.map(row => ({ demandId: row.id, demandNo: row.demand_no, title: redactDeliveryText(row.title ?? '') }))
  }

  async assignmentOptions(actor: Actor, demandId: string) {
    const db = this.database
    const viewer = await currentActor(db, actor)
    if (!isLead(viewer)) throw denied()
    const demand = await readDemand(db, viewer, demandId)
    const approved = await verifiedDemand(db, demand)
    const rows = await db<{ project_id: string, project_name: string, user_id: string, display_name: string }[]>`
      SELECT p.id AS project_id, p.name AS project_name, u.id AS user_id, u.display_name
      FROM enterprise_projects p JOIN enterprise_project_members m ON (p.tenant_id, p.id) = (m.tenant_id, m.project_id)
      JOIN enterprise_users u ON (u.tenant_id, u.id) = (m.tenant_id, m.user_id)
      WHERE p.tenant_id = ${actor.tenantId} AND p.active AND u.active AND u.roles && ARRAY['developer','project_owner']::text[]
      ORDER BY p.name, p.id, u.display_name, u.id LIMIT 500`
    const projects = new Map<string, { id: string, name: string, members: { id: string, displayName: string }[] }>()
    for (const row of rows) {
      let project = projects.get(row.project_id)
      if (!project) {
        project = { id: row.project_id, name: row.project_name, members: [] }
        projects.set(row.project_id, project)
      }
      project.members.push({ id: row.user_id, displayName: row.display_name })
    }
    return { demandId, demandNo: demand.demand_no, title: redactDeliveryText(approved.snapshot.draft.title),
      approvedVersionId: approved.snapshot.versionId, snapshotHash: approved.snapshot_hash, expectedDemandRevision: demand.revision,
      projects: [...projects.values()] }
  }

  async assign(actor: Actor, demandId: string, input: AssignInput) {
    if (!isLead(actor)) throw denied()
    return this.database.begin(async sql => {
      // M3 locks the demand before allocating tenant events. Keep the same ordering.
      const demand = await readDemand(sql, actor, demandId, true)
      const viewer = await currentActor(sql, actor, true)
      if (!isLead(viewer)) throw denied()
      const approved = await verifiedDemand(sql, demand, input.approvedVersionId)
      if (demand.revision !== input.expectedDemandRevision) throw revisionConflict()
      const [member] = await sql`SELECT u.id FROM enterprise_users u WHERE u.tenant_id = ${actor.tenantId}
        AND u.id = ${input.assigneeId} AND u.active AND u.roles && ARRAY['developer','project_owner']::text[]
        AND enterprise_context_scope_allowed(u.tenant_id, u.id, 'project_private', ${input.projectId}::uuid)`
      if (!member) throw denied()
      const [previous] = await sql<TaskRow[]>`SELECT * FROM enterprise_development_tasks
        WHERE tenant_id = ${actor.tenantId} AND demand_id = ${demandId} AND approved_version_id = ${input.approvedVersionId}`
      if (previous) {
        if (previous.project_id !== input.projectId || previous.assignee_id !== input.assigneeId) {
          throw new ControlError(409, 'DELIVERY_ALREADY_ASSIGNED', '这个批准版本已有交付任务。')
        }
        return taskView(sql, viewer, await readTask(sql, viewer, previous.id), true)
      }
      const [created] = await sql<TaskRow[]>`INSERT INTO enterprise_development_tasks
        (tenant_id, id, demand_id, approved_version_id, snapshot_hash, project_id, assignee_id, assigned_by, state)
        VALUES (${actor.tenantId}, ${randomUUID()}, ${demandId}, ${input.approvedVersionId}, ${approved.snapshot_hash},
          ${input.projectId}, ${input.assigneeId}, ${actor.id}, 'ASSIGNED') RETURNING *`
      if (!created) throw missingTask()
      await recordHistory(sql, viewer, created, demand.owner_id, 'delivery.assigned', {})
      return taskView(sql, viewer, await readTask(sql, viewer, created.id), true)
    })
  }

  async list(actor: Actor, demandId?: string, limit = 30) {
    const viewer = await currentActor(this.database, actor)
    const tasks = await taskRows(this.database, viewer, null, demandId ?? null, limit)
    return Promise.all(tasks.map(task => taskView(this.database, viewer, task, false)))
  }

  async get(actor: Actor, id: string) {
    const viewer = await currentActor(this.database, actor)
    return taskView(this.database, viewer, await readTask(this.database, viewer, id), true)
  }

  private async withTask<T>(actor: Actor, id: string,
    work: (sql: TransactionSQL, viewer: Actor, task: AccessTask, demand: Awaited<ReturnType<typeof readDemand>>) => Promise<T>) {
    return this.database.begin(async sql => {
      const [pointer] = await sql<{ demand_id: string }[]>`SELECT demand_id FROM enterprise_development_tasks
        WHERE tenant_id = ${actor.tenantId} AND id = ${id}`
      if (!pointer) throw missingTask()
      const demand = await readDemand(sql, actor, pointer.demand_id, true)
      const viewer = await currentActor(sql, actor, true)
      const task = await readTask(sql, viewer, id, true)
      if (!task.approval_current) throw approvalRequired()
      if (!task.assignment_active) throw denied()
      return work(sql, viewer, task, demand)
    })
  }

  bind(actor: Actor, id: string, revision: number, input: BindInput) {
    return this.withTask(actor, id, async (sql, viewer, task) => {
      const { id: deviceId } = await requireDevice(sql, viewer, task)
      assertRevision(task, revision)
      if (task.state !== 'ASSIGNED' && task.state !== 'DEVELOPING') throw invalidStage()
      const previous = await bindingRow(sql, task)
      if (previous?.device_id === deviceId && previous.worktree_id === input.worktreeId &&
        previous.session_id === input.sessionId && previous.git_revision === input.gitRevision) return taskView(sql, viewer, task, true)
      const bindingId = randomUUID()
      await sql`INSERT INTO enterprise_delivery_bindings (tenant_id, task_id, id, assignee_id, device_id, worktree_id, session_id, git_revision)
        VALUES (${task.tenant_id}, ${task.id}, ${bindingId}, ${viewer.id}, ${deviceId}, ${input.worktreeId}, ${input.sessionId}, ${input.gitRevision})`
      const next = await revise(sql, viewer, task, { binding_id: bindingId, latest_run_id: null, accepted_run_id: null,
        material_verified_at: null, material_invalidated_at: null },
        'delivery.binding.changed', { bindingId })
      return taskView(sql, viewer, next, true)
    })
  }

  async getCheck(actor: Actor, id: string, runId: string) {
    const db = this.database
    const viewer = await currentActor(db, actor)
    const task = await readTask(db, viewer, id)
    if (!task.project_access) throw missingTask()
    const run = await readRun(db, task, runId)
    const binding = viewer.device && task.material_device_active ? await bindingRow(db, task) : undefined
    const result = runView(task, run, Boolean(binding && binding.device_id === viewer.device?.id && binding.id === run.binding_id))
    const [[review], currentReferences] = await Promise.all([
      db<{ reviewer_id: string, decision: ReviewInput['decision'], note: string, acknowledged_warnings: boolean, created_at: Date }[]>`
        SELECT reviewer_id, decision, note, acknowledged_warnings, created_at FROM enterprise_delivery_reviews
        WHERE tenant_id = ${task.tenant_id} AND task_id = ${task.id} AND run_id = ${run.id}`,
      verifyRunReferences(db, viewer, task, run),
    ])
    return { ...result, stale: result.stale || !currentReferences,
      review: review ? { reviewerId: review.reviewer_id, decision: review.decision, note: review.note,
        acknowledgedWarnings: review.acknowledged_warnings, reviewedAt: review.created_at.toISOString() } : null }
  }

  check(actor: Actor, id: string, revision: number, input: CheckInput, requestId?: string) {
    return this.withTask(actor, id, async (sql, viewer, task, demand) => {
      const device = await requireDevice(sql, viewer, task)
      const binding = await bindingRow(sql, task)
      if (!binding || binding.device_id !== device.id) {
        throw new ControlError(409, 'DELIVERY_BINDING_REQUIRED', '请先绑定此设备上的当前工作树和会话。')
      }
      const approved = await verifiedDemand(sql, demand, task.approved_version_id)
      const references = await verifyKnowledge(sql, viewer, input.knowledgeRefs ?? [], task.project_id)
      const inspection = inspectDeliveryFiles({ demandNo: task.demand_no, draft: approved.snapshot.draft,
        approvedVersionId: task.approved_version_id, snapshotHash: task.snapshot_hash, bindingId: binding.id, gitRevision: binding.git_revision },
      input, references)
      if (input.selectionReceipt && !verifyDeviceProof(device.public_key, input.selectionReceipt,
        selectionPayload(device.id, task.id, task.approved_version_id, binding.id, binding.git_revision, materialChecksum(inspection.manifest)))) {
        throw new ControlError(400, 'DELIVERY_SELECTION_INVALID', '材料选择凭证与当前设备和工作树不匹配。')
      }
      if (requestId) {
        const [previous] = await sql<RunRow[]>`SELECT * FROM enterprise_delivery_check_runs
          WHERE tenant_id = ${task.tenant_id} AND task_id = ${task.id} AND request_id = ${requestId}`
        if (previous) {
          if (previous.input_hash !== inspection.inputHash) {
            throw new ControlError(409, 'DELIVERY_IDEMPOTENCY_CONFLICT', '检查编号已关联其他材料，请重新提交。')
          }
          const existing = runView(task, previous, true)
          return { task: await taskView(sql, viewer, task, true), run: { ...existing,
            stale: existing.stale || !previous.knowledge_refs.every(ref => references.has(knowledgeReferenceKey(ref))) } }
        }
      }
      assertRevision(task, revision)
      requireStage(task, 'DEVELOPING')
      const [run] = await sql<RunRow[]>`INSERT INTO enterprise_delivery_check_runs
        (tenant_id, task_id, id, binding_id, submitted_by, task_revision, request_id, input_hash, rule_version, verdict,
          manifest, knowledge_refs, findings, selection_receipt)
        VALUES (${task.tenant_id}, ${task.id}, ${randomUUID()}, ${binding.id}, ${viewer.id}, ${task.revision}, ${requestId ?? null},
          ${inspection.inputHash}, ${inspection.ruleVersion}, ${inspection.verdict},
          ${inspection.manifest}::jsonb, ${inspection.knowledgeRefs}::jsonb, ${inspection.findings}::jsonb, ${input.selectionReceipt ?? null}) RETURNING *`
      if (!run) throw missingTask()
      const next = await revise(sql, viewer, task, { latest_run_id: run.id, accepted_run_id: null,
        material_verified_at: null, material_invalidated_at: null }, 'delivery.check.completed',
        { runId: run.id, verdict: run.verdict })
      return { task: await taskView(sql, viewer, next, true), run: runView(next, run, true) }
    })
  }

  verifyMaterials(actor: Actor, id: string, revision: number, input: MaterialVerificationInput) {
    return this.withTask(actor, id, async (sql, viewer, task) => {
      const device = await requireDevice(sql, viewer, task)
      const binding = await bindingRow(sql, task)
      if (!binding || binding.device_id !== device.id) throw denied()
      if (task.latest_run_id !== input.runId || task.state === 'DELIVERED') throw invalidStage()
      assertRevision(task, revision)
      const run = await readRun(sql, task, input.runId)
      if (run.binding_id !== binding.id || !run.selection_receipt) {
        throw new ControlError(409, 'DELIVERY_MATERIALS_UNVERIFIED', '请从绑定设备重新选择文件并检查。')
      }
      if (task.material_invalidated_at) return { task: await taskView(sql, viewer, task, true), changed: false }
      if (input.checksum !== materialChecksum(run.manifest)) {
        const next = await revise(sql, viewer, task, { state: 'DEVELOPING', accepted_run_id: null,
          material_verified_at: null, material_invalidated_at: new Date() }, 'delivery.materials.changed', { runId: run.id })
        return { task: await taskView(sql, viewer, next, true), changed: true }
      }
      const [verified] = await sql<{ material_verified_at: Date }[]>`UPDATE enterprise_development_tasks SET material_verified_at = now()
        WHERE tenant_id = ${task.tenant_id} AND id = ${task.id} RETURNING material_verified_at`
      if (!verified) throw missingTask()
      return { task: await taskView(sql, viewer, { ...task, ...verified }, true), changed: false }
    })
  }

  review(actor: Actor, id: string, revision: number, input: ReviewInput) {
    return this.withTask(actor, id, async (sql, viewer, task) => {
      if (!isReviewer(viewer, task)) throw denied()
      assertRevision(task, revision)
      requireStage(task, 'DEVELOPING')
      const run = await readRun(sql, task, input.runId)
      if (run.submitted_by === viewer.id) throw denied()
      if (run.id !== task.latest_run_id || run.binding_id !== task.binding_id || run.rule_version !== deliveryRuleVersion || task.material_invalidated_at) {
        throw new ControlError(409, 'DELIVERY_REVIEW_STALE', '请选择当前材料和规则生成的检查结果。')
      }
      requireCurrentMaterials(task)
      if (input.decision === 'ACCEPT' && (run.verdict === 'BLOCK' || (run.verdict === 'WARN' && !input.acknowledgeWarnings) ||
        !await verifyRunReferences(sql, viewer, task, run))) {
        throw new ControlError(409, 'DELIVERY_REVIEW_BLOCKED', '请修复阻断项、核对引用，并确认警告后再通过。')
      }
      const note = redactDeliveryText(input.note)
      const [decision] = await sql`INSERT INTO enterprise_delivery_reviews
        (tenant_id, task_id, run_id, reviewer_id, run_verdict, decision, acknowledged_warnings, note)
        VALUES (${task.tenant_id}, ${task.id}, ${run.id}, ${viewer.id}, ${run.verdict}, ${input.decision}, ${input.acknowledgeWarnings ?? false}, ${note})
        ON CONFLICT (tenant_id, task_id, run_id) DO NOTHING RETURNING run_id`
      if (!decision) throw new ControlError(409, 'DELIVERY_ALREADY_REVIEWED', '该次检查已有复审结论，请提交新修订材料。')
      const next = await revise(sql, viewer, task, { accepted_run_id: input.decision === 'ACCEPT' ? run.id : null },
        input.decision === 'ACCEPT' ? 'delivery.review.accepted' : 'delivery.review.rework', { runId: run.id, note })
      return taskView(sql, viewer, next, true)
    })
  }

  transition(actor: Actor, id: string, revision: number, input: TransitionInput) {
    return this.withTask(actor, id, async (sql, viewer, task) => {
      assertRevision(task, revision)
      const next = await this.applyTransition(sql, viewer, task, input)
      return taskView(sql, viewer, next, true)
    })
  }

  private async applyTransition(sql: TransactionSQL, actor: Actor, task: AccessTask, input: TransitionInput) {
    switch (input.action) {
      case 'start':
        if (!isDeveloper(actor, task)) throw denied()
        requireStage(task, 'ASSIGNED')
        if (!task.binding_id) throw new ControlError(409, 'DELIVERY_BINDING_REQUIRED', '请先在客户端绑定工作树和会话。')
        return revise(sql, actor, task, { state: 'DEVELOPING' }, 'delivery.development.started')
      case 'start_testing':
        if (!isDeveloper(actor, task)) throw denied()
        requireStage(task, 'DEVELOPING')
        await requireAcceptedRun(sql, actor, task)
        return revise(sql, actor, task, { state: 'TESTING' }, 'delivery.testing.started')
      case 'record_test': {
        if (!isReviewer(actor, task)) throw denied()
        requireStage(task, 'TESTING')
        const run = input.outcome === 'passed' ? await requireAcceptedRun(sql, actor, task) :
          await readRun(sql, task, task.accepted_run_id!)
        if (input.outcome === 'passed' && !input.evidence?.length) {
          throw new ControlError(400, 'DELIVERY_TEST_EVIDENCE_REQUIRED', '请提交独立测试记录的名称和校验值。')
        }
        const failed = input.outcome === 'failed' || input.outcome === 'blocked'
        const evidence = input.evidence?.map(item => ({ ...item, label: redactDeliveryText(item.label) })) ?? []
        const patch: TaskPatch = input.outcome === 'passed' ? { state: 'ACCEPTANCE' } :
          failed ? { state: 'DEVELOPING', accepted_run_id: null } : {}
        return revise(sql, actor, task, patch, 'delivery.test.recorded',
          { runId: run.id, outcome: input.outcome, evidence, note: redactDeliveryText(input.note) })
      }
      case 'return_for_rework':
        if (task.owner_id !== actor.id) throw denied()
        requireStage(task, 'ACCEPTANCE')
        return revise(sql, actor, task, { state: 'DEVELOPING', accepted_run_id: null }, 'delivery.rework.requested',
          { note: redactDeliveryText(input.note) })
      case 'accept':
        if (task.owner_id !== actor.id) throw denied()
        requireStage(task, 'ACCEPTANCE')
        await requireAcceptedRun(sql, actor, task)
        return revise(sql, actor, task, { state: 'DELIVERED' }, 'delivery.delivered',
          { deliveryRef: redactDeliveryText(input.deliveryRef), note: redactDeliveryText(input.note) })
    }
  }
}
