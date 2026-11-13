import { z } from 'zod/v4'
import { enterpriseMemoryBodySchema, enterpriseMemorySourceRefSchema, type EnterpriseMemory, type EnterpriseMemoryIssue } from './enterpriseMemory'

const uuid = z.uuid().transform(value => value.toLowerCase())
const revision = z.number().int().min(1).max(2_147_483_647)
const identity = { deviceId: uuid, id: uuid }
const body = enterpriseMemoryBodySchema
const sourceRef = enterpriseMemorySourceRefSchema.nullable()
export const enterpriseMemoryLocalCloudSchema = z.strictObject({ id: uuid, revision })
export type EnterpriseMemoryLocalCloud = z.infer<typeof enterpriseMemoryLocalCloudSchema>
export const enterpriseMemoryLocalRecordSchema = z.strictObject({
  id: uuid, revision, updatedAt: z.iso.datetime(), body, sourceRef, cloud: enterpriseMemoryLocalCloudSchema.nullable(),
})
export type EnterpriseMemoryLocalRecord = z.infer<typeof enterpriseMemoryLocalRecordSchema>
export type EnterpriseMemoryLocalSummary = Pick<EnterpriseMemoryLocalRecord, 'id' | 'revision' | 'updatedAt' | 'cloud'> & { excerpt: string }
export type EnterpriseMemoryLocalConflict = { local: EnterpriseMemoryLocalRecord; latest: EnterpriseMemory }
export type EnterpriseMemoryLocalIssue = EnterpriseMemoryIssue | 'localStorage'

export const enterpriseMemoryLocalRequests = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list') }),
  z.strictObject({ action: z.literal('get'), ...identity }),
  z.strictObject({ action: z.literal('save'), ...identity, expectedLocalRevision: revision.nullable(), body,
    cloud: enterpriseMemoryLocalCloudSchema.nullable(), sourceRef: sourceRef.optional(),
  }),
  z.strictObject({ action: z.literal('discard'), ...identity, expectedLocalRevision: revision }),
  z.strictObject({ action: z.literal('sync'), ...identity, expectedLocalRevision: revision }),
  z.strictObject({ action: z.literal('merge'), ...identity, expectedLocalRevision: revision, expectedCloudRevision: revision, body }),
])
export type EnterpriseMemoryLocalRequest = z.infer<typeof enterpriseMemoryLocalRequests>
type LocalAction = EnterpriseMemoryLocalRequest['action']
type LocalResponses = {
  list: { deviceId: string; drafts: EnterpriseMemoryLocalSummary[]; unreadable: number }
  get: EnterpriseMemoryLocalRecord
  save: EnterpriseMemoryLocalRecord
  discard: { discarded: true }
  merge: EnterpriseMemoryLocalRecord
  sync: { memory: EnterpriseMemory; draft: EnterpriseMemoryLocalRecord | null }
}
export type EnterpriseMemoryLocalResult<A extends LocalAction = LocalAction> =
  | { ok: true; data: LocalResponses[A] }
  | { ok: false; issue: EnterpriseMemoryLocalIssue; conflict?: EnterpriseMemoryLocalConflict }
export type EnterpriseMemoryLocalHost = <R extends EnterpriseMemoryLocalRequest>(input: R) => Promise<EnterpriseMemoryLocalResult<R['action']>>
