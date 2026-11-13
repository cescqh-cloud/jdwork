import { z } from 'zod/v4'

const uuid = z.uuid()
const revision = z.number().int().min(1).max(2_147_483_647)
const date = z.iso.datetime()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const localRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u)
const selectionReceipt = z.string().regex(/^[A-Za-z0-9_-]{86}$/u)
const gitRevision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)
const bounded = (length: number) => z.string().max(length)
const note = bounded(1000).trim().min(1)
export const deliveryStates = ['ASSIGNED', 'DEVELOPING', 'TESTING', 'ACCEPTANCE', 'DELIVERED'] as const
export const deliveryOutcomes = ['passed', 'failed', 'skipped', 'blocked', 'not_run'] as const
const state = z.enum(deliveryStates)
const outcome = z.enum(deliveryOutcomes)
const verdict = z.enum(['PASS', 'WARN', 'BLOCK'])
const decision = z.enum(['ACCEPT', 'REWORK'])
const testEvidence = z.object({ label: bounded(240).min(1), sha256 })
const permissions = z.object({ bind: z.boolean(), submitChecks: z.boolean(), start: z.boolean(), startTesting: z.boolean(),
  review: z.boolean(), recordTest: z.boolean(), accept: z.boolean(), returnForRework: z.boolean() })

const task = z.object({
  id: uuid, demandId: uuid, demandNo: bounded(120), title: bounded(512), approvedVersionId: uuid, snapshotHash: sha256,
  projectId: uuid, projectName: bounded(120), assigneeId: uuid, assigneeName: bounded(120),
  state, revision, canAdvance: z.boolean(), permissions,
  materials: z.object({ state: z.enum(['unchecked', 'current', 'changed', 'unverified']), expiresAt: date.nullable() }).optional(),
  automaticRecheck: z.boolean().optional(),
  binding: z.object({ id: uuid, deviceId: uuid, worktreeId: localRef, sessionId: localRef, gitRevision, createdAt: date }).nullable(),
  latestRunId: uuid.nullable(), acceptedRunId: uuid.nullable(), latestTestOutcome: outcome.nullable(), deliveryRef: bounded(512).nullable(),
  history: z.array(z.object({ revision, actorId: uuid, state, action: bounded(120), occurredAt: date,
    details: z.object({ note: bounded(1600).optional(), outcome: outcome.optional(), verdict: verdict.optional(),
      runId: uuid.optional(), evidence: z.array(testEvidence).max(8).optional() }) })).max(100),
  createdAt: date, updatedAt: date,
})

const report = z.object({
  id: uuid, bindingId: uuid, approvedVersionId: uuid, snapshotHash: sha256, submittedBy: uuid, taskRevision: revision,
  inputHash: sha256, ruleVersion: bounded(80), verdict, stale: z.boolean(), createdAt: date,
  selectionReceipt: selectionReceipt.optional(),
  canReuseMaterials: z.boolean().optional(),
  files: z.array(z.object({ path: bounded(180), sha256 })).max(8),
  findings: z.array(z.object({ ruleId: bounded(120), status: verdict, severity: z.enum(['info', 'warning', 'critical']),
    message: bounded(1200), guidance: bounded(1200), ruleVersion: bounded(80), inputHash: sha256, detectedAt: date,
    evidence: z.array(z.object({ path: bounded(180), line: z.number().int().positive().optional(), sha256: sha256.optional() })).max(12) })).max(40),
  review: z.object({ reviewerId: uuid, decision, note: bounded(1600), acknowledgedWarnings: z.boolean(), reviewedAt: date }).nullable().optional(),
})

const localSession = z.object({
  task, sessionId: localRef, workDir: bounded(4096).min(1), draftText: bounded(10_000).optional(),
})
const transition = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({ action: z.literal('start_testing') }),
  z.strictObject({ action: z.literal('record_test'), outcome, evidence: z.array(testEvidence).max(8).optional(), note }),
  z.strictObject({ action: z.literal('return_for_rework'), note }),
  z.strictObject({ action: z.literal('accept'), deliveryRef: bounded(240).trim().min(1), note }),
])

export const enterpriseDeliveryRequests = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), demandId: uuid.optional() }),
  z.strictObject({ action: z.literal('get'), id: uuid }),
  z.strictObject({ action: z.literal('getCheck'), id: uuid, runId: uuid }),
  z.strictObject({ action: z.literal('bind'), id: uuid, revision }),
  z.strictObject({ action: z.literal('open'), id: uuid, revision }),
  z.strictObject({ action: z.literal('check'), id: uuid, revision, idempotencyKey: uuid.optional() }),
  z.strictObject({ action: z.literal('verify'), id: uuid, revision }),
  z.strictObject({ action: z.literal('recheck'), id: uuid, revision }),
  z.strictObject({ action: z.literal('watch'), id: uuid, revision, enabled: z.boolean() }),
  z.strictObject({ action: z.literal('fix'), id: uuid, revision, runId: uuid, ruleId: bounded(120).regex(/^[a-z][a-z0-9.-]*$/u).optional() }),
  z.strictObject({ action: z.literal('review'), id: uuid, revision, runId: uuid, decision, acknowledgeWarnings: z.boolean().optional(), note }),
  z.strictObject({ action: z.literal('transition'), id: uuid, revision, transition }),
])

const materialResult = z.object({ task, run: report.nullable() })
export const enterpriseDeliveryResponses = {
  list: z.object({ items: z.array(task).max(100) }), get: task, getCheck: report, review: task, transition: task,
  bind: localSession, open: localSession, fix: localSession, check: z.object({ task, run: report }),
  verify: materialResult, recheck: materialResult, watch: materialResult,
} as const

export type EnterpriseDeliveryRequest = z.infer<typeof enterpriseDeliveryRequests>
type Action = EnterpriseDeliveryRequest['action']
export type EnterpriseDeliveryTask = z.infer<typeof task>
export type EnterpriseDeliveryRun = z.infer<typeof report>
export type EnterpriseDeliverySession = z.infer<typeof localSession>
export type EnterpriseDeliveryTransition = z.infer<typeof transition>
export type EnterpriseDeliveryIssue = 'unbound' | 'forbidden' | 'invalid' | 'conflict' | 'notFound' | 'unavailable'
  | 'cancelled' | 'repository' | 'missingLocalWorkspace' | 'invalidMaterial' | 'worktreeChanged' | 'session'
  | 'materialsUnverified' | 'materialsChanged' | 'materialConflict'
export type EnterpriseDeliveryResult<A extends Action = Action> =
  | { ok: true; data: z.infer<typeof enterpriseDeliveryResponses[A]> }
  | { ok: false; issue: EnterpriseDeliveryIssue }
export type EnterpriseDeliveryHost = <R extends EnterpriseDeliveryRequest>(input: R) => Promise<EnterpriseDeliveryResult<R['action']>>
