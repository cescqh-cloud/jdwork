import { z } from 'zod/v4'

const uuid = z.uuid()
const revision = z.number().int().min(1).max(2_147_483_647)
const oaId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/)
const processCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,119}$/)
const text = (length: number) => z.string().trim().max(length)
const date = z.iso.datetime()

export const demandDraftFields = [
  { key: 'title', limit: 160, required: true },
  { key: 'systemKey', limit: 80, required: true },
  { key: 'category', limit: 80, required: true },
  { key: 'businessContext', limit: 5000, required: true, multiline: true },
  { key: 'expectedValue', limit: 2000, multiline: true },
  { key: 'acceptanceCriteria', limit: 2000, multiline: true },
  { key: 'businessOwner', limit: 120 },
  { key: 'priority', limit: 80 },
] as const

export const enterpriseDemandDraftSchema = z.strictObject({
  title: text(160), systemKey: text(80), category: text(80), businessContext: text(5000),
  expectedValue: text(2000), acceptanceCriteria: text(2000), businessOwner: text(120), priority: text(80),
  attachmentRefs: z.array(z.strictObject({ id: oaId, name: text(160).min(1) })).max(12),
})
const draft = enterpriseDemandDraftSchema
export type EnterpriseDemandDraft = z.infer<typeof draft>
export const blankDemandDraft: EnterpriseDemandDraft = {
  title: '', systemKey: '', category: '', businessContext: '',
  expectedValue: '', acceptanceCriteria: '', businessOwner: '', priority: '', attachmentRefs: [],
}

const precheck = z.object({ summary: text(2400), questions: z.array(text(500)).max(12), risks: z.array(text(500)).max(12), draftRevision: revision, checkedAt: date })
const demandState = z.enum(['DRAFT', 'AI_PRECHECK', 'SUBMITTING', 'SUBMIT_FAILED', 'PENDING', 'IMPORT_REVIEW', 'BACKLOG', 'REJECTED', 'CANCELLED', 'CHANGE_REQUEST'])
const submissionState = z.enum(['QUEUED', 'DISPATCHING', 'UNCONFIRMED', 'LINKED', 'CLOSED', 'DECLINED'])
const approvalState = z.enum(['RUNNING', 'AGREE', 'REFUSE', 'TERMINATED', 'UNKNOWN'])
const summary = z.object({
  id: uuid, demandNo: text(64), ownerId: uuid.nullable(), state: demandState,
  origin: z.enum(['WORKBENCH', 'DINGTALK']), revision, draftRevision: revision, updatedAt: date,
})
const version = z.object({
  id: uuid, versionNo: revision, createdAt: date,
  snapshot: z.object({ draftRevision: revision, draft: draft.strip(), precheck: precheck.nullable() }),
})
export const enterpriseDemandDetailSchema = summary.extend({
  createdAt: date, title: text(160),
  draft: draft.strip().nullable(), validation: z.object({ missing: z.array(text(40)), warnings: z.array(text(40)) }).nullable(),
  precheck: precheck.nullable(), activeVersion: version.nullable(), approvedVersion: version.nullable(),
  unsubmittedChanges: z.boolean(),
  draftMutation: z.object({ idempotencyKey: uuid, draftRevision: revision }).optional(),
  submission: z.object({ state: submissionState, errorCode: text(100).nullable(), versionId: uuid }).nullable(),
  approval: z.object({
    instanceId: oaId, processCode, state: approvalState, verifiedAt: date.nullable(),
    decision: z.object({ result: approvalState, decidedAt: date.nullable(), verifiedAt: date }).nullable(),
  }).nullable(),
})
const detail = enterpriseDemandDetailSchema
const status = z.object({ oaConfigured: z.boolean(), callbackConfigured: z.boolean(), aiPrecheckConfigured: z.boolean() })
const templates = z.object({ templates: z.array(z.object({
  processCode, label: text(120),
  approverOptions: z.array(z.object({ actionerKey: oaId, label: text(120), allowedUserIds: z.array(oaId).max(100) })).max(10),
})).max(100) })
const list = z.object({ demands: z.array(summary.extend({ title: text(160), approvedVersionId: uuid.nullable() })).max(100) })

export const enterpriseDemandRequests = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('status') }),
  z.strictObject({ action: z.literal('templates') }),
  z.strictObject({ action: z.literal('list'), offset: z.number().int().min(0).max(50_000).optional() }),
  z.strictObject({ action: z.literal('get'), id: uuid }),
  z.strictObject({ action: z.literal('create'), draft, idempotencyKey: uuid.optional() }),
  z.strictObject({ action: z.literal('edit'), id: uuid, expectedDraftRevision: revision, draft, idempotencyKey: uuid.optional() }),
  z.strictObject({ action: z.literal('precheck'), id: uuid, expectedDraftRevision: revision }),
  z.strictObject({
    action: z.literal('submit'), id: uuid, expectedDraftRevision: revision, processCode, idempotencyKey: uuid,
    approverSelections: z.array(z.strictObject({ actionerKey: oaId, actionerUserIds: z.array(oaId).min(1).max(20) })).max(10),
  }),
  z.strictObject({ action: z.literal('reconcile'), id: uuid }),
])
export type EnterpriseDemandRequest = z.infer<typeof enterpriseDemandRequests>
type Action = EnterpriseDemandRequest['action']
export const enterpriseDemandResponses = {
  status, templates, list, get: detail, create: detail, edit: detail, precheck: detail,
  submit: z.object({ versionId: uuid, reused: z.boolean(), demand: detail }), reconcile: detail,
} as const

export type EnterpriseDemandDetail = z.infer<typeof detail>
export type EnterpriseDemandStatus = z.infer<typeof status>
export type EnterpriseDemandTemplate = z.infer<typeof templates>['templates'][number]
export type EnterpriseDemandSummary = z.infer<typeof list>['demands'][number]
export type EnterpriseDemandIssue = 'unbound' | 'forbidden' | 'invalid' | 'conflict' | 'unavailable' | 'incomplete'
  | 'precheck' | 'dingtalk' | 'identity' | 'approvers' | 'inProgress' | 'notFound' | 'sensitive' | 'localStorage'
export type EnterpriseDemandResult<A extends Action = Action> =
  | { ok: true; data: z.infer<typeof enterpriseDemandResponses[A]> }
  | { ok: false; issue: EnterpriseDemandIssue }
export type EnterpriseDemandHost = <R extends EnterpriseDemandRequest>(input: R) => Promise<EnterpriseDemandResult<R['action']>>
