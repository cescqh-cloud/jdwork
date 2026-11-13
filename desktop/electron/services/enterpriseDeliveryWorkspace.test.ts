// @vitest-environment node

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { EnterpriseDeliveryRun, EnterpriseDeliveryTask } from '../../src/lib/desktopHost/enterpriseDelivery'
import { ELECTRON_IPC_CHANNELS } from '../ipc/channels'
import { isElectronIpcChannelAllowedForPetWindow, validateElectronIpcPayload } from '../ipc/capabilities'
import { EnterpriseBridge } from './enterpriseBridge'
import { createDeliveryWorkspace, inspectDeliveryWorktree, readDeliveryMaterials, readStableDeliveryMaterials } from './enterpriseDeliveryWorkspace'

const origin = 'https://control.example.test'
const date = '2026-11-10T08:00:00.000Z'
const user = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const runId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const bindingId = 'cccccccc-cccc-4ccc-bccc-cccccccccccc'
const key = 'dddddddd-dddd-4ddd-addd-dddddddddddd'
const prefix = '.cc-haha-delivery-test-'
const folders = new Set<string>()
const servers = new Set<Server>()

afterEach(async () => {
  for (const server of servers) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  servers.clear()
  for (const folder of folders) {
    const resolved = await realpath(folder)
    if (dirname(resolved) !== await realpath(process.cwd()) || !basename(resolved).startsWith(prefix)) throw new Error('Unexpected fixture path')
    await rm(resolved, { recursive: true, force: true })
  }
  folders.clear()
})

function git(root: string, args: string[]) {
  return execFileSync('git', ['-C', root, '-c', 'core.hooksPath=' + join(root, 'empty-hooks'), ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8', windowsHide: true,
  }).trim()
}

async function gitFixture() {
  const scratch = await mkdtemp(join(await realpath(process.cwd()), prefix))
  folders.add(scratch)
  const repository = join(scratch, 'repository')
  const worktree = join(scratch, 'worktree')
  await mkdir(repository)
  git(repository, ['init', '--quiet', '--template='])
  git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Fixture'])
  git(repository, ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD'])
  return { scratch, repository, worktree, revision: git(worktree, ['rev-parse', 'HEAD']) }
}

function makeTask(): EnterpriseDeliveryTask {
  return {
    id: '11111111-1111-4111-8111-111111111111', demandId: '22222222-2222-4222-8222-222222222222',
    approvedVersionId: '33333333-3333-4333-8333-333333333333', projectId: '44444444-4444-4444-8444-444444444444',
    demandNo: 'DEMAND-FIXTURE', title: 'Example', snapshotHash: '1'.repeat(64), assigneeId: user, assigneeName: 'Fixture',
    projectName: 'Fixture project', state: 'DEVELOPING', revision: 1, canAdvance: true,
    permissions: { bind: true, submitChecks: true, start: false, startTesting: false, review: false, recordTest: false, accept: false, returnForRework: false },
    binding: null, latestRunId: null, acceptedRunId: null, latestTestOutcome: null, deliveryRef: null, history: [], createdAt: date, updatedAt: date,
  }
}

async function nativeFixture(scratch: string) {
  const sessions = new Map<string, string>()
  const received: { method: string; path: string; authorization: string; body: unknown }[] = []
  const token = 'test-local-sidecar-only'
  const sidecarResponse = (method: string, path: string, authorization: string, body: { workDir?: string; permissionMode?: string } | null) => {
    received.push({ method, path, authorization, body })
    const respond = (status: number, value: unknown) => Response.json(value, { status })
    if (authorization !== `Bearer ${token}`) return respond(401, {})
    if (method === 'POST' && path === '/api/sessions' && typeof body?.workDir === 'string' && body.permissionMode === 'default') {
      const sessionId = 'fixture-session-' + (sessions.size + 1)
      sessions.set(sessionId, body.workDir)
      return respond(201, { sessionId, workDir: body.workDir })
    }
    const match = /^\/api\/sessions\/(fixture-session-\d+)\/inspection\?statusOnly=1$/u.exec(path)
    if (method === 'GET' && match?.[1] && sessions.has(match[1])) {
      return respond(200, { status: { sessionId: match[1], workDir: sessions.get(match[1]) } })
    }
    return respond(404, {})
  }
  let serverUrl = 'http://127.0.0.1:8765'
  const fetchLocal: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    expect(url.origin).toBe(serverUrl)
    expect(init?.redirect).toBe('error')
    return sidecarResponse(init?.method ?? 'GET', url.pathname + url.search, new Headers(init?.headers).get('authorization') ?? '',
      init?.body ? JSON.parse(String(init.body)) : null)
  }
  const realLoopback = process.env.LIYUAN_TEST_DELIVERY_LOOPBACK === '1'
  if (realLoopback) {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      const response = sidecarResponse(req.method ?? '', req.url ?? '', req.headers.authorization ?? '', body)
      res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(await response.text())
    })
    servers.add(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
  let task = makeTask()
  let report: EnterpriseDeliveryRun | null = null
  let deviceId = ''
  let dropCheckReply = false
  let revoked = false
  const accessToken = 'only-fake-enterprise-access'
  const expiresAt = '2026-11-10T09:00:00.000Z'
  const cloud: { path: string; body: unknown; headers: Headers }[] = []
  const options: ConstructorParameters<typeof EnterpriseBridge>[0] = {
    profilePath: join(scratch, 'fixture-device.enc'), platform: process.platform, clientVersion: '0.7.7', now: () => Date.parse(date),
    secureStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() },
    fetch: async (input, init) => {
      const url = new URL(String(input))
      if (url.origin !== origin) return new Response(null, { status: 403 })
      const path = url.pathname
      const headers = new Headers(init?.headers)
      const body = init?.body ? JSON.parse(String(init.body)) : null
      cloud.push({ path, body, headers })
      if (revoked) return new Response(null, { status: 403 })
      if (path === '/api/v1/devices/enroll') {
        deviceId = body.deviceId
        return Response.json({ accessToken, refreshToken: 'only-fake-enterprise-refresh', expiresAt })
      }
      if (headers.get('Authorization') !== `Bearer ${accessToken}`) return new Response(null, { status: 401 })
      if (path === '/api/v1/bootstrap') return Response.json({
        user: { id: user, displayName: 'Fixture', roles: ['developer'] }, device: { id: deviceId, platform: process.platform, clientVersion: '0.7.7' },
        policy: { revision: 1, expiresAt, features: { demands: true, models: false, memories: false, updates: false } }, cursor: 1,
      })
      const root = '/api/v1/deliveries/' + task.id
      if (path === root) return Response.json(task)
      if (path === root + '/bind' && headers.get('If-Match') === `"${task.revision}"`) {
        task = { ...task, revision: task.revision + 1, binding: { ...body, id: bindingId, deviceId, createdAt: date } }
        return Response.json(task)
      }
      if (path === root + '/checks' && headers.get('If-Match') === `"${task.revision}"`) {
        const verdict = body.files[0].text.includes('FIXED') ? 'PASS' : 'BLOCK'
        const currentRunId = report ? randomUUID() : runId
        const digest = (text: string) => createHash('sha256').update(text).digest('hex')
        report = { id: currentRunId, bindingId, approvedVersionId: task.approvedVersionId, snapshotHash: task.snapshotHash, submittedBy: user,
          taskRevision: task.revision, inputHash: digest(body.files[0].text), ruleVersion: 'delivery-v1', verdict, stale: false, review: null, createdAt: date,
          selectionReceipt: body.selectionReceipt,
          files: [{ path: 'request.md', sha256: digest(body.files[0].text) }], findings: [{ ruleId: 'structure.acceptance', status: verdict, severity: 'critical',
            message: '补齐验收标准。', guidance: '按冻结需求填写。', evidence: [{ path: 'request.md', line: 2 }],
            ruleVersion: 'delivery-v1', inputHash: '2'.repeat(64), detectedAt: date }] }
        task = { ...task, revision: task.revision + 1, latestRunId: currentRunId, materials: { state: 'unverified', expiresAt: null } }
        if (dropCheckReply) {
          dropCheckReply = false
          throw new TypeError('Fixture response lost after commit')
        }
        return Response.json({ task, run: report })
      }
      if (path === root + '/materials' && report && body?.runId === report.id && headers.get('If-Match') === `"${task.revision}"`) {
        const digest = createHash('sha256').update(JSON.stringify(report.files.map(file => [file.path, file.sha256]))).digest('hex')
        if (body.checksum !== digest && task.materials?.state !== 'changed') {
          report = { ...report, stale: true }
          task = { ...task, revision: task.revision + 1, materials: { state: 'changed', expiresAt: null } }
        } else if (task.materials?.state !== 'changed') task = { ...task, materials: { state: 'current', expiresAt } }
        return Response.json(task)
      }
      if (report && path === root + '/checks/' + report.id) return Response.json(report)
      return new Response(null, { status: 404 })
    },
  }
  const bridge = new EnterpriseBridge(options)
  expect((await bridge.enroll({ origin, challenge: 'a'.repeat(43) })).state).toBe('connected')
  return { bridge, getTask: () => task, setTask: (value: EnterpriseDeliveryTask) => { task = value },
    received, cloud, serverUrl, token, fetchLocal: realLoopback ? fetch : fetchLocal,
    loseNextCheckReply: () => { dropCheckReply = true },
    revoke: () => { revoked = true },
    restart: () => new EnterpriseBridge(options),
  }
}

it('accepts only typed delivery inputs from the main renderer', () => {
  const channel = ELECTRON_IPC_CHANNELS.enterpriseDelivery
  const input = { action: 'check', id: makeTask().id, revision: 2, idempotencyKey: key }
  expect(validateElectronIpcPayload(channel, input)).toBe(true)
  expect(validateElectronIpcPayload(channel, { ...input, files: [] })).toBe(false)
  expect(validateElectronIpcPayload(channel, { ...input, workDir: '/local' })).toBe(false)
  expect(validateElectronIpcPayload(channel, { action: 'bind', id: input.id, revision: 1, worktreeId: 'arbitrary' })).toBe(false)
  expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
})

it('checks the selected worktree and reads only permitted text material', async () => {
  const { scratch, repository, worktree, revision } = await gitFixture()
  expect(await inspectDeliveryWorktree(worktree)).toEqual({ workDir: await realpath(worktree), gitRevision: revision })
  await expect(inspectDeliveryWorktree(repository)).rejects.toMatchObject({ issue: 'repository' })
  const outside = join(scratch, 'other.md')
  const config = join(worktree, '.env.local.json')
  const inside = join(worktree, '材料.md')
  const bad = join(worktree, 'invalid.md')
  await Promise.all([writeFile(outside, '# outside'), writeFile(config, '{}'), writeFile(inside, '采购'.repeat(1500)), writeFile(bad, Buffer.from([0xff, 0xfe]))])
  expect(await readDeliveryMaterials(worktree, [inside])).toEqual([{ path: '材料.md', text: '采购'.repeat(1500) }])
  for (const paths of [[outside], [config], [bad], [inside, inside]]) {
    await expect(readDeliveryMaterials(worktree, paths)).rejects.toMatchObject({ issue: 'invalidMaterial' })
  }
})

it('refuses to check a selected file with a real unresolved Git merge', async () => {
  const { worktree } = await gitFixture()
  const target = join(worktree, 'request.md')
  const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid']
  const commit = (message: string) => git(worktree, [...identity, 'commit', '--quiet', '-m', message])
  await writeFile(target, '# original')
  git(worktree, ['add', '--', 'request.md'])
  commit('Original material')
  git(worktree, ['branch', 'fixture-other'])
  git(worktree, ['switch', '--quiet', '-c', 'fixture-own'])
  await writeFile(target, '# first edit')
  git(worktree, ['add', '--', 'request.md'])
  commit('First edit')
  git(worktree, ['switch', '--quiet', 'fixture-other'])
  await writeFile(target, '# competing edit')
  git(worktree, ['add', '--', 'request.md'])
  commit('Competing edit')
  git(worktree, ['switch', '--quiet', 'fixture-own'])
  expect(() => git(worktree, [...identity, 'merge', '--no-edit', 'fixture-other'])).toThrow()
  await expect(readStableDeliveryMaterials(worktree, [target])).rejects.toMatchObject({ issue: 'materialConflict' })
}, 12_000)

it('binds actual Git HEAD, sends only selected files, and prepares a separate session without sending an agent message', async () => {
  const { scratch, worktree, revision } = await gitFixture()
  const fixture = await nativeFixture(scratch)
  const { bridge, cloud, received, token, serverUrl, fetchLocal } = fixture
  const id = fixture.getTask().id
  const selected = join(worktree, 'request.md')
  await Promise.all([writeFile(selected, '# Fixture request'), writeFile(join(worktree, 'private.md'), 'not selected')])
  const workspace = createDeliveryWorkspace(() => ({ serverUrl, token }), {
    directory: async () => worktree, files: async root => {
      expect(root).toBe(await realpath(worktree))
      return [selected]
    },
  }, fetchLocal)
  expect(await bridge.delivery({ action: 'bind', id, revision: 1 }, workspace)).toMatchObject({
    ok: true, data: { sessionId: 'fixture-session-1', task: { revision: 2 } },
  })
  const bound = fixture.getTask()
  expect(cloud.find(item => item.path.endsWith('/bind'))?.body).toEqual({
    sessionId: 'fixture-session-1', gitRevision: revision, worktreeId: expect.stringMatching(/^w-[a-f0-9]{32}\.[a-f0-9]{64}$/u),
  })
  expect(await bridge.delivery({ action: 'open', id, revision: 2 }, workspace)).toMatchObject({ ok: true, data: { sessionId: 'fixture-session-1' } })
  expect(await bridge.delivery({ action: 'check', id, revision: 2, idempotencyKey: key }, workspace)).toMatchObject({ ok: true, data: { run: { id: runId } } })
  const check = cloud.find(item => item.path.endsWith('/checks'))
  expect(check?.body).toEqual({ files: [{ path: 'request.md', text: '# Fixture request' }], selectionReceipt: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/u) })
  expect(check?.headers.get('Idempotency-Key')).toBe(key)
  expect(await bridge.delivery({ action: 'fix', id, revision: 3, runId }, workspace)).toMatchObject({
    ok: true, data: { sessionId: 'fixture-session-2', draftText: expect.stringContaining('request.md:2') },
  })
  expect(await bridge.delivery({ action: 'fix', id, revision: 3, runId }, workspace)).toMatchObject({
    ok: true, data: { sessionId: 'fixture-session-2' },
  })
  expect(received.filter(item => item.method === 'POST')).toEqual(Array.from({ length: 2 }, () => ({
    method: 'POST', path: '/api/sessions', authorization: `Bearer ${token}`,
    body: { workDir: worktree, permissionMode: 'default' },
  })))
  expect(cloud.some(item => JSON.stringify(item.body).includes('private.md') || item.headers.get('Authorization') === `Bearer ${token}`)).toBe(false)

  fixture.setTask({ ...fixture.getTask(), binding: { ...bound.binding!, sessionId: 'fixture-session-2' } })
  const localCount = received.length
  expect(await bridge.delivery({ action: 'open', id, revision: 3 }, workspace)).toEqual({ ok: false, issue: 'missingLocalWorkspace' })
  expect(received).toHaveLength(localCount)
  fixture.setTask({ ...fixture.getTask(), binding: bound.binding })
  git(worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Fixture change'])
  expect(await bridge.delivery({ action: 'check', id, revision: 3 }, workspace)).toEqual({ ok: false, issue: 'worktreeChanged' })
  expect(cloud.filter(item => item.path.endsWith('/checks'))).toHaveLength(1)
}, 18_000)

it('automatically rechecks only the previously selected file after explicit opt-in and stops after opt-out', async () => {
  const { scratch, worktree } = await gitFixture()
  const fixture = await nativeFixture(scratch)
  const { bridge, cloud, token, serverUrl, fetchLocal } = fixture
  const id = fixture.getTask().id
  const selected = join(worktree, 'request.md')
  const other = join(worktree, 'private.md')
  await Promise.all([writeFile(selected, '# Fixture request'), writeFile(other, 'not selected')])
  const workspace = createDeliveryWorkspace(() => ({ serverUrl, token }), {
    directory: async () => worktree, files: async () => [selected],
  }, fetchLocal)
  try {
    expect(await bridge.delivery({ action: 'bind', id, revision: 1 }, workspace)).toMatchObject({ ok: true })
    expect(await bridge.delivery({ action: 'check', id, revision: 2 }, workspace)).toMatchObject({
      ok: true, data: { run: { verdict: 'BLOCK' }, task: { materials: { state: 'current' } } },
    })
    const checks = () => cloud.filter(item => item.path.endsWith('/checks'))
    const current = fixture.getTask()
    expect(await bridge.delivery({ action: 'watch', id, revision: current.revision, enabled: true }, workspace)).toMatchObject({ ok: true })
    await writeFile(other, 'updated unrelated file')
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(checks()).toHaveLength(1)
    await writeFile(selected, '# Fixture request FIXED')
    await vi.waitFor(() => expect(fixture.getTask().latestRunId).not.toBe(current.latestRunId), { timeout: 10_000 })
    await vi.waitFor(() => expect(fixture.getTask().materials?.state).toBe('current'), { timeout: 8_000 })
    expect(checks()).toHaveLength(2)
    expect(checks()[1]?.body).toMatchObject({ files: [{ path: 'request.md', text: '# Fixture request FIXED' }] })
    const observations = cloud.filter(item => item.path.endsWith('/materials')).map(item => item.body as { runId: string, checksum: string })
    const invalidation = observations.find(item => item.runId === current.latestRunId && item.checksum !== observations[0]?.checksum)
    expect(invalidation).toBeDefined()
    expect(await bridge.delivery({ action: 'watch', id, revision: fixture.getTask().revision, enabled: false }, workspace)).toMatchObject({ ok: true })
    await writeFile(selected, '# changed after opting out')
    await new Promise(resolve => setTimeout(resolve, 850))
    expect(checks()).toHaveLength(2)
  } finally { await bridge.disconnect() }
}, 20_000)

it('verifies a committed recheck after a lost response and stops the old PASS before sending a transition', async () => {
  const { scratch, worktree } = await gitFixture()
  const fixture = await nativeFixture(scratch)
  const { bridge, cloud, token, serverUrl, fetchLocal } = fixture
  const id = fixture.getTask().id
  const selected = join(worktree, 'request.md')
  await writeFile(selected, '# Fixture request FIXED')
  const workspace = createDeliveryWorkspace(() => ({ serverUrl, token }), {
    directory: async () => worktree, files: async () => [selected],
  }, fetchLocal)
  expect(await bridge.delivery({ action: 'bind', id, revision: 1 }, workspace)).toMatchObject({ ok: true })
  expect(await bridge.delivery({ action: 'check', id, revision: 2 }, workspace)).toMatchObject({ ok: true, data: { run: { verdict: 'PASS' } } })
  await writeFile(selected, '# Fixture request changed')
  expect(await bridge.delivery({ action: 'transition', id, revision: 3, transition: { action: 'start_testing' } }, workspace))
    .toEqual({ ok: false, issue: 'materialsChanged' })
  expect(cloud.some(item => item.path.endsWith('/transition'))).toBe(false)
  fixture.loseNextCheckReply()
  expect(await bridge.delivery({ action: 'recheck', id, revision: fixture.getTask().revision }, workspace)).toEqual({ ok: false, issue: 'unavailable' })
  expect(fixture.getTask().materials?.state).toBe('unverified')
  const restarted = fixture.restart()
  expect(await restarted.delivery({ action: 'get', id }, workspace)).toMatchObject({ ok: true, data: { automaticRecheck: false } })
  expect(await restarted.delivery({ action: 'recheck', id, revision: fixture.getTask().revision }, workspace)).toMatchObject({
    ok: true, data: { task: { materials: { state: 'current' }, automaticRecheck: false } },
  })
  expect(cloud.filter(item => item.path.endsWith('/checks'))).toHaveLength(2)
  expect(await restarted.delivery({ action: 'watch', id, revision: fixture.getTask().revision, enabled: true }, workspace)).toMatchObject({ ok: true })
  fixture.revoke()
  await writeFile(selected, '# changed after device revocation')
  await new Promise(resolve => setTimeout(resolve, 900))
  expect(cloud.filter(item => item.path.endsWith('/checks'))).toHaveLength(2)
}, 20_000)
