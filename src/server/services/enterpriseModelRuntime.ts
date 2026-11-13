import {
  enterpriseBrokerEnv, enterpriseModelPaths, enterpriseOfficeOrigin, isEnterpriseProjectId, isEnterpriseTimestamp, parseEnterpriseModelCatalog,
  parseEnterpriseContextResult, type EnterpriseContextQuery, type EnterpriseGrant, type EnterpriseModel, type EnterpriseModelCatalog,
} from '../../shared/enterpriseModels.js'
import { parseEnterpriseErpInput, parseEnterpriseErpResult, type EnterpriseErpQuery } from '../../shared/enterpriseErp.js'
import { parsePiContextInput, parsePiContextResult, type PiContextInput } from '../../shared/piContext.js'
import { MODEL_CONTEXT_WINDOWS_ENV_KEY, MODEL_MAX_OUTPUT_TOKENS_ENV_KEY } from '../../utils/model/modelContextWindows.js'
import { PROVIDER_MAX_OUTPUT_TOKENS_ENV_KEY } from '../../utils/managedEnvConstants.js'

export const enterpriseModelUnavailable = 'Enterprise model unavailable or not authorized. Reconnect to the enterprise server or choose another model.'

type BrokerSettings = { origin: string; secret: string; officeOrigin?: string }

function consumeBrokerSettings(env: NodeJS.ProcessEnv): BrokerSettings | null {
  const { origin, secret, officeOrigin } = enterpriseBrokerEnv
  const settings = { origin: env[origin], secret: env[secret], officeOrigin: env[officeOrigin] }
  // Only this service owns the sidecar credential. Never pass it to the CLI,
  // terminal, MCP workers or detached adapter processes.
  delete env[origin]
  delete env[secret]
  delete env[officeOrigin]
  return settings.origin && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(settings.origin)
    && settings.secret && /^[A-Za-z0-9_-]{43}$/.test(settings.secret)
    ? { origin: settings.origin, secret: settings.secret,
        ...(settings.officeOrigin === enterpriseOfficeOrigin ? { officeOrigin: settings.officeOrigin } : {}) }
    : null
}

function isEnterpriseOrigin(value: unknown, officeOrigin?: string) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.origin === value && (
      url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))
      || (value === enterpriseOfficeOrigin && officeOrigin === enterpriseOfficeOrigin)
    )
  } catch {
    return false
  }
}

export class EnterpriseModelRuntime {
  constructor(private readonly broker: BrokerSettings | null, private readonly fetchBroker: typeof fetch = fetch) {}

  async catalog(projectId?: string, signal?: AbortSignal): Promise<EnterpriseModelCatalog | null> {
    if (projectId !== undefined && !isEnterpriseProjectId(projectId)) return null
    const value = await this.request('/catalog' + (projectId ? `?projectId=${projectId}` : ''), undefined, signal)
    if (!value || typeof value.deviceId !== 'string') return null
    const catalog = parseEnterpriseModelCatalog(value, value.deviceId, true)
    return catalog && Date.parse(catalog.expiresAt) > Date.now() ? catalog : null
  }

  async model(providerId: string, modelId: string, projectId?: string, signal?: AbortSignal): Promise<EnterpriseModel | null> {
    const catalog = await this.catalog(projectId, signal)
    return catalog?.models.find(model => model.providerId === providerId && model.modelId === modelId) ?? null
  }

  async grant(model: EnterpriseModel, sessionId: string): Promise<EnterpriseGrant | null> {
    const { providerId, modelId, protocol, projectId } = model
    const value = await this.request('/grant', {
      providerId, modelId, sessionId, protocol, ...(projectId ? { projectId } : {}),
    })
    if (!value || typeof value.origin !== 'string' || !isEnterpriseOrigin(value.origin, this.broker?.officeOrigin)
      || typeof value.accessToken !== 'string' || !/^[A-Za-z0-9._~-]{20,4096}$/.test(value.accessToken)
      || !isEnterpriseTimestamp(value.expiresAt) || Date.parse(value.expiresAt) <= Date.now()
      || value.proxyEndpoint !== enterpriseModelPaths[protocol]) return null
    return {
      origin: value.origin, accessToken: value.accessToken, expiresAt: value.expiresAt,
      proxyEndpoint: enterpriseModelPaths[protocol],
    }
  }

  async context(model: EnterpriseModel, query: EnterpriseContextQuery, signal?: AbortSignal) {
    if (!model.canSearchContext || !model.capabilities.includes('tools')) return null
    const { providerId, modelId, projectId } = model
    const input = { ...query, providerId, modelId, ...(projectId ? { projectId } : {}) }
    return parseEnterpriseContextResult(await this.request('/context', input, signal), input)
  }

  async piContext(value: PiContextInput, signal?: AbortSignal) {
    const input = parsePiContextInput(value)
    if (!input) return null
    return parsePiContextResult(await this.request('/pi-context', input, signal, 20_000), input.kind)
  }

  async erp(model: EnterpriseModel, sessionId: string, query: EnterpriseErpQuery, signal?: AbortSignal) {
    if (!model.canQueryErp || !model.capabilities.includes('tools')) return null
    const { providerId, modelId, projectId } = model
    const input = parseEnterpriseErpInput({ ...query, providerId, modelId, sessionId, ...(projectId ? { modelProjectId: projectId } : {}) })
    if (!input) return null
    return parseEnterpriseErpResult(await this.request('/erp', input, signal, 30_000), input)
  }

  private async request(route: string, body?: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 15_000): Promise<Record<string, unknown> | null> {
    if (!this.broker) return null
    try {
      signal?.throwIfAborted()
      const deadline = AbortSignal.timeout(timeoutMs)
      const response = await this.fetchBroker(new URL(route, this.broker.origin), {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${this.broker.secret}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return null
      }
      const value: unknown = await response.json()
      signal?.throwIfAborted()
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
    } catch {
      return null
    }
  }
}

export const enterpriseModelRuntime = new EnterpriseModelRuntime(consumeBrokerSettings(process.env))

export function buildEnterpriseModelEnv(model: EnterpriseModel, sdkUrl: string): Record<string, string> {
  const sdk = new URL(sdkUrl)
  const sessionId = sdk.pathname.split('/').pop()
  const token = sdk.searchParams.get('token')
  if (sdk.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(sdk.hostname)
    || !sessionId || !/^[a-z0-9_-]{1,64}$/i.test(sessionId) || !token) throw new Error(enterpriseModelUnavailable)
  return {
    ANTHROPIC_BASE_URL: `http://${sdk.host}/proxy/enterprise/${sessionId}`,
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_MODEL: model.modelId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model.modelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model.modelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model.modelId,
    [MODEL_CONTEXT_WINDOWS_ENV_KEY]: JSON.stringify({ [model.modelId]: model.contextWindow }),
    [MODEL_MAX_OUTPUT_TOKENS_ENV_KEY]: JSON.stringify({ [model.modelId]: model.maxOutputTokens }),
    [PROVIDER_MAX_OUTPUT_TOKENS_ENV_KEY]: String(model.maxOutputTokens),
    ENABLE_TOOL_SEARCH: 'false',
  }
}
