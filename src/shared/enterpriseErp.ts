import { z } from 'zod/v4'
import { enterpriseDeviceFromProviderId } from './enterpriseModels.js'

const code = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const erpKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/u)
const label = z.string().min(1).max(120)
const kind = z.enum(['connection', 'metadata', 'document'])
const mode = z.enum(['test', 'sandbox'])
const columnKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/u)
  .refine(value => !/token|secret|password|passwd|credential|cookie|phone|mobile|email|api_?key|authorization/iu.test(value))
  .refine(value => value !== 'constructor' && value !== 'prototype')
const scalar = z.union([z.string().max(800), z.number(), z.boolean(), z.null()])

export const enterpriseErpReadArguments = z.strictObject({
  projectId: z.uuid(), environmentId: erpKey, operation: erpKey,
  number: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/u).optional(),
})

type ReadArguments = z.infer<typeof enterpriseErpReadArguments>
export type EnterpriseErpQuery = { action: 'list' } | ({ action: 'read' } & ReadArguments)
type ModelScope = { providerId: string; modelId: string; sessionId: string; modelProjectId?: string }
export type EnterpriseErpInput = EnterpriseErpQuery & ModelScope

export function enterpriseErpProviderCode(id: string): string | null {
  const device = enterpriseDeviceFromProviderId(id)
  if (!device) return null
  const provider = id.slice('enterprise:'.length + device.length + 1)
  return code.test(provider) ? provider : null
}

const scope = {
  providerId: z.string().refine(id => enterpriseErpProviderCode(id) !== null),
  modelId: z.string().regex(code),
  sessionId: z.string().regex(/^[a-z0-9_-]{1,64}$/iu),
  modelProjectId: z.uuid().optional(),
}
const brokerInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), ...scope }),
  z.strictObject({ action: z.literal('read'), ...scope, ...enterpriseErpReadArguments.shape }),
])

export function parseEnterpriseErpInput(value: unknown): EnterpriseErpInput | null {
  const parsed = brokerInput.safeParse(value)
  if (!parsed.success) return null
  const input = parsed.data
  return input.action === 'read' && input.modelProjectId && input.modelProjectId !== input.projectId ? null : input
}

const query = z.object({ id: erpKey, label, kind, requiresNumber: z.boolean() })
const environment = z.object({
  id: erpKey, name: label, mode,
  projects: z.array(z.object({ id: z.uuid(), name: label })).max(30),
  queries: z.array(query).max(25),
})
const listResult = z.object({ action: z.literal('list'), environments: z.array(environment).max(20) })
const readResult = z.object({ action: z.literal('read'), result: z.object({
  requestId: z.uuid(), projectId: z.uuid(), environmentId: erpKey, environmentName: label, mode, operation: erpKey,
  query: query.extend({ columns: z.array(z.object({ key: columnKey, title: label })).max(24) }),
  checkedAt: z.iso.datetime(), rows: z.array(z.record(z.string(), z.unknown())).max(10), truncated: z.boolean(),
}) })

export type EnterpriseErpResult = z.infer<typeof listResult> | {
  action: 'read'; result: Omit<z.infer<typeof readResult>['result'], 'rows'> & { rows: Record<string, z.infer<typeof scalar>>[] }
}

/** Project only the authorized shape and bind a reply to the requested action. */
export function parseEnterpriseErpResult(value: unknown, input: EnterpriseErpQuery & { modelProjectId?: string }): EnterpriseErpResult | null {
  if (input.action === 'list') {
    const result = listResult.safeParse(value)
    if (!result.success || result.data.environments.some(env => env.projects.some(project =>
      input.modelProjectId !== undefined && project.id !== input.modelProjectId))) return null
    return result.data
  }
  const parsed = readResult.safeParse(value)
  if (!parsed.success || (input.modelProjectId && input.modelProjectId !== input.projectId)) return null
  const { result } = parsed.data
  const { columns, id, kind, requiresNumber } = result.query
  if (result.projectId !== input.projectId || result.environmentId !== input.environmentId || result.operation !== input.operation ||
      id !== input.operation || requiresNumber !== Boolean(input.number) || requiresNumber !== (kind === 'document') ||
      (kind === 'connection' && result.rows.length > 0) || new Set(columns.map(column => column.key)).size !== columns.length) return null
  const rows = result.rows.map(row => Object.fromEntries(columns.map(({ key }) => {
    const cell = scalar.safeParse(Object.hasOwn(row, key) ? row[key] : null)
    return [key, cell.success ? cell.data : null]
  })))
  return { action: 'read', result: { ...result, rows } }
}
