import { z } from 'zod/v4'
import { enterpriseDemandDraftSchema, type EnterpriseDemandDetail, type EnterpriseDemandDraft, type EnterpriseDemandIssue } from './enterpriseDemand'

const uuid = z.uuid().transform(value => value.toLowerCase())
const revision = z.number().int().min(1).max(2_147_483_647)
const identity = { deviceId: uuid, id: uuid }
export const enterpriseDemandCloudDraftSchema = z.strictObject({
  id: uuid, draftRevision: revision, demandNo: z.string().min(1).max(64),
})
export type EnterpriseDemandCloudDraft = z.infer<typeof enterpriseDemandCloudDraftSchema>
export const enterpriseDemandLocalRecordSchema = z.strictObject({
  id: uuid, revision, updatedAt: z.iso.datetime(), cloud: enterpriseDemandCloudDraftSchema.nullable(),
  draft: enterpriseDemandDraftSchema,
})
export type EnterpriseDemandLocalRecord = z.infer<typeof enterpriseDemandLocalRecordSchema>
export type EnterpriseDemandLocalSummary = Omit<EnterpriseDemandLocalRecord, 'draft'> & { title: string }
export type EnterpriseDemandLatestDraft = { cloud: EnterpriseDemandCloudDraft; draft: EnterpriseDemandDraft }
export type EnterpriseDemandDraftConflict = {
  local: EnterpriseDemandLocalRecord
  baseDraft: EnterpriseDemandDraft | null
  latest: EnterpriseDemandLatestDraft
}

export const enterpriseDemandLocalRequests = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list') }),
  z.strictObject({ action: z.literal('get'), ...identity }),
  z.strictObject({ action: z.literal('save'), ...identity, expectedLocalRevision: revision.nullable(),
    cloud: enterpriseDemandCloudDraftSchema.nullable(), draft: enterpriseDemandDraftSchema, baseDraft: enterpriseDemandDraftSchema.optional(),
  }).refine(value => value.baseDraft === undefined || (value.expectedLocalRevision === null && value.cloud !== null)),
  z.strictObject({ action: z.literal('export'), ...identity, expectedLocalRevision: revision }),
  z.strictObject({ action: z.literal('sync'), ...identity, expectedLocalRevision: revision }),
  z.strictObject({ action: z.literal('merge'), ...identity, expectedLocalRevision: revision,
    expectedCloudRevision: revision, draft: enterpriseDemandDraftSchema }),
])
export type EnterpriseDemandLocalRequest = z.infer<typeof enterpriseDemandLocalRequests>
type LocalAction = EnterpriseDemandLocalRequest['action']
type LocalResponses = {
  list: { deviceId: string; drafts: EnterpriseDemandLocalSummary[]; unreadable: number }
  get: EnterpriseDemandLocalRecord
  save: EnterpriseDemandLocalRecord
  merge: EnterpriseDemandLocalRecord
  export: { saved: boolean }
  sync: { demand: EnterpriseDemandDetail; draft: EnterpriseDemandLocalRecord | null }
}
export type EnterpriseDemandLocalResult<A extends LocalAction = LocalAction> =
  | { ok: true; data: LocalResponses[A] } | { ok: false; issue: EnterpriseDemandIssue; conflict?: EnterpriseDemandDraftConflict }
export type EnterpriseDemandLocalHost = <R extends EnterpriseDemandLocalRequest>(input: R) => Promise<EnterpriseDemandLocalResult<R['action']>>
