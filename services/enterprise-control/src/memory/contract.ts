import { z } from 'zod'
import { ControlError } from '../contract'

const memoryScope = z.enum(['user_private', 'project_private', 'team_shared'])
const knowledgeScope = z.enum(['enterprise_reference', 'project_private', 'team_shared'])
const allScope = z.enum(['user_private', 'project_private', 'team_shared', 'enterprise_reference'])
export const classification = z.enum(['general', 'internal', 'restricted'])
const reference = z.string().regex(/^[a-zA-Z0-9._:-]{1,120}$/u)
const timestamp = z.iso.datetime({ offset: true })
const cleanText = (limit: number) => z.string().trim().min(1).max(limit).refine(value => !value.includes('\u0000'))

const sourceRef = z.strictObject({ sessionId: reference, messageRefs: z.array(reference).max(12).optional() })
const sourceUrl = z.url().max(300).refine(value => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password &&
      [...url.searchParams.keys()].every(key => !/^(?:access.?token|api.?key|password|secret|signature|auth)$/iu.test(key))
  } catch { return false }
})
const knowledgeSource = z.strictObject({ label: cleanText(120), url: sourceUrl.optional() })
const scopeReferences = { projectId: z.uuid().optional(), departmentId: z.uuid().optional() }
const memoryFields = {
  body: cleanText(2000),
  sourceRef: sourceRef.nullable().optional(),
  classification: classification.optional(),
  expiresAt: timestamp.nullable().optional(),
}
const documentFields = {
  title: cleanText(160), body: cleanText(3500), source: knowledgeSource, classification: classification.optional(),
}

export const candidateInput = z.strictObject({ scope: memoryScope, ...scopeReferences, ...memoryFields })
export const editMemoryInput = z.strictObject(memoryFields).partial().refine(value => Object.keys(value).length > 0)
export const newKnowledgeInput = z.strictObject({ scope: knowledgeScope, ...scopeReferences, ...documentFields })
export const editKnowledgeInput = z.strictObject({ scope: knowledgeScope, ...scopeReferences, ...documentFields }).partial()
  .refine(value => Object.keys(value).length > 0)
export const searchInput = z.strictObject({
  query: cleanText(160), scope: allScope.optional(), ...scopeReferences, limit: z.number().int().min(1).max(30).optional(),
}).refine(input => !(input.projectId && input.departmentId))

export type MemoryScope = z.infer<typeof memoryScope>
export type KnowledgeScope = z.infer<typeof knowledgeScope>
export type Scope = z.infer<typeof allScope>
export type Classification = z.infer<typeof classification>
export type SourceRef = z.infer<typeof sourceRef>
export interface KnowledgeFileSource {
  name: string
  key: string
  format: 'markdown' | 'text'
  bytes: number
  lines: number
  sha256: string
  importedAt: string
}
export type KnowledgeSource = z.infer<typeof knowledgeSource> & { file?: KnowledgeFileSource }
export type CandidateInput = z.infer<typeof candidateInput>
export type EditMemoryInput = z.infer<typeof editMemoryInput>
export type NewKnowledgeInput = z.infer<typeof newKnowledgeInput>
export type EditKnowledgeInput = z.infer<typeof editKnowledgeInput>
export type SearchInput = z.infer<typeof searchInput>
export type TombstoneReason = 'deleted' | 'access_revoked' | 'expired' | 'unpublished'
export type ResourceType = 'memory' | 'knowledge'

export interface ContextSearchPolicy {
  modelProjectId: string | null
  classifications: readonly Classification[]
}

export function scopeId(scope: Scope, userId: string, input: { projectId?: string, departmentId?: string }): string | null {
  if (scope === 'project_private' && input.projectId && !input.departmentId) return input.projectId
  if (scope === 'team_shared' && input.departmentId && !input.projectId) return input.departmentId
  if (!input.projectId && !input.departmentId) {
    if (scope === 'user_private') return userId
    if (scope === 'enterprise_reference') return null
  }
  throw new ControlError(400, 'MEMORY_SCOPE_INVALID', '请提供与所选范围一致的项目或部门。')
}

export function assertCleanContext(...texts: string[]) {
  const credential = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{8,}|\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|password|passwd)\s*[:=：]\s*\S{4,}/iu
  const personal = /(?:身份证号?|手机号|护照号|银行卡号|家庭住址)\s*[:=：]\s*\S{4,}|\b(?:social security number|passport number|bank account)\s*[:=]\s*\S{4,}/iu
  if (texts.some(text => credential.test(text.normalize('NFKC')) || personal.test(text.normalize('NFKC')))) {
    throw new ControlError(400, 'MEMORY_SENSITIVE_CONTENT', '请先移除凭据和个人敏感信息。')
  }
}

export function assertFuture(expiresAt: string | null | undefined) {
  if (expiresAt && !(Date.parse(expiresAt) > Date.now())) {
    throw new ControlError(400, 'MEMORY_EXPIRY_INVALID', '请选择未来的到期时间。')
  }
}

export function readRevision(header: string | undefined): number {
  const match = /^"([1-9]\d{0,9})"$/u.exec(header ?? '')
  const value = Number(match?.[1])
  if (!(value > 0 && value <= 2_147_483_647)) {
    throw new ControlError(400, 'MEMORY_REVISION_REQUIRED', '请使用记录返回的 ETag 作为 If-Match。')
  }
  return value
}

export function readCursor(value: string | undefined): number {
  const cursor = Number(value ?? '0')
  if (!/^(?:0|[1-9]\d{0,15})$/u.test(value ?? '0') || !Number.isSafeInteger(cursor)) {
    throw new ControlError(400, 'MEMORY_CURSOR_INVALID', '请使用最近成功同步的游标。')
  }
  return cursor
}

export class MemoryRevisionConflict extends ControlError {
  constructor(readonly current: { revision: number }, readonly submitted: unknown) {
    super(409, 'MEMORY_REVISION_CONFLICT', '记录已在其他位置更新，请核对当前版本与本次修改。')
  }
}

export function searchTerms(query: string): { fts: string, terms: string[] } {
  const normalized = query.normalize('NFKC').trim().toLowerCase()
  const han = /\p{Script=Han}/u
  const segments = Array.from(new Intl.Segmenter('zh', { granularity: 'word' }).segment(normalized))
    .filter(word => word.isWordLike).map(word => word.segment)
  const cjk = normalized.match(/\p{Script=Han}{2,}/gu) ?? []
  return {
    fts: segments.filter(word => !han.test(word)).slice(0, 12).join(' '),
    terms: [...new Set([...cjk, ...segments.filter(word => han.test(word) && word.length > 1)])].slice(0, 12),
  }
}
