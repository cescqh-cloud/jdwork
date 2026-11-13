import { z } from 'zod'

export const auditCategory = z.enum(['all', 'identity', 'models', 'demands', 'knowledge', 'delivery', 'releases', 'erp', 'audit', 'other'])
export type AuditCategory = z.infer<typeof auditCategory>
export const auditCategoryLabels: Record<AuditCategory, string> = {
  all: '全部模块', identity: '身份与设备', models: '模型与组织配置', demands: '需求与审批', knowledge: '记忆与知识',
  delivery: '开发交付', releases: '版本发布', erp: '金蝶', audit: '审计导出', other: '其他',
}

const auditDate = z.iso.date().refine(value => !value.startsWith('0000-'))
export const auditFilter = z.strictObject({ from: auditDate.optional(), to: auditDate.optional(), category: auditCategory.default('all') })
export const auditQuery = auditFilter.extend({ limit: z.coerce.number().int().min(1).max(100).default(40), cursor: z.string().min(1).max(500).optional() })
export type AuditFilter = z.infer<typeof auditFilter>
export type AuditQuery = z.infer<typeof auditQuery>
export const auditSource = z.enum(['operation', 'erp_query'])
export const auditInstant = z.iso.datetime({ precision: 6 })
export const auditEntry = z.object({ id: z.uuid(), source: auditSource, category: auditCategory, action: z.string(), label: z.string(),
  actorId: z.uuid().nullable(), targetId: z.uuid(), occurredAt: auditInstant })
export const auditPage = z.object({ entries: z.array(auditEntry), nextCursor: z.string().nullable(), filters: auditFilter.required() })
export type AuditEntry = z.infer<typeof auditEntry>
