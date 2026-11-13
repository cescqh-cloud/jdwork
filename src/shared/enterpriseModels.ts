export const enterpriseModelPaths = {
  anthropic: '/api/v1/model-gateway/anthropic',
  openai: '/api/v1/model-gateway/openai',
} as const

export const enterpriseEfforts = ['low', 'medium', 'high'] as const
const capabilities = ['text', 'tools', 'vision', 'reasoning'] as const
const providerPrefix = 'enterprise:'
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,139}$/
const sessionIdPattern = /^[a-z0-9_-]{1,64}$/i

export const enterpriseOfficeOrigin = 'http://192.168.254.203:8081'

export const enterpriseBrokerEnv = {
  origin: 'CC_HAHA_ENTERPRISE_BROKER_ORIGIN',
  secret: 'CC_HAHA_ENTERPRISE_BROKER_SECRET',
  officeOrigin: 'LIYUAN_ENTERPRISE_OFFICE_ORIGIN',
} as const

export type EnterpriseModel = {
  providerId: string
  modelId: string
  displayName: string
  protocol: keyof typeof enterpriseModelPaths
  capabilities: Array<typeof capabilities[number]>
  contextWindow: number
  maxOutputTokens: number
  defaultEffort: typeof enterpriseEfforts[number] | null
  proxyEndpoint: typeof enterpriseModelPaths[keyof typeof enterpriseModelPaths]
  projectId: string | null
  isDefault: boolean
  canSearchContext?: boolean
  canQueryErp?: boolean
  quota: { dailyTokens: number | null; softDailyTokens: number | null }
}

export type EnterpriseModelCatalog = {
  deviceId: string
  revision: number
  expiresAt: string
  models: EnterpriseModel[]
}

export type EnterpriseGrantInput = {
  providerId: string
  modelId: string
  sessionId: string
  protocol: EnterpriseModel['protocol']
  projectId?: string
}

export type EnterpriseGrant = {
  origin: string
  accessToken: string
  expiresAt: string
  proxyEndpoint: EnterpriseModel['proxyEndpoint']
}

export const enterpriseContextSources = ['memory', 'knowledge', 'both'] as const
export type EnterpriseContextQuery = {
  query: string
  source: typeof enterpriseContextSources[number]
  limit: number
}
export type EnterpriseContextInput = EnterpriseContextQuery & Pick<EnterpriseGrantInput, 'providerId' | 'modelId' | 'projectId'>
export type EnterpriseContextResult = {
  revision: number
  modelId: string
  projectId: string | null
  memories: Array<{ id: string; revision: number; scope: string; excerpt: string; lastVerifiedAt: string | null }>
  knowledge: Array<{ title: string; excerpt: string; source: { label: string }; citation: { documentId: string; revision: number; checksum: string } }>
}

export function isEnterpriseProviderId(id: unknown): id is `enterprise:${string}` {
  return typeof id === 'string' && id.startsWith(providerPrefix)
}

export function enterpriseDeviceFromProviderId(id: string): string | null {
  if (!isEnterpriseProviderId(id)) return null
  const deviceId = id.slice(providerPrefix.length, providerPrefix.length + 36)
  const suffix = id.slice(providerPrefix.length + 37)
  return uuid.test(deviceId) && id[providerPrefix.length + 36] === ':' && identifier.test(suffix) ? deviceId : null
}

export function isEnterpriseProjectId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWhole(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
}

function isQuota(value: unknown): value is number | null {
  return value === null || isWhole(value, 1)
}

export function isEnterpriseProtocol(value: unknown): value is EnterpriseModel['protocol'] {
  return value === 'anthropic' || value === 'openai'
}

export function isEnterpriseTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value))
}

export function isEnterpriseEffort(value: unknown): value is typeof enterpriseEfforts[number] {
  return value === 'low' || value === 'medium' || value === 'high'
}

function isEnterpriseCapability(value: unknown): value is typeof capabilities[number] {
  return capabilities.some(capability => capability === value)
}

/** Validate policy metadata and explicitly copy only fields that may reach the renderer. */
export function parseEnterpriseModelCatalog(value: unknown, deviceId: string, fromBroker = false): EnterpriseModelCatalog | null {
  if (!isRecord(value) || !isEnterpriseProjectId(deviceId) || !isWhole(value.revision)
    || !isEnterpriseTimestamp(value.expiresAt) || !Array.isArray(value.models) || value.models.length > 256) return null
  const models: EnterpriseModel[] = []
  const seen = new Set<string>()
  for (const model of value.models) {
    if (!isRecord(model) || typeof model.providerId !== 'string'
      || (!fromBroker && !identifier.test(model.providerId))
      || typeof model.modelId !== 'string' || !identifier.test(model.modelId)
      || typeof model.displayName !== 'string' || model.displayName.trim().length === 0 || model.displayName.length > 160
      || !isEnterpriseProtocol(model.protocol) || model.proxyEndpoint !== enterpriseModelPaths[model.protocol]
      || !Array.isArray(model.capabilities) || model.capabilities.length > capabilities.length || !model.capabilities.every(isEnterpriseCapability)
      || !isWhole(model.contextWindow, 1) || !isWhole(model.maxOutputTokens, 1)
      || (model.defaultEffort !== null && !isEnterpriseEffort(model.defaultEffort))
      || (model.projectId !== null && !isEnterpriseProjectId(model.projectId)) || typeof model.isDefault !== 'boolean'
      || (model.canSearchContext !== undefined && typeof model.canSearchContext !== 'boolean')
      || (model.canQueryErp !== undefined && typeof model.canQueryErp !== 'boolean')
      || !isRecord(model.quota) || !isQuota(model.quota.dailyTokens) || !isQuota(model.quota.softDailyTokens)) return null
    if (fromBroker && enterpriseDeviceFromProviderId(model.providerId) !== deviceId) return null
    const providerId = fromBroker ? model.providerId : `${providerPrefix}${deviceId}:${model.providerId}`
    const key = JSON.stringify([providerId, model.modelId])
    if (seen.has(key)) return null
    seen.add(key)
    models.push({
      providerId, modelId: model.modelId, displayName: model.displayName,
      protocol: model.protocol, capabilities: model.capabilities, contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      defaultEffort: model.defaultEffort, proxyEndpoint: enterpriseModelPaths[model.protocol],
      projectId: model.projectId, isDefault: model.isDefault, canSearchContext: model.canSearchContext === true,
      canQueryErp: model.canQueryErp === true,
      quota: { dailyTokens: model.quota.dailyTokens, softDailyTokens: model.quota.softDailyTokens },
    })
  }
  return { deviceId, revision: value.revision, expiresAt: value.expiresAt, models }
}

export function parseEnterpriseContextQuery(value: unknown): EnterpriseContextQuery | null {
  if (!isRecord(value) || typeof value.query !== 'string' || value.query.length > 160
    || !value.query.trim() || value.query.includes('\u0000')) return null
  const { source = 'both', limit = 4 } = value
  if ((source !== 'memory' && source !== 'knowledge' && source !== 'both') || !isWhole(limit, 1) || limit > 6) return null
  return { query: value.query.trim(), source, limit }
}

export function parseEnterpriseContextInput(value: unknown): EnterpriseContextInput | null {
  const query = parseEnterpriseContextQuery(value)
  if (!query || !isRecord(value) || typeof value.providerId !== 'string' || !enterpriseDeviceFromProviderId(value.providerId)
    || typeof value.modelId !== 'string' || !identifier.test(value.modelId)
    || (value.projectId !== undefined && !isEnterpriseProjectId(value.projectId))) return null
  return { ...query, providerId: value.providerId, modelId: value.modelId, ...(value.projectId ? { projectId: value.projectId } : {}) }
}

export function parseEnterpriseContextResult(value: unknown, input: EnterpriseContextInput): EnterpriseContextResult | null {
  if (!isRecord(value) || value.modelId !== input.modelId || value.projectId !== (input.projectId ?? null) || !isWhole(value.revision)
    || !Array.isArray(value.memories) || value.memories.length > input.limit || !Array.isArray(value.knowledge) || value.knowledge.length > input.limit) return null
  const memories: EnterpriseContextResult['memories'] = []
  const knowledge: EnterpriseContextResult['knowledge'] = []
  for (const memory of value.memories) {
    if (!isRecord(memory) || !isEnterpriseProjectId(memory.id) || !isWhole(memory.revision, 1)
      || (memory.scope !== 'user_private' && memory.scope !== 'project_private' && memory.scope !== 'team_shared')
      || (memory.scope === 'project_private' && !input.projectId) || typeof memory.excerpt !== 'string' || memory.excerpt.length > 1400
      || (memory.lastVerifiedAt !== null && !isEnterpriseTimestamp(memory.lastVerifiedAt))) return null
    memories.push({ id: memory.id, revision: memory.revision, scope: memory.scope, excerpt: memory.excerpt, lastVerifiedAt: memory.lastVerifiedAt })
  }
  for (const item of value.knowledge) {
    if (!isRecord(item) || typeof item.title !== 'string' || item.title.length > 160
      || typeof item.excerpt !== 'string' || item.excerpt.length > 1200
      || !isRecord(item.source) || typeof item.source.label !== 'string' || item.source.label.length > 120
      || !isRecord(item.citation) || !isEnterpriseProjectId(item.citation.documentId) || !isWhole(item.citation.revision, 1)
      || typeof item.citation.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(item.citation.checksum)) return null
    knowledge.push({ title: item.title, excerpt: item.excerpt, source: { label: item.source.label },
      citation: { documentId: item.citation.documentId, revision: item.citation.revision, checksum: item.citation.checksum } })
  }
  return { revision: value.revision, modelId: input.modelId, projectId: input.projectId ?? null, memories, knowledge }
}

export function parseEnterpriseGrantInput(value: unknown): EnterpriseGrantInput | null {
  if (!isRecord(value) || typeof value.providerId !== 'string' || !enterpriseDeviceFromProviderId(value.providerId)
    || typeof value.modelId !== 'string' || !identifier.test(value.modelId)
    || typeof value.sessionId !== 'string' || !sessionIdPattern.test(value.sessionId)
    || !isEnterpriseProtocol(value.protocol) || (value.projectId !== undefined && !isEnterpriseProjectId(value.projectId))) return null
  return {
    providerId: value.providerId, modelId: value.modelId, sessionId: value.sessionId, protocol: value.protocol,
    ...(value.projectId ? { projectId: value.projectId } : {}),
  }
}
