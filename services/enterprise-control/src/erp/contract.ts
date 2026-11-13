import { z } from 'zod'
import { role, tenantSlug, tokenSchema } from '../contract'
import { grantInput, projectInput, providerId } from '../models/contract'

export const erpKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/u)
const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/u).refine(value => !/token|secret|password|passwd|credential|cookie|phone|mobile|email/iu.test(value))
const name = z.string().trim().min(1).max(100)
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/u)
const endpoint = z.string().regex(/^\/kapi\/(?:[A-Za-z0-9_-]+\/){1,8}[A-Za-z0-9_-]+$/u)
const reviewRole = z.enum(['platform_admin', 'it_lead', 'approver'])
const namedScope = z.strictObject({ projectId: z.uuid(), roles: z.array(role).min(1).max(7), writeReviewRoles: z.array(reviewRole).max(3).default([]) })
  .refine(scope => scope.writeReviewRoles.every(role => scope.roles.includes(role)))
const column = z.strictObject({ key: field, title: name })
const templateInput = z.strictObject({
  id: erpKey, label: name, kind: z.enum(['connection', 'metadata', 'document']), path: endpoint,
  allowAssistant: z.boolean().default(false),
  numberParameter: field.optional(), numberColumn: field.optional(), fixedParameters: z.record(field, z.string().max(120)).default({}),
  rowPath: z.array(field).max(4).default([]), columns: z.array(column).max(24).default([]),
}).refine(value => (value.kind === 'document') === Boolean(value.numberParameter) && (value.kind === 'document') === Boolean(value.numberColumn) &&
  (!value.numberColumn || value.columns.some(column => column.key === value.numberColumn)) &&
  (!value.numberParameter || !Object.hasOwn(value.fixedParameters, value.numberParameter)) &&
  (value.kind === 'connection' || value.columns.length > 0) && new Set(value.columns.map(item => item.key)).size === value.columns.length)

const environmentInput = z.strictObject({
  tenant: tenantSlug, id: erpKey, name, kind: z.literal('kingdee-xh'), mode: z.enum(['sandbox', 'test', 'production']),
  origin: z.url(), credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{2,40}$/u), scopes: z.array(namedScope).min(1).max(30),
  queries: z.array(templateInput).min(1).max(25),
}).refine(value => value.queries.some(template => template.kind === 'connection') &&
  new Set(value.queries.map(template => template.id)).size === value.queries.length &&
  new Set(value.scopes.map(scope => scope.projectId)).size === value.scopes.length &&
  (value.mode !== 'production' || value.queries.every(query => !query.allowAssistant)))

export type ErpQueryTemplate = z.infer<typeof templateInput>
export interface KingdeeCredential {
  clientId: string
  secret: string
  username: string
  accountId: string
  gatewayIdentity: string
}
export type ErpEnvironment = Omit<z.infer<typeof environmentInput>, 'credentialRef'> & { credential: KingdeeCredential }

function configuredOrigin(value: string, allowLoopback: boolean) {
  const url = new URL(value)
  const development = allowLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
  if ((!development && url.protocol !== 'https:') || url.pathname !== '/' || url.search || url.hash || url.username || url.password ||
      /[\s\\]/u.test(value)) throw new Error('Each ERP environment needs an HTTPS origin')
  return url.origin
}

export function loadErpEnvironments(env: Record<string, string | undefined>, localDevelopment: boolean): ErpEnvironment[] {
  const value = env.ENTERPRISE_ERP_ENVIRONMENTS
  if (!value) return []
  try {
    const definitions = z.array(environmentInput).max(20).parse(JSON.parse(value))
    const identifiers = new Set<string>()
    return definitions.map(definition => {
      const { credentialRef, origin, ...configuration } = definition
      const key = `${definition.tenant}:${definition.id}`
      if (identifiers.has(key)) throw new Error('Duplicate ERP environment')
      identifiers.add(key)
      const field = (suffix: string) => z.string().min(1).max(2048).regex(/^[^\u0000-\u001f\u007f]+$/u).parse(env[`${credentialRef}_${suffix}`])
      return { ...configuration, origin: configuredOrigin(origin, localDevelopment && definition.mode !== 'production'),
        credential: { clientId: field('CLIENT_ID'), secret: field('CLIENT_SECRET'), username: field('USERNAME'),
          accountId: field('ACCOUNT_ID'), gatewayIdentity: field('GATEWAY_IDENTITY') } }
    })
  } catch { throw new Error('ERP environments, query contracts or credentials are invalid') }
}

export const runErpQueryInput = z.strictObject({ projectId: z.uuid(), operation: erpKey, number: ref.optional() })
export type RunErpQueryInput = z.infer<typeof runErpQueryInput>
const erpMode = environmentInput.shape.mode
const queryView = z.object({ id: erpKey, label: name, kind: templateInput.shape.kind, columns: z.array(column), requiresNumber: z.boolean() })
export const erpEnvironmentList = z.object({ environments: z.array(z.object({ id: erpKey, name, mode: erpMode,
  kind: environmentInput.shape.kind, projects: z.array(z.object({ id: z.uuid(), name: z.string(), writeApprovalEnabled: z.boolean() })), queries: z.array(queryView),
})) })
export const runErpQueryOutput = z.object({ requestId: z.uuid(), projectId: z.uuid(), environmentId: erpKey, environmentName: name,
  mode: erpMode, operation: erpKey, query: queryView, checkedAt: z.iso.datetime(),
  rows: z.array(z.record(field, z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(50), truncated: z.boolean(),
})
const assistantProof = grantInput.pick({ modelId: true, sessionId: true }).extend({ providerId, modelGrant: tokenSchema })
export const assistantErpInput = z.discriminatedUnion('action', [
  assistantProof.extend({ action: z.literal('list') }),
  assistantProof.extend({ ...runErpQueryInput.shape, action: z.literal('read'), environmentId: erpKey }),
])
export type AssistantErpInput = z.infer<typeof assistantErpInput>
const assistantMode = z.enum(['sandbox', 'test'])
export const assistantErpOutput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), environments: z.array(z.object({ id: erpKey, name, mode: assistantMode,
    projects: z.array(z.object({ id: z.uuid(), name: projectInput.shape.name })), queries: z.array(queryView.omit({ columns: true })),
  })) }),
  z.object({ action: z.literal('read'), result: runErpQueryOutput.extend({ mode: assistantMode, rows: runErpQueryOutput.shape.rows.max(10) }) }),
])
const description = z.string().trim().min(1).max(1200)
export const erpPlanInput = z.strictObject({ projectId: z.uuid(), idempotencyKey: z.uuid(), object: name, documentNumber: ref, change: description, reason: description })
export const erpPlanDecision = z.strictObject({ projectId: z.uuid(), expectedRevision: z.number().int().min(1), decision: z.enum(['approve', 'reject']), note: z.string().trim().min(1).max(400) })
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
export const erpExecuteInput = z.strictObject({ projectId: z.uuid(), snapshotHash: sha256, confirmEnvironment: erpKey })
export const erpPlanSnapshot = z.strictObject({ projectId: z.uuid(), environmentId: erpKey, environmentName: name, environmentFingerprint: sha256,
  mode: erpMode, object: name, documentNumber: ref, change: description, reason: description })
export const erpPlanState = z.enum(['pending', 'approved', 'rejected', 'executing', 'completed', 'unknown', 'failed'])
export const erpPlanView = z.object({ id: z.uuid(), snapshot: erpPlanSnapshot, snapshotHash: sha256, state: erpPlanState, revision: z.number().int().positive(),
  requesterId: z.uuid(), approvedBy: z.uuid().nullable(), decisionNote: z.string().nullable(), createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(), startedAt: z.iso.datetime().nullable(), finishedAt: z.iso.datetime().nullable(), canReview: z.boolean() })
export const erpPlanListView = z.object({ environment: z.object({ id: erpKey, name, mode: erpMode }),
  project: z.object({ id: z.uuid(), name: z.string() }), canRequest: z.boolean(), plans: z.array(erpPlanView).max(50) })
export type ErpPlanInput = z.infer<typeof erpPlanInput>
export type ErpPlanDecision = z.infer<typeof erpPlanDecision>
export type ErpExecuteInput = z.infer<typeof erpExecuteInput>
export type ErpPlanSnapshot = z.infer<typeof erpPlanSnapshot>
export type ErpPlanState = z.infer<typeof erpPlanState>
