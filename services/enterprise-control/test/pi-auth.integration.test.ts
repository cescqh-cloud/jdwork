import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { migrate } from '../src/migrate'
import { startControlRuntime } from '../src/runtime'

const databaseUrl = Bun.env.ENTERPRISE_TEST_DATABASE_URL
const redisUrl = Bun.env.ENTERPRISE_TEST_REDIS_URL
const integration = databaseUrl && redisUrl ? test : test.skip
const consoleOrigin = 'http://127.0.0.1:8787'

function requireFixture(value: string, protocol: string, disposableDatabase = false) {
  const url = new URL(value)
  if (url.hostname !== '127.0.0.1' || url.protocol !== protocol || (disposableDatabase && !url.pathname.endsWith('_test'))) {
    throw new Error('Pi identity integration requires isolated loopback services.')
  }
  return value
}

function desktop(challenge: string) {
  const keys = generateKeyPairSync('ed25519')
  const deviceId = randomUUID()
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const proof = (fields: string[]) => sign(null, Buffer.from(JSON.stringify(fields)), keys.privateKey).toString('base64url')
  return {
    deviceId,
    enrollment: { challenge, deviceId, publicKey, platform: 'win32', clientVersion: '0.7.8',
      signature: proof(['enterprise-enroll-v1', challenge, deviceId, publicKey, 'win32', '0.7.8']) },
    refresh: (token: string) => ({ deviceId, refreshToken: token, signature: proof(['enterprise-refresh-v1', deviceId, token]) }),
  }
}

integration('Pi identity protects browser sessions, device enrollment and refresh against revoked upstream authorization', async () => {
  const sql = new SQL(requireFixture(databaseUrl!, 'postgres:', true))
  const redis = requireFixture(redisUrl!, 'redis:')
  const tenant = 'pi-fixture-' + randomUUID().slice(0, 8)
  const adminToken = 'fixture-admin-token-'.repeat(3)
  const memberCookie = 'a'.repeat(64)
  const state: { active: boolean, available: boolean, admin: boolean, instanceId?: string, token: string, memberActive: boolean, modelCalls: number } = {
    active: true, available: true, admin: true, instanceId: undefined, token: adminToken, memberActive: true, modelCalls: 0,
  }
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/v1/chat/completions' && request.method === 'POST') {
        state.modelCalls++
        return Response.json({ choices: [{ message: { content: '模拟回答' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
      }
      if (new URL(request.url).pathname !== '/api/me' || request.method !== 'GET') return new Response(null, { status: 404 })
      if (!state.available) return new Response(null, { status: 503 })
      const authState = state.instanceId ? { authState: { instanceId: state.instanceId } } : {}
      if (request.headers.get('authorization') === 'Bearer ' + state.token && state.active) {
        return Response.json({ identity: { id: 'admin', name: '管理员', source: 'token', admin: state.admin }, ...authState })
      }
      if (request.headers.get('cookie') === 'pi_session=' + memberCookie && state.memberActive) {
        return Response.json({ identity: { id: 'dingtalk:corp:member', name: '普通成员', source: 'dingtalk', admin: false, userId: 'member' },
          ...authState })
      }
      return new Response(null, { status: 401 })
    },
  })
  const piAuth = { origin: upstream.url.origin, tenant, encryptionKey: randomBytes(32) }
  let runtime: Awaited<ReturnType<typeof startControlRuntime>> | undefined
  try {
    await migrate(sql)
    runtime = await startControlRuntime({ origin: consoleOrigin, host: '127.0.0.1', port: 0,
      databaseUrl: databaseUrl!, redisUrl: redis, localLogin: false, piAuth,
      modelGateway: { allowLoopback: true, encryptionKey: randomBytes(32), allowedUpstreams: new Set([upstream.url.origin + '/v1']) } })
    const store = runtime.store
    const admin = await store.bindPiAdministrator({ kind: 'token', value: adminToken },
      { tenantName: '测试组织', login: 'admin', displayName: '原管理员' })
    expect(await store.bindPiAdministrator({ kind: 'token', value: adminToken },
      { tenantName: '测试组织', login: 'admin', displayName: '不应覆盖' })).toEqual(admin)
    state.instanceId = randomUUID()
    const member = await store.createExternalUser('测试组织', { tenant, login: 'member', displayName: '普通成员', roles: ['requester'] })
    await expect(store.bindPiUser({ kind: 'token', value: 'invalid-credential-'.repeat(3) },
      { login: 'member', subject: 'dingtalk:corp:member' })).rejects.toMatchObject({ status: 401 })
    expect(await store.bindPiUser({ kind: 'token', value: adminToken },
      { login: 'member', subject: 'dingtalk:corp:member' })).toEqual({ userId: member, changed: true })

    const request = (path: string, options: RequestInit = {}) => fetch(new URL(path, runtime!.server.url), {
      ...options, redirect: 'manual', signal: AbortSignal.timeout(6000),
    })
    const post = (path: string, body: unknown, token?: string) => request(path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body) })
    const adminLogin = () => request('/console/pi-token', { method: 'POST',
      headers: { Origin: consoleOrigin }, body: new URLSearchParams({ token: adminToken }) })
    const login = await adminLogin()
    expect(login.status).toBe(303)
    const adminCookie = login.headers.getSetCookie().find(value => value.startsWith('enterprise-dev-session='))!.split(';', 1)[0]!
    const challengeResponse = await request('/api/v1/devices/challenge', { method: 'POST',
      headers: { Origin: consoleOrigin, Cookie: adminCookie } })
    expect(challengeResponse.status).toBe(201)
    const machine = desktop((await challengeResponse.json() as { challenge: string }).challenge)
    const enrollment = await post('/api/v1/devices/enroll', machine.enrollment)
    expect(enrollment.status).toBe(201)
    const tokens = await enrollment.json() as { accessToken: string, refreshToken: string }
    const deviceView = () => request('/api/v1/bootstrap', { headers: { Authorization: 'Bearer ' + tokens.accessToken } })
    expect((await deviceView()).status).toBe(200)
    const [proof] = await sql<{ pi_authorization: string }[]>`SELECT pi_authorization FROM enterprise_devices WHERE id = ${machine.deviceId}`
    expect(proof!.pi_authorization).not.toContain(adminToken)
    const adminPost = (path: string, data: unknown) => request(path, { method: 'POST',
      headers: { Origin: consoleOrigin, Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    expect((await adminPost('/api/v1/admin/models/providers', {
      id: 'fixture-provider', displayName: '模拟模型', protocol: 'openai', authHeader: 'bearer', classifications: ['general', 'internal'],
      apiKey: 'fixture-provider-key', baseUrl: upstream.url.origin + '/v1',
    })).status).toBe(200)
    expect((await adminPost('/api/v1/admin/models/catalog', {
      id: 'fixture-model', displayName: '模拟模型', providerId: 'fixture-provider', upstreamModel: 'fixture-model',
      contextWindow: 1024, maxOutputTokens: 64, capabilities: ['text'], allowedRoles: ['platform_admin'],
    })).status).toBe(200)
    const grant = await post('/api/v1/models/grants', { modelId: 'fixture-model', sessionId: 'fixture-session' }, tokens.accessToken)
    expect(grant.status).toBe(201)
    const modelToken = (await grant.json() as { accessToken: string }).accessToken
    const modelCall = () => post('/api/v1/model-gateway/openai/v1/chat/completions', { model: 'fixture-model', messages: [] }, modelToken)
    expect((await modelCall()).status).toBe(200)
    expect(state.modelCalls).toBe(1)

    const crossOrigin = await request('/console/pi-token', { method: 'POST', headers: { Origin: 'http://other.invalid' },
      body: new URLSearchParams({ token: adminToken }) })
    expect(crossOrigin.status).toBe(403)
    const untrusted = await request('/api/v1/bootstrap', { headers: { Origin: 'http://other.invalid', Authorization: 'Bearer ' + tokens.accessToken } })
    expect(untrusted.status).toBe(403)

    state.admin = false
    expect((await deviceView()).status).toBe(401)
    expect((await post('/api/v1/devices/refresh', machine.refresh(tokens.refreshToken))).status).toBe(401)
    expect((await modelCall()).status).toBe(401)
    expect(state.modelCalls).toBe(1)
    state.admin = true
    state.available = false
    expect((await deviceView()).status).toBe(503)
    expect((await post('/api/v1/devices/refresh', machine.refresh(tokens.refreshToken))).status).toBe(503)
    state.available = true
    state.token = 'rotated-admin-token-'.repeat(3)
    expect((await deviceView()).status).toBe(401)
    state.token = adminToken
    state.instanceId = randomUUID()
    expect((await deviceView()).status).toBe(401)
    expect((await post('/api/v1/devices/refresh', machine.refresh(tokens.refreshToken))).status).toBe(401)

    const memberLogin = await request('/console/pi-session', { method: 'POST',
      headers: { Origin: consoleOrigin, Cookie: 'pi_session=' + memberCookie } })
    expect(memberLogin.status).toBe(303)
    const memberSession = memberLogin.headers.getSetCookie().find(value => value.startsWith('enterprise-dev-session='))!.split(';', 1)[0]!
    const memberView = await request('/api/v1/bootstrap', { headers: { Cookie: memberSession } })
    expect(memberView.status).toBe(200)
    expect(await memberView.json()).toMatchObject({ user: { id: member, roles: ['requester'] } })
    expect((await request('/api/v1/admin/devices', { headers: { Cookie: memberSession } })).status).toBe(403)
    state.memberActive = false
    expect((await request('/api/v1/bootstrap', { headers: { Cookie: memberSession } })).status).toBe(401)

    await sql`UPDATE enterprise_users SET roles = ARRAY['requester']::text[] WHERE id = ${admin.userId}`
    await expect(store.bindPiAdministrator({ kind: 'token', value: adminToken },
      { tenantName: '测试组织', login: 'admin', displayName: '管理员' })).rejects.toMatchObject({ status: 403 })
    const [after] = await sql<{ roles: string[] }[]>`SELECT roles FROM enterprise_users WHERE id = ${admin.userId}`
    expect(after!.roles).toEqual(['requester'])
  } finally {
    await runtime?.close()
    await upstream.stop(true)
    await sql.close()
  }
}, 30_000)
