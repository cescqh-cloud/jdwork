import type { SQL, TransactionSQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { ControlError, tokenDigest, type Role } from '../contract'
import { requireAdmin, type Actor } from '../store'
import {
  assertCleanContext, assertFuture, MemoryRevisionConflict, scopeId, type CandidateInput, type ContextSearchPolicy, type EditKnowledgeInput,
  type EditMemoryInput, type KnowledgeSource, type NewKnowledgeInput, type SearchInput,
} from './contract'
import {
  getViewer, isReviewer, knowledgeView, memoryView, missingKnowledge, missingMemory, recordAudit, requireScope,
  scopeDenied, withdrawResource, type Database, type KnowledgeRow, type MemoryRow,
} from './database'
import { lexicalSearch } from './search'
import { readChanges } from './sync'
import type { KnowledgeUpload } from './import'

const hashFact = (body: string) => tokenDigest(body.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' '))

function assertKnownRevision(current: { revision: number }, revision: number, submitted: EditMemoryInput | EditKnowledgeInput) {
  if (current.revision !== revision) throw new MemoryRevisionConflict(current, { revision, ...submitted })
}

async function saveVersion(sql: TransactionSQL, actor: Actor, row: MemoryRow, action: string) {
  const snapshot = { body: row.body, sourceRef: row.source_ref, classification: row.classification,
    expiresAt: row.expires_at, lastVerifiedAt: row.last_verified_at }
  await sql`INSERT INTO enterprise_memory_versions (tenant_id, memory_id, revision, actor_id, status, fact_hash, snapshot)
    VALUES (${actor.tenantId}, ${row.id}, ${row.revision}, ${actor.id}, ${row.status}, ${row.fact_hash}, ${snapshot}::jsonb)`
  await recordAudit(sql, actor, action, row.id)
}

function visibleMemories(sql: Database, actor: Actor) {
  return sql`
    FROM enterprise_memory_records m
    JOIN enterprise_users u ON (u.tenant_id, u.id) = (m.tenant_id, ${actor.id}::uuid)
    WHERE m.tenant_id = ${actor.tenantId} AND m.status <> 'deleted'
      AND (m.expires_at IS NULL OR m.expires_at > now())
      AND enterprise_context_scope_allowed(m.tenant_id, u.id, m.scope, m.scope_id)
      AND (m.status = 'active' OR m.owner_id = u.id OR
        (m.scope <> 'user_private' AND u.roles && ARRAY['platform_admin', 'it_lead']::text[]) OR
        (m.scope = 'project_private' AND 'project_owner' = ANY(u.roles)))
  `
}

async function readMemory(sql: Database, actor: Actor, id: string, lock = false) {
  const [row] = await sql<MemoryRow[]>`SELECT m.* ${visibleMemories(sql, actor)} AND m.id = ${id}
    ${lock ? sql`FOR UPDATE OF m` : sql``}`
  if (!row) throw missingMemory()
  return row
}

function visibleKnowledge(sql: Database, actor: Actor) {
  return sql`FROM enterprise_knowledge_documents k WHERE k.tenant_id = ${actor.tenantId} AND k.status <> 'deleted'
    AND enterprise_context_scope_allowed(k.tenant_id, ${actor.id}::uuid, k.scope, k.scope_id)`
}

function managedKnowledge(sql: Database, actor: Actor, roles: Role[]) {
  if (actor.device || !isReviewer('project_private', roles)) requireAdmin({ ...actor, roles })
  return sql`${visibleKnowledge(sql, actor)} AND (${roles.includes('platform_admin')} OR k.scope = 'project_private')`
}

async function readManagedKnowledge(sql: Database, actor: Actor, id: string, roles: Role[], lock = false) {
  const [row] = await sql<KnowledgeRow[]>`SELECT k.* ${managedKnowledge(sql, actor, roles)} AND k.id = ${id}
    ${lock ? sql`FOR UPDATE OF k` : sql``}`
  if (!row) throw missingKnowledge()
  return row
}

async function insertKnowledgeDraft(sql: TransactionSQL, actor: Actor, input: Omit<NewKnowledgeInput, 'source'> & { source: KnowledgeSource }) {
  const [row] = await sql<KnowledgeRow[]>`INSERT INTO enterprise_knowledge_documents
    (tenant_id, id, owner_id, scope, project_id, department_id, title, body, source, classification, checksum, status, revision)
    VALUES (${actor.tenantId}, ${randomUUID()}, ${actor.id}, ${input.scope}, ${input.projectId ?? null},
      ${input.departmentId ?? null}, ${input.title}, ${input.body}, ${input.source}::jsonb,
      ${input.classification ?? 'internal'}, ${tokenDigest(input.body)}, 'draft', 1) RETURNING *`
  if (!row) throw missingKnowledge()
  await recordAudit(sql, actor, 'knowledge.draft.created', row.id)
  return row
}

export class MemoryStore {
  constructor(private readonly database: SQL) {}

  async createCandidate(actor: Actor, input: CandidateInput, key?: string) {
    const namespace = scopeId(input.scope, actor.id, input)
    const body = input.body.trim()
    const classification = input.classification ?? 'internal'
    const source = input.sourceRef ?? null
    const expires = input.expiresAt ?? null
    assertCleanContext(body, ...(source ? [source.sessionId, ...(source.messageRefs ?? [])] : []))
    assertFuture(expires)
    const fact = hashFact(body)
    const fingerprint = tokenDigest(JSON.stringify([input.scope, namespace, body, classification, source, expires]))
    return this.database.begin(async sql => {
      const viewer = await getViewer(sql, actor, true)
      await requireScope(sql, actor, input.scope, namespace)
      if (key) {
        const [existing] = await sql<MemoryRow[]>`SELECT * FROM enterprise_memory_records
          WHERE tenant_id = ${actor.tenantId} AND owner_id = ${actor.id} AND create_key = ${key}`
        if (existing) {
          if (existing.create_fingerprint !== fingerprint || existing.status === 'deleted' ||
            (existing.expires_at && existing.expires_at.getTime() <= Date.now())) {
            throw new ControlError(409, 'MEMORY_IDEMPOTENCY_CONFLICT', '请使用新的提交编号重新提交候选。')
          }
          return memoryView(existing, actor, viewer.policy_revision)
        }
      }
      const [duplicate] = await sql<MemoryRow[]>`SELECT * FROM enterprise_memory_records
        WHERE tenant_id = ${actor.tenantId} AND owner_id = ${actor.id} AND scope = ${input.scope} AND scope_id = ${namespace}
          AND fact_hash = ${fact} AND status <> 'deleted' AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at, id LIMIT 1`
      if (duplicate) {
        if (key) throw new ControlError(409, 'MEMORY_DUPLICATE_CANDIDATE', '已存在相同记忆，请打开现有记录。')
        return memoryView(duplicate, actor, viewer.policy_revision)
      }
      const [row] = await sql<MemoryRow[]>`INSERT INTO enterprise_memory_records
        (tenant_id, id, owner_id, scope, project_id, department_id, body, source_ref, classification, fact_hash, status, revision,
          create_key, create_fingerprint, expires_at)
        VALUES (${actor.tenantId}, ${randomUUID()}, ${actor.id}, ${input.scope}, ${input.projectId ?? null},
          ${input.departmentId ?? null}, ${body}, ${source}::jsonb, ${classification}, ${fact},
          'candidate', 1, ${key ?? null}, ${fingerprint}, ${expires}) RETURNING *`
      if (!row) throw missingMemory()
      await saveVersion(sql, actor, row, 'memory.candidate.created')
      return memoryView(row, actor, viewer.policy_revision)
    })
  }

  async candidates(actor: Actor, limit = 30) {
    const viewer = await getViewer(this.database, actor)
    const rows = await this.database<MemoryRow[]>`SELECT m.* ${visibleMemories(this.database, actor)}
      AND m.status = 'candidate' ORDER BY m.updated_at DESC, m.id LIMIT ${limit}`
    return rows.map(row => memoryView(row, actor, viewer.policy_revision))
  }

  async availableScopes(actor: Actor) {
    const db = this.database
    await getViewer(db, actor)
    const [projects, [department]] = await Promise.all([
      db<{ id: string, name: string }[]>`SELECT p.id, p.name FROM enterprise_project_members m
        JOIN enterprise_projects p ON (p.tenant_id, p.id) = (m.tenant_id, m.project_id)
        WHERE m.tenant_id = ${actor.tenantId} AND m.user_id = ${actor.id}
          AND enterprise_context_scope_allowed(p.tenant_id, m.user_id, 'project_private', p.id) ORDER BY p.name, p.id`,
      db<{ id: string, name: string }[]>`SELECT d.id, d.name FROM enterprise_users u
        JOIN enterprise_departments d ON (d.tenant_id, d.id) = (u.tenant_id, u.department_id)
        WHERE u.tenant_id = ${actor.tenantId} AND u.id = ${actor.id}
          AND enterprise_context_scope_allowed(u.tenant_id, u.id, 'team_shared', d.id)`,
    ])
    return { projects, department: department ?? null }
  }

  async get(actor: Actor, id: string) {
    const viewer = await getViewer(this.database, actor)
    return memoryView(await readMemory(this.database, actor, id), actor, viewer.policy_revision)
  }

  async search(actor: Actor, input: SearchInput, policy?: ContextSearchPolicy) {
    const db = this.database
    const viewer = await getViewer(db, actor)
    const permitted = db`SELECT m.*, m.body AS searchable ${visibleMemories(db, actor)} AND m.status = 'active'
      AND (${input.scope ?? null}::text IS NULL OR m.scope = ${input.scope ?? null})
      AND (${input.projectId ?? null}::uuid IS NULL OR m.project_id = ${input.projectId ?? null})
      AND (${input.departmentId ?? null}::uuid IS NULL OR m.department_id = ${input.departmentId ?? null})
      ${policy ? db`AND m.classification = ANY(${db.array([...policy.classifications], 'TEXT')})
        AND (m.scope <> 'project_private' OR m.project_id = ${policy.modelProjectId}::uuid)` : db``}`
    const rows = await lexicalSearch<MemoryRow>(db, permitted, input.query, input.limit ?? 12)
    return { strategy: 'lexical' as const, items: rows.map(row => ({
      ...memoryView(row, actor, viewer.policy_revision), matchedTerms: row.matched_terms, score: row.lexical_score,
    })) }
  }

  update(actor: Actor, id: string, revision: number, input: EditMemoryInput) {
    return this.changeMemory(actor, id, revision, 'updated', input)
  }

  publish(actor: Actor, id: string, revision: number) {
    return this.changeMemory(actor, id, revision, 'published')
  }

  remove(actor: Actor, id: string, revision: number) {
    return this.changeMemory(actor, id, revision, 'deleted')
  }

  private async changeMemory(actor: Actor, id: string, revision: number, action: 'updated' | 'published' | 'deleted', input: EditMemoryInput = {}) {
    return this.database.begin(async sql => {
      const viewer = await getViewer(sql, actor, true)
      const current = await readMemory(sql, actor, id, true)
      const owner = current.owner_id === actor.id
      const reviewer = isReviewer(current.scope, viewer.roles)
      const allowed = action === 'published' && current.scope !== 'user_private' ? reviewer : owner || reviewer
      if (!allowed) throw scopeDenied()
      assertKnownRevision(memoryView(current, actor, viewer.policy_revision), revision, input)
      if (action === 'published' && current.status !== 'candidate') {
        throw new ControlError(409, 'MEMORY_NOT_CANDIDATE', '请选择待审核的候选记忆。')
      }
      const status = action === 'deleted' ? 'deleted' : action === 'published' ? 'active' :
        current.scope === 'user_private' ? current.status : 'candidate'
      const body = status === 'deleted' ? '' : input.body?.trim() ?? current.body
      const source = status === 'deleted' ? null : input.sourceRef === undefined ? current.source_ref : input.sourceRef
      const expires = input.expiresAt === undefined ? current.expires_at : input.expiresAt
      assertFuture(input.expiresAt)
      assertCleanContext(body, ...(source ? [source.sessionId, ...(source.messageRefs ?? [])] : []))
      const [row] = await sql<MemoryRow[]>`UPDATE enterprise_memory_records
        SET status = ${status}, body = ${body}, source_ref = ${source}::jsonb,
          classification = ${input.classification ?? current.classification}, expires_at = ${expires},
          fact_hash = ${status === 'deleted' ? current.fact_hash : hashFact(body)}, revision = revision + 1, updated_at = now(),
          last_verified_at = CASE WHEN ${status}::text = 'active' THEN now() ELSE NULL END
        WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING *`
      if (!row) throw missingMemory()
      if (current.status === 'active' && status !== 'active') {
        await withdrawResource(sql, actor.tenantId, 'memory', id, status === 'deleted' ? 'deleted' : 'unpublished')
      }
      await saveVersion(sql, actor, row, `memory.${action}`)
      return memoryView(row, actor, viewer.policy_revision)
    })
  }

  changes(actor: Actor, cursor: number) {
    return readChanges(this.database, actor, cursor)
  }

  async createKnowledge(actor: Actor, input: NewKnowledgeInput) {
    const namespace = scopeId(input.scope, actor.id, input)
    assertCleanContext(input.title, input.body, input.source.label)
    return this.database.begin(async sql => {
      const viewer = await getViewer(sql, actor, true)
      requireAdmin({ ...actor, roles: viewer.roles })
      await requireScope(sql, actor, input.scope, namespace)
      const row = await insertKnowledgeDraft(sql, actor, input)
      return knowledgeView(row, viewer.policy_revision, true)
    })
  }

  importProjectKnowledge(actor: Actor, upload: KnowledgeUpload) {
    return this.database.begin(async sql => {
      // Use the same tenant lock as scope revocation and draft writes.
      const viewer = await getViewer(sql, actor, true)
      if (actor.device || !isReviewer('project_private', viewer.roles)) throw scopeDenied()
      await requireScope(sql, actor, 'project_private', upload.projectId)
      const rows = await sql<KnowledgeRow[]>`SELECT * FROM enterprise_knowledge_documents
        WHERE tenant_id = ${actor.tenantId} AND scope = 'project_private' AND scope_id = ${upload.projectId}
          AND status <> 'deleted' AND source->'file'->>'key' = ANY(${sql.array(upload.files.map(file => file.source.key), 'TEXT')})`
      const existing = new Map(rows.map(row => [row.source.file?.key, row]))
      const items = []
      for (const file of upload.files) {
        const previous = existing.get(file.source.key)
        if (previous && (previous.source.file?.sha256 !== file.source.sha256 || previous.classification !== upload.classification)) {
          throw new ControlError(409, 'KNOWLEDGE_IMPORT_CONFLICT', '项目已有同名资料，内容或信息等级不同。请先核对已有资料。')
        }
        const row = previous ?? await insertKnowledgeDraft(sql, actor, { scope: 'project_private', projectId: upload.projectId,
          classification: upload.classification, title: file.title, body: file.body, source: { label: file.source.name, file: file.source } })
        items.push({ created: !previous, document: knowledgeView(row, viewer.policy_revision, false) })
      }
      return { items }
    })
  }

  async listKnowledge(actor: Actor, limit = 30) {
    const viewer = await getViewer(this.database, actor)
    const rows = await this.database<KnowledgeRow[]>`SELECT k.* ${managedKnowledge(this.database, actor, viewer.roles)}
      ORDER BY k.updated_at DESC, k.id LIMIT ${limit}`
    return rows.map(row => knowledgeView(row, viewer.policy_revision, false))
  }

  async getManagedKnowledge(actor: Actor, id: string) {
    const viewer = await getViewer(this.database, actor)
    const row = await readManagedKnowledge(this.database, actor, id, viewer.roles)
    return knowledgeView(row, viewer.policy_revision, true)
  }

  async getKnowledge(actor: Actor, id: string, revision?: number) {
    const viewer = await getViewer(this.database, actor)
    const [row] = await this.database<KnowledgeRow[]>`SELECT k.* ${visibleKnowledge(this.database, actor)}
      AND k.id = ${id} AND k.status = 'ready'`
    if (!row) throw missingKnowledge()
    if (revision !== undefined && revision !== row.revision) {
      throw new ControlError(410, 'KNOWLEDGE_CITATION_STALE', '此引用版本已变更，请重新检索并核对来源。')
    }
    return knowledgeView(row, viewer.policy_revision, true)
  }

  async searchKnowledge(actor: Actor, input: SearchInput, policy?: ContextSearchPolicy) {
    const db = this.database
    const viewer = await getViewer(db, actor)
    const permitted = db`SELECT k.*, k.title || ' ' || k.body AS searchable ${visibleKnowledge(db, actor)} AND k.status = 'ready'
      AND (${input.scope ?? null}::text IS NULL OR k.scope = ${input.scope ?? null})
      AND (${input.projectId ?? null}::uuid IS NULL OR k.project_id = ${input.projectId ?? null})
      AND (${input.departmentId ?? null}::uuid IS NULL OR k.department_id = ${input.departmentId ?? null})
      ${policy ? db`AND k.classification = ANY(${db.array([...policy.classifications], 'TEXT')})
        AND (k.scope <> 'project_private' OR k.project_id = ${policy.modelProjectId}::uuid)` : db``}`
    const rows = await lexicalSearch<KnowledgeRow>(db, permitted, input.query, input.limit ?? 12)
    return { strategy: 'lexical' as const, items: rows.map(row => ({
      ...knowledgeView(row, viewer.policy_revision, false), matchedTerms: row.matched_terms, score: row.lexical_score,
    })) }
  }

  updateKnowledge(actor: Actor, id: string, revision: number, input: EditKnowledgeInput) {
    return this.changeKnowledge(actor, id, revision, 'updated', input)
  }

  publishKnowledge(actor: Actor, id: string, revision: number) {
    return this.changeKnowledge(actor, id, revision, 'published')
  }

  removeKnowledge(actor: Actor, id: string, revision: number) {
    return this.changeKnowledge(actor, id, revision, 'deleted')
  }

  private async changeKnowledge(actor: Actor, id: string, revision: number, action: 'updated' | 'published' | 'deleted', input: EditKnowledgeInput = {}) {
    return this.database.begin(async sql => {
      const viewer = await getViewer(sql, actor, true)
      const current = await readManagedKnowledge(sql, actor, id, viewer.roles, true)
      assertKnownRevision(knowledgeView(current, viewer.policy_revision, true), revision, input)
      if (action === 'published' && current.status !== 'draft') {
        throw new ControlError(409, 'KNOWLEDGE_NOT_DRAFT', '请选择待发布的知识草稿。')
      }
      const status = action === 'published' ? 'ready' : action === 'deleted' ? 'deleted' : 'draft'
      const scope = input.scope ?? current.scope
      const refs = {
        projectId: input.projectId ?? (scope === current.scope ? current.project_id ?? undefined : undefined),
        departmentId: input.departmentId ?? (scope === current.scope ? current.department_id ?? undefined : undefined),
      }
      const namespace = scopeId(scope, actor.id, refs)
      if ((current.source.file || !viewer.roles.includes('platform_admin')) &&
        (scope !== current.scope || namespace !== current.scope_id)) throw scopeDenied()
      await requireScope(sql, actor, scope, namespace)
      const title = input.title ?? current.title
      const body = status === 'deleted' ? '' : input.body ?? current.body
      const source = input.source ? { ...input.source, ...(current.source.file ? { file: current.source.file } : {}) } : current.source
      assertCleanContext(title, body, source.label)
      const [row] = await sql<KnowledgeRow[]>`UPDATE enterprise_knowledge_documents
        SET scope = ${scope}, project_id = ${refs.projectId ?? null}, department_id = ${refs.departmentId ?? null},
          title = ${title}, body = ${body}, source = ${source}::jsonb, checksum = ${tokenDigest(body)},
          classification = ${input.classification ?? current.classification}, status = ${status},
          index_revision = CASE WHEN ${status}::text = 'ready' THEN revision + 1 ELSE NULL END,
          revision = revision + 1, updated_at = now()
        WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING *`
      if (!row) throw missingKnowledge()
      if (current.status === 'ready' && status !== 'ready') {
        await withdrawResource(sql, actor.tenantId, 'knowledge', id, status === 'deleted' ? 'deleted' : 'unpublished')
      }
      await recordAudit(sql, actor, `knowledge.${action}`, id)
      return knowledgeView(row, viewer.policy_revision, true)
    })
  }
}
