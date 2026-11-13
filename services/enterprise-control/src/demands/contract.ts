import { createHash } from 'node:crypto'
import { z } from 'zod'

export const processCode = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,119}$/u)
export const dingTalkId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/u)
export const revision = z.number().int().min(1).max(2_147_483_647)
const text = (max: number) => z.string().trim().max(max)
const attachment = z.strictObject({ id: dingTalkId, name: text(160).min(1) })

export const draftInput = z.strictObject({
  title: text(160).default(''),
  systemKey: text(80).default(''),
  category: text(80).default(''),
  businessContext: text(5000).default(''),
  expectedValue: text(2000).default(''),
  acceptanceCriteria: text(2000).default(''),
  businessOwner: text(120).default(''),
  priority: text(80).default(''),
  attachmentRefs: z.array(attachment).max(12).default([]),
})
export type DemandDraft = z.infer<typeof draftInput>

export const newDemand = z.strictObject({ draft: draftInput, idempotencyKey: z.uuid().optional() })
export const editDemand = z.strictObject({ expectedDraftRevision: revision, draft: draftInput, idempotencyKey: z.uuid().optional() })
export const precheckInput = z.strictObject({ expectedDraftRevision: revision, modelId: text(120).min(1).optional() })
const actioner = z.strictObject({ actionerKey: dingTalkId, actionerUserIds: z.array(dingTalkId).min(1).max(20) })
export const submitInput = z.strictObject({
  expectedDraftRevision: revision,
  processCode,
  idempotencyKey: z.uuid(),
  approverSelections: z.array(actioner).max(10).default([]),
})
export const confirmImportInput = z.strictObject({ expectedRevision: revision, ownerId: z.uuid().optional() })

const fieldRef = z.strictObject({ name: text(120).min(1), id: dingTalkId.optional() })
const fieldNames = [
  'title', 'systemKey', 'category', 'businessContext', 'expectedValue', 'acceptanceCriteria', 'businessOwner',
  'priority', 'attachmentRefs', 'demandNo', 'precheckSummary', 'versionRef',
] as const
export const fieldMap = z.partialRecord(z.enum(fieldNames), fieldRef)
export type FieldName = typeof fieldNames[number]
export type FieldMap = z.infer<typeof fieldMap>
export type FieldRef = z.infer<typeof fieldRef>

const requiredFields = ['title', 'systemKey', 'category', 'businessContext'] as const
export const templateInput = z.strictObject({
  processCode,
  label: text(120).min(1),
  submitEnabled: z.boolean(),
  importEnabled: z.boolean(),
  fieldMap,
  approverOptions: z.array(z.strictObject({
    actionerKey: dingTalkId,
    label: text(120).min(1),
    allowedUserIds: z.array(dingTalkId).min(1).max(100),
  })).max(10).default([]),
  expectedRevision: revision.nullable(),
}).superRefine((value, context) => {
  if (value.submitEnabled) {
    for (const field of [...requiredFields, 'versionRef'] as const) {
      if (!value.fieldMap[field]) context.addIssue({ code: 'custom', path: ['fieldMap', field], message: 'This mapping is required for workbench submissions.' })
    }
  }
  const names = Object.values(value.fieldMap).map(field => field.name)
  const ids = Object.values(value.fieldMap).flatMap(field => field.id ? [field.id] : [])
  if (new Set(names).size !== names.length || new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['fieldMap'], message: 'Map each OA field only once.' })
  }
  if (new Set(value.approverOptions.map(option => option.actionerKey)).size !== value.approverOptions.length) {
    context.addIssue({ code: 'custom', path: ['approverOptions'], message: 'Duplicate approval node.' })
  }
})

export const identityInput = z.strictObject({
  userId: z.uuid(),
  staffId: dingTalkId,
  departmentId: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
})
export const precheckOutput = z.strictObject({
  summary: text(2400).min(1),
  questions: z.array(text(500).min(1)).max(12),
  risks: z.array(text(500).min(1)).max(12),
})
export type PrecheckOutput = z.infer<typeof precheckOutput>
const precheckResult = precheckOutput.extend({ draftRevision: revision, checkedAt: z.iso.datetime() })
export type Precheck = z.infer<typeof precheckResult>
export type TemplateInput = z.infer<typeof templateInput>
export type IdentityInput = z.infer<typeof identityInput>
export type SubmitInput = z.infer<typeof submitInput>

const demandState = z.enum(['DRAFT', 'AI_PRECHECK', 'SUBMITTING', 'SUBMIT_FAILED', 'PENDING', 'IMPORT_REVIEW', 'BACKLOG', 'REJECTED', 'CANCELLED', 'CHANGE_REQUEST'])
const demandOrigin = z.enum(['WORKBENCH', 'DINGTALK'])
const approvalDecision = z.enum(['AGREE', 'REFUSE', 'TERMINATED'])
const verifiedState = z.enum(['AGREE', 'REFUSE', 'TERMINATED', 'RUNNING', 'UNKNOWN'])
const submissionState = z.enum(['QUEUED', 'DISPATCHING', 'UNCONFIRMED', 'LINKED', 'CLOSED', 'DECLINED'])
export type DemandState = z.infer<typeof demandState>
export type DemandOrigin = z.infer<typeof demandOrigin>
export type Decision = z.infer<typeof approvalDecision>
export type VerifiedState = z.infer<typeof verifiedState>
export type SubmissionState = z.infer<typeof submissionState>

const hash = z.string().regex(/^[0-9a-f]{64}$/u)
const snapshot = z.object({ format: z.literal(1), demandId: z.uuid(), demandNo: z.string(), versionId: z.uuid(), versionNo: revision,
  draftRevision: revision, origin: demandOrigin, draft: draftInput, precheck: precheckResult.nullable(),
  oaFieldDigests: z.array(z.object({ field: fieldRef, digest: hash })).max(fieldNames.length).optional() })
export type DemandSnapshot = z.infer<typeof snapshot>
export const demandEvidence = z.object({ id: z.uuid(), versionNo: revision, submittedBy: z.uuid().nullable(), snapshot,
  snapshotHash: hash, bodyHash: hash, createdAt: z.iso.datetime() })
export const demandSummary = z.object({ id: z.uuid(), demandNo: z.string(), title: z.string(), ownerId: z.uuid().nullable(),
  state: demandState, origin: demandOrigin, revision, draftRevision: revision, approvedVersionId: z.uuid().nullable(), updatedAt: z.iso.datetime() })
export const demandDetail = demandSummary.omit({ approvedVersionId: true }).extend({ createdAt: z.iso.datetime(), draft: draftInput.nullable(),
  draftMutation: z.object({ idempotencyKey: z.uuid(), draftRevision: revision }).optional(),
  validation: z.object({ missing: z.array(z.enum(requiredFields)), warnings: z.array(z.enum(['expectedValue', 'acceptanceCriteria'])) }).nullable(),
  precheck: precheckResult.nullable(), importConfirmed: z.boolean(), activeVersion: demandEvidence.nullable(),
  approvedVersion: demandEvidence.nullable(), unsubmittedChanges: z.boolean(),
  submission: z.object({ state: submissionState, errorCode: z.string().nullable(), versionId: z.uuid() }).nullable(),
  approval: z.object({ instanceId: z.string(), processCode, state: verifiedState, verifiedAt: z.iso.datetime().nullable(),
    decision: z.object({ result: approvalDecision, decidedAt: z.iso.datetime().nullable(), verifiedAt: z.iso.datetime(), snapshotHash: hash }).nullable() }).nullable(),
})
export const demandSubmission = z.object({ versionId: z.uuid(), reused: z.boolean(), demand: demandDetail })

export function validateDemand(draft: DemandDraft) {
  return {
    missing: requiredFields.filter(key => !draft[key]),
    warnings: (['expectedValue', 'acceptanceCriteria'] as const).filter(key => !draft[key]),
  }
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, ordered(item)]))
  }
  return value
}

export function evidenceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(ordered(value)), 'utf8').digest('hex')
}

export function bodyHash(draft: DemandDraft): string {
  return createHash('sha256').update(draft.businessContext, 'utf8').digest('hex')
}

export function snapshotReference(versionId: string, snapshotHash: string): string {
  return `wb1.${versionId}.${snapshotHash}`
}

export function redactDemandText(value: string) {
  return value
    .replace(/\b(cookie\s*[:=]\s*)[^\r\n]+/giu, '$1[已脱敏]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.~:-]{8,}/giu, '[已脱敏]')
    .replace(/((?:\b(?:password|passwd|secret|token|access[_ -]?token|api[_ -]?key)\b|密码|密钥|口令)\s*(?:[:=：]|为)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,，;；]+)/giu, '$1[已脱敏]')
    .replace(/\b((?:postgres(?:ql)?|mysql|mssql|redis|rediss|https?):\/\/)[^@\s/?#]+:[^@\s/?#]+@/giu, '$1[已脱敏]@')
}
