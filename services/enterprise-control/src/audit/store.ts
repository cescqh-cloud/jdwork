import type { SQL, TransactionSQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ControlError } from '../contract'
import type { Actor } from '../store'
import { auditActions } from './actions'
import { auditCategory, auditInstant, auditSource, type AuditEntry, type AuditFilter, type AuditQuery } from './contract'

type Database = SQL | TransactionSQL
type Filters = Required<AuditFilter>
type AuditRow = Pick<AuditEntry, 'id' | 'source' | 'action' | 'actorId' | 'targetId' | 'occurredAt'>
const cursorSchema = z.tuple([z.literal(1), auditInstant, auditSource, z.uuid(), z.iso.date(), z.iso.date(), auditCategory])
type Cursor = z.infer<typeof cursorSchema>
const day = 24 * 60 * 60 * 1000
export const auditExportLimit = 1000
const audits = Object.entries(auditActions)
const knownActions = audits.map(([code]) => code)
const forbidden = () => new ControlError(403, 'AUDIT_ACCESS_DENIED', '审计记录仅对管理员和审计员开放。')
const invalidCursor = () => new ControlError(400, 'AUDIT_CURSOR_INVALID', '请从当前筛选条件的第一页重新查看。')

export function canReadAudit(actor: Actor) {
  return !actor.device && actor.roles.some(role => role === 'platform_admin' || role === 'auditor')
}

function effectiveFilters(input: AuditFilter, now: number): Filters {
  const to = input.to ?? new Date(now).toISOString().slice(0, 10)
  const from = input.from ?? new Date(Date.parse(to) - 6 * day).toISOString().slice(0, 10)
  const days = (Date.parse(to) - Date.parse(from)) / day + 1
  if (!Number.isFinite(days) || days < 1 || days > 92 || from.startsWith('0000-')) {
    throw new ControlError(400, 'AUDIT_DATE_RANGE_INVALID', '请选择同一段不超过 92 天的 UTC 日期。')
  }
  return { from, to, category: input.category }
}

function readCursor(value: string | undefined, filters: Filters): Cursor | undefined {
  if (!value) return undefined
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) throw invalidCursor()
    const cursor = cursorSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    if (cursor[4] !== filters.from || cursor[5] !== filters.to || cursor[6] !== filters.category) throw invalidCursor()
    return cursor
  } catch { throw invalidCursor() }
}

function view(row: AuditRow): AuditEntry {
  if (!Object.hasOwn(auditActions, row.action)) return { ...row, category: 'other', action: 'other.recorded', label: '其他已记录操作' }
  const [category, label] = auditActions[row.action]!
  return { ...row, category, label }
}

async function requireAuditAccess(db: Database, actor: Actor) {
  if (!canReadAudit(actor) || actor.expiresAt.getTime() <= Date.now()) throw forbidden()
  const [current] = await db`SELECT 1 FROM enterprise_users u JOIN enterprise_tenants t ON t.id = u.tenant_id
    WHERE u.tenant_id = ${actor.tenantId} AND u.id = ${actor.id} AND u.active AND t.active AND u.roles && ARRAY['platform_admin','auditor']::text[]`
  if (!current) throw forbidden()
}

async function selectEntries(db: Database, tenantId: string, filters: Filters, limit: number, cursor?: Cursor) {
  const start = `${filters.from}T00:00:00Z`
  const end = db`((${filters.to}::date + 1)::timestamp AT TIME ZONE 'UTC')`
  const category = filters.category
  const actionFilter = category === 'all' ? db`` : category === 'other' ? db`AND NOT action = ANY(${db.array(knownActions, 'TEXT')})` :
    db`AND action = ANY(${db.array(audits.filter(([, item]) => item[0] === category).map(([code]) => code), 'TEXT')})`
  const position = cursor ? db`AND (occurred_at, source, id) < (${cursor[1]}::timestamptz, ${cursor[2]}::text, ${cursor[3]}::uuid)` : db``
  return db<AuditRow[]>`WITH activity AS (
      SELECT id, 'operation'::text AS source, action, actor_id, target_id, occurred_at FROM enterprise_audit
        WHERE tenant_id = ${tenantId} AND occurred_at >= ${start}::timestamptz AND occurred_at < ${end}
      UNION ALL
      SELECT request_id, 'erp_query'::text, 'erp.query.' || outcome, actor_id, project_id, occurred_at FROM enterprise_erp_activity
        WHERE tenant_id = ${tenantId} AND occurred_at >= ${start}::timestamptz AND occurred_at < ${end}
    ) SELECT id, source, action, actor_id AS "actorId", target_id AS "targetId",
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt"
    FROM activity WHERE true ${actionFilter} ${position} ORDER BY occurred_at DESC, source DESC, id DESC LIMIT ${limit}`
}

export class AuditStore {
  constructor(private readonly database: SQL, private readonly now: () => number = Date.now) {}

  async list(actor: Actor, input: AuditQuery) {
    await requireAuditAccess(this.database, actor)
    const filters = effectiveFilters(input, this.now())
    const rows = await selectEntries(this.database, actor.tenantId, filters, input.limit + 1, readCursor(input.cursor, filters))
    const entries = rows.slice(0, input.limit).map(view)
    const last = rows.length > input.limit ? entries.at(-1) : undefined
    const nextCursor = last ? Buffer.from(JSON.stringify([1, last.occurredAt, last.source, last.id, filters.from, filters.to, filters.category])).toString('base64url') : null
    return { filters, entries, nextCursor }
  }

  async export(actor: Actor, input: AuditFilter) {
    return this.database.begin(async db => {
      await requireAuditAccess(db, actor)
      const filters = effectiveFilters(input, this.now())
      const rows = await selectEntries(db, actor.tenantId, filters, auditExportLimit + 1)
      await db`INSERT INTO enterprise_audit (id, tenant_id, actor_id, action, target_id)
        VALUES (${randomUUID()}, ${actor.tenantId}, ${actor.id}, 'audit.exported', ${actor.id})`
      return { entries: rows.slice(0, auditExportLimit).map(view), truncated: rows.length > auditExportLimit }
    })
  }
}
