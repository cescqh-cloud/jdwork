import { z } from 'zod'
import { loadDingTalkConnections, type DingTalkConnection } from './demands/service'
import { loadDingTalkStream, type DingTalkStreamConfig } from './dingtalk-stream'
import { loadErpEnvironments, type ErpEnvironment } from './erp/contract'
import { loadOidcConfig, type OidcConfig } from './identity'
import { loadModelConfig, providerId, type ModelGatewayConfig } from './models/contract'
import { loadReleaseConfig, type ReleaseConfig } from './releases/signatures'
import { loadPiAuthConfig, privateHttpOrigin, type PiAuthConfig } from './pi-auth'
import { createPiContext } from './pi-context'

const literalLoopback = new Set(['localhost', '127.0.0.1', '[::1]'])

function serviceUrl(value: string, protocols: readonly string[], field: string): string {
  let url: URL
  try { url = new URL(value) }
  catch { throw new Error(`${field} requires a valid URL`) }
  if (!protocols.includes(url.protocol) || !url.hostname || url.hash) {
    throw new Error(`${field} uses an unsupported address`)
  }
  return value
}

export function controlOrigin(value: string): string {
  const url = new URL(value)
  const local = url.protocol === 'http:' && literalLoopback.has(url.hostname)
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ENTERPRISE_ORIGIN requires an HTTPS origin or a loopback development address')
  }
  return url.origin
}

export interface ControlConfig {
  origin: string
  host: string
  port: number
  databaseUrl: string
  redisUrl: string
  localLogin: boolean
  piAuth?: PiAuthConfig
  piContext?: ReturnType<typeof createPiContext>
  modelGateway?: ModelGatewayConfig
  oidc?: OidcConfig
  demandPrecheckModel?: string
  dingTalkConnections?: ReadonlyMap<string, DingTalkConnection>
  dingTalkStream?: DingTalkStreamConfig
  releases?: ReleaseConfig
  erpEnvironments?: readonly ErpEnvironment[]
}

export function loadControlConfig(env: Record<string, string | undefined>): ControlConfig {
  const port = z.coerce.number().int().min(1).max(65535).parse(env.ENTERPRISE_PORT ?? '8787')
  const intranet = env.ENTERPRISE_INTRANET_ORIGIN
    ? privateHttpOrigin(env.ENTERPRISE_INTRANET_ORIGIN, 'ENTERPRISE_INTRANET_ORIGIN') : undefined
  if (intranet && env.ENTERPRISE_ORIGIN && env.ENTERPRISE_ORIGIN !== intranet) {
    throw new Error('ENTERPRISE_ORIGIN must match the configured intranet origin.')
  }
  const origin = intranet ?? controlOrigin(env.ENTERPRISE_ORIGIN ?? `http://127.0.0.1:${port}`)
  const host = env.ENTERPRISE_HOST ?? '127.0.0.1'
  if (intranet && (host !== new URL(intranet).hostname || Number(new URL(intranet).port || '80') !== port)) {
    throw new Error('The intranet listener must match the configured IP and port.')
  }
  if (!intranet && origin.startsWith('http:') && !literalLoopback.has(host)) {
    throw new Error('HTTP development mode requires a loopback listener')
  }
  const localLogin = env.ENTERPRISE_LOCAL_LOGIN === 'true'
  const development = !intranet && origin.startsWith('http:')
  if (localLogin && !development) throw new Error('Password sign-in is restricted to loopback development mode')
  const piAuth = loadPiAuthConfig(env, intranet)
  if (intranet && !piAuth) throw new Error('Intranet mode requires Pi identity configuration.')
  const contextToken = env.ENTERPRISE_PI_CONTEXT_TOKEN
  if (contextToken && !piAuth) throw new Error('Pi shared context requires Pi identity configuration.')
  const piContext = contextToken && piAuth ? createPiContext({ origin: piAuth.origin, token: contextToken }) : undefined
  const modelGateway = loadModelConfig(env, origin, development)
  const demandPrecheckModel = env.ENTERPRISE_DEMAND_PRECHECK_MODEL ? providerId.parse(env.ENTERPRISE_DEMAND_PRECHECK_MODEL) : undefined
  if (demandPrecheckModel && !modelGateway) throw new Error('Configure the enterprise model gateway before enabling demand precheck')
  return {
    origin, host, port,
    databaseUrl: serviceUrl(env.ENTERPRISE_DATABASE_URL ?? '', ['postgres:', 'postgresql:'], 'ENTERPRISE_DATABASE_URL'),
    redisUrl: serviceUrl(env.ENTERPRISE_REDIS_URL ?? '', ['redis:', 'rediss:'], 'ENTERPRISE_REDIS_URL'),
    localLogin, piAuth, piContext,
    modelGateway,
    oidc: loadOidcConfig(env, origin),
    demandPrecheckModel,
    dingTalkConnections: loadDingTalkConnections(env),
    dingTalkStream: loadDingTalkStream(env),
    releases: loadReleaseConfig(env),
    erpEnvironments: loadErpEnvironments(env, development),
  }
}
