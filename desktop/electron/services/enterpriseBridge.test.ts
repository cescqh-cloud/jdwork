// @vitest-environment node

import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EnterpriseBridge } from './enterpriseBridge'
import { blankDemandDraft } from '../../src/lib/desktopHost/enterpriseDemand'
import type { EnterpriseErpInput } from '../../../src/shared/enterpriseErp'

const origin = 'https://control.example.test'
const officeOrigin = 'http://192.168.254.203:8081'
const challenge = 'a'.repeat(43)
const initialTime = Date.parse('2026-11-10T00:00:00Z')
const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const target = await realpath(directory)
    if (dirname(target) !== await realpath(process.cwd()) || !basename(target).startsWith('.cc-haha-enterprise-test-')) {
      throw new Error('Invalid enterprise fixture cleanup directory')
    }
    await rm(target, { recursive: true, force: true })
  }
})

function fakeSecureStorage() {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString(value: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decryptString(value: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
}

async function fixture() {
  const directory = await mkdtemp(join(process.cwd(), '.cc-haha-enterprise-test-'))
  directories.push(directory)
  const profilePath = join(directory, 'enterprise-device.v1.enc')
  const existingSettings = join(directory, 'legacy-settings.json')
  const originalSettings = '{"sessions":["local-session"],"provider":"personal"}'
  await writeFile(existingSettings, originalSettings)
  const storage = fakeSecureStorage()
  const server = {
    now: initialTime,
    revision: 1,
    cursor: 4,
    events: [] as { sequence: number }[],
    resetCursor: false,
    revoke: false,
    rejectAccess: false,
    modelAllowed: true,
    erpAllowed: false,
    demandIssue: false,
    demandsEnabled: false,
    userId: 'user-a',
    roles: ['member'],
    memoriesEnabled: false,
    updatesEnabled: false,
    deviceId: '',
    publicKey: '',
    credentials: {
      accessToken: 'test-access-token-initial-01',
      refreshToken: 'test-refresh-token-initial-01',
      expiresAt: new Date(initialTime + 60_000).toISOString(),
    },
  }
  const api = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    if (url.pathname === '/api/v1/devices/enroll') {
      const body = JSON.parse(String(init?.body))
      server.deviceId = body.deviceId
      server.publicKey = body.publicKey
      return Response.json(server.credentials)
    }
    if (url.pathname === '/api/v1/devices/refresh') {
      if (server.revoke) return new Response('', { status: 401 })
      server.rejectAccess = false
      const count = api.mock.calls.filter(([target]) => String(target).endsWith('/refresh')).length
      server.credentials = {
        accessToken: `test-access-token-rotated-${count}`,
        refreshToken: `test-refresh-token-rotated-${count}`,
        expiresAt: new Date(server.now + 60_000).toISOString(),
      }
      return Response.json(server.credentials)
    }
    if (server.revoke) return new Response('', { status: 403 })
    if (server.rejectAccess || headers.get('authorization') !== `Bearer ${server.credentials.accessToken}`) {
      return new Response('', { status: 401 })
    }
    if (url.pathname === '/api/v1/models/catalog') {
      return Response.json({
        revision: server.revision,
        expiresAt: new Date(server.now + 30_000).toISOString(),
        models: server.modelAllowed ? [{
          providerId: 'fixture-provider', modelId: 'fixture-model', displayName: 'Fixture company model',
          protocol: 'openai', capabilities: ['text', 'tools'], contextWindow: 64_000, maxOutputTokens: 2_000,
          defaultEffort: null, proxyEndpoint: '/api/v1/model-gateway/openai',
          projectId: null, isDefault: false, quota: { dailyTokens: null, softDailyTokens: null },
          canQueryErp: server.erpAllowed,
          apiKey: 'never-serialized-organization-key',
        }] : [],
      })
    }
    if (url.pathname === '/api/v1/models/grants') {
      return server.modelAllowed ? Response.json({
        accessToken: 'short-grant-for-isolated-test-1',
        expiresAt: new Date(server.now + 120_000).toISOString(),
        proxyEndpoint: '/api/v1/model-gateway/openai',
      }) : new Response('', { status: 403 })
    }
    if (url.pathname === '/api/v1/demands/status') {
      return Response.json({ oaConfigured: true, callbackConfigured: false, aiPrecheckConfigured: true, accessToken: server.credentials.accessToken })
    }
    if (url.pathname.startsWith('/api/v1/demands/')) {
      return server.demandIssue
        ? Response.json({ error: { code: 'DEMAND_DRAFT_CONFLICT', message: 'private fixture error text' } }, { status: 409 })
        : Response.json({})
    }
    if (url.pathname === '/api/v1/memories/changes') {
      return Response.json({ cursor: 7, aclVersion: 1, hasMore: false, changes: [], cacheExpiresAt: server.credentials.expiresAt,
        accessToken: server.credentials.accessToken })
    }
    if (url.pathname === '/api/v1/updates/check') return new Response('isolated update stream')
    if (url.pathname === '/api/v1/bootstrap') {
      return Response.json({
        accessToken: server.credentials.accessToken,
        user: { id: server.userId, displayName: 'Test Employee', roles: server.roles, refreshToken: server.credentials.refreshToken },
        device: { id: server.deviceId, platform: 'win32', clientVersion: '0.7.7', privateKey: 'server-extra-field' },
        policy: {
          revision: server.revision,
          expiresAt: new Date(server.now + 120_000).toISOString(),
          features: { demands: server.demandsEnabled, models: false, memories: server.memoriesEnabled, updates: server.updatesEnabled, extra: 'server-extra-field' },
        },
        cursor: server.cursor,
      })
    }
    if (url.pathname === '/api/v1/events') {
      return server.resetCursor
        ? new Response('', { status: 410 })
        : Response.json({ events: server.events, cursor: server.cursor })
    }
    return new Response('', { status: 404 })
  })
  const options = {
    profilePath, platform: 'win32' as const, clientVersion: '0.7.7',
    secureStorage: storage, fetch: api, now: () => server.now,
  }
  return { options, server, api, storage, profilePath, existingSettings, originalSettings }
}

function verifySignature(publicKey: string, fields: string[], signature: string) {
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' })
  return key.asymmetricKeyType === 'ed25519' && verify(
    null, Buffer.from(JSON.stringify(fields)), key, Buffer.from(signature, 'base64url'),
  )
}

function demandResponse(id: string, ownerId: string, draftRevision: number, title: string) {
  const date = new Date(initialTime).toISOString()
  return {
    id, ownerId, demandNo: 'REQ-2026-12', title, state: 'DRAFT', origin: 'WORKBENCH',
    revision: draftRevision, draftRevision, createdAt: date, updatedAt: date, draft: { ...blankDemandDraft, title },
    validation: { missing: [], warnings: [] }, precheck: null, activeVersion: null, approvedVersion: null,
    unsubmittedChanges: false, submission: null, approval: null,
  }
}

describe('native Enterprise Bridge', () => {
  it('uses a fresh model/session grant for ERP, strips backend fields, and drops cancelled or revoked replies', async () => {
    const { options, api, server } = await fixture()
    const projectId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
    const calls: { body: Record<string, unknown>; headers: Headers }[] = []
    let hold: Promise<void> | undefined
    let started: ((signal: AbortSignal) => void) | undefined
    let echoGrant = false
    let expiredGrant = false
    const transport = vi.fn<typeof fetch>(async (target, init) => {
      const path = new URL(String(target)).pathname
      if (path !== '/api/v1/models/erp') return api(target, init)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push({ body, headers: new Headers(init?.headers) })
      if (expiredGrant) return Response.json({ error: { code: 'MODEL_GRANT_EXPIRED' } }, { status: 401 })
      started?.(init!.signal!)
      if (hold) await hold
      return Response.json({
        action: 'read', credential: 'fixture-private-value',
        result: {
          requestId: randomUUID(), projectId, environmentId: 'xh-test', environmentName: '模拟 ERP 测试',
          operation: 'receipt', mode: 'test', checkedAt: new Date(initialTime).toISOString(), truncated: false,
          query: { id: 'receipt', kind: 'document', requiresNumber: true, label: '收货查询', columns: [{ key: 'status', title: '状态' }] },
          rows: [{ status: echoGrant ? body.modelGrant : '待收货', access_token: 'fixture-private-value' }],
        },
      })
    })
    const bridge = new EnterpriseBridge({ ...options, fetch: transport })
    await bridge.enroll({ origin, challenge })
    const query: EnterpriseErpInput = {
      action: 'read', providerId: `enterprise:${server.deviceId}:fixture-provider`, modelId: 'fixture-model', sessionId: 'fixture-session',
      projectId, environmentId: 'xh-test', operation: 'receipt', number: 'FIXTURE-001',
    }
    expect(await bridge.modelErp(query)).toBeNull()
    expect(api.mock.calls.some(([url]) => String(url).endsWith('/models/grants'))).toBe(false)
    expect(calls).toHaveLength(0)
    server.erpAllowed = true
    const result = await bridge.modelErp(query)
    expect(result).toMatchObject({ action: 'read', result: { rows: [{ status: '待收货' }] } })
    expect(calls[0]?.body).toEqual({
      action: 'read', providerId: 'fixture-provider', modelId: 'fixture-model', sessionId: 'fixture-session',
      modelGrant: 'short-grant-for-isolated-test-1', projectId, environmentId: 'xh-test', operation: 'receipt', number: 'FIXTURE-001',
    })
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${server.credentials.accessToken}`)
    const grant = api.mock.calls.find(([url]) => String(url).endsWith('/models/grants'))
    expect(JSON.parse(String(grant?.[1]?.body))).toEqual({ modelId: 'fixture-model', sessionId: 'fixture-session' })
    expect(JSON.stringify(result)).not.toContain('fixture-private-value')
    echoGrant = true
    expect(await bridge.modelErp(query)).toBeNull()
    echoGrant = false

    expiredGrant = true
    const count = calls.length
    expect(await bridge.modelErp(query)).toBeNull()
    expect(calls).toHaveLength(count + 1)
    expect(api.mock.calls.some(([target]) => String(target).endsWith('/devices/refresh'))).toBe(false)
    expiredGrant = false

    for (const reason of ['cancel', 'disconnect'] as const) {
      const controller = new AbortController()
      const arrived = new Promise<AbortSignal>(resolve => { started = resolve })
      let finish!: () => void
      hold = new Promise<void>(resolve => { finish = resolve })
      const pending = bridge.modelErp(query, controller.signal)
      const signal = await arrived
      if (reason === 'cancel') { controller.abort(); expect(signal.aborted).toBe(true) }
      else await bridge.disconnect()
      finish()
      expect(await pending).toBeNull()
    }
  })

  it('recovers encrypted drafts after a restart, exports offline and replays only the prior explicit cloud save', async () => {
    const { options, api, server, profilePath, existingSettings, originalSettings } = await fixture()
    server.demandsEnabled = true
    const writes: { route: string; method: string | undefined; body: { idempotencyKey: string; draft: typeof blankDemandDraft; expectedDraftRevision?: number } }[] = []
    let offline = false
    let received: typeof writes[number]['body'] | undefined
    const cloudId = randomUUID()
    const authorId = randomUUID()
    const requests = vi.fn<typeof fetch>(async (url, init) => {
      if (offline) throw new Error('Isolated network disconnected')
      const route = new URL(String(url)).pathname
      if (route === '/api/v1/demands' || route === `/api/v1/demands/${cloudId}`) {
        if (init?.method === 'GET') return new Response(null, { status: 503 })
        const body = JSON.parse(String(init?.body)) as typeof writes[number]['body']
        writes.push({ route, method: init?.method, body })
        if (init?.method === 'PATCH') return Response.json({ error: { code: 'DEMAND_DRAFT_CONFLICT' } }, { status: 409 })
        if (!received) {
          received = body
          throw new Error('Fixture committed the draft but lost the response')
        }
        expect(body).toEqual(received)
        const at = new Date(initialTime).toISOString()
        return Response.json({
          id: cloudId, demandNo: 'REQ-2026-12', ownerId: authorId, title: received.draft.title, state: 'DRAFT', origin: 'WORKBENCH',
          revision: 1, draftRevision: 1, createdAt: at, updatedAt: at, draft: received.draft, validation: { missing: [], warnings: [] },
          precheck: null, activeVersion: null, approvedVersion: null, unsubmittedChanges: false, submission: null, approval: null,
          draftMutation: { idempotencyKey: received.idempotencyKey, draftRevision: 1 },
        }, { status: 201 })
      }
      return api(url, init)
    })
    const setup = { ...options, fetch: requests }
    const bridge = new EnterpriseBridge(setup)
    await bridge.enroll({ origin, challenge })
    const deviceId = server.deviceId
    const id = randomUUID()
    const draft = { ...blankDemandDraft, title: '隔离采购计划草稿', businessContext: '在本机记录采购报表口径。' }
    offline = true
    requests.mockClear()
    const saved = await bridge.demandLocal({ action: 'save', deviceId, id, expectedLocalRevision: null, cloud: null, draft })
    expect(saved).toMatchObject({ ok: true, data: { revision: 1, draft } })
    expect(requests).not.toHaveBeenCalled()

    const restarted = new EnterpriseBridge(setup)
    expect(await restarted.demandLocal({ action: 'list' })).toMatchObject({ ok: true, data: { deviceId, drafts: [{ id, title: draft.title }], unreadable: 0 } })
    expect(await restarted.demandLocal({ action: 'get', deviceId, id })).toMatchObject({ ok: true, data: { draft } })
    const file = join(dirname(profilePath), '导出的模拟草稿.md')
    expect(await restarted.demandLocal({ action: 'export', deviceId, id, expectedLocalRevision: 1 }, async () => file))
      .toEqual({ ok: true, data: { saved: true } })
    expect(await readFile(file, 'utf8')).toContain('需求草稿 · 未送审')
    expect(await readFile(file, 'utf8')).toContain(draft.businessContext)
    expect(requests).not.toHaveBeenCalled()
    const directory = join(dirname(profilePath), 'enterprise-demand-drafts')
    const [encryptedFile] = (await readdir(directory, { recursive: true })).filter(name => name.endsWith('.enc'))
    expect((await readFile(join(directory, encryptedFile!))).includes(Buffer.from(draft.title))).toBe(false)
    expect(await readFile(existingSettings, 'utf8')).toBe(originalSettings)

    offline = false
    expect(await restarted.demandLocal({ action: 'sync', deviceId, id, expectedLocalRevision: 1 })).toEqual({ ok: false, issue: 'unavailable' })
    const newerDraft = { ...draft, title: '断线后的第二稿' }
    expect(await restarted.demandLocal({ action: 'save', deviceId, id, expectedLocalRevision: 1, cloud: null, draft: newerDraft }))
      .toMatchObject({ ok: true, data: { revision: 2, draft: newerDraft } })
    const reopened = new EnterpriseBridge(setup)
    expect(await reopened.demandLocal({ action: 'sync', deviceId, id, expectedLocalRevision: 2 })).toMatchObject({
      ok: true, data: { demand: { id: cloudId }, draft: { revision: 2, draft: newerDraft, cloud: { id: cloudId, draftRevision: 1 } } },
    })
    expect(writes[1]).toEqual(writes[0])
    expect(await reopened.demandLocal({ action: 'sync', deviceId, id, expectedLocalRevision: 2 })).toEqual({ ok: false, issue: 'conflict' })
    expect(writes[2]).toMatchObject({ method: 'PATCH', body: { draft: newerDraft, expectedDraftRevision: 1 } })
    expect(await reopened.demandLocal({ action: 'get', deviceId, id })).toMatchObject({ ok: true, data: { draft: newerDraft } })
    expect(requests.mock.calls.some(([url]) => String(url).includes('/submit'))).toBe(false)

    await reopened.enroll({ origin, challenge })
    expect(server.deviceId).not.toBe(deviceId)
    expect(await reopened.demandLocal({ action: 'list' })).toMatchObject({ ok: true, data: { deviceId: server.deviceId, drafts: [] } })
    expect(await reopened.demandLocal({ action: 'get', deviceId, id })).toEqual({ ok: false, issue: 'unbound' })
  })

  it('replays the old encrypted request until a definitive version conflict, then rechecks and saves a manual merge locally', async () => {
    const { options, api, server, profilePath, storage } = await fixture()
    Object.assign(server, { demandsEnabled: true, userId: randomUUID(), roles: ['requester'] })
    const cloudId = randomUUID()
    let latest = demandResponse(cloudId, server.userId, 3, '云端第三稿')
    let failure: 'network' | 'other' | 'revision' = 'network'
    const writes: { idempotencyKey: string; expectedDraftRevision: number; draft: typeof blankDemandDraft }[] = []
    const bridge = new EnterpriseBridge({ ...options, fetch: async (url, init) => {
      if (new URL(String(url)).pathname !== `/api/v1/demands/${cloudId}`) return api(url, init)
      if (init?.method === 'GET') return Response.json(latest)
      writes.push(JSON.parse(String(init?.body)))
      if (failure === 'network') throw new Error('Mock response was lost')
      return Response.json({ error: { code: failure === 'other' ? 'DEMAND_DRAFT_REQUEST_CONFLICT' : 'DEMAND_DRAFT_CONFLICT' } }, { status: 409 })
    } })
    await bridge.enroll({ origin, challenge })
    const deviceId = server.deviceId
    const id = randomUUID()
    const binding = createHash('sha256').update(JSON.stringify([origin, deviceId])).digest('hex')
    const directory = join(dirname(profilePath), 'enterprise-demand-drafts', binding)
    const path = join(directory, `${id}.enc`)
    await mkdir(directory, { recursive: true })
    const cloud = { id: cloudId, draftRevision: 1, demandNo: latest.demandNo }
    const draft = { ...blankDemandDraft, title: '本机待合并草稿' }
    const pending = { key: randomUUID(), draft }
    const record = { id, revision: 1, updatedAt: latest.updatedAt, cloud, draft }
    await writeFile(path, storage.encryptString(JSON.stringify({ version: 1, binding, record, pending })))

    const sync = { action: 'sync', deviceId, id, expectedLocalRevision: 1 } as const
    const merge = { action: 'merge', deviceId, id, expectedLocalRevision: 1, expectedCloudRevision: 3, draft } as const
    expect(await bridge.demandLocal(sync)).toEqual({ ok: false, issue: 'unavailable' })
    expect(await bridge.demandLocal(merge)).toEqual({ ok: false, issue: 'conflict' })
    failure = 'other'
    expect(await bridge.demandLocal(sync)).toEqual({ ok: false, issue: 'conflict' })
    failure = 'revision'
    expect(await bridge.demandLocal(sync)).toMatchObject({ ok: false, issue: 'conflict',
      conflict: { local: record, baseDraft: null, latest: { cloud: { draftRevision: 3 }, draft: latest.draft } },
    })
    expect(writes.map(write => write.idempotencyKey)).toEqual([pending.key, pending.key, pending.key])

    latest = demandResponse(cloudId, server.userId, 4, '云端第四稿')
    expect(await bridge.demandLocal(merge)).toMatchObject({ ok: false, issue: 'conflict',
      conflict: { local: record, baseDraft: null, latest: { cloud: { draftRevision: 4 }, draft: latest.draft } },
    })
    expect(await bridge.demandLocal({ ...merge, expectedCloudRevision: 4 })).toMatchObject({
      ok: true, data: { ...record, revision: 2, updatedAt: expect.any(String), cloud: { ...cloud, draftRevision: 4 } },
    })
    expect(writes).toHaveLength(3)
    expect(await bridge.demandLocal({ ...merge, expectedCloudRevision: 4 })).toEqual({ ok: false, issue: 'conflict' })
    expect(JSON.parse(storage.decryptString(await readFile(path)))).toMatchObject({
      version: 2, baseDraft: latest.draft, pending: null,
    })
    const fourth = latest.draft
    latest = demandResponse(cloudId, server.userId, 5, '云端第五稿')
    expect(await bridge.demandLocal({ ...sync, expectedLocalRevision: 2 })).toMatchObject({
      ok: false, issue: 'conflict', conflict: { baseDraft: fourth, latest: { draft: latest.draft }, local: { revision: 2, draft } },
    })
    expect(writes[3]).toMatchObject({ expectedDraftRevision: 4, draft })
    expect(writes[3]?.idempotencyKey).not.toBe(pending.key)
    const list = await bridge.demandLocal({ action: 'list' })
    expect(JSON.stringify(list)).not.toContain('云端第四稿')
    expect(JSON.stringify(list)).not.toContain('baseDraft')
  })

  it('keeps the acknowledged request body as the next base and rechecks editor access before merge', async () => {
    const { options, api, server, profilePath, storage } = await fixture()
    Object.assign(server, { demandsEnabled: true, userId: randomUUID(), roles: ['requester'] })
    const cloudId = randomUUID()
    let latest = demandResponse(cloudId, server.userId, 1, '新建本机副本所用基准')
    let waitForRead: (() => Promise<void>) | undefined
    const writes: { idempotencyKey: string; expectedDraftRevision: number; draft: typeof blankDemandDraft }[] = []
    const bridge = new EnterpriseBridge({ ...options, fetch: async (url, init) => {
      if (new URL(String(url)).pathname !== `/api/v1/demands/${cloudId}`) return api(url, init)
      if (init?.method === 'GET') {
        await waitForRead?.()
        return Response.json(latest)
      }
      const body = JSON.parse(String(init?.body)) as typeof writes[number]
      writes.push(body)
      if (writes.length === 1) throw new Error('Mock response was lost')
      if (writes.length === 2) return Response.json({ ...latest, draftMutation: { idempotencyKey: randomUUID(), draftRevision: 2 } })
      if (writes.length === 3) return Response.json({ ...latest, draftMutation: { idempotencyKey: body.idempotencyKey, draftRevision: 2 } })
      return Response.json({ error: { code: 'DEMAND_DRAFT_CONFLICT' } }, { status: 409 })
    } })
    await bridge.enroll({ origin, challenge })
    const deviceId = server.deviceId
    const id = randomUUID()
    const cloud = { id: cloudId, draftRevision: 1, demandNo: latest.demandNo }
    const draft = { ...blankDemandDraft, title: '已写入第二稿' }
    const newer = { ...draft, title: '较新的本机稿' }
    const save = { action: 'save', id, deviceId, expectedLocalRevision: null, cloud, draft, baseDraft: latest.draft } as const
    expect(await bridge.demandLocal(save)).toMatchObject({ ok: true, data: { revision: 1 } })
    const binding = createHash('sha256').update(JSON.stringify([origin, deviceId])).digest('hex')
    const path = join(dirname(profilePath), 'enterprise-demand-drafts', binding, `${id}.enc`)
    expect(JSON.parse(storage.decryptString(await readFile(path)))).toMatchObject({ version: 2, baseDraft: latest.draft })
    const sync = { action: 'sync', deviceId, id, expectedLocalRevision: 1 } as const
    expect(await bridge.demandLocal(sync)).toEqual({ ok: false, issue: 'unavailable' })
    expect(await bridge.demandLocal({ action: 'save', id, deviceId, expectedLocalRevision: 1, cloud, draft: newer }))
      .toMatchObject({ ok: true, data: { revision: 2, draft: newer } })
    latest = demandResponse(cloudId, server.userId, 3, '云端另一人已经编辑')
    expect(await bridge.demandLocal({ ...sync, expectedLocalRevision: 2 })).toEqual({ ok: false, issue: 'unavailable' })
    expect(await bridge.demandLocal({ ...sync, expectedLocalRevision: 2 })).toMatchObject({
      ok: true, data: { demand: { draftRevision: 3 }, draft: { draft: newer, cloud: { draftRevision: 2 } } },
    })
    expect(writes.slice(0, 3)).toEqual([writes[0], writes[0], writes[0]])
    expect(await bridge.demandLocal({ ...sync, expectedLocalRevision: 2 })).toMatchObject({
      ok: false, issue: 'conflict', conflict: { baseDraft: draft, latest: { draft: latest.draft }, local: { draft: newer } },
    })
    const merge = { action: 'merge', deviceId, id, expectedLocalRevision: 2, expectedCloudRevision: 3, draft: newer } as const
    server.roles = ['approver']
    expect(await bridge.demandLocal(merge)).toEqual({ ok: false, issue: 'forbidden' })
    server.roles = ['requester']
    latest = { ...latest, ownerId: randomUUID() }
    expect(await bridge.demandLocal(merge)).toEqual({ ok: false, issue: 'forbidden' })
    expect(await bridge.demandLocal({ action: 'get', deviceId, id })).toMatchObject({
      ok: true, data: { revision: 2, draft: newer, cloud: { id: cloudId, draftRevision: 2 } },
    })

    latest = { ...latest, id: randomUUID(), ownerId: server.userId }
    expect(await bridge.demandLocal(merge)).toEqual({ ok: false, issue: 'unavailable' })
    latest = { ...latest, id: cloudId }
    const encrypted = await readFile(path)
    let startRead!: () => void
    let finishRead!: () => void
    const started = new Promise<void>(resolve => { startRead = resolve })
    const held = new Promise<void>(resolve => { finishRead = resolve })
    waitForRead = () => { startRead(); return held }
    const merging = bridge.demandLocal(merge)
    await started
    try { expect(await bridge.disconnect()).toMatchObject({ state: 'disconnected' }) }
    finally { finishRead() }
    expect(await merging).toEqual({ ok: false, issue: 'unbound' })
    expect(await readFile(path)).toEqual(encrypted)
    expect(writes).toHaveLength(4)
  })

  it('keeps a replacement pending request when a previous conflict reply arrives late', async () => {
    const { options, api, server } = await fixture()
    Object.assign(server, { demandsEnabled: true, userId: randomUUID(), roles: ['requester'] })
    const cloudId = randomUUID()
    const latest = demandResponse(cloudId, server.userId, 2, '云端新版本')
    const keys: string[] = []
    let markFirstWrite!: () => void
    let releaseFirstWrite!: () => void
    const started = new Promise<void>(resolve => { markFirstWrite = resolve })
    const held = new Promise<void>(resolve => { releaseFirstWrite = resolve })
    const bridge = new EnterpriseBridge({ ...options, fetch: async (url, init) => {
      if (new URL(String(url)).pathname !== `/api/v1/demands/${cloudId}`) return api(url, init)
      if (init?.method === 'GET') return Response.json(latest)
      keys.push((JSON.parse(String(init?.body)) as { idempotencyKey: string }).idempotencyKey)
      if (keys.length === 1) { markFirstWrite(); await held }
      else if (keys.length > 2) throw new Error('Mock response was lost')
      return Response.json({ error: { code: 'DEMAND_DRAFT_CONFLICT' } }, { status: 409 })
    } })
    await bridge.enroll({ origin, challenge })
    const deviceId = server.deviceId
    const id = randomUUID()
    const draft = { ...blankDemandDraft, title: '本机草稿' }
    const cloud = { id: cloudId, draftRevision: 1, demandNo: latest.demandNo }
    await bridge.demandLocal({ action: 'save', id, deviceId, expectedLocalRevision: null, cloud, draft })
    const sync = { action: 'sync', deviceId, id, expectedLocalRevision: 1 } as const
    const late = bridge.demandLocal(sync)
    await started
    try {
      expect(await bridge.demandLocal(sync)).toMatchObject({ ok: false, issue: 'conflict', conflict: { latest: { draft: latest.draft } } })
      expect(await bridge.demandLocal(sync)).toEqual({ ok: false, issue: 'unavailable' })
    } finally { releaseFirstWrite() }
    expect(await late).toEqual({ ok: false, issue: 'conflict' })
    expect(await bridge.demandLocal(sync)).toEqual({ ok: false, issue: 'unavailable' })
    expect(keys[2]).not.toBe(keys[0])
    expect(keys).toEqual([keys[0], keys[0], keys[2], keys[2]])
  })

  it('binds update streaming to one origin and device and rotates the bearer on a single 401', async () => {
    const { options, api, server } = await fixture()
    const bridge = new EnterpriseBridge(options)
    expect(await bridge.updateTransport()).toBeNull()
    server.updatesEnabled = true
    await bridge.enroll({ origin, challenge })
    const transport = await bridge.updateTransport()
    expect(transport?.binding).toBe(`${origin}|${server.deviceId}`)
    const check = '/api/v1/updates/check?platform=win32&arch=x64&currentVersion=0.7.7'
    server.rejectAccess = true
    const response = await transport!.request(check)
    expect(await response.text()).toBe('isolated update stream')
    const requests = api.mock.calls.filter(([target]) => String(target) === origin + check)
    expect(requests).toHaveLength(2)
    expect(requests[1]?.[1]).toMatchObject({ redirect: 'error', credentials: 'omit', method: 'GET' })
    expect(new Headers(requests[1]?.[1]?.headers).get('authorization')).toBe(`Bearer ${server.credentials.accessToken}`)
    await expect(transport!.request('/api/v1/memories/changes?cursor=0')).rejects.toThrow('Invalid enterprise update request')
    await bridge.enroll({ origin, challenge })
    await expect(transport!.request(check)).rejects.toThrow('bindingExpired')
  })

  it('gates memory access on the bootstrap feature and strips unrecognized server fields', async () => {
    const { options, api, server } = await fixture()
    const bridge = new EnterpriseBridge(options)
    await bridge.enroll({ origin, challenge })
    expect(await bridge.memory({ action: 'changes', cursor: 0 })).toEqual({ ok: false, issue: 'forbidden' })
    expect(api.mock.calls.some(([target]) => String(target).includes('/memories/'))).toBe(false)
    server.memoriesEnabled = true
    await bridge.sync()
    const result = await bridge.memory({ action: 'changes', cursor: 3 })
    expect(result).toMatchObject({ ok: true, data: { cursor: 7, hasMore: false } })
    expect(JSON.stringify(result)).not.toContain(server.credentials.accessToken)
    expect(String(api.mock.calls.at(-1)?.[0])).toBe(`${origin}/api/v1/memories/changes?cursor=3`)
  })

  it('signs enrollment, encrypts device credentials, restores the binding, and leaves existing data intact', async () => {
    const { options, api, server, profilePath, storage, existingSettings, originalSettings } = await fixture()
    const bridge = new EnterpriseBridge(options)
    expect(await bridge.sync()).toEqual({ state: 'disconnected', origin: null })
    expect(api).not.toHaveBeenCalled()

    const connection = await bridge.enroll({ origin: `${origin}/`, challenge })
    expect(connection.issue).toBeUndefined()
    expect(connection).toMatchObject({
      origin, state: 'connected',
      bootstrap: { user: { displayName: 'Test Employee', roles: ['member'] }, device: { id: server.deviceId }, cursor: 4 },
    })
    const [url, request] = api.mock.calls[0]!
    const body = JSON.parse(String(request?.body))
    expect(String(url)).toBe(`${origin}/api/v1/devices/enroll`)
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    expect(Object.keys(body).sort()).toEqual(['challenge', 'clientVersion', 'deviceId', 'platform', 'publicKey', 'signature'])
    expect(body.deviceId).toMatch(/^[\da-f-]{36}$/)
    expect(verifySignature(body.publicKey, [
      'enterprise-enroll-v1', challenge, body.deviceId, body.publicKey, 'win32', '0.7.7',
    ], body.signature)).toBe(true)

    const encrypted = await readFile(profilePath)
    const stored = JSON.parse(storage.decryptString(encrypted))
    expect(stored).toMatchObject({ version: 1, origin, deviceId: body.deviceId, ...server.credentials })
    const privateValues = [challenge, stored.privateKey, server.credentials.accessToken, server.credentials.refreshToken]
    for (const value of privateValues) {
      expect(encrypted.includes(value)).toBe(false)
      expect(JSON.stringify(connection)).not.toContain(value)
    }
    expect(JSON.stringify(connection)).not.toContain('server-extra-field')
    const restarted = new EnterpriseBridge(options)
    expect(await restarted.sync()).toEqual(connection)
    api.mockClear()
    expect(await restarted.disconnect()).toEqual({ state: 'disconnected', origin: null })
    expect(await readFile(existingSettings, 'utf8')).toBe(originalSettings)
    await expect(readFile(profilePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await new EnterpriseBridge(options).sync()).toEqual({ state: 'disconnected', origin: null })
    expect(api).not.toHaveBeenCalled()
  })

  it('rotates credentials once when concurrently refreshed and recovers from an expired access token', async () => {
    const { options, server, api, storage, profilePath } = await fixture()
    const bridge = new EnterpriseBridge(options)
    await bridge.enroll({ origin, challenge })
    const previousToken = server.credentials.refreshToken
    server.now += 61_000
    const outcomes = await Promise.all([bridge.sync(), bridge.sync()])
    expect(outcomes.map(outcome => outcome.state)).toEqual(['connected', 'connected'])
    const requests = api.mock.calls.filter(([target]) => String(target).endsWith('/refresh'))
    expect(requests).toHaveLength(1)
    const refresh = JSON.parse(String(requests[0]![1]?.body))
    expect(refresh.refreshToken).toBe(previousToken)
    expect(verifySignature(server.publicKey, ['enterprise-refresh-v1', server.deviceId, previousToken], refresh.signature)).toBe(true)
    expect(JSON.parse(storage.decryptString(await readFile(profilePath))).refreshToken).toBe(server.credentials.refreshToken)

    server.rejectAccess = true
    expect((await bridge.sync()).state).toBe('connected')
    expect(api.mock.calls.filter(([target]) => String(target).endsWith('/refresh'))).toHaveLength(2)
  })

  it('retries local persistence after the server rotates a token and the first save fails', async () => {
    const { options, server, api, storage } = await fixture()
    const bridge = new EnterpriseBridge(options)
    await bridge.enroll({ origin, challenge })
    server.now += 61_000
    vi.spyOn(storage, 'encryptString').mockImplementationOnce(() => { throw new Error('fixture storage failure') })
    expect(await bridge.sync()).toEqual({ origin, state: 'unavailable', issue: 'secureStorage' })
    expect((await bridge.sync()).state).toBe('connected')
    expect((await new EnterpriseBridge(options).sync()).state).toBe('connected')
    expect(api.mock.calls.filter(([target]) => String(target).endsWith('/refresh'))).toHaveLength(1)
  })

  it('polls with the last cursor, reloads policy after events or a cursor reset, and redacts revoked state', async () => {
    const { options, server, api } = await fixture()
    const bridge = new EnterpriseBridge(options)
    await bridge.enroll({ origin, challenge })
    api.mockClear()
    expect(await bridge.sync(true)).toMatchObject({ bootstrap: { cursor: 4, policy: { revision: 1 } } })
    expect(api.mock.calls.map(([target]) => String(target))).toEqual([`${origin}/api/v1/events?cursor=4`])
    server.cursor = 8
    server.events = [{ sequence: 8 }]
    server.revision = 2
    expect(await bridge.sync(true)).toMatchObject({ bootstrap: { cursor: 8, policy: { revision: 2 } } })
    server.resetCursor = true
    server.cursor = 12
    server.revision = 3
    expect(await bridge.sync(true)).toMatchObject({ bootstrap: { cursor: 12, policy: { revision: 3 } } })
    server.revoke = true
    expect(await bridge.sync(true)).toEqual({ origin, state: 'revoked', issue: 'bindingExpired' })
  })

  it('rejects invalid origins and challenges, including loopback HTTP outside development', async () => {
    const { options, api } = await fixture()
    const bridge = new EnterpriseBridge(options)
    for (const input of [
      'http://control.example.test', 'http://127.0.0.1:3000', 'https://name:password@control.example.test',
      'https://control.example.test/path/..', 'https://control.example.test?query=1', 'https://control.example.test#hash',
      'file:///tmp/enterprise',
    ]) {
      expect(await bridge.enroll({ origin: input, challenge })).toMatchObject({ issue: 'invalidOrigin' })
    }
    expect(await bridge.enroll({ origin, challenge: 'invalid' })).toMatchObject({ issue: 'invalidChallenge' })
    const devBridge = new EnterpriseBridge({ ...options, allowLoopbackHttp: true })
    expect(await devBridge.enroll({ origin: 'http://localhost:3000', challenge })).toMatchObject({ issue: 'invalidOrigin' })
    expect(api).not.toHaveBeenCalled()
    expect(await devBridge.enroll({ origin: 'http://127.0.0.1:3000', challenge })).toMatchObject({ state: 'connected' })
  })

  it('requires an explicit office selection and restores only the pinned HTTP origin', async () => {
    const { options, api, profilePath, storage, existingSettings, originalSettings } = await fixture()
    const enterpriseOptions = { ...options, officeHttpOrigin: officeOrigin }
    const bridge = new EnterpriseBridge(enterpriseOptions)
    expect(await bridge.sync()).toEqual({ state: 'disconnected', origin: null, officeHttpOrigin: officeOrigin })

    for (const input of [
      { origin: officeOrigin, challenge },
      { origin: officeOrigin, challenge, officeHttp: false },
      { origin: 'http://192.168.254.204:8081', challenge, officeHttp: true },
      { origin: 'http://192.168.254.203:8788', challenge, officeHttp: true },
      { origin: 'http://192.168.254.203:8081/path', challenge, officeHttp: true },
    ]) {
      expect(await bridge.enroll(input)).toMatchObject({ issue: 'invalidOrigin' })
    }
    expect(api).not.toHaveBeenCalled()
    expect(await new EnterpriseBridge(options).enroll({ origin: officeOrigin, challenge, officeHttp: true }))
      .toMatchObject({ issue: 'invalidOrigin' })

    const connected = await bridge.enroll({ origin: officeOrigin, challenge, officeHttp: true })
    expect(connected).toMatchObject({ origin: officeOrigin, state: 'connected' })
    const stored = JSON.parse(storage.decryptString(await readFile(profilePath)))
    expect(stored).toMatchObject({ version: 1, origin: officeOrigin, officeHttp: true })
    expect(await new EnterpriseBridge(enterpriseOptions).sync()).toEqual(connected)
    api.mockClear()
    expect(await new EnterpriseBridge(options).sync()).toMatchObject({ issue: 'secureStorage' })
    expect(api).not.toHaveBeenCalled()
    expect(await readFile(existingSettings, 'utf8')).toBe(originalSettings)
  })

  it('forwards only valid shared context through a bound device and rejects invalid replies', async () => {
    const { options, api, server } = await fixture()
    const bridge = new EnterpriseBridge(options)
    expect(await bridge.piContext({ kind: 'prompt' })).toBeNull()
    expect(api).not.toHaveBeenCalled()
    await bridge.enroll({ origin, challenge })
    api.mockClear()

    for (const input of [
      {}, { kind: 'prompt', query: 'x' }, { kind: 'memory', query: '' },
      { kind: 'knowledge', query: '采购\n收货' }, { kind: 'knowledge', query: 'x'.repeat(161) },
      { kind: 'unknown', query: '采购' }, { kind: 'memory', query: '采购', extra: true },
    ]) expect(await bridge.piContext(input)).toBeNull()
    expect(api).not.toHaveBeenCalled()

    api.mockResolvedValueOnce(Response.json({ kind: 'knowledge', text: '已授权资料' }))
    expect(await bridge.piContext({ kind: 'knowledge', query: '  采购收货  ' }))
      .toEqual({ kind: 'knowledge', text: '已授权资料' })
    const [target, init] = api.mock.calls.at(-1)!
    expect(String(target)).toBe(origin + '/api/v1/pi-context')
    expect(JSON.parse(String(init?.body))).toEqual({ kind: 'knowledge', query: '采购收货' })
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + server.credentials.accessToken)
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' })

    api.mockResolvedValueOnce(Response.json({ kind: 'memory', text: '已授权记忆' }))
    expect(await bridge.piContext({ kind: 'memory', query: '项目交付' }))
      .toEqual({ kind: 'memory', text: '已授权记忆' })
    api.mockResolvedValueOnce(Response.json({ kind: 'prompt', text: '已授权场景提示' }))
    expect(await bridge.piContext({ kind: 'prompt' }))
      .toEqual({ kind: 'prompt', text: '已授权场景提示' })

    for (const reply of [
      { kind: 'prompt', text: 'wrong kind' },
      { kind: 'knowledge', text: 'x'.repeat(32_001) },
      { kind: 'knowledge', text: '' },
      { kind: 'knowledge', text: '  \n  ' },
      { kind: 'knowledge', text: server.credentials.accessToken },
      { kind: 'knowledge', text: 'unexpected field', extra: true },
    ]) {
      api.mockResolvedValueOnce(Response.json(reply))
      expect(await bridge.piContext({ kind: 'knowledge', query: '采购' })).toBeNull()
    }
  })

  it('discards shared context when the binding changes or is revoked during the request', async () => {
    const { options, api, server } = await fixture()
    const bridge = new EnterpriseBridge(options)
    await bridge.enroll({ origin, challenge })

    async function pendingPrompt() {
      let received!: () => void
      const started = new Promise<void>(resolve => { received = resolve })
      let release!: (response: Response) => void
      const response = new Promise<Response>(resolve => { release = resolve })
      api.mockImplementationOnce(async () => { received(); return response })
      const result = bridge.piContext({ kind: 'prompt' })
      await started
      return { result, release }
    }

    const replaced = await pendingPrompt()
    await bridge.enroll({ origin, challenge })
    replaced.release(Response.json({ kind: 'prompt', text: '旧连接的结果' }))
    expect(await replaced.result).toBeNull()

    const revoked = await pendingPrompt()
    server.revoke = true
    expect((await bridge.sync()).state).toBe('revoked')
    revoked.release(Response.json({ kind: 'prompt', text: '撤权前的结果' }))
    expect(await revoked.result).toBeNull()
  })

  it('fails closed if secure storage is unavailable or enrollment is redirected', async () => {
    const { options, api, storage, profilePath } = await fixture()
    const bridge = new EnterpriseBridge(options)
    storage.isEncryptionAvailable.mockReturnValue(false)
    expect(await bridge.enroll({ origin, challenge })).toMatchObject({ issue: 'secureStorage' })
    expect(api).not.toHaveBeenCalled()
    storage.isEncryptionAvailable.mockReturnValue(true)
    api.mockResolvedValueOnce(new Response('', { status: 307, headers: { location: 'https://unrelated.example.test/' } }))
    expect(await bridge.enroll({ origin, challenge })).toMatchObject({ issue: 'network' })
    expect(api).toHaveBeenCalledTimes(1)
    expect(api.mock.calls[0]![1]).toMatchObject({ redirect: 'error' })
    await expect(readFile(profilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('redacts the enterprise model catalog and pins grants to the enrolling device and protocol', async () => {
    const { options, server, api } = await fixture()
    const bridge = new EnterpriseBridge(options)
    expect(await bridge.models()).toBeNull()
    expect(api).not.toHaveBeenCalled()
    await bridge.enroll({ origin, challenge })
    const catalog = await bridge.models()
    expect(catalog?.models[0]).toMatchObject({ providerId: `enterprise:${server.deviceId}:fixture-provider`, modelId: 'fixture-model' })
    expect(JSON.stringify(catalog)).not.toContain('organization-key')
    expect(JSON.stringify(catalog)).not.toContain(server.credentials.accessToken)
    const model = catalog!.models[0]!
    const scope = { providerId: model.providerId, modelId: model.modelId, protocol: model.protocol, sessionId: 'session-fixture' }
    expect(await bridge.modelGrant({ ...scope, providerId: 'enterprise:wrong-binding' })).toBeNull()
    expect(await bridge.modelGrant({ ...scope, protocol: 'anthropic' })).toBeNull()
    expect(await bridge.modelGrant(scope)).toMatchObject({
      origin, accessToken: 'short-grant-for-isolated-test-1', proxyEndpoint: '/api/v1/model-gateway/openai',
    })
    const lastRequest = api.mock.calls.at(-1)!
    expect(JSON.parse(String(lastRequest[1]?.body))).toEqual({ modelId: model.modelId, sessionId: 'session-fixture' })
    server.modelAllowed = false
    expect(await bridge.modelGrant(scope)).toBeNull()
    expect(await bridge.models()).toMatchObject({ models: [] })
    await bridge.enroll({ origin, challenge })
    expect(await bridge.modelGrant(scope)).toBeNull()
  })

  it('routes demands with native device auth and returns redacted typed status and conflicts', async () => {
    const { options, server, api } = await fixture()
    const bridge = new EnterpriseBridge(options)
    expect(await bridge.demand({ action: 'status' })).toEqual({ ok: false, issue: 'unbound' })
    await bridge.enroll({ origin, challenge })
    expect(await bridge.demand({ action: 'status' })).toEqual({
      ok: true, data: { oaConfigured: true, callbackConfigured: false, aiPrecheckConfigured: true },
    })
    server.demandIssue = true
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    expect(await bridge.demand({ action: 'precheck', id, expectedDraftRevision: 2 })).toEqual({ ok: false, issue: 'conflict' })
    const [target, init] = api.mock.calls.at(-1)!
    expect(String(target)).toBe(`${origin}/api/v1/demands/${id}/precheck`)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(JSON.parse(String(init?.body))).toEqual({ expectedDraftRevision: 2 })
  })

  it('supports automatic challenge retrieval for office HTTP intranet enrollment', async () => {
    const { options, api } = await fixture()
    const autoChallenge = 'c'.repeat(43)
    const enterpriseOptions = { ...options, officeHttpOrigin: officeOrigin }
    const bridge = new EnterpriseBridge(enterpriseOptions)
    let capturedDeviceId = ''
    api.mockImplementation(async (target: string | URL, init?: RequestInit) => {
      const url = String(target)
      if (url.endsWith('/api/v1/devices/intranet-challenge')) {
        return new Response(JSON.stringify({ challenge: autoChallenge, expiresAt: new Date(Date.now() + 60000).toISOString() }), {
          status: 201, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/v1/devices/enroll')) {
        const body = JSON.parse(String(init?.body))
        capturedDeviceId = body.deviceId
        return new Response(JSON.stringify({
          accessToken: 'a'.repeat(30), refreshToken: 'r'.repeat(30), expiresAt: new Date(Date.now() + 60000).toISOString(),
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        user: { id: 'user-1', displayName: '管理员', roles: ['platform_admin'] },
        device: { id: capturedDeviceId, platform: 'win32', clientVersion: '0.7.8' },
        policy: { revision: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), features: { demands: true, models: true, memories: true, updates: true } },
        cursor: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const connected = await bridge.enroll({ origin: officeOrigin, challenge: '', officeHttp: true })
    expect(connected.state).toBe('connected')
    expect(api.mock.calls.some(([req]) => String(req).endsWith('/api/v1/devices/intranet-challenge'))).toBe(true)
  })
})
