import type { SQL, TransactionSQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { ControlError } from '../contract'
import { evidenceHash, redactDemandText } from '../demands/contract'
import { assertCleanContext } from '../memory/contract'
import type { Actor } from '../store'
import type { ErpEnvironment, ErpExecuteInput, ErpPlanDecision, ErpPlanInput, ErpPlanSnapshot, ErpPlanState } from './contract'
import type { ErpService } from './service'

type Database = SQL | TransactionSQL
interface PlanRow {
  id: string
  snapshot: ErpPlanSnapshot
  snapshot_hash: string
  requester_id: string
  approved_by: string | null
  state: ErpPlanState
  decision_note: string | null
  revision: number
  created_at: Date
  decided_at: Date | null
  started_at: Date | null
  finished_at: Date | null
}

// The deployed runtime supplies no writer. Injection is limited to a loopback sandbox fixture.
export interface SandboxErpWriter {
  timeoutMs?: number
  execute(input: { planId: string, snapshot: ErpPlanSnapshot }, signal: AbortSignal): Promise<'completed' | 'failed'>
}

const missing = () => new ControlError(404, 'ERP_PLAN_NOT_FOUND', '当前项目中没有这份写操作申请。')
const approvalRequired = () => new ControlError(403, 'ERP_WRITE_APPROVAL_REQUIRED', '此操作需要单独的 ERP 审批。')
const writeDisabled = () => new ControlError(403, 'ERP_WRITE_DISABLED', '当前工作台的金蝶连接仅开放查询。')
const environmentKey = (environment: ErpEnvironment) => evidenceHash([environment.tenant, environment.id, environment.kind, environment.mode,
  environment.origin, environment.credential.accountId, environment.credential.clientId, environment.credential.username, environment.credential.gatewayIdentity])

function clean(...texts: string[]) {
  try {
    assertCleanContext(...texts)
    if (texts.some(value => redactDemandText(value) !== value)) throw new Error('Contains a credential')
  } catch { throw new ControlError(400, 'ERP_PLAN_SENSITIVE_CONTENT', '请移除申请中的密钥、口令和个人敏感信息。') }
}

function view(row: PlanRow, actor: Actor, reviewer: boolean) {
  return { id: row.id, snapshot: row.snapshot, snapshotHash: row.snapshot_hash, state: row.state, revision: row.revision,
    requesterId: row.requester_id, approvedBy: row.approved_by, decisionNote: row.decision_note, createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null, startedAt: row.started_at?.toISOString() ?? null, finishedAt: row.finished_at?.toISOString() ?? null,
    canReview: !actor.device && reviewer && row.requester_id !== actor.id && row.state === 'pending' }
}

async function audit(db: Database, actor: Actor, planId: string, action: string) {
  await db`INSERT INTO enterprise_audit (id, tenant_id, actor_id, action, target_id) VALUES (${randomUUID()}, ${actor.tenantId}, ${actor.id}, ${action}, ${planId})`
}

async function dispatch(writer: SandboxErpWriter, row: PlanRow): Promise<'completed' | 'failed' | 'unknown'> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const reason = new Error('ERP sandbox result timed out')
        controller.abort(reason)
        reject(reason)
      }, writer.timeoutMs ?? 8_000)
    })
    return await Promise.race([writer.execute({ planId: row.id, snapshot: row.snapshot }, controller.signal), deadline])
  } catch { return 'unknown' }
  finally { clearTimeout(timer) }
}

export class ErpPlanStore {
  constructor(private readonly database: SQL, private readonly erp: ErpService, private readonly sandboxWriter?: SandboxErpWriter) {}

  private async access(db: Database, actor: Actor, environmentId: string, projectId: string) {
    const { environment, scope, project } = await this.erp.authorize(actor, environmentId, projectId, db)
    return { environment, project, enabled: scope.writeReviewRoles.length > 0, reviewer: scope.writeReviewRoles.some(role => project.roles.includes(role)) }
  }

  private async row(db: Database, actor: Actor, environmentId: string, projectId: string, id: string) {
    const [row] = await db<PlanRow[]>`SELECT * FROM enterprise_erp_operation_plans WHERE tenant_id = ${actor.tenantId}
      AND id = ${id} AND project_id = ${projectId} AND environment_id = ${environmentId} FOR UPDATE`
    if (!row) throw missing()
    return row
  }

  async list(actor: Actor, environmentId: string, projectId: string) {
    const { environment, project, enabled, reviewer } = await this.access(this.database, actor, environmentId, projectId)
    const rows = await this.database<PlanRow[]>`SELECT * FROM enterprise_erp_operation_plans WHERE tenant_id = ${actor.tenantId}
      AND project_id = ${projectId} AND environment_id = ${environmentId} AND (requester_id = ${actor.id} OR ${reviewer}) ORDER BY created_at DESC LIMIT 50`
    return { environment: { id: environment.id, name: environment.name, mode: environment.mode }, project: { id: project.id, name: project.name },
      canRequest: enabled, plans: rows.map(row => view(row, actor, reviewer)) }
  }

  async create(actor: Actor, environmentId: string, input: ErpPlanInput) {
    const { projectId, idempotencyKey, object, documentNumber, change, reason } = input
    clean(object, documentNumber, change, reason)
    return this.database.begin(async db => {
      const { environment, enabled, reviewer } = await this.access(db, actor, environmentId, projectId)
      if (!enabled) throw writeDisabled()
      const snapshot: ErpPlanSnapshot = { projectId, environmentId, environmentName: environment.name, mode: environment.mode,
        environmentFingerprint: environmentKey(environment), object, documentNumber, change, reason }
      const hash = evidenceHash(snapshot)
      const [created] = await db<PlanRow[]>`INSERT INTO enterprise_erp_operation_plans
        (tenant_id, id, project_id, environment_id, request_key, requester_id, snapshot, snapshot_hash, state)
        VALUES (${actor.tenantId}, ${randomUUID()}, ${projectId}, ${environmentId}, ${idempotencyKey}, ${actor.id}, ${snapshot}::jsonb, ${hash}, 'pending')
        ON CONFLICT (tenant_id, requester_id, request_key) DO NOTHING RETURNING *`
      if (created) {
        await audit(db, actor, created.id, 'erp.plan.submitted')
        return view(created, actor, reviewer)
      }
      const [previous] = await db<PlanRow[]>`SELECT * FROM enterprise_erp_operation_plans
        WHERE tenant_id = ${actor.tenantId} AND requester_id = ${actor.id} AND request_key = ${idempotencyKey}`
      if (!previous || previous.snapshot_hash !== hash) throw new ControlError(409, 'ERP_PLAN_REQUEST_CONFLICT', '这次提交与原申请内容不一致，请重新发起。')
      return view(previous, actor, reviewer)
    })
  }

  async decide(actor: Actor, environmentId: string, id: string, input: ErpPlanDecision) {
    clean(input.note)
    return this.database.begin(async db => {
      const { projectId, decision, expectedRevision, note } = input
      const { environment, reviewer } = await this.access(db, actor, environmentId, projectId)
      if (!reviewer || actor.device) throw approvalRequired()
      const row = await this.row(db, actor, environmentId, projectId, id)
      if (row.requester_id === actor.id) throw approvalRequired()
      if (row.state !== 'pending' || row.revision !== expectedRevision || row.snapshot.environmentFingerprint !== environmentKey(environment) ||
          evidenceHash(row.snapshot) !== row.snapshot_hash) throw new ControlError(409, 'ERP_PLAN_CHANGED', '审批版本或目标环境已变化，请刷新后核对。')
      const state = decision === 'approve' ? 'approved' : 'rejected'
      const [saved] = await db<PlanRow[]>`UPDATE enterprise_erp_operation_plans SET state = ${state}, revision = revision + 1,
        approved_by = ${decision === 'approve' ? actor.id : null}, decision_note = ${note}, decided_at = now()
        WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING *`
      await audit(db, actor, id, `erp.plan.${state}`)
      return view(saved!, actor, reviewer)
    })
  }

  async execute(actor: Actor, environmentId: string, id: string, input: ErpExecuteInput) {
    const writer = this.sandboxWriter
    const reservation = await this.database.begin(async db => {
      const { projectId } = input
      const { environment, reviewer } = await this.access(db, actor, environmentId, projectId)
      const row = await this.row(db, actor, environmentId, projectId, id)
      const deny = async (error: ControlError) => { await audit(db, actor, id, 'erp.write.denied'); return { error } as const }
      if (row.requester_id !== actor.id || !row.approved_by || row.state === 'pending' || row.state === 'rejected') return deny(approvalRequired())
      if (input.confirmEnvironment !== environmentId || input.snapshotHash !== row.snapshot_hash || evidenceHash(row.snapshot) !== row.snapshot_hash ||
          row.snapshot.environmentFingerprint !== environmentKey(environment)) return deny(new ControlError(403, 'ERP_WRITE_CONFIRMATION_REQUIRED', '请核对目标环境和已审批的申请版本。'))
      const address = new URL(environment.origin)
      if (!writer || environment.mode !== 'sandbox' || address.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(address.hostname)) return deny(writeDisabled())
      if (row.state === 'executing' && row.started_at && Date.now() - row.started_at.getTime() > 60_000) {
        const [unknown] = await db<PlanRow[]>`UPDATE enterprise_erp_operation_plans SET state = 'unknown', revision = revision + 1, finished_at = now()
          WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING *`
        await audit(db, actor, id, 'erp.write.unknown')
        return { existing: view(unknown!, actor, reviewer) } as const
      }
      if (row.state !== 'approved') return { existing: view(row, actor, reviewer) } as const
      const currentApproval = await this.access(db, { ...actor, id: row.approved_by, device: null }, environmentId, projectId)
        .catch((error: unknown) => { if (error instanceof ControlError && error.status === 404) return null; throw error })
      if (!currentApproval?.reviewer) return deny(approvalRequired())
      const [reserved] = await db<PlanRow[]>`UPDATE enterprise_erp_operation_plans SET state = 'executing', revision = revision + 1, started_at = now()
        WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING *`
      await audit(db, actor, id, 'erp.write.started')
      return { reserved: reserved!, writer } as const
    })
    if ('error' in reservation) throw reservation.error
    if ('existing' in reservation) return reservation.existing
    const state = await dispatch(reservation.writer, reservation.reserved)
    return this.database.begin(async db => {
      const row = await this.row(db, actor, environmentId, input.projectId, id)
      if (row.state !== 'executing') return view(row, actor, false)
      const [saved] = await db<PlanRow[]>`UPDATE enterprise_erp_operation_plans SET state = ${state}, revision = revision + 1, finished_at = now()
        WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING *`
      await audit(db, actor, id, `erp.write.${state}`)
      return view(saved!, actor, false)
    })
  }
}
