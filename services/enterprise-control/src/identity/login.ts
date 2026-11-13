import type { RedisClient } from 'bun'
import { createHash } from 'node:crypto'
import { decode, verify } from 'hono/jwt'
import { z } from 'zod'
import { ControlError, randomToken, tenantSlug, tokenDigest, tokenSchema } from '../contract'
import type { OidcConfig } from './config'

export const oidcFlowLifetimeSeconds = 300
const providerTimeoutMs = 5000
const providerResponseLimit = 65_536
const compactPart = z.string().regex(/^[A-Za-z0-9_-]+$/u)
export const oidcSubject = z.string().regex(/^[\x21-\x7e]{1,255}$/u)

const storedFlow = z.strictObject({
  tenant: tenantSlug,
  nonce: tokenSchema,
  verifier: tokenSchema,
  provider: z.string().regex(/^[a-f0-9]{64}$/u),
})
const keyId = z.string().min(1).max(512)
const header = z.object({
  alg: z.literal('RS256'),
  kid: keyId.optional(),
  jwk: z.never().optional(),
  jku: z.never().optional(),
  x5u: z.never().optional(),
})
const signingKey = z.object({
  kid: keyId.optional(),
  kty: z.literal('RSA'),
  alg: z.literal('RS256').optional(),
  use: z.literal('sig').optional(),
  key_ops: z.tuple([z.literal('verify')]).optional(),
  n: compactPart.min(342).max(1366),
  e: compactPart.max(12),
  d: z.never().optional(),
})
const jwksResponse = z.object({ keys: z.array(z.unknown()).max(64) })
const tokenResponse = z.object({ id_token: z.string().max(16_384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u) })
const identityClaims = z.object({
  sub: oidcSubject,
  nonce: tokenSchema,
  aud: z.union([z.string(), z.tuple([z.string()])]),
  azp: z.string().optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
})

type FetchOidc = (url: string, init: RequestInit) => Promise<Response>

export interface OidcStateStore {
  remember(key: string, value: string, ttlSeconds: number): Promise<boolean>
  take(key: string): Promise<string | null>
}

export interface VerifiedOidcIdentity {
  tenant: string
  issuer: string
  subject: string
}

export function redisOidcState(redis: Pick<RedisClient, 'send'>): OidcStateStore {
  const redisKey = (key: string) => `enterprise-control:oidc:flow:v1:${key}`
  return {
    async remember(key, value, ttlSeconds) {
      return await redis.send('SET', [redisKey(key), value, 'EX', String(ttlSeconds), 'NX']) === 'OK'
    },
    async take(key) {
      const result: unknown = await redis.send('GETDEL', [redisKey(key)])
      return typeof result === 'string' ? result : null
    },
  }
}

const invalidLogin = () => new ControlError(401, 'OIDC_LOGIN_FAILED', '企业登录未能验证，请重新发起。')
const providerUnavailable = () => new ControlError(503, 'OIDC_PROVIDER_UNAVAILABLE', '企业身份服务暂时不可用，请稍后重试。')

function stateKey(state: string, browserBinding: string): string {
  return tokenDigest(state + ':' + browserBinding)
}

function formComponent(value: string): string {
  return new URLSearchParams([['', value]]).toString().slice(1)
}

async function providerJson(fetcher: FetchOidc, url: string, init: RequestInit, tokenExchange = false): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(url, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(providerTimeoutMs) })
  } catch {
    throw providerUnavailable()
  }
  if (!response.ok) {
    if (tokenExchange && response.status >= 400 && response.status < 500 && response.status !== 429) throw invalidLogin()
    throw providerUnavailable()
  }
  const contentType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
  if (!response.body || (contentType !== 'application/json' && contentType !== 'application/jwk-set+json')) {
    throw providerUnavailable()
  }
  const reader = response.body.getReader()
  try {
    let size = 0
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > providerResponseLimit) {
        void reader.cancel().catch(() => {})
        throw providerUnavailable()
      }
      chunks.push(value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    throw providerUnavailable()
  } finally { reader.releaseLock() }
}

function verificationKeys(rawKeys: unknown[], kid?: string) {
  const matching = []
  for (const rawKey of rawKeys) {
    const key = signingKey.safeParse(rawKey)
    if (!key.success || (kid !== undefined && key.data.kid !== kid)) continue
    const modulus = Buffer.from(key.data.n, 'base64url')
    // Require a canonical unsigned RSA modulus with at least 2048 bits.
    if (modulus.toString('base64url') !== key.data.n || modulus[0] === 0
      || modulus.length < 256 || (modulus.length === 256 && modulus[0]! < 128)) continue
    matching.push(key.data)
  }
  return matching
}

async function verifyToken(fetcher: FetchOidc, config: OidcConfig, idToken: string, nonce: string): Promise<string> {
  const tokenHeader = (() => {
    try { return header.safeParse(decode(idToken).header) }
    catch { throw invalidLogin() }
  })()
  if (!tokenHeader.success) throw invalidLogin()
  // Read the configured JWKS on every redemption so a newly published signing key takes effect immediately.
  const jwks = jwksResponse.safeParse(await providerJson(fetcher, config.jwksUri, {
    headers: { Accept: 'application/json, application/jwk-set+json' },
  }))
  if (!jwks.success) throw providerUnavailable()
  const keys = verificationKeys(jwks.data.keys, tokenHeader.data.kid)
  if (keys.length !== 1) throw invalidLogin()
  const claims = await verify(idToken, keys[0]!, { alg: 'RS256', iss: config.issuer, aud: config.clientId })
    .catch(() => { throw invalidLogin() })
  const identity = identityClaims.safeParse(claims)
  if (!identity.success || identity.data.nonce !== nonce || identity.data.exp <= identity.data.iat
    || (identity.data.azp !== undefined && identity.data.azp !== config.clientId)) throw invalidLogin()
  return identity.data.sub
}

async function exchangeCode(fetcher: FetchOidc, config: OidcConfig, code: string, verifier: string): Promise<string> {
  const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' })
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  })
  if (config.tokenAuthMethod === 'client_secret_post') {
    body.set('client_id', config.clientId)
    body.set('client_secret', config.clientSecret)
  } else {
    const credentials = formComponent(config.clientId) + ':' + formComponent(config.clientSecret)
    headers.set('Authorization', 'Basic ' + Buffer.from(credentials).toString('base64'))
  }
  const response = tokenResponse.safeParse(await providerJson(fetcher, config.tokenEndpoint, { method: 'POST', headers, body }, true))
  if (!response.success) throw invalidLogin()
  return response.data.id_token
}

export function createOidcLogin(config: OidcConfig, stateStore: OidcStateStore, fetcher: FetchOidc = fetch) {
  const provider = tokenDigest(JSON.stringify([config.issuer, config.clientId, config.tokenEndpoint, config.jwksUri, config.redirectUri]))
  return {
    async begin(tenant: string) {
      if (!tenantSlug.safeParse(tenant).success) throw new ControlError(400, 'INVALID_INPUT', '请输入有效的组织代码。')
      const state = randomToken()
      const browserBinding = randomToken()
      const verifier = randomToken()
      const nonce = randomToken()
      const key = stateKey(state, browserBinding)
      if (!await stateStore.remember(key, JSON.stringify({ tenant, nonce, verifier, provider }), oidcFlowLifetimeSeconds)) {
        throw providerUnavailable()
      }
      const url = new URL(config.authorizationEndpoint)
      url.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        response_mode: 'query',
        scope: 'openid',
        redirect_uri: config.redirectUri,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      }).toString()
      return { authorizationUrl: url.href, browserBinding }
    },
    async complete(query: URLSearchParams, browserBinding: string | undefined): Promise<VerifiedOidcIdentity> {
      const states = query.getAll('state')
      if (states.length !== 1 || !tokenSchema.safeParse(states[0]).success || !tokenSchema.safeParse(browserBinding).success) {
        throw invalidLogin()
      }
      const value = await stateStore.take(stateKey(states[0]!, browserBinding!))
      if (!value) throw invalidLogin()
      let flow: z.infer<typeof storedFlow>
      try { flow = storedFlow.parse(JSON.parse(value)) }
      catch { throw invalidLogin() }
      const codes = query.getAll('code')
      const responseIssuers = query.getAll('iss')
      const code = codes[0] ?? ''
      if (flow.provider !== provider || query.has('error') || codes.length !== 1 || !/^[\x21-\x7e]{1,4096}$/u.test(code)
        || responseIssuers.length > 1 || (responseIssuers[0] !== undefined && responseIssuers[0] !== config.issuer)) throw invalidLogin()
      const idToken = await exchangeCode(fetcher, config, code, flow.verifier)
      const subject = await verifyToken(fetcher, config, idToken, flow.nonce)
      return { tenant: flow.tenant, issuer: config.issuer, subject }
    },
  }
}

export type OidcLogin = ReturnType<typeof createOidcLogin>
