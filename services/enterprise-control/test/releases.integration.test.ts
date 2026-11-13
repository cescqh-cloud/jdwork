import { afterAll, beforeAll, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Hono } from 'hono'
import { ControlError, type Role } from '../src/contract'
import { migrate } from '../src/migrate'
import type { Actor } from '../src/store'
import { type CheckOutput } from '../src/releases/contract'
import { mountReleaseRoutes } from '../src/releases/routes'
import { ReleaseService } from '../src/releases/service'
import { createAuthenticodeVerifier, createReleaseSigner, verifyReleaseProof } from '../src/releases/signatures'
import { ReleaseStore } from '../src/releases/store'
import { builderOutput, fixtureFingerprint, fixturePublisher, requireDesktop, sha256, sha512 } from './releases-fixtures'

const address = Bun.env.ENTERPRISE_TEST_DATABASE_URL
let database: SQL
const fixtures: string[] = []
if (address) {
  const url = new URL(address)
  if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('_test')) throw new Error('Use a disposable loopback Postgres database ending in _test.')
  beforeAll(async () => { database = new SQL(address); await migrate(database) }, 15_000)
  afterAll(async () => {
    await database?.close({ timeout: 2 })
    const root = await realpath(tmpdir())
    for (const item of fixtures) {
      const absolute = await realpath(item)
      if (dirname(absolute) !== root || !basename(absolute).startsWith('enterprise-release-fixture-')) throw new Error('Refusing to remove a non-fixture path')
      await rm(absolute, { recursive: true, force: true, maxRetries: 2 })
    }
  })
}
const integration = address ? test : test.skip
type Release = Awaited<ReturnType<ReleaseStore['detail']>>

async function result<T>(request: Promise<Response> | Response, status: number) {
  const reply = await request
  const text = await reply.text()
  if (reply.status !== status) throw new Error(`Expected HTTP ${status}; got ${reply.status} ${text}`)
  return JSON.parse(text) as T
}

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'enterprise-release-fixture-'))
  fixtures.push(folder)
  const tenant = randomUUID()
  const external = randomUUID()
  const slug = `m5-${tenant.slice(0, 8)}`
  const department = randomUUID()
  await database`INSERT INTO enterprise_tenants (id, slug, name) VALUES (${tenant}, ${slug}, 'Release test organization'),
    (${external}, ${`${slug}-other`}, 'Separate organization')`
  await database`INSERT INTO enterprise_departments (tenant_id, id, name) VALUES (${tenant}, ${department}, 'QA')`
  const actors: Record<string, Actor> = {}
  async function person(name: string, role: Role, device: boolean, otherTenant = false, assignedDepartment = false) {
    const id = randomUUID()
    const tenantId = otherTenant ? external : tenant
    await database`INSERT INTO enterprise_users (tenant_id, id, login, display_name, roles, department_id)
      VALUES (${tenantId}, ${id}, ${name}, ${name}, ${database.array([role], 'TEXT')}, ${assignedDepartment ? department : null})`
    const deviceId = device ? randomUUID() : undefined
    if (deviceId) {
      await database`INSERT INTO enterprise_devices (id, tenant_id, user_id, public_key, platform, client_version)
        VALUES (${deviceId}, ${tenantId}, ${id}, 'isolated-fixture-device-key', 'win32', '0.7.7')`
    }
    const actor: Actor = { id, tenantId, displayName: name, roles: [role], expiresAt: new Date(Date.now() + 60_000),
      device: deviceId ? { id: deviceId, platform: 'win32', clientVersion: '0.7.7' } : null }
    actors[name] = actor
    return actor
  }
  await person('admin', 'platform_admin', false)
  await person('admin-device', 'platform_admin', true)
  await person('member', 'developer', false)
  const a = await person('device-a', 'developer', true)
  const b = await person('device-b', 'developer', true, false, true)
  const c = await person('device-c', 'developer', true)
  const d = await person('device-d', 'developer', true, false, true)
  const foreign = await person('foreign', 'developer', true, true)
  const keys = createReleaseSigner(generateKeyPairSync('ed25519').privateKey)
  const signing = { fingerprint: fixtureFingerprint, calls: 0 }
  const objects = join(folder, 'objects')
  const service = new ReleaseService(new ReleaseStore(database), { directory: objects, maxBytes: 4096, signer: keys,
    trustedFingerprints: new Set([fixtureFingerprint]), allowFixtureSignatures: true,
    async verifier() { signing.calls++; return { kind: 'test-fixture', fingerprint: signing.fingerprint, publisher: fixturePublisher } },
  }, 'http://127.0.0.1:8798')
  const app = new Hono()
  app.onError((error, context) => {
    if (error instanceof ControlError) return context.json({ code: error.code, message: error.message }, error.status)
    throw error
  })
  mountReleaseRoutes(app, { service, actor: async (context, allowDevice = true) => {
    const actor = actors[context.req.header('x-fixture-actor') ?? '']
    if (!actor || (!allowDevice && actor.device)) throw new ControlError(401, 'AUTH_REQUIRED', 'The local fixture actor is unavailable.')
    return actor
  } })
  const request = (path: string, actor = 'admin', method = 'GET', body?: RequestInit['body'], headers?: Record<string, string>) =>
    app.request(path, { method, body, headers: { 'x-fixture-actor': actor, ...headers } })
  const json = (path: string, actor = 'admin', method = 'GET', data?: unknown) => request(`/api/v1${path}`, actor, method,
    data === undefined ? undefined : JSON.stringify(data), data === undefined ? undefined : { 'Content-Type': 'application/json' })
  const create = (version: string, policy: Record<string, unknown> = {}) => result<Release>(json('/admin/releases', 'admin', 'POST', {
    platform: 'win32', arch: 'x64', channel: 'canary', version, rolloutPercent: 100,
    targetDeviceIds: [a.device!.id], targetDepartmentIds: [department], failureMinSample: 2, failureThresholdPercent: 50, ...policy,
  }), 201)
  const check = (actor: string, version = '0.7.7', arch = 'x64', channel = 'canary') =>
    result<CheckOutput>(json(`/updates/check?${new URLSearchParams({ platform: 'win32', arch, currentVersion: version, channel })}`, actor), 200)
  const manifest = (id: string, body: Uint8Array) => request(`/api/v1/admin/releases/${id}/manifest`, 'admin', 'PUT', body, { 'Content-Type': 'application/yaml' })
  const installer = (id: string, body: RequestInit['body']) => request(`/api/v1/admin/releases/${id}/package`, 'admin', 'PUT', body, { 'Content-Type': 'application/octet-stream' })
  const publish = (id: string, expectedRevision: number) => json(`/admin/releases/${id}/publish`, 'admin', 'POST', { expectedRevision, testEvidence: 'QA build verification fixture' })
  const report = (actor: string, releaseId: string, stage: string, eventId: string = randomUUID(), errorCode?: string) =>
    json('/client/update-reports', actor, 'POST', { releaseId, eventId, stage, ...(errorCode ? { errorCode } : {}) })
  async function stage(draft: Release, marker?: number) {
    const data = await builderOutput(join(folder, draft.id), draft.version, marker)
    const uploaded = await result<Release>(manifest(draft.id, data.manifest), 200)
    const verified = await result<Release>(installer(draft.id, data.bytes), 200)
    return { data, uploaded, verified }
  }
  return { folder, objects, tenant, actors, a, b, c, d, foreign, keys, signing, app, request, json, create, check, manifest, installer, publish, report, stage }
}

integration('admin uploads immutable builder assets and serves only the eligible device with a signed manifest and byte ranges', async () => {
  const f = await fixture()
  expect((await f.json('/admin/releases', 'member')).status).toBe(403)
  expect((await f.json('/admin/releases', 'admin-device')).status).toBe(401)
  expect((await f.json('/admin/releases', 'admin', 'POST', { platform: 'win32', arch: 'x64', channel: 'canary', version: '0.7.8',
    rolloutPercent: 100, targetDeviceIds: [f.foreign.device!.id] })).status).toBe(400)
  const draft = await f.create('0.7.8', { minClientVersion: '0.7.8', maxTestedVersion: '0.8.0', securityRequired: true })
  const { id } = draft
  expect((await f.publish(id, draft.revision)).status).toBe(409)
  expect((await f.check('device-a')).candidate).toBeNull()
  const data = await builderOutput(join(f.folder, id), draft.version)
  const manifestReady = await result<Release>(f.manifest(id, data.manifest), 200)
  expect(manifestReady.manifest?.sha256).toBe(sha256(data.manifest))
  expect(manifestReady.revision).toBe(2)
  const changed = Buffer.from(data.bytes)
  changed[500] = 0x11
  expect((await f.installer(id, changed)).status).toBe(409)
  expect(f.signing.calls).toBe(0)
  f.signing.fingerprint = 'b'.repeat(64)
  expect((await f.installer(id, data.bytes)).status).toBe(409)
  f.signing.fingerprint = fixtureFingerprint
  const streaming = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(data.bytes.subarray(0, 177)); controller.enqueue(data.bytes.subarray(177)); controller.close()
  } })
  const ready = await result<Release>(f.installer(id, streaming), 200)
  expect(ready.artifact).toEqual({ name: data.name, size: data.bytes.length, sha256: sha256(data.bytes), sha512: sha512(data.bytes) })
  expect(ready.signer?.kind).toBe('test-fixture')
  expect(await readdir(join(f.objects, f.tenant, id))).toEqual([`${sha256(data.bytes)}.exe`])
  expect((await f.publish(id, manifestReady.revision)).status).toBe(409)
  const published = await result<Release>(f.publish(id, ready.revision), 200)
  expect(published.status).toBe('PUBLISHED')

  const base = `/api/v1/updates/feed/${id}`
  expect((await f.request(`${base}/latest.yml`, 'device-a')).status).toBe(404)
  expect((await f.check('device-c')).candidate).toBeNull()
  expect((await f.check('foreign')).candidate).toBeNull()
  const offered = await f.check('device-a', '0.0.1')
  expect(offered.currentVersion).toBe('0.7.7')
  expect(offered.compatibility).toBe('UPDATE_REQUIRED')
  expect(offered.candidate?.feedPath).toBe(`${base}/`)
  expect((await f.check('device-a', '0.7.7', 'x64', 'stable')).candidate).toBeNull()
  expect((await f.json('/updates/check?platform=win32&arch=arm64&currentVersion=0.7.7&channel=canary', 'device-a')).status).toBe(409)
  expect((await f.json('/updates/check?platform=linux&arch=x64&currentVersion=0.7.7&channel=canary', 'device-a')).status).toBe(409)
  expect((await f.json('/updates/check?platform=win32&arch=x64&currentVersion=0.7.7&channel=canary', 'member')).status).toBe(403)
  expect(verifyReleaseProof(offered.candidate?.proof, f.keys.publicKey)).toMatchObject({ artifact: ready.artifact, releaseId: id,
    manifestSha256: sha256(data.manifest), version: draft.version, signer: ready.signer })

  const raw = await f.request(`${base}/latest.yml`, 'device-a')
  expect(raw.status).toBe(200)
  expect(Buffer.from(await raw.arrayBuffer())).toEqual(data.manifest)
  expect(raw.headers.get('X-Enterprise-Release-Key-Id')).toBe(f.keys.keyId)
  expect((await f.request(`${base}/latest.yml`, 'device-c')).status).toBe(404)
  expect((await f.request(`${base}/latest.yml`, 'foreign')).status).toBe(404)
  expect((await f.request(`${base}/latest.yml`, 'unknown')).status).toBe(401)
  const path = `${base}/${encodeURIComponent(data.name)}`
  const bytes = await f.request(path, 'device-a', 'GET', undefined, { Range: 'bytes=120-145' })
  expect(bytes.status).toBe(206)
  expect(bytes.headers.get('Content-Range')).toBe('bytes 120-145/1024')
  expect(Buffer.from(await bytes.arrayBuffer())).toEqual(data.bytes.subarray(120, 146))
  expect((await f.request(path, 'device-a', 'HEAD')).headers.get('Content-Length')).toBe('1024')
  expect((await f.request(path, 'device-a', 'GET', undefined, { Range: 'bytes=2048-' })).status).toBe(416)
  expect((await f.request(`${base}/${encodeURIComponent('..\\file.exe')}`, 'device-a')).status).toBe(404)
  expect((await f.request(`${path}.blockmap`, 'device-a')).status).toBe(404)
  const tryReplacing = async () => { await database`UPDATE enterprise_client_releases SET artifact_sha256 = ${'c'.repeat(64)} WHERE tenant_id = ${f.tenant} AND id = ${id}` }
  await expect(tryReplacing()).rejects.toThrow('immutable')
}, 20_000)

integration('health deduplicates and pauses an update as soon as distinct reports reach the threshold', async () => {
  const f = await fixture()
  const draft = await f.create('0.7.9')
  const { verified, data } = await f.stage(draft)
  await result(f.publish(draft.id, verified.revision), 200)
  expect((await f.check('device-a')).candidate?.releaseId).toBe(draft.id)
  expect((await f.check('device-b')).candidate?.releaseId).toBe(draft.id)
  expect((await f.report('device-c', draft.id, 'failed', randomUUID(), 'INSTALL_FAILED')).status).toBe(404)
  const id = randomUUID()
  expect(await result(f.report('device-a', draft.id, 'failed', id, 'INSTALL_FAILED'), 200)).toEqual({ accepted: true, reused: false, paused: false })
  expect(await result(f.report('device-a', draft.id, 'failed', id, 'INSTALL_FAILED'), 200)).toEqual({ accepted: true, reused: true, paused: false })
  expect((await f.report('device-a', draft.id, 'healthy', id)).status).toBe(409)
  expect(await result(f.report('device-b', draft.id, 'healthy'), 200)).toEqual({ accepted: true, reused: false, paused: true })
  expect((await f.check('device-d')).candidate).toBeNull()
  expect((await f.check('device-b', '0.7.6')).currentVersion).toBe('0.7.9')
  expect((await f.request(`/api/v1/updates/feed/${draft.id}/latest.yml`, 'device-a')).status).toBe(404)
  expect((await f.request(`/api/v1/updates/feed/${draft.id}/${encodeURIComponent(data.name)}`, 'device-a')).status).toBe(404)
  expect((await f.report('device-b', draft.id, 'failed', randomUUID(), 'LATE_FAILURE')).status).toBe(200)
  const paused = await result<Release>(f.json(`/admin/releases/${draft.id}`), 200)
  expect(paused.status).toBe('PAUSED')
  expect(paused.pauseReason).toBe('FAILURE_THRESHOLD_REACHED')
  expect(paused.health).toMatchObject({ offered: 2, healthy: 1, failed: 1 })

  const old = await f.create('0.7.8')
  const older = await f.stage(old)
  expect((await f.publish(old.id, older.verified.revision)).status).toBe(409)
  const newer = await f.create('0.7.10')
  const next = await f.stage(newer, 0x72)
  const nextPublished = await result<Release>(f.publish(newer.id, next.verified.revision), 200)
  expect((await f.check('device-a')).candidate?.version).toBe('0.7.10')
  expect((await f.json(`/admin/releases/${newer.id}/pause`, 'admin', 'POST', { expectedRevision: next.verified.revision, reason: '暂停复核' })).status).toBe(409)
  expect((await result<Release>(f.json(`/admin/releases/${newer.id}/pause`, 'admin', 'POST', {
    expectedRevision: nextPublished.revision, reason: '暂停复核',
  }), 200)).status).toBe('PAUSED')
  expect((await f.check('device-a')).candidate).toBeNull()
}, 20_000)

integration('locked electron-updater NSIS path checks and downloads the real builder-format feed without installing', async () => {
  const f = await fixture()
  const draft = await f.create('0.7.8')
  const { data, verified } = await f.stage(draft)
  await result(f.publish(draft.id, verified.revision), 200)
  const candidate = (await f.check('device-a')).candidate!
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: f.app.fetch })
  try {
    const configPath = join(f.folder, 'app-update.yml')
    await writeFile(configPath, `publisherName: [${JSON.stringify(fixturePublisher)}]\nupdaterCacheDirName: updater-fixture\n`)
    interface FixtureUpdater {
      httpExecutor: unknown
      _testOnlyOptions: { platform: string }
      autoDownload: boolean
      autoInstallOnAppQuit: boolean
      disableDifferentialDownload: boolean
      disableWebInstaller: boolean
      logger: unknown
      requestHeaders: Record<string, string>
      verifyUpdateCodeSignature(names: string[], path: string): Promise<string | null>
      setFeedURL(options: unknown): void
      checkForUpdates(): Promise<{ isUpdateAvailable: boolean, updateInfo: { version: string } }>
      downloadUpdate(): Promise<string[]>
    }
    const { NsisUpdater } = requireDesktop('electron-updater/out/NsisUpdater') as { NsisUpdater: new (options: undefined, app: unknown) => FixtureUpdater }
    const { ElectronHttpExecutor } = requireDesktop('electron-updater/out/electronHttpExecutor') as {
      ElectronHttpExecutor: new () => { createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): unknown }
    }
    const neverInstall = () => { throw new Error('This fixture must never install or relaunch anything') }
    const executor = new ElectronHttpExecutor()
    // Exercise the dependency's real download/checksum code. Substitute only Electron's socket factory.
    executor.createRequest = (options, callback) => {
      if (options.protocol !== 'http:' || options.hostname !== '127.0.0.1' || String(options.port) !== String(server.port)) {
        throw new Error('An updater fixture cannot connect outside its isolated loopback server')
      }
      return httpRequest(options, callback)
    }
    let checkedFixtureSignature = 0
    function updaterFor(cache: string) {
      const updater = new NsisUpdater(undefined, { version: '0.7.7', name: 'Isolated update fixture', isPackaged: true,
        appUpdateConfigPath: configPath, userDataPath: f.folder, baseCachePath: cache, async whenReady() {},
        relaunch: neverInstall, quit: neverInstall, onQuit: neverInstall })
      updater.httpExecutor = executor
      updater._testOnlyOptions = { platform: 'win32' }
      updater.logger = null
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = false
      updater.disableDifferentialDownload = true
      updater.disableWebInstaller = true
      updater.verifyUpdateCodeSignature = async (names, path) => {
        checkedFixtureSignature++
        const matches = names.includes(fixturePublisher) && sha512(new Uint8Array(await Bun.file(path).arrayBuffer())) === candidate.artifact.sha512
        return matches ? null : 'Fixture signature rejected'
      }
      updater.setFeedURL({ provider: 'generic', url: new URL(candidate.feedPath, server.url).href, useMultipleRangeRequest: false })
      updater.requestHeaders = { 'x-fixture-actor': 'device-a' }
      return updater
    }
    const updater = updaterFor(f.folder)
    const result = await updater.checkForUpdates()
    expect(result.isUpdateAvailable).toBe(true)
    expect(result.updateInfo.version).toBe(draft.version)
    const [downloaded] = await updater.downloadUpdate()
    expect(checkedFixtureSignature).toBe(1)
    expect(Buffer.from(await Bun.file(downloaded!).arrayBuffer())).toEqual(data.bytes)

    const damaged = Buffer.from(data.bytes)
    damaged[512] = 0x07
    await writeFile(join(f.objects, f.tenant, draft.id, `${candidate.artifact.sha256}.exe`), damaged)
    const unsafe = updaterFor(join(f.folder, 'fresh-cache'))
    expect((await unsafe.checkForUpdates()).isUpdateAvailable).toBe(true)
    await expect(unsafe.downloadUpdate()).rejects.toThrow('checksum mismatch')
    expect(checkedFixtureSignature).toBe(1)
  } finally { await server.stop(true) }
}, 20_000)

integration('the real Windows verifier rejects unsigned fixture bytes', async () => {
  if (process.platform !== 'win32') return
  const f = await fixture()
  const data = await builderOutput(join(f.folder, 'unsigned'), '0.7.8')
  await expect(createAuthenticodeVerifier()(join(f.folder, 'unsigned', data.name))).rejects.toThrow('valid Windows Authenticode')
}, 20_000)

integration('empty stored audience arrays keep ordinary eligible devices in the stable rollout', async () => {
  const f = await fixture()
  const draft = await f.create('0.7.8', { channel: 'stable', targetDeviceIds: [], targetUserIds: [], targetDepartmentIds: [] })
  expect(draft.targetDeviceIds).toEqual([])
  expect(draft.targetUserIds).toEqual([])
  expect(draft.targetDepartmentIds).toEqual([])
  const { verified } = await f.stage(draft)
  await result(f.publish(draft.id, verified.revision), 200)
  expect((await f.check('device-c', '0.7.7', 'x64', 'stable')).candidate?.releaseId).toBe(draft.id)
  expect((await f.check('foreign', '0.7.7', 'x64', 'stable')).candidate).toBeNull()
}, 20_000)
