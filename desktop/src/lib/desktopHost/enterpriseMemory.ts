import { z } from 'zod/v4'

const id = z.uuid()
const revision = z.number().int().min(1).max(2_147_483_647)
const cursor = z.number().int().nonnegative()
const date = z.iso.datetime()
const text = (max: number) => z.string().max(max)
export const enterpriseMemoryBodySchema = text(2000).trim().min(1).refine(value => !value.includes('\u0000'))
const body = enterpriseMemoryBodySchema
const reference = z.string().regex(/^[a-zA-Z0-9._:-]{1,120}$/u)
export const enterpriseMemorySourceRefSchema = z.strictObject({ sessionId: reference, messageRefs: z.array(reference).max(12).optional() })
export type EnterpriseMemorySourceRef = z.infer<typeof enterpriseMemorySourceRefSchema>
export const memoryScopes = ['user_private', 'project_private', 'team_shared'] as const
const memoryScope = z.enum(memoryScopes)
const knowledgeScope = z.enum(['enterprise_reference', 'project_private', 'team_shared'])
const resourceType = z.enum(['memory', 'knowledge'])
const classification = z.enum(['general', 'internal', 'restricted'])
const ref = { projectId: id.optional(), departmentId: id.optional() }
const memory = z.object({
  id, revision, scope: memoryScope, ownerId: id, projectId: id.nullable(), departmentId: id.nullable(),
  body: text(2000), sourceRef: enterpriseMemorySourceRefSchema.nullable().optional(),
  classification, status: z.enum(['candidate', 'active', 'deleted']),
  lastVerifiedAt: date.nullable(), expiresAt: date.nullable(), updatedAt: date,
})
const memorySummary = memory.transform(({ body: content, ...record }) => ({
  ...record, excerpt: Array.from(content).slice(0, 180).join(''),
}))
const citation = z.object({ documentId: id, revision, checksum: z.string().regex(/^[a-f0-9]{64}$/i) })
const knowledge = z.object({
  id, revision, scope: knowledgeScope, projectId: id.nullable(), departmentId: id.nullable(),
  title: text(160), excerpt: text(1200), source: z.object({ label: text(120) }), citation,
  classification, status: z.literal('ready'), updatedAt: date,
})
const knowledgeDetail = knowledge.extend({ body: text(3500) })
const sequence = { sequence: cursor, id, revision }
const changes = z.object({ cursor, hasMore: z.boolean(), aclVersion: cursor, cacheExpiresAt: date, changes: z.array(z.union([
  z.object({ ...sequence, resourceType, operation: z.literal('tombstone'), reason: z.enum(['deleted', 'access_revoked', 'expired', 'unpublished']) }),
  z.object({ ...sequence, resourceType: z.literal('memory'), operation: z.literal('upsert'), record: memorySummary }),
  z.object({ ...sequence, resourceType: z.literal('knowledge'), operation: z.literal('upsert'), record: knowledge }),
])).max(100) })
const scopeEntry = z.object({ id, name: text(200) })
const resources = z.object({ projects: z.array(scopeEntry).max(200), department: scopeEntry.nullable() })
const searchHits = z.object({ items: z.array(z.object({ id, revision })).max(30) })

export const enterpriseMemoryRequests = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('changes'), cursor }),
  z.strictObject({ action: z.literal('scopes') }),
  z.strictObject({ action: z.literal('candidates') }),
  z.strictObject({ action: z.literal('searchMemory'), query: text(160).trim().min(1), scope: memoryScope.optional() }),
  z.strictObject({ action: z.literal('searchKnowledge'), query: text(160).trim().min(1) }),
  z.strictObject({ action: z.literal('getMemory'), id }),
  z.strictObject({ action: z.literal('getKnowledge'), id, revision }),
  z.strictObject({ action: z.literal('create'), scope: memoryScope, ...ref, body, idempotencyKey: id,
    sourceRef: enterpriseMemorySourceRefSchema.nullable().optional(),
  }).refine(input => (
    input.scope === 'user_private' ? !input.projectId && !input.departmentId
      : input.scope === 'project_private' ? Boolean(input.projectId) && !input.departmentId : Boolean(input.departmentId) && !input.projectId
  )),
  z.strictObject({ action: z.literal('edit'), id, revision, body }),
  z.strictObject({ action: z.literal('publish'), id, revision }),
  z.strictObject({ action: z.literal('delete'), id, revision }),
])

export const enterpriseMemoryResponses = {
  changes, scopes: resources, candidates: z.object({ items: z.array(memorySummary).max(30) }),
  searchMemory: searchHits, searchKnowledge: searchHits,
  getMemory: memory, getKnowledge: knowledgeDetail, create: memory, edit: memory, publish: memory, delete: memory,
} as const

export type EnterpriseMemoryRequest = z.infer<typeof enterpriseMemoryRequests>
export type EnterpriseMemory = z.infer<typeof memory>
export type EnterpriseMemorySummary = z.infer<typeof memorySummary>
export type EnterpriseKnowledge = z.infer<typeof knowledge>
export type EnterpriseKnowledgeDetail = z.infer<typeof knowledgeDetail>
export type EnterpriseMemoryChanges = z.infer<typeof changes>
export type EnterpriseMemoryScopes = z.infer<typeof resources>
export type EnterpriseMemoryScope = z.infer<typeof memoryScope>
export type EnterpriseMemoryIssue = 'unbound' | 'forbidden' | 'invalid' | 'conflict' | 'notFound' | 'sensitive' | 'unavailable' | 'reset'
type Action = EnterpriseMemoryRequest['action']
export type EnterpriseMemoryResult<A extends Action = Action> =
  | { ok: true; data: z.infer<typeof enterpriseMemoryResponses[A]> }
  | { ok: false; issue: EnterpriseMemoryIssue }
export type EnterpriseMemoryHost = <R extends EnterpriseMemoryRequest>(input: R) => Promise<EnterpriseMemoryResult<R['action']>>
