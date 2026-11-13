import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { ControlError, role, tokenSchema } from '../contract'

export const providerId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u)
export const protocol = z.enum(['anthropic', 'openai'])
export const classification = z.enum(['general', 'internal', 'restricted'])
export const capability = z.enum(['text', 'tools', 'vision', 'reasoning'])
export const effort = z.enum(['low', 'medium', 'high'])
const label = z.string().trim().min(1).max(120)
const dailyLimit = z.number().int().min(1).max(1_000_000_000).nullable().default(null)

export const providerInput = z.strictObject({
  id: providerId, displayName: label, protocol,
  baseUrl: z.string().min(1).max(1024),
  apiKey: z.string().min(1).max(1024).regex(/^[\x21-\x7e]+$/u).optional(),
  authHeader: z.enum(['bearer', 'x-api-key']),
  classifications: z.array(classification).min(1).max(3),
  streamUsage: z.boolean().default(true), enabled: z.boolean().default(true),
}).refine(input => input.protocol === 'anthropic' || input.authHeader === 'bearer')

export const modelInput = z.strictObject({
  id: providerId, providerId, displayName: label, upstreamModel: z.string().trim().min(1).max(200),
  capabilities: z.array(capability).min(1).max(4).refine(values => values.includes('text')),
  contextWindow: z.number().int().min(1024).max(2_000_000),
  maxOutputTokens: z.number().int().min(1).max(2_000_000), defaultEffort: effort.nullable().default(null),
  allowedRoles: z.array(role).min(1).max(7), projectId: z.uuid().nullable().default(null),
  isDefault: z.boolean().default(false), enabled: z.boolean().default(true),
  allowContext: z.boolean().default(false),
  allowErpRead: z.boolean().default(false),
  dailyTokens: dailyLimit, softDailyTokens: dailyLimit,
}).refine(input => input.maxOutputTokens <= input.contextWindow &&
  (input.softDailyTokens === null || input.dailyTokens === null || input.softDailyTokens <= input.dailyTokens) &&
  (input.defaultEffort === null || input.capabilities.includes('reasoning')) &&
  (!input.allowErpRead || input.capabilities.includes('tools')))

export const projectInput = z.strictObject({ id: z.uuid().optional(), name: label, classification, active: z.boolean().default(true) })
export const membershipInput = z.strictObject({ projectId: z.uuid(), userId: z.uuid(), enabled: z.boolean() })
export const departmentInput = z.strictObject({ id: z.uuid().optional(), name: label })
export const userDepartmentInput = z.strictObject({ userId: z.uuid(), departmentId: z.uuid().nullable() })
export const grantInput = z.strictObject({ modelId: providerId, projectId: z.uuid().optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/u) })
export const modelContextInput = z.strictObject({ modelId: providerId, projectId: z.uuid().optional(),
  query: z.string().trim().min(1).max(160), source: z.enum(['memory', 'knowledge', 'both']).default('both'),
  limit: z.number().int().min(1).max(6).default(4) })

export type Protocol = z.infer<typeof protocol>
export type Classification = z.infer<typeof classification>
export type Capability = z.infer<typeof capability>
export type Effort = z.infer<typeof effort>
export type ApiKind = 'messages' | 'count_tokens' | 'chat_completions'
export type ProviderInput = z.infer<typeof providerInput>
export type ModelInput = z.infer<typeof modelInput>

export interface ModelGatewayConfig {
  encryptionKey: Uint8Array
  allowedUpstreams: ReadonlySet<string>
  allowLoopback: boolean
}

export function normalizeUpstream(value: string, allowLoopback: boolean): string {
  const parsed = new URL(value)
  const development = allowLoopback && parsed.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname)
  if ((!development && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.search || parsed.hash ||
    /(?:%2f|%5c|\\)/iu.test(value)) throw new Error('Use a configured HTTPS API base address.')
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`
}

export function loadModelConfig(env: Record<string, string | undefined>, origin: string, allowLoopback = origin.startsWith('http:')): ModelGatewayConfig | undefined {
  const key = env.ENTERPRISE_MODEL_ENCRYPTION_KEY
  const upstreams = env.ENTERPRISE_MODEL_UPSTREAMS
  if (!key && !upstreams) return undefined
  if (!key || !tokenSchema.safeParse(key).success || !upstreams) throw new Error('Configure a 32-byte base64url model encryption key and the allowed upstreams.')
  const encryptionKey = Buffer.from(key, 'base64url')
  if (encryptionKey.length !== 32 || encryptionKey.toString('base64url') !== key) throw new Error('Invalid model encryption key.')
  const allowedUpstreams = new Set(upstreams.split(',').map(item => normalizeUpstream(item.trim(), allowLoopback)))
  return { encryptionKey, allowedUpstreams, allowLoopback }
}

export function approvedUpstream(value: string, config: ModelGatewayConfig): string {
  try {
    const url = normalizeUpstream(value, config.allowLoopback)
    if (config.allowedUpstreams.has(url)) return url
  } catch { /* Return a safe error without reflecting the URL. */ }
  throw new ControlError(400, 'UPSTREAM_NOT_APPROVED', 'Use an API base address from the approved server list.')
}

export function sealKey(secret: string, key: Uint8Array, tenantId: string, id: string): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(JSON.stringify([tenantId, id])))
  const value = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return ['v1', nonce.toString('base64url'), value.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}

export function openKey(sealed: string, key: Uint8Array, tenantId: string, id: string): string {
  const [version, nonce, data, tag] = sealed.split('.')
  if (version !== 'v1' || !nonce || !data || !tag) throw new Error('Unsupported key envelope')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'))
  decipher.setAAD(Buffer.from(JSON.stringify([tenantId, id])))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
}

export const proxyEndpoint = (value: Protocol) => `/api/v1/model-gateway/${value}`
