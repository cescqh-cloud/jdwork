import type { SQL, TransactionSQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { ControlError } from '../contract'
import type { Actor } from '../store'
import {
  bodyHash, evidenceHash, redactDemandText, snapshotReference, validateDemand, type Decision, type DemandDraft, type DemandOrigin,
  type DemandSnapshot, type DemandState, type FieldMap, type FieldRef, type IdentityInput, type Precheck,
  type SubmissionState, type SubmitInput, type TemplateInput, type VerifiedState,
} from './contract'
import { formText, type DingTalkCreateRequest, type DingTalkInstance } from './dingtalk'
import type { DingTalkEvent } from './callback'

type Connection = SQL | TransactionSQL
type DraftMutation = { id: string; draftRevision: number }
const notFound = () => new ControlError(404, 'DEMAND_NOT_FOUND', 'The demand could not be found in your scope.')
const draftConflict = () => new ControlError(409, 'DEMAND_DRAFT_CONFLICT', 'The draft changed. Reload both versions before saving or submitting.')
const leadOnly = () => new ControlError(403, 'DEMAND_LEAD_REQUIRED', 'This action requires an information center lead.')
const adminOnly = () => new ControlError(403, 'DEMAND_ADMIN_REQUIRED', 'This action requires a platform administrator in the web console.')

export interface DemandRow {
  tenant_id: string
  id: string
  demand_no: string
  owner_id: string | null
  draft: DemandDraft
  draft_revision: number
  revision: number
  precheck: Precheck | null
  state: DemandState
  origin: DemandOrigin
  import_confirmed: boolean
  active_version_id: string | null
  approved_version_id: string | null
  created_at: Date
  updated_at: Date
}

interface VersionRow {
  id: string
  version_no: number
  draft_revision: number
  submitted_by: string | null
  snapshot: DemandSnapshot
  snapshot_hash: string
  body_hash: string
  created_at: Date
}

interface ApprovalRow {
  decision: Decision
  decided_at: Date | null
  verified_at: Date
  snapshot_hash: string
}

export interface InstanceRow {
  tenant_id: string
  instance_id: string
  demand_id: string
  version_id: string
  corp_id: string
  process_code: string
  originator_user_id: string
  state: VerifiedState
  verified_at: Date | null
}

export interface SubmissionRow {
  tenant_id: string
  demand_id: string
  version_id: string
  corp_id: string
  process_code: string
  originator_user_id: string
  request_id: string
  request_fingerprint: string
  request: DingTalkCreateRequest
  state: SubmissionState
  error_code: string | null
  version_ref_field: FieldRef
  submitted_at: Date
}

interface TemplateRow {
  process_code: string
  label: string
  field_map: FieldMap
  submit_enabled: boolean
  import_enabled: boolean
  approver_options: TemplateInput['approverOptions']
  revision: number
}

export interface InboxRow {
  event_id: string
  corp_id: string
  process_code: string
  instance_id: string
  event_type: DingTalkEvent['type'] | 'scan'
  attempts: number
}

const isLead = (actor: Actor) => actor.roles.includes('it_lead')
const isAdmin = (actor: Actor) => actor.device === null && actor.roles.includes('platform_admin')
const canDraft = (actor: Actor) => actor.roles.some(role => ['requester', 'developer', 'project_owner', 'it_lead', 'platform_admin'].includes(role))
const terminal = (state: VerifiedState): state is Decision => state === 'AGREE' || state === 'REFUSE' || state === 'TERMINATED'
const demandStatus = (decision: VerifiedState): DemandState => decision === 'AGREE' ? 'BACKLOG' : decision === 'REFUSE' ? 'REJECTED' : decision === 'TERMINATED' ? 'CANCELLED' : 'PENDING'

function evidence(row: VersionRow) {
  return { id: row.id, versionNo: row.version_no, submittedBy: row.submitted_by, snapshot: row.snapshot,
    snapshotHash: row.snapshot_hash, bodyHash: row.body_hash, createdAt: row.created_at.toISOString() }
}

function template(row: TemplateRow) {
  return { processCode: row.process_code, label: row.label, fieldMap: row.field_map, approverOptions: row.approver_options,
    submitEnabled: row.submit_enabled, importEnabled: row.import_enabled, revision: row.revision }
}

function mappedFields(snapshot: DemandSnapshot, mapping: FieldMap, reference: string) {
  const { attachmentRefs, ...business } = snapshot.draft
  const optional = { expectedValue: '预期收益', acceptanceCriteria: '验收要求', businessOwner: '业务责任人', priority: '期望时间或紧急程度' } as const
  const supplement = Object.entries(optional).flatMap(([key, label]) => {
    const field = key as keyof typeof optional
    return !mapping[field] && business[field] ? [`${label}\n${business[field]}`] : []
  })
  if (!mapping.attachmentRefs && attachmentRefs.length) supplement.push(`附件引用\n${attachmentRefs.map(file => `${file.name}（${file.id}）`).join('\n')}`)
  const fields = { ...business, businessContext: [business.businessContext, ...supplement].join('\n\n'),
    attachmentRefs: attachmentRefs.length ? JSON.stringify(attachmentRefs) : '', demandNo: snapshot.demandNo,
    precheckSummary: snapshot.precheck?.summary ?? '', versionRef: reference }
  return Object.entries(mapping).flatMap(([key, field]) => {
    const value = fields[key as keyof typeof fields]
    return value ? [{ name: field.name, value }] : []
  })
}

function verifiedSelections(input: SubmitInput, config: TemplateRow, originatorUserId: string) {
  const selections = new Map(input.approverSelections.map(item => [item.actionerKey, item.actionerUserIds]))
  if (selections.size !== input.approverSelections.length || selections.size !== config.approver_options.length) {
    throw new ControlError(400, 'DEMAND_APPROVER_SELECTION', 'Select approvers for the configured template nodes.')
  }
  return config.approver_options.map(node => {
    const ids = selections.get(node.actionerKey)
    if (!ids || new Set(ids).size !== ids.length || ids.some(id => id === originatorUserId || !node.allowedUserIds.includes(id))) {
      throw new ControlError(400, 'DEMAND_APPROVER_SELECTION', 'Use the allowed approvers for each configured template node.')
    }
    return { actionerKey: node.actionerKey, actionerUserIds: ids }
  })
}

async function audit(sql: TransactionSQL, tenantId: string, actorId: string | null, action: string, target: string) {
  await sql`INSERT INTO enterprise_audit (id, tenant_id, actor_id, action, target_id)
    VALUES (${randomUUID()}, ${tenantId}, ${actorId}, ${action}, ${target})`
}

async function emit(sql: TransactionSQL, row: DemandRow, actorId: string | null, action: string) {
  await audit(sql, row.tenant_id, actorId, action, row.id)
  const watchers = await sql<{ id: string }[]>`SELECT id FROM enterprise_users WHERE tenant_id = ${row.tenant_id} AND active
    AND (id = ${row.owner_id} OR 'it_lead' = ANY(roles)) ORDER BY id`
  if (!watchers.length) return
  const [head] = await sql<{ event_sequence: string }[]>`UPDATE enterprise_tenants SET event_sequence = event_sequence + ${watchers.length}
    WHERE id = ${row.tenant_id} RETURNING event_sequence::text`
  if (!head) throw new Error('Demand tenant disappeared')
  let sequence = Number(head.event_sequence) - watchers.length
  for (const watcher of watchers) {
    await sql`INSERT INTO enterprise_events (tenant_id, sequence, event_id, user_id, event_type, resource_id, revision)
      VALUES (${row.tenant_id}, ${++sequence}, ${randomUUID()}, ${watcher.id}, ${action}, ${row.id}, ${row.revision})`
  }
}

async function lockDemand(sql: TransactionSQL, tenantId: string, id: string) {
  const [row] = await sql<DemandRow[]>`SELECT * FROM enterprise_demands WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`
  if (!row) throw notFound()
  return row
}

async function lockInstance(sql: TransactionSQL, tenantId: string, id: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext(${id}::text))`
}

async function mutateDraft(sql: TransactionSQL, actor: Actor, key: string | undefined, input: unknown,
  mutate: () => Promise<DraftMutation>): Promise<DraftMutation> {
  if (!key) return mutate()
  const fingerprint = evidenceHash(input)
  await lockInstance(sql, actor.tenantId, `draft:${actor.id}:${key}`)
  const [prior] = await sql<{ demand_id: string; draft_revision: number; request_fingerprint: string }[]>`
    SELECT demand_id, draft_revision, request_fingerprint FROM enterprise_demand_draft_requests
    WHERE tenant_id = ${actor.tenantId} AND actor_id = ${actor.id} AND request_id = ${key}`
  if (prior) {
    if (prior.request_fingerprint !== fingerprint) {
      throw new ControlError(409, 'DEMAND_DRAFT_REQUEST_CONFLICT', 'This draft request was already used for different content.')
    }
    return { id: prior.demand_id, draftRevision: prior.draft_revision }
  }
  const result = await mutate()
  await sql`INSERT INTO enterprise_demand_draft_requests (tenant_id, actor_id, request_id, demand_id, request_fingerprint, draft_revision)
    VALUES (${actor.tenantId}, ${actor.id}, ${key}, ${result.id}, ${fingerprint}, ${result.draftRevision})`
  return result
}

async function writeVersion(sql: TransactionSQL, demand: DemandRow, origin: DemandOrigin, userId: string | null,
  oaFieldDigests?: DemandSnapshot['oaFieldDigests']) {
  const [previous] = await sql<{ n: number }[]>`SELECT coalesce(max(version_no), 0)::int AS n FROM enterprise_demand_versions
    WHERE tenant_id = ${demand.tenant_id} AND demand_id = ${demand.id}`
  const snapshot: DemandSnapshot = {
    format: 1, demandId: demand.id, demandNo: demand.demand_no, versionId: randomUUID(), versionNo: (previous?.n ?? 0) + 1,
    draftRevision: demand.draft_revision, origin, draft: demand.draft,
    precheck: origin === 'WORKBENCH' && demand.precheck?.draftRevision === demand.draft_revision ? demand.precheck : null,
    ...(oaFieldDigests ? { oaFieldDigests } : {}),
  }
  const hash = evidenceHash(snapshot)
  const [saved] = await sql<VersionRow[]>`INSERT INTO enterprise_demand_versions
    (tenant_id, demand_id, id, version_no, draft_revision, submitted_by, snapshot, snapshot_hash, body_hash)
    VALUES (${demand.tenant_id}, ${demand.id}, ${snapshot.versionId}, ${snapshot.versionNo}, ${snapshot.draftRevision}, ${userId},
      ${snapshot}::jsonb, ${hash}, ${bodyHash(demand.draft)}) RETURNING *`
  return saved!
}

export class DemandStore {
  constructor(private readonly db: SQL) {}

  async tenantId(slug: string) {
    const [row] = await this.db<{ id: string }[]>`SELECT id FROM enterprise_tenants WHERE slug = ${slug} AND active`
    return row?.id
  }

  async tenantSlug(id: string) {
    const [row] = await this.db<{ slug: string }[]>`SELECT slug FROM enterprise_tenants WHERE id = ${id} AND active`
    return row?.slug
  }

  private async readable(actor: Actor, id: string) {
    const [row] = await this.db<DemandRow[]>`SELECT d.* FROM enterprise_demands d
      WHERE d.tenant_id = ${actor.tenantId} AND d.id = ${id} AND (d.owner_id = ${actor.id} OR ${isLead(actor)} OR
        (${actor.roles.includes('approver')} AND EXISTS (SELECT 1 FROM enterprise_dingtalk_demand_instances i
          JOIN enterprise_dingtalk_demand_identities di ON di.tenant_id = i.tenant_id AND di.corp_id = i.corp_id
          WHERE (i.tenant_id, i.demand_id, i.version_id) = (d.tenant_id, d.id, d.active_version_id)
            AND di.user_id = ${actor.id} AND di.staff_id = ANY(i.approver_user_ids))))`
    if (!row) throw notFound()
    return row
  }

  async list(actor: Actor, backlog: boolean, limit: number, offset: number) {
    const rows = await this.db<Array<Pick<DemandRow, 'id' | 'demand_no' | 'owner_id' | 'state' | 'origin' | 'revision' | 'draft_revision' | 'updated_at' | 'approved_version_id'> & { title: string | null }>>`
      SELECT d.id, d.demand_no, d.owner_id, d.state, d.origin, d.revision, d.draft_revision, d.updated_at,
        CASE WHEN d.owner_id = ${actor.id} OR ${isLead(actor)} OR d.active_version_id = d.approved_version_id THEN d.approved_version_id END AS approved_version_id,
        CASE WHEN ${backlog} THEN approved.snapshot #>> '{draft,title}'
          WHEN d.owner_id = ${actor.id} OR ${isLead(actor)} THEN d.draft ->> 'title' ELSE submitted.snapshot #>> '{draft,title}' END AS title
      FROM enterprise_demands d LEFT JOIN enterprise_demand_versions approved
        ON (approved.tenant_id, approved.demand_id, approved.id) = (d.tenant_id, d.id, d.approved_version_id)
      LEFT JOIN enterprise_demand_versions submitted ON (submitted.tenant_id, submitted.demand_id, submitted.id) = (d.tenant_id, d.id, d.active_version_id)
      WHERE d.tenant_id = ${actor.tenantId} AND (NOT ${backlog} OR d.approved_version_id IS NOT NULL) AND
        (d.owner_id = ${actor.id} OR ${isLead(actor)} OR (NOT ${backlog} AND ${actor.roles.includes('approver')} AND EXISTS (
          SELECT 1 FROM enterprise_dingtalk_demand_instances i
          JOIN enterprise_dingtalk_demand_identities di ON di.tenant_id = i.tenant_id AND di.corp_id = i.corp_id
          WHERE (i.tenant_id, i.demand_id, i.version_id) = (d.tenant_id, d.id, d.active_version_id)
            AND di.user_id = ${actor.id} AND di.staff_id = ANY(i.approver_user_ids))))
      ORDER BY d.updated_at DESC, d.id LIMIT ${limit} OFFSET ${offset}`
    return { demands: rows.map(row => ({ id: row.id, demandNo: row.demand_no, title: row.title ?? '', ownerId: row.owner_id,
      state: row.state, origin: row.origin, revision: row.revision, draftRevision: row.draft_revision,
      approvedVersionId: row.approved_version_id, updatedAt: row.updated_at.toISOString() })) }
  }

  private async findVersion(sql: Connection, row: DemandRow, versionId: string) {
    const [version] = await sql<VersionRow[]>`SELECT * FROM enterprise_demand_versions
      WHERE tenant_id = ${row.tenant_id} AND demand_id = ${row.id} AND id = ${versionId}`
    return version
  }

  async version(actor: Actor, demandId: string, versionId: string) {
    const row = await this.readable(actor, demandId)
    if (actor.id !== row.owner_id && !isLead(actor)) throw notFound()
    const version = await this.findVersion(this.db, row, versionId)
    if (!version) throw notFound()
    return evidence(version)
  }

  async get(actor: Actor, id: string) {
    const row = await this.readable(actor, id)
    const canReadDraft = actor.id === row.owner_id || isLead(actor)
    const [active, approved, submission, instance] = await Promise.all([
      row.active_version_id ? this.findVersion(this.db, row, row.active_version_id) : undefined,
      canReadDraft && row.approved_version_id ? this.findVersion(this.db, row, row.approved_version_id) : undefined,
      canReadDraft && row.active_version_id ? this.submission(actor.tenantId, id, row.active_version_id) : undefined,
      row.active_version_id ? this.activeInstance(actor.tenantId, id, row.active_version_id) : undefined,
    ])
    const decision = instance && terminal(instance.state) ? await this.decision(instance.tenant_id, instance.instance_id) : undefined
    return {
      id: row.id, demandNo: row.demand_no, title: canReadDraft ? row.draft.title : active?.snapshot.draft.title ?? '',
      ownerId: row.owner_id, state: row.state, origin: row.origin,
      revision: row.revision, draftRevision: row.draft_revision, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      draft: canReadDraft ? row.draft : null, validation: canReadDraft ? validateDemand(row.draft) : null,
      precheck: canReadDraft ? row.precheck : null, importConfirmed: row.import_confirmed,
      activeVersion: active && canReadDraft ? evidence(active) : null, approvedVersion: approved ? evidence(approved) : null,
      unsubmittedChanges: canReadDraft && active !== undefined && active.draft_revision !== row.draft_revision,
      submission: submission ? { state: submission.state, errorCode: submission.error_code, versionId: submission.version_id } : null,
      approval: instance ? { instanceId: instance.instance_id, processCode: instance.process_code, state: instance.state,
        verifiedAt: instance.verified_at?.toISOString() ?? null, decision: decision ? { result: decision.decision,
          decidedAt: decision.decided_at?.toISOString() ?? null, verifiedAt: decision.verified_at.toISOString(), snapshotHash: decision.snapshot_hash } : null } : null,
    }
  }

  async create(actor: Actor, draft: DemandDraft) {
    return (await this.createDraft(actor, draft)).id
  }

  async createDraft(actor: Actor, draft: DemandDraft, idempotencyKey?: string) {
    if (!canDraft(actor)) throw new ControlError(403, 'DEMAND_CREATE_DENIED', 'Your role does not allow creating demands.')
    return this.db.begin(sql => mutateDraft(sql, actor, idempotencyKey, { action: 'create', draft }, async () => {
      const [row] = await sql<DemandRow[]>`INSERT INTO enterprise_demands (tenant_id, id, owner_id, draft, state, origin)
        VALUES (${actor.tenantId}, ${randomUUID()}, ${actor.id}, ${draft}::jsonb, 'DRAFT', 'WORKBENCH') RETURNING *`
      await emit(sql, row!, actor.id, 'demand.created')
      return { id: row!.id, draftRevision: row!.draft_revision }
    }))
  }

  private assertDraftEditor(actor: Actor, row: DemandRow) {
    if ((row.owner_id === actor.id && canDraft(actor)) || (isLead(actor) && row.state === 'IMPORT_REVIEW')) return
    throw notFound()
  }

  async edit(actor: Actor, id: string, expectedRevision: number, draft: DemandDraft, idempotencyKey?: string) {
    return this.db.begin(async sql => {
      const row = await lockDemand(sql, actor.tenantId, id)
      this.assertDraftEditor(actor, row)
      return mutateDraft(sql, actor, idempotencyKey, { action: 'edit', id, expectedRevision, draft }, async () => {
        if (row.draft_revision !== expectedRevision) throw draftConflict()
        const state: DemandState = row.state === 'BACKLOG' ? 'CHANGE_REQUEST'
          : ['REJECTED', 'CANCELLED', 'AI_PRECHECK'].includes(row.state) ? 'DRAFT' : row.state
        const [updated] = await sql<DemandRow[]>`UPDATE enterprise_demands SET draft = ${draft}::jsonb, state = ${state},
          draft_revision = draft_revision + 1, revision = revision + 1, precheck = NULL, updated_at = now()
          WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING *`
        await emit(sql, updated!, actor.id, 'demand.draft.changed')
        return { id, draftRevision: updated!.draft_revision }
      })
    })
  }

  async precheckDraft(actor: Actor, id: string, expectedRevision: number) {
    const row = await this.readable(actor, id)
    this.assertDraftEditor(actor, row)
    if (row.draft_revision !== expectedRevision) throw draftConflict()
    return { draft: row.draft, previous: row.precheck }
  }

  async recordPrecheck(actor: Actor, id: string, precheck: Precheck) {
    await this.db.begin(async sql => {
      const row = await lockDemand(sql, actor.tenantId, id)
      this.assertDraftEditor(actor, row)
      if (row.draft_revision !== precheck.draftRevision) throw draftConflict()
      if (row.precheck?.draftRevision === precheck.draftRevision) return
      const [updated] = await sql<DemandRow[]>`UPDATE enterprise_demands SET precheck = ${precheck}::jsonb,
        state = CASE WHEN state = 'DRAFT' THEN 'AI_PRECHECK' ELSE state END, revision = revision + 1, updated_at = now()
        WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING *`
      await emit(sql, updated!, actor.id, 'demand.precheck.ready')
    })
  }

  async adminTemplates(actor: Actor) {
    if (!isAdmin(actor)) throw adminOnly()
    const rows = await this.db<TemplateRow[]>`SELECT * FROM enterprise_dingtalk_demand_templates WHERE tenant_id = ${actor.tenantId} ORDER BY process_code`
    return { templates: rows.map(template) }
  }

  async userTemplates(actor: Actor) {
    if (!canDraft(actor)) return { templates: [] }
    const rows = await this.db<TemplateRow[]>`SELECT * FROM enterprise_dingtalk_demand_templates WHERE tenant_id = ${actor.tenantId}
      AND submit_enabled ORDER BY label, process_code`
    return { templates: rows.map(row => ({ processCode: row.process_code, label: row.label, approverOptions: row.approver_options })) }
  }

  async getTemplate(tenantId: string, processCode: string) {
    const [row] = await this.db<TemplateRow[]>`SELECT * FROM enterprise_dingtalk_demand_templates
      WHERE tenant_id = ${tenantId} AND process_code = ${processCode}`
    return row ? template(row) : undefined
  }

  async saveTemplate(actor: Actor, input: TemplateInput) {
    if (!isAdmin(actor)) throw adminOnly()
    return this.db.begin(async sql => {
      const [saved] = input.expectedRevision === null
        ? await sql<TemplateRow[]>`INSERT INTO enterprise_dingtalk_demand_templates
            (tenant_id, process_code, label, field_map, approver_options, submit_enabled, import_enabled)
            VALUES (${actor.tenantId}, ${input.processCode}, ${input.label}, ${input.fieldMap}::jsonb, ${input.approverOptions}::jsonb,
              ${input.submitEnabled}, ${input.importEnabled}) ON CONFLICT DO NOTHING RETURNING *`
        : await sql<TemplateRow[]>`UPDATE enterprise_dingtalk_demand_templates SET label = ${input.label}, field_map = ${input.fieldMap}::jsonb,
            approver_options = ${input.approverOptions}::jsonb, submit_enabled = ${input.submitEnabled}, import_enabled = ${input.importEnabled},
            revision = revision + 1, updated_at = now() WHERE tenant_id = ${actor.tenantId} AND process_code = ${input.processCode}
              AND revision = ${input.expectedRevision} RETURNING *`
      if (!saved) throw new ControlError(409, 'DINGTALK_TEMPLATE_CONFLICT', 'The template mapping changed. Reload it before saving.')
      await audit(sql, actor.tenantId, actor.id, 'demand.template.saved', actor.tenantId)
      return template(saved)
    })
  }

  async saveIdentity(actor: Actor, corpId: string, input: IdentityInput) {
    if (!isAdmin(actor)) throw adminOnly()
    return this.db.begin(async sql => {
      const [target] = await sql<{ id: string }[]>`SELECT id FROM enterprise_users WHERE tenant_id = ${actor.tenantId}
        AND id = ${input.userId} AND active FOR UPDATE`
      if (!target) throw new ControlError(404, 'DEMAND_IDENTITY_USER_NOT_FOUND', 'The active user could not be found in your tenant.')
      const [existing] = await sql<{ user_id: string }[]>`SELECT user_id FROM enterprise_dingtalk_demand_identities
        WHERE tenant_id = ${actor.tenantId} AND corp_id = ${corpId} AND staff_id = ${input.staffId}`
      if (existing && existing.user_id !== input.userId) throw new ControlError(409, 'DINGTALK_STAFF_ALREADY_LINKED', 'This DingTalk user is already linked.')
      await sql`INSERT INTO enterprise_dingtalk_demand_identities (tenant_id, user_id, corp_id, staff_id, department_id)
        VALUES (${actor.tenantId}, ${input.userId}, ${corpId}, ${input.staffId}, ${input.departmentId})
        ON CONFLICT (tenant_id, user_id, corp_id) DO UPDATE SET staff_id = EXCLUDED.staff_id,
          department_id = EXCLUDED.department_id, updated_at = now()`
      await audit(sql, actor.tenantId, actor.id, 'demand.identity.saved', input.userId)
      return input
    })
  }

  async adminIdentities(actor: Actor, corpId: string | undefined, login: string, limit: number) {
    if (!isAdmin(actor)) throw adminOnly()
    const rows = await this.db<Array<{ id: string, login: string, display_name: string, staff_id: string | null, department_id: string | null }>>`
      SELECT u.id, u.login, u.display_name, di.staff_id, di.department_id::text FROM enterprise_users u
      LEFT JOIN enterprise_dingtalk_demand_identities di ON (di.tenant_id, di.user_id) = (u.tenant_id, u.id) AND di.corp_id = ${corpId ?? null}
      WHERE u.tenant_id = ${actor.tenantId} AND u.active AND starts_with(u.login, ${login}) ORDER BY u.login LIMIT ${limit}`
    return { users: rows.map(row => ({ userId: row.id, login: row.login, displayName: row.display_name,
      staffId: row.staff_id, departmentId: row.department_id === null ? null : Number(row.department_id) })) }
  }

  async reserve(actor: Actor, id: string, corpId: string, input: SubmitInput) {
    const fingerprint = evidenceHash(input)
    return this.db.begin(async sql => {
      const row = await lockDemand(sql, actor.tenantId, id)
      if (!canDraft(actor) || row.owner_id !== actor.id) throw notFound()
      const [prior] = await sql<SubmissionRow[]>`SELECT * FROM enterprise_demand_submissions
        WHERE tenant_id = ${actor.tenantId} AND demand_id = ${id} AND request_id = ${input.idempotencyKey}`
      if (prior) {
        if (prior.request_fingerprint !== fingerprint) throw new ControlError(409, 'DEMAND_IDEMPOTENCY_CONFLICT', 'Use a new submission key for a changed request.')
        return { versionId: prior.version_id, reused: true }
      }
      if (row.draft_revision !== input.expectedDraftRevision) throw draftConflict()
      const [open] = await sql<SubmissionRow[]>`SELECT * FROM enterprise_demand_submissions WHERE tenant_id = ${actor.tenantId}
        AND demand_id = ${id} AND state IN ('QUEUED', 'DISPATCHING', 'UNCONFIRMED', 'LINKED')`
      if (open || ['SUBMITTING', 'PENDING', 'IMPORT_REVIEW'].includes(row.state)) {
        throw new ControlError(409, 'DEMAND_APPROVAL_IN_PROGRESS', 'Finish or reconcile the existing approval before submitting another version.')
      }
      if (validateDemand(row.draft).missing.length || row.precheck?.draftRevision !== row.draft_revision) {
        throw new ControlError(409, 'DEMAND_PRECHECK_REQUIRED', 'Complete the required fields and run AI precheck for this draft revision.')
      }
      const { attachmentRefs, ...businessText } = row.draft
      if ([...Object.values(businessText), ...attachmentRefs.map(file => file.name)].some(value => redactDemandText(value) !== value)) {
        throw new ControlError(409, 'DEMAND_CREDENTIALS_IN_DRAFT', '草稿包含疑似密码、令牌或连接凭据。请移除后再送审。')
      }
      const [previous] = row.active_version_id ? await sql<VersionRow[]>`SELECT * FROM enterprise_demand_versions
        WHERE tenant_id = ${actor.tenantId} AND demand_id = ${id} AND id = ${row.active_version_id}` : []
      if (previous?.draft_revision === row.draft_revision && ['BACKLOG', 'REJECTED', 'CANCELLED'].includes(row.state)) {
        throw new ControlError(409, 'DEMAND_NEW_REVISION_REQUIRED', 'Save a new draft revision before submitting it.')
      }
      const [config] = await sql<TemplateRow[]>`SELECT * FROM enterprise_dingtalk_demand_templates WHERE tenant_id = ${actor.tenantId}
        AND process_code = ${input.processCode} AND submit_enabled FOR SHARE`
      const versionField = config?.field_map.versionRef
      if (!config || !versionField) throw new ControlError(403, 'DINGTALK_TEMPLATE_NOT_ALLOWED', 'This OA template is unavailable for submissions.')
      const [identity] = await sql<{ staff_id: string, department_id: string }[]>`SELECT staff_id, department_id::text
        FROM enterprise_dingtalk_demand_identities WHERE tenant_id = ${actor.tenantId} AND user_id = ${actor.id} AND corp_id = ${corpId}`
      if (!identity) throw new ControlError(409, 'DINGTALK_IDENTITY_REQUIRED', 'Ask an administrator to link your DingTalk user and department.')
      const selections = verifiedSelections(input, config, identity.staff_id)
      const version = await writeVersion(sql, row, 'WORKBENCH', actor.id)
      const request: DingTalkCreateRequest = { RequestId: input.idempotencyKey, originatorUserId: identity.staff_id,
        deptId: Number(identity.department_id), processCode: input.processCode,
        formComponentValues: mappedFields(version.snapshot, config.field_map, snapshotReference(version.id, version.snapshot_hash)),
        ...(selections.length ? { targetSelectActioners: selections } : {}),
      }
      await sql`INSERT INTO enterprise_demand_submissions (tenant_id, demand_id, version_id, request_id, request_fingerprint,
        state, corp_id, process_code, originator_user_id, request, version_ref_field)
        VALUES (${actor.tenantId}, ${id}, ${version.id}, ${input.idempotencyKey}, ${fingerprint}, 'QUEUED', ${corpId}, ${input.processCode},
          ${identity.staff_id}, ${request}::jsonb, ${versionField}::jsonb)`
      const [updated] = await sql<DemandRow[]>`UPDATE enterprise_demands SET active_version_id = ${version.id}, state = 'SUBMITTING',
        revision = revision + 1, updated_at = now() WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING *`
      await emit(sql, updated!, actor.id, 'demand.approval.submitted')
      return { versionId: version.id, reused: false }
    })
  }

  async submission(tenantId: string, demandId: string, versionId: string) {
    const [row] = await this.db<SubmissionRow[]>`SELECT * FROM enterprise_demand_submissions WHERE tenant_id = ${tenantId}
      AND demand_id = ${demandId} AND version_id = ${versionId}`
    return row
  }

  async submissionByVersion(tenantId: string, versionId: string) {
    const [row] = await this.db<SubmissionRow[]>`SELECT * FROM enterprise_demand_submissions WHERE tenant_id = ${tenantId}
      AND version_id = ${versionId}`
    return row
  }

  async openSubmissionForStaff(tenantId: string, corpId: string, processCode: string, originatorUserId: string) {
    const [row] = await this.db<{ present: number }[]>`SELECT 1 AS present FROM enterprise_demand_submissions
      WHERE tenant_id = ${tenantId} AND corp_id = ${corpId} AND process_code = ${processCode} AND originator_user_id = ${originatorUserId}
        AND state IN ('DISPATCHING', 'UNCONFIRMED') LIMIT 1`
    return Boolean(row)
  }

  async claimDispatch(tenantId: string, corpId: string) {
    const [claimed] = await this.db<SubmissionRow[]>`WITH next AS (SELECT tenant_id, demand_id, version_id FROM enterprise_demand_submissions
      WHERE tenant_id = ${tenantId} AND corp_id = ${corpId} AND state = 'QUEUED' AND next_check_at <= now()
      ORDER BY next_check_at, version_id LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE enterprise_demand_submissions s SET state = 'DISPATCHING', next_check_at = now() + interval '90 seconds'
      FROM next WHERE (s.tenant_id, s.demand_id, s.version_id) = (next.tenant_id, next.demand_id, next.version_id) RETURNING s.*`
    return claimed
  }

  async dispatchAllowed(attempt: SubmissionRow) {
    const [row] = await this.db<{ present: number }[]>`SELECT 1 AS present FROM enterprise_demands d
      JOIN enterprise_tenants t ON t.id = d.tenant_id
      JOIN enterprise_users u ON (u.tenant_id, u.id) = (d.tenant_id, d.owner_id)
      JOIN enterprise_dingtalk_demand_identities di ON (di.tenant_id, di.user_id) = (d.tenant_id, d.owner_id)
      JOIN enterprise_dingtalk_demand_templates dt ON dt.tenant_id = d.tenant_id AND dt.process_code = ${attempt.process_code}
      WHERE d.tenant_id = ${attempt.tenant_id} AND d.id = ${attempt.demand_id} AND d.active_version_id = ${attempt.version_id}
        AND t.active AND u.active AND dt.submit_enabled AND di.corp_id = ${attempt.corp_id} AND di.staff_id = ${attempt.originator_user_id}
        AND u.roles && ARRAY['requester','developer','project_owner','it_lead','platform_admin']::text[]`
    if (!row) return false
    const config = await this.getTemplate(attempt.tenant_id, attempt.process_code)
    if (!config?.submitEnabled) return false
    const currentNames = new Set(Object.values(config.fieldMap).map(value => value.name))
    if (attempt.request.formComponentValues.some(value => !currentNames.has(value.name))) return false
    const selected = attempt.request.targetSelectActioners ?? []
    return config.approverOptions.length === selected.length && selected.every(selection => {
      const node = config.approverOptions.find(option => option.actionerKey === selection.actionerKey)
      return selection.actionerUserIds.every(id => node?.allowedUserIds.includes(id))
    })
  }

  async claimRecovery(tenantId: string, corpId: string) {
    const [claimed] = await this.db<SubmissionRow[]>`WITH next AS (SELECT tenant_id, demand_id, version_id FROM enterprise_demand_submissions
      WHERE tenant_id = ${tenantId} AND corp_id = ${corpId} AND state IN ('DISPATCHING', 'UNCONFIRMED') AND next_check_at <= now()
      ORDER BY next_check_at, version_id LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE enterprise_demand_submissions s SET state = 'UNCONFIRMED', next_check_at = now() + interval '15 minutes',
        error_code = 'DINGTALK_SUBMISSION_UNCONFIRMED'
      FROM next WHERE (s.tenant_id, s.demand_id, s.version_id) = (next.tenant_id, next.demand_id, next.version_id) RETURNING s.*`
    return claimed
  }

  async dispatchFailed(attempt: SubmissionRow, state: 'DECLINED' | 'UNCONFIRMED', errorCode: string, expectedState: SubmissionState = 'DISPATCHING') {
    await this.db.begin(async sql => {
      const demand = await lockDemand(sql, attempt.tenant_id, attempt.demand_id)
      const [changed] = await sql<{ version_id: string }[]>`UPDATE enterprise_demand_submissions SET state = ${state}, error_code = ${errorCode},
        next_check_at = CASE WHEN state = 'DISPATCHING' THEN now() + interval '30 seconds' ELSE next_check_at END
        WHERE tenant_id = ${attempt.tenant_id} AND demand_id = ${attempt.demand_id} AND version_id = ${attempt.version_id}
          AND state = ${expectedState} RETURNING version_id`
      if (!changed || demand.active_version_id !== attempt.version_id || demand.state === 'SUBMIT_FAILED') return
      const [updated] = await sql<DemandRow[]>`UPDATE enterprise_demands SET state = 'SUBMIT_FAILED', revision = revision + 1, updated_at = now()
        WHERE tenant_id = ${attempt.tenant_id} AND id = ${attempt.demand_id} RETURNING *`
      await emit(sql, updated!, null, 'demand.approval.unavailable')
    })
  }

  async knownInstance(tenantId: string, instanceId: string) {
    const [row] = await this.db<InstanceRow[]>`SELECT * FROM enterprise_dingtalk_demand_instances
      WHERE tenant_id = ${tenantId} AND instance_id = ${instanceId}`
    return row
  }

  async activeInstance(tenantId: string, demandId: string, versionId: string) {
    const [row] = await this.db<InstanceRow[]>`SELECT * FROM enterprise_dingtalk_demand_instances
      WHERE tenant_id = ${tenantId} AND demand_id = ${demandId} AND version_id = ${versionId}`
    return row
  }

  private async decision(tenantId: string, instanceId: string) {
    const [row] = await this.db<ApprovalRow[]>`SELECT * FROM enterprise_demand_approvals WHERE tenant_id = ${tenantId} AND instance_id = ${instanceId}`
    return row
  }

  async link(attempt: SubmissionRow, instanceId: string) {
    return this.db.begin(async sql => {
      await lockInstance(sql, attempt.tenant_id, instanceId)
      const demand = await lockDemand(sql, attempt.tenant_id, attempt.demand_id)
      const [already] = await sql<InstanceRow[]>`SELECT * FROM enterprise_dingtalk_demand_instances
        WHERE tenant_id = ${attempt.tenant_id} AND instance_id = ${instanceId}`
      if (already) return already.demand_id === attempt.demand_id && already.version_id === attempt.version_id ? already : undefined
      if (demand.active_version_id !== attempt.version_id) return undefined
      const [changed] = await sql<{ version_id: string }[]>`UPDATE enterprise_demand_submissions SET state = 'LINKED', error_code = NULL
        WHERE tenant_id = ${attempt.tenant_id} AND demand_id = ${attempt.demand_id} AND version_id = ${attempt.version_id}
          AND state IN ('DISPATCHING', 'UNCONFIRMED') RETURNING version_id`
      if (!changed) return undefined
      const [instance] = await sql<InstanceRow[]>`INSERT INTO enterprise_dingtalk_demand_instances (tenant_id, instance_id, corp_id,
        process_code, demand_id, version_id, originator_user_id)
        VALUES (${attempt.tenant_id}, ${instanceId}, ${attempt.corp_id}, ${attempt.process_code}, ${attempt.demand_id},
          ${attempt.version_id}, ${attempt.originator_user_id}) RETURNING *`
      const [updated] = await sql<DemandRow[]>`UPDATE enterprise_demands SET state = 'PENDING', revision = revision + 1, updated_at = now()
        WHERE tenant_id = ${attempt.tenant_id} AND id = ${attempt.demand_id} RETURNING *`
      await emit(sql, updated!, null, 'demand.approval.linked')
      return instance
    })
  }

  matches(attempt: SubmissionRow, processCode: string, instance: DingTalkInstance) {
    if (attempt.process_code !== processCode || attempt.originator_user_id !== instance.originatorUserId ||
        (instance.processCode && instance.processCode !== processCode)) return false
    const pinned = attempt.request.formComponentValues.find(item => item.name === attempt.version_ref_field.name)
    if (!pinned || formText(instance.form, attempt.version_ref_field) !== pinned.value) return false
    return attempt.request.formComponentValues.every(item => item === pinned || formText(instance.form, { name: item.name }) === item.value)
  }

  async claimPoll(tenantId: string, corpId: string) {
    const [row] = await this.db<InstanceRow[]>`WITH next AS (SELECT tenant_id, instance_id FROM enterprise_dingtalk_demand_instances
      WHERE tenant_id = ${tenantId} AND corp_id = ${corpId} AND state IN ('UNKNOWN', 'RUNNING') AND next_check_at <= now()
      ORDER BY next_check_at, instance_id LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE enterprise_dingtalk_demand_instances i SET next_check_at = now() + interval '10 minutes' FROM next
      WHERE (i.tenant_id, i.instance_id) = (next.tenant_id, next.instance_id) RETURNING i.*`
    return row
  }

  async scheduleReconcile(demand: DemandRow) {
    if (!demand.active_version_id) return
    await this.db`UPDATE enterprise_dingtalk_demand_instances SET next_check_at = least(next_check_at, now())
      WHERE tenant_id = ${demand.tenant_id} AND demand_id = ${demand.id} AND version_id = ${demand.active_version_id}
        AND state IN ('UNKNOWN', 'RUNNING') AND next_check_at <= now() + interval '9 minutes 45 seconds'`
    await this.db`UPDATE enterprise_demand_submissions SET next_check_at = least(next_check_at, now())
      WHERE tenant_id = ${demand.tenant_id} AND demand_id = ${demand.id} AND version_id = ${demand.active_version_id}
        AND state = 'UNCONFIRMED' AND next_check_at <= now() + interval '14 minutes 30 seconds'`
  }

  private async setDecisionState(sql: TransactionSQL, demand: DemandRow, instance: InstanceRow, action: string) {
    const state = demand.import_confirmed ? demandStatus(instance.state) : 'IMPORT_REVIEW'
    const [updated] = await sql<DemandRow[]>`UPDATE enterprise_demands SET state = ${state},
      approved_version_id = CASE WHEN ${state} = 'BACKLOG' THEN ${instance.version_id}::uuid ELSE approved_version_id END,
      revision = revision + 1, updated_at = now() WHERE tenant_id = ${demand.tenant_id} AND id = ${demand.id} RETURNING *`
    await emit(sql, updated!, null, action)
  }

  async recordVerified(link: InstanceRow, actual: DingTalkInstance) {
    if (actual.instanceId !== link.instance_id || actual.originatorUserId !== link.originator_user_id ||
        (actual.processCode && actual.processCode !== link.process_code)) return false
    return this.db.begin(async sql => {
      const demand = await lockDemand(sql, link.tenant_id, link.demand_id)
      const [current] = await sql<InstanceRow[]>`SELECT * FROM enterprise_dingtalk_demand_instances
        WHERE tenant_id = ${link.tenant_id} AND instance_id = ${link.instance_id} FOR UPDATE`
      if (!current || terminal(current.state)) return true
      const state = actual.state === 'UNKNOWN' ? current.state : actual.state
      const version = terminal(state) ? await this.findVersion(sql, demand, link.version_id) : undefined
      if (state === 'AGREE' && version && !await this.matchesApproval(sql, link, version, actual)) {
        await this.flagSnapshotMismatch(sql, demand, link, version.snapshot.origin === 'DINGTALK')
        return false
      }
      await sql`UPDATE enterprise_dingtalk_demand_instances SET state = ${state}, verified_at = now(),
        approver_user_ids = ${sql.array(actual.approverUserIds, 'TEXT')}, next_check_at = now() + interval '10 minutes'
        WHERE tenant_id = ${link.tenant_id} AND instance_id = ${link.instance_id}`
      if (!terminal(state)) return true
      if (!version) throw new Error('Frozen demand version disappeared')
      await sql`INSERT INTO enterprise_demand_approvals (tenant_id, instance_id, demand_id, version_id, decision, decided_at, snapshot_hash)
        VALUES (${link.tenant_id}, ${link.instance_id}, ${link.demand_id}, ${link.version_id}, ${state},
          ${actual.finishedAt ? new Date(actual.finishedAt) : null}, ${version.snapshot_hash})`
      await sql`UPDATE enterprise_demand_submissions SET state = 'CLOSED', error_code = NULL
        WHERE tenant_id = ${link.tenant_id} AND demand_id = ${link.demand_id} AND version_id = ${link.version_id} AND state = 'LINKED'`
      if (demand.active_version_id === link.version_id) await this.setDecisionState(sql, demand, { ...link, state }, 'demand.approval.changed')
      return true
    })
  }

  private async matchesApproval(sql: TransactionSQL, link: InstanceRow, version: VersionRow, actual: DingTalkInstance) {
    if (version.snapshot.origin === 'DINGTALK') {
      return (version.snapshot.oaFieldDigests ?? []).every(({ field, digest }) => evidenceHash(formText(actual.form, field) ?? null) === digest)
    }
    const [attempt] = await sql<SubmissionRow[]>`SELECT * FROM enterprise_demand_submissions WHERE tenant_id = ${link.tenant_id}
      AND demand_id = ${link.demand_id} AND version_id = ${link.version_id}`
    return !!attempt && this.matches(attempt, link.process_code, actual)
  }

  private async flagSnapshotMismatch(sql: TransactionSQL, demand: DemandRow, link: InstanceRow, external: boolean) {
    await sql`UPDATE enterprise_dingtalk_demand_instances SET verified_at = NULL, next_check_at = now() + interval '10 minutes'
      WHERE tenant_id = ${link.tenant_id} AND instance_id = ${link.instance_id}`
    const [warned] = await sql<{ version_id: string }[]>`UPDATE enterprise_demand_submissions SET error_code = 'DINGTALK_SNAPSHOT_MISMATCH'
      WHERE tenant_id = ${link.tenant_id} AND demand_id = ${link.demand_id} AND version_id = ${link.version_id} AND state = 'LINKED'
        AND error_code IS DISTINCT FROM 'DINGTALK_SNAPSHOT_MISMATCH' RETURNING version_id`
    if (demand.active_version_id !== link.version_id || (!warned && (!external || demand.state === 'IMPORT_REVIEW'))) return
    const [updated] = await sql<DemandRow[]>`UPDATE enterprise_demands
      SET state = CASE WHEN ${Boolean(warned)} THEN state ELSE 'IMPORT_REVIEW' END,
        import_confirmed = CASE WHEN ${Boolean(warned)} THEN import_confirmed ELSE false END,
        revision = revision + 1, updated_at = now() WHERE tenant_id = ${demand.tenant_id} AND id = ${demand.id} RETURNING *`
    await emit(sql, updated!, null, 'demand.approval.snapshot_mismatch')
  }

  async enqueue(tenantId: string, event: Omit<DingTalkEvent, 'type'> & { type: DingTalkEvent['type'] | 'scan' }) {
    await this.db`INSERT INTO enterprise_dingtalk_demand_inbox (tenant_id, event_id, corp_id, process_code, instance_id, event_type)
      VALUES (${tenantId}, ${event.eventId}, ${event.corpId}, ${event.processCode}, ${event.instanceId}, ${event.type}) ON CONFLICT DO NOTHING`
  }

  async claimInbox(tenantId: string, corpId: string) {
    const [row] = await this.db<InboxRow[]>`WITH next AS (SELECT tenant_id, event_id FROM enterprise_dingtalk_demand_inbox
      WHERE tenant_id = ${tenantId} AND corp_id = ${corpId} AND processed_at IS NULL AND next_check_at <= now()
      ORDER BY next_check_at, event_id LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE enterprise_dingtalk_demand_inbox i SET attempts = attempts + 1,
        next_check_at = now() + (CASE WHEN attempts < 3 THEN interval '1 minute' WHEN attempts < 8 THEN interval '10 minutes' ELSE interval '1 hour' END)
      FROM next WHERE (i.tenant_id, i.event_id) = (next.tenant_id, next.event_id) RETURNING i.*`
    return row
  }

  async finishInbox(tenantId: string, eventId: string) {
    await this.db`UPDATE enterprise_dingtalk_demand_inbox SET processed_at = now()
      WHERE tenant_id = ${tenantId} AND event_id = ${eventId} AND processed_at IS NULL`
  }

  async importExisting(tenantId: string, corpId: string, processCode: string, instance: DingTalkInstance, draft: DemandDraft, complete: boolean, mapping: FieldMap) {
    return this.db.begin(async sql => {
      await lockInstance(sql, tenantId, instance.instanceId)
      const [prior] = await sql<InstanceRow[]>`SELECT * FROM enterprise_dingtalk_demand_instances
        WHERE tenant_id = ${tenantId} AND instance_id = ${instance.instanceId}`
      if (prior) return prior
      const [allowed] = await sql<{ process_code: string }[]>`SELECT process_code FROM enterprise_dingtalk_demand_templates
        WHERE tenant_id = ${tenantId} AND process_code = ${processCode} AND import_enabled FOR SHARE`
      if (!allowed) return undefined
      const [identity] = await sql<{ user_id: string }[]>`SELECT di.user_id FROM enterprise_dingtalk_demand_identities di JOIN enterprise_users u
        ON (u.tenant_id, u.id) = (di.tenant_id, di.user_id) WHERE di.tenant_id = ${tenantId} AND di.corp_id = ${corpId}
          AND di.staff_id = ${instance.originatorUserId} AND u.active`
      const owner = identity?.user_id ?? null
      const confirmed = complete && owner !== null
      const [demand] = await sql<DemandRow[]>`INSERT INTO enterprise_demands (tenant_id, id, owner_id, draft, state, origin, import_confirmed)
        VALUES (${tenantId}, ${randomUUID()}, ${owner}, ${draft}::jsonb, ${confirmed ? 'PENDING' : 'IMPORT_REVIEW'}, 'DINGTALK', ${confirmed}) RETURNING *`
      const digests = Object.values(mapping).map(field => ({ field, digest: evidenceHash(formText(instance.form, field) ?? null) }))
      const version = await writeVersion(sql, demand!, 'DINGTALK', owner, digests)
      const [bound] = await sql<InstanceRow[]>`INSERT INTO enterprise_dingtalk_demand_instances (tenant_id, instance_id, corp_id,
        process_code, demand_id, version_id, originator_user_id)
        VALUES (${tenantId}, ${instance.instanceId}, ${corpId}, ${processCode}, ${demand!.id}, ${version.id}, ${instance.originatorUserId}) RETURNING *`
      const [updated] = await sql<DemandRow[]>`UPDATE enterprise_demands SET active_version_id = ${version.id}
        WHERE tenant_id = ${tenantId} AND id = ${demand!.id} RETURNING *`
      await emit(sql, updated!, null, 'demand.imported')
      return bound
    })
  }

  async confirmImport(actor: Actor, id: string, expectedRevision: number, ownerId: string | undefined) {
    if (!isLead(actor)) throw leadOnly()
    await this.db.begin(async sql => {
      const row = await lockDemand(sql, actor.tenantId, id)
      if (row.revision !== expectedRevision) throw draftConflict()
      if (row.state !== 'IMPORT_REVIEW' || row.origin !== 'DINGTALK' || !row.active_version_id) {
        throw new ControlError(409, 'DINGTALK_IMPORT_NOT_PENDING', 'This item is not waiting for import confirmation.')
      }
      const [instance] = await sql<InstanceRow[]>`SELECT * FROM enterprise_dingtalk_demand_instances
        WHERE tenant_id = ${actor.tenantId} AND demand_id = ${id} AND version_id = ${row.active_version_id}`
      if (!instance?.verified_at) throw new ControlError(409, 'DINGTALK_IMPORT_UNVERIFIED', 'Reconcile the OA instance before confirming this import.')
      const [owner] = await sql<{ user_id: string }[]>`SELECT di.user_id FROM enterprise_dingtalk_demand_identities di
        JOIN enterprise_users u ON (u.tenant_id, u.id) = (di.tenant_id, di.user_id)
        WHERE di.tenant_id = ${actor.tenantId} AND di.corp_id = ${instance.corp_id} AND di.staff_id = ${instance.originator_user_id} AND u.active`
      if (!owner || (ownerId && ownerId !== owner.user_id)) throw new ControlError(409, 'DINGTALK_IDENTITY_REQUIRED', 'Link the OA originator to an active tenant user first.')
      if (validateDemand(row.draft).missing.length) throw new ControlError(409, 'DINGTALK_IMPORT_DRAFT_INCOMPLETE', 'Complete the local draft fields before confirming this import.')
      const state = demandStatus(instance.state)
      const [updated] = await sql<DemandRow[]>`UPDATE enterprise_demands SET owner_id = ${owner.user_id}, import_confirmed = true, state = ${state},
        approved_version_id = CASE WHEN ${state} = 'BACKLOG' THEN ${instance.version_id}::uuid ELSE approved_version_id END,
        revision = revision + 1, updated_at = now() WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING *`
      await emit(sql, updated!, actor.id, 'demand.import.confirmed')
    })
  }

  async requireManager(actor: Actor, id: string) {
    const row = await this.readable(actor, id)
    if (row.owner_id !== actor.id && !isLead(actor)) throw notFound()
    return row
  }

  async scanTemplate(actor: Actor, processCode: string) {
    if (!isAdmin(actor) && !isLead(actor)) throw leadOnly()
    const config = await this.getTemplate(actor.tenantId, processCode)
    if (!config?.importEnabled) throw new ControlError(403, 'DINGTALK_TEMPLATE_NOT_ALLOWED', 'This OA template is unavailable for imports.')
    return config
  }
}
