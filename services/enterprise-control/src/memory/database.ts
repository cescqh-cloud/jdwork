import type { SQL, TransactionSQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { ControlError, type Role } from '../contract'
import type { Actor } from '../store'
import type { Classification, KnowledgeScope, KnowledgeSource, MemoryScope, ResourceType, Scope, SourceRef, TombstoneReason } from './contract'

export type Database = SQL | TransactionSQL

interface ScopedRow {
  tenant_id: string
  id: string
  owner_id: string
  project_id: string | null
  department_id: string | null
  scope_id: string | null
  classification: Classification
  revision: number
  body: string
  created_at: Date
  updated_at: Date
}

export interface MemoryRow extends ScopedRow {
  scope: MemoryScope
  status: 'candidate' | 'active' | 'deleted'
  source_ref: SourceRef | null
  fact_hash: string
  create_fingerprint: string
  expires_at: Date | null
  last_verified_at: Date | null
}

export interface KnowledgeRow extends ScopedRow {
  scope: KnowledgeScope
  status: 'draft' | 'ready' | 'deleted'
  title: string
  source: KnowledgeSource
  checksum: string
  index_revision: number | null
}

export function memoryView(row: MemoryRow, actor: Actor, aclVersion: number) {
  return {
    id: row.id, tenantId: row.tenant_id, scope: row.scope, ownerId: row.owner_id,
    projectId: row.project_id, departmentId: row.department_id, revision: row.revision, aclVersion,
    body: row.body, sourceRef: row.owner_id === actor.id ? row.source_ref : null,
    sourceKind: row.source_ref ? 'session' : 'manual',
    classification: row.classification, status: row.status, lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  }
}

export function knowledgeView(row: KnowledgeRow, aclVersion: number, full: boolean) {
  const imported = row.source.file
  const source = { label: row.source.label, ...(row.source.url ? { url: row.source.url } : {}),
    ...(imported ? { file: { name: imported.name, format: imported.format, bytes: imported.bytes, lines: imported.lines,
      sha256: imported.sha256, importedAt: imported.importedAt } } : {}) }
  return {
    id: row.id, tenantId: row.tenant_id, scope: row.scope,
    projectId: row.project_id, departmentId: row.department_id, revision: row.revision, aclVersion,
    title: row.title, status: row.status, indexRevision: row.index_revision, classification: row.classification,
    source, excerpt: Array.from(row.body).slice(0, 600).join(''),
    ...(full ? { body: row.body } : {}),
    citation: { documentId: row.id, revision: row.revision, checksum: row.checksum,
      href: `/api/v1/knowledge/${row.id}?revision=${row.revision}` },
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  }
}

export function isReviewer(scope: MemoryScope, roles: Role[]): boolean {
  if (scope === 'user_private') return false
  return roles.includes('platform_admin') || roles.includes('it_lead') ||
    (scope === 'project_private' && roles.includes('project_owner'))
}

export const missingMemory = () => new ControlError(404, 'MEMORY_NOT_FOUND', '此记忆不存在或当前账号无权访问。')
export const missingKnowledge = () => new ControlError(404, 'KNOWLEDGE_NOT_FOUND', '此知识不存在、尚未就绪或当前账号无权访问。')
export const scopeDenied = () => new ControlError(403, 'MEMORY_SCOPE_DENIED', '请确认账号仍属于所选项目或部门，并具有操作权限。')

export async function getViewer(sql: Database, actor: Actor, lock = false) {
  const [viewer] = await sql<{ roles: Role[], policy_revision: number }[]>`
    SELECT u.roles, t.policy_revision FROM enterprise_users u JOIN enterprise_tenants t ON t.id = u.tenant_id
    WHERE u.tenant_id = ${actor.tenantId} AND u.id = ${actor.id} AND u.active AND t.active
    ${lock ? sql`FOR UPDATE OF t` : sql``}
  `
  if (!viewer) throw new ControlError(401, 'AUTH_REQUIRED', '请重新登录工作台。')
  return viewer
}

export async function requireScope(sql: Database, actor: Actor, scope: Scope, id: string | null) {
  const [row] = await sql<{ allowed: boolean }[]>`
    SELECT enterprise_context_scope_allowed(${actor.tenantId}::uuid, ${actor.id}::uuid, ${scope}::text, ${id}::uuid) AS allowed
  `
  if (!row?.allowed) throw scopeDenied()
}

export async function recordAudit(sql: TransactionSQL, actor: Actor, action: string, id: string) {
  await sql`INSERT INTO enterprise_audit (id, tenant_id, actor_id, action, target_id)
    VALUES (${randomUUID()}, ${actor.tenantId}, ${actor.id}, ${action}, ${id})`
}

export async function withdrawResource(sql: TransactionSQL, tenantId: string, type: ResourceType, id: string, reason: TombstoneReason) {
  await sql`SELECT enterprise_context_withdraw(${tenantId}::uuid, NULL, NULL, NULL, ${type}::text, ${id}::uuid, ${reason}::text)`
}
