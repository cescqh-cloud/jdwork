import { afterAll, beforeAll, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { migrate } from '../src/migrate'
import { startControlRuntime } from '../src/runtime'

const databaseUrl = Bun.env.ENTERPRISE_TEST_DATABASE_URL
const redisUrl = Bun.env.ENTERPRISE_TEST_REDIS_URL
const enabled = Boolean(databaseUrl && redisUrl)
const tenant = `fixture-${randomUUID().slice(0, 8)}`
const otherTenant = `${tenant}-other`
const origin = 'http://127.0.0.1:8787'
const fixturePassword = 'fixture-password-do-not-use-in-production'
let runtime: Awaited<ReturnType<typeof startControlRuntime>>
type DeviceTokens = Awaited<ReturnType<typeof runtime.store.refresh>>
type Snapshot = Awaited<ReturnType<typeof runtime.store.bootstrap>>
type Devices = Awaited<ReturnType<typeof runtime.store.devices>>
type Events = Awaited<ReturnType<typeof runtime.store.events>>

if (enabled) {
  for (const [value, service] of [[databaseUrl!, 'PostgreSQL'], [redisUrl!, 'Redis']] as const) {
    const address = new URL(value)
    if (address.hostname !== '127.0.0.1') throw new Error(`${service} test address must be on the loopback interface.`)
    if (service === 'PostgreSQL' && !address.pathname.endsWith('_test')) throw new Error('Integration tests require a disposable database ending in _test.')
  }
  beforeAll(async () => {
    const sql = new SQL(databaseUrl!)
    try {
      await migrate(sql)
      await migrate(sql)
    } finally { await sql.close() }
    runtime = await startControlRuntime({ host: '127.0.0.1', port: 0, origin, databaseUrl: databaseUrl!, redisUrl: redisUrl!, localLogin: true })
    await runtime.store.createLocalUser('Main test tenant', { tenant, login: 'operator', displayName: 'Operator', password: fixturePassword, roles: ['platform_admin'] })
    await runtime.store.createLocalUser('Main test tenant', { tenant, login: 'engineer', displayName: 'Engineer', password: fixturePassword, roles: ['developer'] })
    await runtime.store.createLocalUser('Second test tenant', { tenant: otherTenant, login: 'operator', displayName: 'Other Operator', password: fixturePassword, roles: ['platform_admin'] })
  }, 25_000)
  afterAll(async () => { await runtime?.close() })
}

function request(path: string, input?: unknown, accessToken?: string) {
  const headers = new Headers()
  if (input !== undefined) headers.set('Content-Type', 'application/json')
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  return fetch(new URL(path, runtime.server.url), { method: input === undefined ? 'GET' : 'POST', headers,
    body: input === undefined ? undefined : JSON.stringify(input), redirect: 'manual', signal: AbortSignal.timeout(6000) })
}

async function readJson<T>(response: Response | Promise<Response>): Promise<T> {
  return (await response).json() as Promise<T>
}

async function login(tenant: string, login: string): Promise<string> {
  const response = await request('/api/v1/auth/exchange', { tenant, login, password: fixturePassword })
  expect(response.status).toBe(200)
  return (await readJson<{ accessToken: string }>(response)).accessToken
}

async function challenge(token: string): Promise<string> {
  const response = await request('/api/v1/devices/challenge', {}, token)
  expect(response.status).toBe(201)
  return (await readJson<{ challenge: string }>(response)).challenge
}

function device(enrollmentCode: string) {
  const keys = generateKeyPairSync('ed25519')
  const deviceId = randomUUID()
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const platform = 'win32'
  const clientVersion = '0.7.7'
  function proof(parts: string[]) { return sign(null, Buffer.from(JSON.stringify(parts)), keys.privateKey).toString('base64url') }
  return {
    deviceId,
    enrollment: { challenge: enrollmentCode, deviceId, publicKey, platform, clientVersion,
      signature: proof(['enterprise-enroll-v1', enrollmentCode, deviceId, publicKey, platform, clientVersion]) },
    refresh(refreshToken: string) { return { deviceId, refreshToken, signature: proof(['enterprise-refresh-v1', deviceId, refreshToken]) } },
  }
}

const integration = enabled ? test : test.skip

integration('real Postgres/Redis preserve tenant isolation, one-use enrollment, refresh rotation and revocation', async () => {
  const admin = await login(tenant, 'operator')
  const member = await login(tenant, 'engineer')
  const other = await login(otherTenant, 'operator')
  const main = device(await challenge(admin))
  const employee = device(await challenge(member))
  const bad = { ...employee.enrollment, signature: 'A'.repeat(86) }
  expect((await request('/api/v1/devices/enroll', bad)).status).toBe(403)
  const adminEnrollment = await request('/api/v1/devices/enroll', main.enrollment)
  expect(adminEnrollment.status).toBe(201)
  const [first, second] = await Promise.all([
    request('/api/v1/devices/enroll', employee.enrollment), request('/api/v1/devices/enroll', employee.enrollment),
  ])
  expect([first.status, second.status].sort()).toEqual([201, 410])
  const enrolled = await readJson<DeviceTokens>(first.status === 201 ? first : second)
  const snapshot = await readJson<Snapshot>(request('/api/v1/bootstrap', undefined, enrolled.accessToken))
  expect(snapshot.user.roles).toEqual(['developer'])
  expect(snapshot.device?.id).toBe(employee.deviceId)
  expect(JSON.stringify(snapshot)).not.toContain(enrolled.refreshToken)
  expect((await request('/api/v1/admin/devices', undefined, member)).status).toBe(403)
  expect((await request('/api/v1/admin/devices', undefined, enrolled.accessToken)).status).toBe(401)
  const visible = await readJson<{ devices: Devices }>(request('/api/v1/admin/devices', undefined, admin))
  expect(visible.devices.map(item => item.id).sort()).toEqual([main.deviceId, employee.deviceId].sort())
  expect((await readJson<{ devices: Devices }>(request('/api/v1/admin/devices', undefined, other))).devices).toEqual([])
  expect((await request('/api/v1/devices/revoke', { deviceId: employee.deviceId }, other)).status).toBe(404)

  const history = await readJson<Events>(request('/api/v1/events?cursor=0', undefined, enrolled.accessToken))
  expect(history.events.map(event => event.resourceId)).toEqual([employee.deviceId])
  expect((await readJson<Events>(request(`/api/v1/events?cursor=${history.cursor}`, undefined, enrolled.accessToken))).events).toEqual([])
  expect((await request('/api/v1/events?cursor=9007199254740992', undefined, enrolled.accessToken)).status).toBe(400)

  const refresh = employee.refresh(enrolled.refreshToken)
  const [rotationA, rotationB] = await Promise.all([request('/api/v1/devices/refresh', refresh), request('/api/v1/devices/refresh', refresh)])
  expect([rotationA.status, rotationB.status].sort()).toEqual([200, 401])
  const rotated = await readJson<DeviceTokens>(rotationA.status === 200 ? rotationA : rotationB)
  expect(rotated.refreshToken).not.toBe(enrolled.refreshToken)
  expect((await request('/api/v1/bootstrap', undefined, enrolled.accessToken)).status).toBe(401)
  expect((await request('/api/v1/bootstrap', undefined, rotated.accessToken)).status).toBe(200)

  const syncUrl = new URL('/api/v1/sync/ws', runtime.server.url)
  syncUrl.protocol = 'ws:'
  const socket = new WebSocket(syncUrl, { headers: { Authorization: `Bearer ${rotated.accessToken}` } })
  try {
    const hint = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No authenticated change hint')), 3500)
      socket.addEventListener('message', event => { clearTimeout(timeout); resolve(String(event.data)) }, { once: true })
    })
    expect(JSON.parse(hint)).toEqual({ type: 'sync.available' })
    const closed = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Device sync did not close after revocation')), 4000)
      socket.addEventListener('close', event => { clearTimeout(timeout); resolve(event.code) }, { once: true })
    })
    expect((await request('/api/v1/devices/revoke', { deviceId: employee.deviceId }, admin)).status).toBe(200)
    expect(await closed).toBe(1008)
  } finally { socket.close() }
  expect((await request('/api/v1/bootstrap', undefined, rotated.accessToken)).status).toBe(401)
  expect((await request('/api/v1/devices/refresh', employee.refresh(rotated.refreshToken))).status).toBe(401)
  expect((await request('/api/v1/devices/revoke', { deviceId: employee.deviceId }, admin)).status).toBe(200)
  const auditView = await readJson<Events>(request('/api/v1/events?cursor=0', undefined, admin))
  expect(auditView.events.filter(event => event.type === 'device.revoked')).toHaveLength(1)
}, 20_000)

integration('web console requires same-origin writes and renders an actual short-lived enrollment code', async () => {
  const loginBody = new URLSearchParams({ tenant, login: 'engineer', password: fixturePassword })
  expect((await request('/')).headers.get('Referrer-Policy')).toBe('strict-origin')
  const denied = await fetch(new URL('/console/session', runtime.server.url), { method: 'POST', body: loginBody,
    headers: { Origin: 'https://unrelated.example.test' }, redirect: 'manual' })
  expect(denied.status).toBe(403)
  const opaque = await fetch(new URL('/console/session', runtime.server.url), { method: 'POST', body: loginBody,
    headers: { Origin: 'null' }, redirect: 'manual' })
  expect(opaque.status).toBe(403)
  const valid = await fetch(new URL('/console/session', runtime.server.url), { method: 'POST', body: loginBody,
    headers: { Origin: origin }, redirect: 'manual' })
  expect(valid.status).toBe(303)
  const cookie = valid.headers.get('Set-Cookie') ?? ''
  expect(cookie).toContain('HttpOnly')
  const session = cookie.split(';')[0]!
  expect((await fetch(new URL('/console/enrollment', runtime.server.url), { method: 'POST', headers: { Cookie: session } })).status).toBe(403)
  const issued = await fetch(new URL('/console/enrollment', runtime.server.url), { method: 'POST', headers: { Cookie: session, Origin: origin } })
  expect(issued.status).toBe(200)
  expect(await issued.text()).toMatch(/<code>[A-Za-z0-9_-]{43}<\/code>/u)
  expect(await (await request('/healthz')).json()).toEqual({ ok: true, redis: true })
}, 12_000)
