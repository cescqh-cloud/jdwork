import { describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import { ControlError } from '../src/contract'
import {
  createOidcLogin, createOidcRoutes, loadOidcConfig, OIDC_CALLBACK_PATH, OIDC_MOUNT_PATH, OIDC_START_PATH,
  type OidcStateStore, type VerifiedOidcIdentity,
} from '../src/identity'

const origin = 'https://control.fixture.invalid'
const environment = {
  ENTERPRISE_OIDC_ISSUER: 'https://id.fixture.invalid/organization',
  ENTERPRISE_OIDC_AUTHORIZATION_URL: 'https://id.fixture.invalid/authorize',
  ENTERPRISE_OIDC_TOKEN_URL: 'https://id.fixture.invalid/token',
  ENTERPRISE_OIDC_JWKS_URL: 'https://keys.fixture.invalid/keys',
  ENTERPRISE_OIDC_CLIENT_ID: 'control-client',
  ENTERPRISE_OIDC_CLIENT_SECRET: 'fixture:secret with spaces',
}
const keyOne = signingKey('signing-one')
const keyTwo = signingKey('signing-two')

function signingKey(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } }
}

function signedToken(header: object, claims: object, key: KeyObject): string {
  const parts = [header, claims].map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')
  return parts + '.' + sign('sha256', Buffer.from(parts), key).toString('base64url')
}

class MemoryState implements OidcStateStore {
  values = new Map<string, string>()
  ttlSeconds?: number

  async remember(key: string, value: string, ttlSeconds: number) {
    this.ttlSeconds = ttlSeconds
    if (this.values.has(key)) return false
    this.values.set(key, value)
    return true
  }

  async take(key: string) {
    const value = this.values.get(key)
    this.values.delete(key)
    return value ?? null
  }
}

function mockLogin(env = environment) {
  const config = loadOidcConfig(env, origin)!
  const state = new MemoryState()
  const calls: { url: string, request: RequestInit }[] = []
  const provider = {
    signer: keyOne,
    keys: [keyOne.jwk],
    claims: {} as Record<string, unknown>,
    nonce: '',
    alg: 'RS256',
  }
  const login = createOidcLogin(config, state, async (url, request) => {
    calls.push({ url, request })
    if (url === config.jwksUri) return Response.json({ keys: provider.keys })
    if (url !== config.tokenEndpoint) return new Response(null, { status: 404 })
    const now = Math.floor(Date.now() / 1000)
    const idToken = signedToken(
      { alg: provider.alg, kid: provider.signer.kid, typ: 'JWT' },
      {
        iss: config.issuer, sub: 'Employee-0007', aud: config.clientId, nonce: provider.nonce,
        exp: now + 180, iat: now, email: 'fixture@example.invalid', roles: ['platform_admin'],
        ...provider.claims,
      },
      provider.signer.privateKey,
    )
    return Response.json({ id_token: idToken, access_token: 'fixture-provider-token' })
  })
  function redirect(authorizationUrl: string) {
    const url = new URL(authorizationUrl)
    provider.nonce = url.searchParams.get('nonce')!
    return new URLSearchParams({ state: url.searchParams.get('state')!, code: 'fixture-code', iss: config.issuer })
  }
  async function start(tenant = 'fixture-tenant') {
    const flow = await login.begin(tenant)
    return { ...flow, callback: redirect(flow.authorizationUrl) }
  }
  return { config, state, calls, provider, login, start, redirect }
}

describe('enterprise OIDC config', () => {
  test('requires a complete HTTPS provider configuration and a fixed callback', () => {
    expect(loadOidcConfig({}, origin)).toBeUndefined()
    expect(() => loadOidcConfig({ ENTERPRISE_OIDC_CLIENT_ID: 'incomplete' }, origin)).toThrow('ENTERPRISE_OIDC_ISSUER')
    expect(() => loadOidcConfig({ ...environment, ENTERPRISE_OIDC_TOKEN_URL: 'http://id.fixture.invalid/token' }, origin)).toThrow('ENTERPRISE_OIDC_TOKEN_URL')
    expect(() => loadOidcConfig({ ...environment, ENTERPRISE_OIDC_JWKS_URL: 'https://user:pass@keys.fixture.invalid/keys' }, origin)).toThrow('ENTERPRISE_OIDC_JWKS_URL')
    expect(loadOidcConfig(environment, origin)).toMatchObject({
      issuer: environment.ENTERPRISE_OIDC_ISSUER,
      redirectUri: origin + OIDC_CALLBACK_PATH,
      tokenAuthMethod: 'client_secret_basic',
    })
  })
})

describe('enterprise OIDC login', () => {
  test('binds authorization code, PKCE, nonce, tenant and a verified immutable subject', async () => {
    const fixture = mockLogin()
    const flow = await fixture.start()
    const authorize = new URL(flow.authorizationUrl)
    const parameters = authorize.searchParams
    expect(authorize.origin + authorize.pathname).toBe(fixture.config.authorizationEndpoint)
    expect(Object.fromEntries(parameters)).toMatchObject({
      response_type: 'code', scope: 'openid', client_id: fixture.config.clientId, redirect_uri: origin + OIDC_CALLBACK_PATH,
      code_challenge_method: 'S256', state: flow.callback.get('state'), nonce: fixture.provider.nonce,
    })
    expect(parameters.has('code_verifier')).toBe(false)
    expect(parameters.has('client_secret')).toBe(false)
    expect(fixture.state.ttlSeconds).toBe(300)
    expect([...fixture.state.values.keys()][0]).not.toBe(parameters.get('state'))
    expect(flow.browserBinding).not.toBe(parameters.get('state')!)
    flow.callback.set('tenant', 'other-tenant')
    expect(await fixture.login.complete(flow.callback, flow.browserBinding)).toEqual({
      tenant: 'fixture-tenant', issuer: fixture.config.issuer, subject: 'Employee-0007',
    })
    const [tokenCall, keysCall] = fixture.calls
    if (!tokenCall || !keysCall) throw new Error('Expected token and signing key requests')
    const headers = new Headers(tokenCall.request.headers)
    expect(headers.get('Authorization')).toBe('Basic ' + Buffer.from('control-client:fixture%3Asecret+with+spaces').toString('base64'))
    expect(tokenCall.request.method).toBe('POST')
    expect(tokenCall.request.redirect).toBe('error')
    expect(keysCall.request.redirect).toBe('error')
    const body = new URLSearchParams(tokenCall.request.body as URLSearchParams)
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: 'authorization_code', code: 'fixture-code', redirect_uri: origin + OIDC_CALLBACK_PATH,
    })
    expect(body.has('client_secret')).toBe(false)
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(parameters.get('code_challenge')!)
  })

  test('atomically consumes only the matching browser state before using the provider code', async () => {
    const fixture = mockLogin()
    const flow = await fixture.start()
    await expect(fixture.login.complete(flow.callback, 'a'.repeat(43))).rejects.toMatchObject({ status: 401 })
    const repeatedState = new URLSearchParams(flow.callback)
    repeatedState.append('state', flow.callback.get('state')!)
    await expect(fixture.login.complete(repeatedState, flow.browserBinding)).rejects.toMatchObject({ status: 401 })
    expect(fixture.calls).toHaveLength(0)
    const results = await Promise.allSettled([
      fixture.login.complete(flow.callback, flow.browserBinding),
      fixture.login.complete(flow.callback, flow.browserBinding),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(fixture.calls.filter(call => call.url === fixture.config.tokenEndpoint)).toHaveLength(1)
  })

  test('rejects authorization-response issuer mismatch and expired or cancelled flows before exchanging', async () => {
    const fixture = mockLogin()
    const wrongIssuer = await fixture.start()
    wrongIssuer.callback.set('iss', 'https://other.fixture.invalid')
    await expect(fixture.login.complete(wrongIssuer.callback, wrongIssuer.browserBinding)).rejects.toMatchObject({ status: 401 })
    const cancelled = await fixture.start()
    cancelled.callback.delete('code')
    cancelled.callback.set('error', 'access_denied')
    await expect(fixture.login.complete(cancelled.callback, cancelled.browserBinding)).rejects.toMatchObject({ status: 401 })
    const expired = await fixture.start()
    fixture.state.values.clear()
    await expect(fixture.login.complete(expired.callback, expired.browserBinding)).rejects.toMatchObject({ status: 401 })
    expect(fixture.calls).toHaveLength(0)
  })

  test.each([
    ['wrong issuer', { iss: 'https://other.fixture.invalid' }],
    ['wrong audience', { aud: 'other-client' }],
    ['an untrusted additional audience', { aud: ['control-client', 'other-client'], azp: 'control-client' }],
    ['wrong authorized party', { azp: 'other-client' }],
    ['wrong nonce', { nonce: 'nonce-from-another-flow' }],
    ['expired token', { exp: 1 }],
    ['missing expiration', { exp: undefined }],
    ['missing issue time', { iat: undefined }],
    ['future token', { iat: 4_102_444_800 }],
    ['missing subject', { sub: undefined }],
  ] as const)('rejects a signed ID token with %s', async (_name, claims) => {
    const fixture = mockLogin()
    fixture.provider.claims = { ...claims }
    const flow = await fixture.start()
    await expect(fixture.login.complete(flow.callback, flow.browserBinding)).rejects.toMatchObject({ status: 401 })
  })

  test('rejects an untrusted signature and algorithm, then accepts the next published signing key', async () => {
    const fixture = mockLogin()
    fixture.provider.signer = { ...keyTwo, kid: keyOne.kid }
    const badSignature = await fixture.start()
    await expect(fixture.login.complete(badSignature.callback, badSignature.browserBinding)).rejects.toMatchObject({ status: 401 })
    fixture.provider.signer = keyTwo
    fixture.provider.keys = [keyTwo.jwk]
    fixture.provider.alg = 'HS256'
    const wrongAlgorithm = await fixture.start()
    await expect(fixture.login.complete(wrongAlgorithm.callback, wrongAlgorithm.browserBinding)).rejects.toMatchObject({ status: 401 })
    fixture.provider.alg = 'RS256'
    const rotated = await fixture.start()
    expect(await fixture.login.complete(rotated.callback, rotated.browserBinding)).toMatchObject({ subject: 'Employee-0007' })
    expect(fixture.calls.filter(call => call.url === fixture.config.jwksUri).length).toBeGreaterThanOrEqual(2)
  })
})

test('console login binds the callback to its secure browser cookie and passes only the verified identity', async () => {
  const fixture = mockLogin()
  const logins: VerifiedOidcIdentity[] = []
  const app = new Hono()
  app.onError((error, c) => error instanceof ControlError ? c.text(error.code, error.status) : c.text('unexpected error', 500))
  app.route(OIDC_MOUNT_PATH, createOidcRoutes({
    origin,
    login: fixture.login,
    async signIn(identity) {
      logins.push(identity)
      return { accessToken: 'fixture-workbench-session', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    },
    setSession(c, session) {
      setCookie(c, '__Host-fixture-session', session.accessToken, { secure: true, httpOnly: true, path: '/', sameSite: 'Lax' })
    },
  }))
  const form = new URLSearchParams({ tenant: 'fixture-tenant' })
  const badOrigin = await app.request(origin + OIDC_START_PATH, { method: 'POST', body: form })
  expect(badOrigin.status).toBe(403)
  const start = await app.request(origin + OIDC_START_PATH, { method: 'POST', headers: { Origin: origin }, body: form })
  expect(start.status).toBe(303)
  const flowCookie = start.headers.getSetCookie()[0]!
  expect(flowCookie).toMatch(/^__Host-enterprise-oidc-flow=/u)
  expect(flowCookie).toContain('HttpOnly')
  expect(flowCookie).toContain('Secure')
  expect(flowCookie).toContain('SameSite=Lax')
  const callback = origin + OIDC_CALLBACK_PATH + '?' + fixture.redirect(start.headers.get('Location')!).toString()
  expect((await app.request(callback)).status).toBe(401)
  const signedIn = await app.request(callback, { headers: { Cookie: flowCookie.split(';', 1)[0]! } })
  expect(signedIn.status).toBe(303)
  expect(signedIn.headers.get('Location')).toBe('/')
  expect(signedIn.headers.getSetCookie()).toContain('__Host-fixture-session=fixture-workbench-session; Path=/; HttpOnly; Secure; SameSite=Lax')
  expect(logins).toEqual([{ tenant: 'fixture-tenant', issuer: fixture.config.issuer, subject: 'Employee-0007' }])
})
