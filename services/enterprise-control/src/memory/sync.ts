import type { SQL } from 'bun'
import { ControlError } from '../contract'
import type { Actor } from '../store'
import type { ResourceType, TombstoneReason } from './contract'
import { getViewer, knowledgeView, memoryView, type KnowledgeRow, type MemoryRow } from './database'

const pageSize = 100
const cacheLifetimeMs = 5 * 60_000

interface ChangeRow {
  sequence: string
  resource_type: ResourceType
  resource_id: string
  revision: number
  operation: 'upsert' | 'tombstone'
  reason: TombstoneReason | null
  occurred_at: Date
}

type Change = { sequence: number, resourceType: ResourceType, id: string, revision: number, occurredAt: string } &
  ({ operation: 'tombstone', reason: TombstoneReason } |
  { operation: 'upsert', record: ReturnType<typeof memoryView> | ReturnType<typeof knowledgeView> })

export async function readChanges(database: SQL, actor: Actor, cursor: number) {
  return database.begin(async sql => {
    const viewer = await getViewer(sql, actor, true)
    await sql`SELECT enterprise_context_reconcile(${actor.tenantId}::uuid, ${actor.id}::uuid)`
    const [head] = await sql<{ sequence: string }[]>`
      SELECT COALESCE(max(sequence), 0)::text AS sequence FROM enterprise_context_changes
      WHERE tenant_id = ${actor.tenantId} AND user_id = ${actor.id}`
    if (cursor > Number(head?.sequence ?? 0)) throw new ControlError(409, 'MEMORY_SYNC_REQUIRED', '请清除旧的记忆游标并重新同步。')
    const events = await sql<ChangeRow[]>`SELECT enterprise_context_changes.sequence::text, resource_type, resource_id, revision, operation, reason, occurred_at
      FROM enterprise_context_changes WHERE tenant_id = ${actor.tenantId} AND user_id = ${actor.id}
        AND enterprise_context_changes.sequence > ${cursor} ORDER BY enterprise_context_changes.sequence ASC LIMIT ${pageSize + 1}`
    const page = events.slice(0, pageSize)
    const memoryIds = [...new Set(page.filter(event => event.operation === 'upsert' && event.resource_type === 'memory').map(event => event.resource_id))]
    const knowledgeIds = [...new Set(page.filter(event => event.operation === 'upsert' && event.resource_type === 'knowledge').map(event => event.resource_id))]
    const memories = memoryIds.length ? await sql<MemoryRow[]>`SELECT m.* FROM enterprise_memory_records m
      JOIN enterprise_context_visibility v ON v.tenant_id = m.tenant_id AND v.user_id = ${actor.id}
        AND v.resource_type = 'memory' AND v.resource_id = m.id
      WHERE m.tenant_id = ${actor.tenantId} AND m.id = ANY(${sql.array(memoryIds, 'UUID')}) AND m.status = 'active'
        AND (m.expires_at IS NULL OR m.expires_at > now())
        AND enterprise_context_scope_allowed(m.tenant_id, v.user_id, m.scope, m.scope_id)` : []
    const documents = knowledgeIds.length ? await sql<KnowledgeRow[]>`SELECT k.* FROM enterprise_knowledge_documents k
      JOIN enterprise_context_visibility v ON v.tenant_id = k.tenant_id AND v.user_id = ${actor.id}
        AND v.resource_type = 'knowledge' AND v.resource_id = k.id
      WHERE k.tenant_id = ${actor.tenantId} AND k.id = ANY(${sql.array(knowledgeIds, 'UUID')}) AND k.status = 'ready'
        AND enterprise_context_scope_allowed(k.tenant_id, v.user_id, k.scope, k.scope_id)` : []
    const memoryById = new Map(memories.map(row => [row.id, memoryView(row, actor, viewer.policy_revision)]))
    const knowledgeById = new Map(documents.map(row => [row.id, knowledgeView(row, viewer.policy_revision, false)]))
    const changes = page.flatMap<Change>(event => {
      const identity = { sequence: Number(event.sequence), resourceType: event.resource_type, id: event.resource_id,
        occurredAt: event.occurred_at.toISOString() }
      if (event.operation === 'tombstone') {
        return [{ ...identity, operation: 'tombstone' as const, revision: event.revision, reason: event.reason! }]
      }
      // Historical upserts never replay content that the current actor can no longer read.
      const record = event.resource_type === 'memory' ? memoryById.get(event.resource_id) : knowledgeById.get(event.resource_id)
      return record ? [{ ...identity, operation: 'upsert' as const, revision: record.revision, record }] : []
    })
    const cacheExpiresAt = new Date(Math.min(actor.expiresAt.getTime(), Date.now() + cacheLifetimeMs)).toISOString()
    return { cursor: Number(page.at(-1)?.sequence ?? cursor), hasMore: events.length > pageSize, changes,
      aclVersion: viewer.policy_revision, cacheExpiresAt }
  })
}
