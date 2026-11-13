import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  enterpriseDeviceFromProviderId, enterpriseModelPaths, isEnterpriseProjectId, isEnterpriseTimestamp,
  parseEnterpriseContextResult, parseEnterpriseModelCatalog, type EnterpriseContextInput, type EnterpriseGrant, type EnterpriseGrantInput, type EnterpriseModelCatalog,
} from '../../../src/shared/enterpriseModels'
import { enterpriseErpProviderCode, parseEnterpriseErpInput, parseEnterpriseErpResult, type EnterpriseErpInput } from '../../../src/shared/enterpriseErp'
import { enterpriseFeatures, type EnterpriseBootstrap, type EnterpriseConnection, type EnterpriseEnrollment, type EnterpriseIssue } from '../../src/lib/desktopHost/enterprise'
import { enterpriseDemandResponses, type EnterpriseDemandRequest, type EnterpriseDemandResult } from '../../src/lib/desktopHost/enterpriseDemand'
import { enterpriseDemandIssue, enterpriseDemandRoute } from './enterpriseDemandRouting'
import {
  enterpriseDemandCloudDraftSchema, type EnterpriseDemandCloudDraft, type EnterpriseDemandDraftConflict,
  type EnterpriseDemandLatestDraft, type EnterpriseDemandLocalRequest, type EnterpriseDemandLocalResult,
} from '../../src/lib/desktopHost/enterpriseDemandLocal'
import { DemandDraftVaultError, EnterpriseDemandDraftVault, exportDemandDraft, type DemandDraftScope } from './enterpriseDemandDraftVault'
import { enterpriseMemoryResponses, type EnterpriseMemoryRequest, type EnterpriseMemoryResult } from '../../src/lib/desktopHost/enterpriseMemory'
import { enterpriseMemoryIssue, enterpriseMemoryRoute } from './enterpriseMemoryRouting'
import type { EnterpriseDeliveryRequest, EnterpriseDeliveryResult } from '../../src/lib/desktopHost/enterpriseDelivery'
import { EnterpriseDeliveryCoordinator } from './enterpriseDeliveryCoordinator'
import { deliveryIssue } from './enterpriseDeliveryRouting'
import { DeliveryWorkspaceError, type DeliveryWorkspace } from './enterpriseDeliveryWorkspace'
import { enterpriseUpdateRequestAllowed, type EnterpriseUpdateTransport } from './enterpriseUpdateRouting'
import { parsePiContextInput, parsePiContextResult } from '../../../src/shared/piContext'

type Credentials = { accessToken: string; refreshToken: string; expiresAt: string }
type Profile = Credentials & { origin: string; deviceId: string; privateKey: string; officeHttp?: true }
type RequestOptions = {
  body?: Record<string, unknown>; bearer?: string; rejected?: EnterpriseIssue; method?: 'POST' | 'PATCH' | 'DELETE'
  timeoutMs?: number; captureServerCode?: boolean; headers?: Record<string, string>; responseLimit?: number; signal?: AbortSignal
}

type EnterpriseBridgeOptions = {
  profilePath: string
  platform: NodeJS.Platform
  clientVersion: string
  allowLoopbackHttp?: boolean
  officeHttpOrigin?: string
  secureStorage: {
    isEncryptionAvailable(): boolean
    getSelectedStorageBackend?(): string
    encryptString(value: string): Buffer
    decryptString(value: Buffer): string
  }
  fetch?: typeof fetch
  now?: () => number
}

class EnterpriseBridgeError extends Error {
  constructor(readonly issue: EnterpriseIssue, readonly httpStatus?: number, readonly serverCode?: string) {
    super(issue)
  }
}

const challengePattern = /^[A-Za-z0-9_-]{43}$/
const devicePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const maxResponseBytes = 256 * 1024
const disconnected: EnterpriseConnection = { origin: null, state: 'disconnected' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{20,4096}$/.test(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value))
}

function isCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function normalizeOrigin(raw: string, allowLoopbackHttp = false, officeHttpOrigin?: string): string {
  const value = raw.trim()
  if (value.length > 2048 || !/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(value)) {
    throw new EnterpriseBridgeError('invalidOrigin')
  }
  if (value.toLowerCase().startsWith('http:')
    && !(allowLoopbackHttp && /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d{1,5})?\/?$/i.test(value))
    && value !== officeHttpOrigin && value !== officeHttpOrigin + '/') {
    throw new EnterpriseBridgeError('invalidOrigin')
  }
  try { return new URL(value).origin } catch { throw new EnterpriseBridgeError('invalidOrigin') }
}

function parseCredentials(value: unknown): Credentials {
  if (!isRecord(value) || !isToken(value.accessToken) || !isToken(value.refreshToken) || !isTimestamp(value.expiresAt)) {
    throw new EnterpriseBridgeError('invalidResponse')
  }
  return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt }
}

function parseBootstrap(value: unknown, deviceId: string): EnterpriseBootstrap {
  if (!isRecord(value) || !isRecord(value.user) || !isRecord(value.device) || !isRecord(value.policy) || !isCursor(value.cursor)) {
    throw new EnterpriseBridgeError('invalidResponse')
  }
  const { user, device, policy, cursor } = value
  const features = policy.features
  if (!isLabel(user.id) || !isLabel(user.displayName) || !Array.isArray(user.roles) || user.roles.length > 32 || !user.roles.every(isLabel)
    || device.id !== deviceId || !isLabel(device.platform) || !isLabel(device.clientVersion)
    || !isCursor(policy.revision) || !isTimestamp(policy.expiresAt) || !isRecord(features)
    || !enterpriseFeatures.every(feature => typeof features[feature] === 'boolean')) {
    throw new EnterpriseBridgeError('invalidResponse')
  }
  // Only the public contract can cross the renderer boundary, including at nested levels.
  return {
    user: { id: user.id, displayName: user.displayName, roles: user.roles },
    device: { id: deviceId, platform: device.platform, clientVersion: device.clientVersion },
    policy: {
      revision: policy.revision,
      expiresAt: policy.expiresAt,
      features: {
        demands: features.demands as boolean,
        models: features.models as boolean,
        memories: features.memories as boolean,
        updates: features.updates as boolean,
      },
    },
    cursor,
  }
}

function parseEventPage(value: unknown, previousCursor: number): { count: number; cursor: number } {
  if (!isRecord(value) || !Array.isArray(value.events) || !isCursor(value.cursor) || value.cursor < previousCursor) {
    throw new EnterpriseBridgeError('invalidResponse')
  }
  let last = previousCursor
  for (const event of value.events) {
    if (!isRecord(event) || !isCursor(event.sequence) || event.sequence <= last || event.sequence > value.cursor) {
      throw new EnterpriseBridgeError('invalidResponse')
    }
    last = event.sequence
  }
  return { count: value.events.length, cursor: value.cursor }
}

async function readJson(response: Response, limit = maxResponseBytes): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new EnterpriseBridgeError('invalidResponse')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > limit) throw new EnterpriseBridgeError('invalidResponse')
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as unknown
  } catch {
    await reader.cancel().catch(() => {})
    throw new EnterpriseBridgeError('invalidResponse')
  } finally {
    reader.releaseLock()
  }
}

function deviceSignature(privateKey: string, fields: string[]): string {
  return sign(null, Buffer.from(JSON.stringify(fields)), createPrivateKey({
    key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8',
  })).toString('base64url')
}

export class EnterpriseBridge {
  private profile: Profile | null | undefined
  private profileDirty = false
  private bootstrap: EnterpriseBootstrap | undefined
  private piContextRevision = 0
  private queue: Promise<void> = Promise.resolve()
  private readonly demandDrafts: EnterpriseDemandDraftVault
  private readonly deliveries = new EnterpriseDeliveryCoordinator({
    identity: () => this.enqueue(() => this.usableProfile()),
    userId: () => this.bootstrap?.user.id,
    sign: deviceSignature,
    request: async ({ route, ...options }, deviceId) => {
      try { return await this.deviceRequest(route, options, 'demands', deviceId) } catch (error) {
        if (!(error instanceof EnterpriseBridgeError)) throw error
        throw new DeliveryWorkspaceError(error.issue === 'bindingExpired' ? 'unbound' : deliveryIssue(error.httpStatus, error.serverCode))
      }
    },
  })

  constructor(private readonly options: EnterpriseBridgeOptions) {
    this.demandDrafts = new EnterpriseDemandDraftVault(join(dirname(options.profilePath), 'enterprise-demand-drafts'), options.secureStorage)
  }

  enroll(input: EnterpriseEnrollment): Promise<EnterpriseConnection> {
    this.piContextRevision++
    return this.serial(async () => {
      const origin = normalizeOrigin(input.origin, this.options.allowLoopbackHttp,
        input.officeHttp === true ? this.options.officeHttpOrigin : undefined)
      let challenge = (input.challenge ?? '').trim()
      if (input.officeHttp === true && (!challenge || challenge === 'auto')) {
        const autoChallenge = await this.request(origin, '/api/v1/devices/intranet-challenge', { method: 'POST', rejected: 'network' })
        if (isRecord(autoChallenge) && typeof autoChallenge.challenge === 'string') {
          challenge = autoChallenge.challenge
        }
      }
      if (!challengePattern.test(challenge)) throw new EnterpriseBridgeError('invalidChallenge')
      this.assertSecureStorage()
      const deviceId = randomUUID()
      const pair = generateKeyPairSync('ed25519')
      const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
      const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
      const { platform, clientVersion } = this.options
      const signature = deviceSignature(privateKey, ['enterprise-enroll-v1', challenge, deviceId, publicKey, platform, clientVersion])
      const credentials = parseCredentials(await this.request(origin, '/api/v1/devices/enroll', {
        body: { challenge, deviceId, publicKey, platform, clientVersion, signature },
        rejected: 'enrollmentRejected',
      }))
      this.deliveries.stop()
      this.bootstrap = undefined
      const officeHttp = input.officeHttp === true && origin === this.options.officeHttpOrigin
      await this.save({ ...credentials, origin, deviceId, privateKey, ...(officeHttp ? { officeHttp: true as const } : {}) })
      return this.synchronize(false)
    })
  }

  sync(incremental = false): Promise<EnterpriseConnection> {
    return this.serial(() => this.synchronize(incremental)).then(connection => {
      if (connection.state !== 'connected') this.piContextRevision++
      if (connection.state === 'revoked') this.deliveries.stop()
      return connection
    })
  }

  models(projectId?: string, signal?: AbortSignal): Promise<EnterpriseModelCatalog | null> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      if (projectId !== undefined && !isEnterpriseProjectId(projectId)) return null
      const profile = await this.usableProfile()
      if (!profile) return null
      const route = '/api/v1/models/catalog' + (projectId ? `?projectId=${projectId}` : '')
      const catalog = parseEnterpriseModelCatalog(await this.authorizedRequest(profile, route, undefined, false, signal), profile.deviceId)
      return catalog && Date.parse(catalog.expiresAt) > this.now() ? catalog : null
    }).catch(() => null)
  }

  modelGrant(input: EnterpriseGrantInput, signal?: AbortSignal): Promise<EnterpriseGrant | null> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      const profile = await this.usableProfile()
      if (!profile || enterpriseDeviceFromProviderId(input.providerId) !== profile.deviceId) return null
      const { modelId, sessionId, projectId, protocol } = input
      const value = await this.authorizedRequest(profile, '/api/v1/models/grants', {
        modelId, sessionId, ...(projectId ? { projectId } : {}),
      }, false, signal)
      if (!isRecord(value) || !isToken(value.accessToken) || !isEnterpriseTimestamp(value.expiresAt)
        || Date.parse(value.expiresAt) <= this.now() || value.proxyEndpoint !== enterpriseModelPaths[protocol]) return null
      return {
        origin: profile.origin, accessToken: value.accessToken, expiresAt: value.expiresAt,
        proxyEndpoint: enterpriseModelPaths[protocol],
      }
    }).catch(() => null)
  }

  async modelContext(input: EnterpriseContextInput) {
    const { providerId, modelId, projectId, query, source, limit } = input
    const deviceId = enterpriseDeviceFromProviderId(providerId)
    if (!deviceId) return null
    try {
      const result = await this.deviceRequest('/api/v1/models/context', { body: {
        modelId, ...(projectId ? { projectId } : {}), query, source, limit,
      } }, 'memories', deviceId)
      return parseEnterpriseContextResult(result, input)
    } catch {
      return null
    }
  }

  async piContext(value: unknown, signal?: AbortSignal) {
    const input = parsePiContextInput(value)
    if (!input || signal?.aborted) return null
    const revision = this.piContextRevision
    try {
      const profile = await this.enqueue(() => this.usableProfile())
      if (!profile || signal?.aborted || revision !== this.piContextRevision) return null
      const policyRevision = this.bootstrap?.policy.revision
      const response = await this.deviceRequest('/api/v1/pi-context', { body: input, signal, timeoutMs: 14_000 }, undefined, profile.deviceId)
      const active = this.profile
      if (signal?.aborted || revision !== this.piContextRevision || !active || active.deviceId !== profile.deviceId
        || active.origin !== profile.origin || this.bootstrap?.policy.revision !== policyRevision) return null
      const result = parsePiContextResult(response, input.kind)
      const secrets = [profile.accessToken, profile.refreshToken, profile.privateKey, active.accessToken, active.refreshToken, active.privateKey]
      return result && !secrets.some(secret => result.text.includes(secret)) ? result : null
    } catch {
      return null
    }
  }

  async modelErp(value: EnterpriseErpInput, signal?: AbortSignal) {
    const input = parseEnterpriseErpInput(value)
    if (!input || signal?.aborted) return null
    const { providerId, modelId, sessionId, modelProjectId, ...query } = input
    const deviceId = enterpriseDeviceFromProviderId(providerId)
    const providerCode = enterpriseErpProviderCode(providerId)
    if (!deviceId || !providerCode) return null
    try {
      const catalog = await this.models(modelProjectId, signal)
      const model = catalog?.models.find(item => item.providerId === providerId && item.modelId === modelId &&
        item.projectId === (modelProjectId ?? null))
      if (!model?.canQueryErp || !model.capabilities.includes('tools') || signal?.aborted) return null
      const profile = this.profile
      const grant = await this.modelGrant({ providerId, modelId, sessionId, protocol: model.protocol,
        ...(modelProjectId ? { projectId: modelProjectId } : {}),
      }, signal)
      if (!grant || signal?.aborted) return null
      const reply = await this.deviceRequest('/api/v1/models/erp', {
        body: { ...query, providerId: providerCode, modelId, sessionId, modelGrant: grant.accessToken },
        signal, timeoutMs: 22_000, responseLimit: 512 * 1024,
      }, undefined, deviceId)
      const active = this.profile
      if (signal?.aborted || !active || active.deviceId !== deviceId || active.origin !== grant.origin || Date.parse(grant.expiresAt) <= this.now()) return null
      const result = parseEnterpriseErpResult(reply, input)
      const privateValues = [grant.accessToken, profile?.accessToken, profile?.refreshToken, active.accessToken, active.refreshToken, active.privateKey]
      const projected = result && JSON.stringify(result)
      return projected && privateValues.some(secret => secret && projected.includes(secret)) ? null : result
    } catch {
      return null
    }
  }

  async demand(input: EnterpriseDemandRequest): Promise<EnterpriseDemandResult> {
    try {
      const { route, ...options } = enterpriseDemandRoute(input)
      const value = await this.deviceRequest(route, options)
      const result = enterpriseDemandResponses[input.action].safeParse(value)
      return result.success ? { ok: true, data: result.data } : { ok: false, issue: 'unavailable' }
    } catch (error) {
      return {
        ok: false, issue: error instanceof EnterpriseBridgeError
          ? (error.issue === 'bindingExpired' ? 'unbound' : enterpriseDemandIssue(error.httpStatus, error.serverCode))
          : 'unavailable',
      }
    }
  }

  async demandLocal(input: EnterpriseDemandLocalRequest, chooseExportPath?: (name: string) => Promise<string | null>): Promise<EnterpriseDemandLocalResult> {
    try {
      // Local reading, editing and export remain available when a bound device cannot renew or meet the online policy.
      const profile = this.profile === undefined ? await this.enqueue(() => this.getProfile()) : this.profile
      if (!profile || (input.action !== 'list' && input.deviceId !== profile.deviceId)) return { ok: false, issue: 'unbound' }
      this.assertSecureStorage()
      const scope = { origin: profile.origin, deviceId: profile.deviceId }
      const assertBinding = () => {
        if (this.profile?.deviceId !== scope.deviceId || this.profile.origin !== scope.origin) throw new EnterpriseBridgeError('bindingExpired')
      }
      const compare = (id: string, prior: EnterpriseDemandCloudDraft, latest: EnterpriseDemandLatestDraft, revision?: number) =>
        this.enqueue(async (): Promise<EnterpriseDemandDraftConflict> => {
          assertBinding()
          const { local, baseDraft, hasPending } = await this.demandDrafts.comparison(scope, id, revision)
          if (hasPending || local.cloud?.id !== prior.id || local.cloud.draftRevision !== prior.draftRevision ||
              latest.cloud.draftRevision <= prior.draftRevision) throw new DemandDraftVaultError('conflict')
          return { local, baseDraft, latest }
        })
      switch (input.action) {
        case 'list': {
          const data = await this.demandDrafts.list(scope)
          assertBinding()
          return { ok: true, data }
        }
        case 'get': {
          const data = await this.demandDrafts.get(scope, input.id)
          assertBinding()
          return { ok: true, data }
        }
        case 'save': {
          const data = await this.demandDrafts.save(scope, input)
          assertBinding()
          return { ok: true, data }
        }
        case 'export': {
          const record = await this.demandDrafts.get(scope, input.id, input.expectedLocalRevision)
          assertBinding()
          if (!chooseExportPath) return { ok: false, issue: 'localStorage' }
          const file = await chooseExportPath(`需求草稿-${record.id.slice(0, 8)}.md`)
          if (!file) return { ok: true, data: { saved: false } }
          assertBinding()
          await writeFile(file, exportDemandDraft(record), { flag: 'wx', mode: 0o600, flush: true })
            .catch(() => { throw new DemandDraftVaultError('localStorage') })
          return { ok: true, data: { saved: true } }
        }
        case 'merge': {
          const { local, hasPending } = await this.demandDrafts.comparison(scope, input.id, input.expectedLocalRevision)
          const prior = local.cloud
          if (!prior || hasPending) throw new DemandDraftVaultError('conflict')
          assertBinding()
          const latest = await this.readLatestDemand(scope, prior)
          if (latest.cloud.draftRevision !== input.expectedCloudRevision) {
            return { ok: false, issue: 'conflict', conflict: await compare(input.id, prior, latest, input.expectedLocalRevision) }
          }
          const data = await this.enqueue(() => {
            assertBinding()
            return this.demandDrafts.merge(scope, input, prior, latest)
          })
          return { ok: true, data }
        }
        case 'sync': {
          const { cloud, pending } = await this.enqueue(() => {
            assertBinding()
            return this.demandDrafts.prepare(scope, input)
          })
          const request: EnterpriseDemandRequest = cloud
            ? { action: 'edit', id: cloud.id, expectedDraftRevision: cloud.draftRevision, draft: pending.draft, idempotencyKey: pending.key }
            : { action: 'create', draft: pending.draft, idempotencyKey: pending.key }
          const { route, ...options } = enterpriseDemandRoute(request)
          let value: unknown
          try { value = await this.deviceRequest(route, options, 'demands', scope.deviceId) } catch (error) {
            if (!cloud || !(error instanceof EnterpriseBridgeError) || error.httpStatus !== 409 || error.serverCode !== 'DEMAND_DRAFT_CONFLICT') throw error
            // The server has explicitly rejected this revision. Only retire this exact staged request.
            await this.enqueue(() => {
              assertBinding()
              return this.demandDrafts.rejectConflict(scope, input.id, pending.key, cloud)
            })
            const latest = await this.readLatestDemand(scope, cloud).catch((readError: unknown) => {
              if (readError instanceof EnterpriseBridgeError && readError.issue !== 'bindingExpired') return null
              throw readError
            })
            if (!latest) return { ok: false, issue: 'conflict' }
            return { ok: false, issue: 'conflict', conflict: await compare(input.id, cloud, latest) }
          }
          const parsed = enterpriseDemandResponses[request.action].safeParse(value)
          if (!parsed.success) return { ok: false, issue: 'unavailable' }
          const demand = parsed.data
          const receipt = demand.draftMutation
          if (!receipt || receipt.idempotencyKey !== pending.key || (cloud && demand.id !== cloud.id) ||
              receipt.draftRevision !== (cloud?.draftRevision ?? 0) + 1 || demand.draftRevision < receipt.draftRevision) {
            return { ok: false, issue: 'unavailable' }
          }
          const draft = await this.enqueue(() => {
            assertBinding()
            return this.demandDrafts.acknowledge(scope, input.id, pending.key, {
              id: demand.id, demandNo: demand.demandNo, draftRevision: receipt.draftRevision,
            })
          })
          assertBinding()
          return { ok: true, data: { demand, draft } }
        }
      }
    } catch (error) {
      return { ok: false, issue: error instanceof DemandDraftVaultError ? error.issue : error instanceof EnterpriseBridgeError
        ? error.issue === 'secureStorage' ? 'localStorage' : error.issue === 'bindingExpired' ? 'unbound' : enterpriseDemandIssue(error.httpStatus, error.serverCode)
        : 'localStorage' }
    }
  }

  private async readLatestDemand(scope: DemandDraftScope, prior: EnterpriseDemandCloudDraft): Promise<EnterpriseDemandLatestDraft> {
    const { route, ...options } = enterpriseDemandRoute({ action: 'get', id: prior.id })
    const parsed = enterpriseDemandResponses.get.safeParse(await this.deviceRequest(route, options, 'demands', scope.deviceId))
    if (!parsed.success || parsed.data.id !== prior.id) throw new EnterpriseBridgeError('invalidResponse')
    const { id, draftRevision, demandNo, draft, ownerId, state } = parsed.data
    const cloud = enterpriseDemandCloudDraftSchema.safeParse({ id, draftRevision, demandNo })
    if (!cloud.success) throw new EnterpriseBridgeError('invalidResponse')
    const { user, policy } = await this.enqueue(async () => {
      if (this.profile?.deviceId !== scope.deviceId || this.profile.origin !== scope.origin) throw new EnterpriseBridgeError('bindingExpired')
      const connection = await this.synchronize(false)
      const bootstrap = connection.bootstrap
      if (connection.state !== 'connected' || connection.origin !== scope.origin || !bootstrap || bootstrap.device.id !== scope.deviceId) {
        throw new EnterpriseBridgeError('bindingExpired')
      }
      return bootstrap
    })
    const canEditOwn = ownerId === user.id && user.roles.some(role => ['requester', 'developer', 'project_owner', 'it_lead', 'platform_admin'].includes(role))
    const canReviewImport = state === 'IMPORT_REVIEW' && user.roles.includes('it_lead')
    if (!draft || !policy.features.demands || (!canEditOwn && !canReviewImport)) throw new EnterpriseBridgeError('network', 403)
    return { cloud: cloud.data, draft }
  }

  async memory(input: EnterpriseMemoryRequest): Promise<EnterpriseMemoryResult> {
    try {
      const { route, ...options } = enterpriseMemoryRoute(input)
      const value = await this.deviceRequest(route, options, 'memories')
      const result = enterpriseMemoryResponses[input.action].safeParse(value)
      return result.success ? { ok: true, data: result.data } : { ok: false, issue: 'unavailable' }
    } catch (error) {
      return { ok: false, issue: error instanceof EnterpriseBridgeError
        ? (error.issue === 'bindingExpired' ? 'unbound' : enterpriseMemoryIssue(error.httpStatus, error.serverCode))
        : 'unavailable' }
    }
  }

  async delivery(input: EnterpriseDeliveryRequest, workspace: DeliveryWorkspace): Promise<EnterpriseDeliveryResult> {
    try {
      return await this.deliveries.execute(input, workspace)
    } catch (error) {
      return { ok: false, issue: error instanceof DeliveryWorkspaceError ? error.issue :
        error instanceof EnterpriseBridgeError ? (error.issue === 'bindingExpired' ? 'unbound' : deliveryIssue(error.httpStatus, error.serverCode)) : 'unavailable' }
    }
  }

  async updateTransport(): Promise<EnterpriseUpdateTransport | null> {
    const profile = await this.enqueue(async () => {
      const active = await this.usableProfile()
      if (!active) return null
      if (!this.bootstrap || Date.parse(this.bootstrap.policy.expiresAt) <= this.now()) await this.synchronize(false)
      return this.bootstrap?.policy.features.updates ? this.profile ?? active : null
    })
    if (!profile) return null
    const matches = (active: Profile | null | undefined) => active?.deviceId === profile.deviceId && active.origin === profile.origin
    return {
      binding: `${profile.origin}|${profile.deviceId}`,
      request: async (path, init) => {
        if (!enterpriseUpdateRequestAllowed(path, init)) throw new Error('Invalid enterprise update request')
        const active = await this.enqueue(async () => {
          if (!matches(await this.getProfile())) throw new EnterpriseBridgeError('bindingExpired')
          const current = await this.usableProfile()
          if (!this.bootstrap || Date.parse(this.bootstrap.policy.expiresAt) <= this.now()) await this.synchronize(false)
          if (!current || !this.bootstrap?.policy.features.updates) throw new EnterpriseBridgeError('bindingExpired')
          return this.profile ?? current
        })
        const send = (current: Profile) => (this.options.fetch ?? fetch)(new URL(path, profile.origin), {
          method: init?.method ?? 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
          headers: {
            authorization: `Bearer ${current.accessToken}`,
            ...(init?.body ? { 'content-type': 'application/json' } : {}),
            ...(init?.range ? { range: init.range } : {}),
          },
          ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
          signal: init?.signal,
        })
        let response = await send(active)
        if (response.status === 401) {
          await response.body?.cancel().catch(() => {})
          const renewed = await this.enqueue(async () => {
            const current = await this.getProfile()
            if (!current || !matches(current) || !this.bootstrap?.policy.features.updates) throw new EnterpriseBridgeError('bindingExpired')
            return current.accessToken === active.accessToken ? this.renew(current) : current
          })
          response = await send(renewed)
        }
        if (!matches(this.profile) || !this.bootstrap?.policy.features.updates) {
          await response.body?.cancel().catch(() => {})
          throw new EnterpriseBridgeError('bindingExpired')
        }
        return response
      },
    }
  }

  disconnect(): Promise<EnterpriseConnection> {
    this.piContextRevision++
    this.deliveries.stop()
    return this.serial(async () => {
      try { await unlink(this.options.profilePath) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new EnterpriseBridgeError('secureStorage')
      }
      this.profile = null
      this.profileDirty = false
      this.bootstrap = undefined
      return disconnected
    })
  }

  private serial(operation: () => Promise<EnterpriseConnection>): Promise<EnterpriseConnection> {
    return this.enqueue(operation).catch((error: unknown): EnterpriseConnection => {
      const issue = error instanceof EnterpriseBridgeError ? error.issue : 'network'
      return { origin: this.profile?.origin ?? null, state: issue === 'bindingExpired' ? 'revoked' : 'unavailable', issue }
    }).then(connection => this.options.officeHttpOrigin
      ? { ...connection, officeHttpOrigin: this.options.officeHttpOrigin }
      : connection)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.then(() => {}, () => {})
    return result
  }

  private assertSecureStorage() {
    const storage = this.options.secureStorage
    if (!storage.isEncryptionAvailable()
      || (this.options.platform === 'linux' && storage.getSelectedStorageBackend?.() === 'basic_text')) {
      throw new EnterpriseBridgeError('secureStorage')
    }
  }

  private async getProfile() {
    if (this.profile !== undefined) return this.profile
    try {
      const encrypted = await readFile(this.options.profilePath)
      if (encrypted.byteLength > 32 * 1024) throw new EnterpriseBridgeError('secureStorage')
      this.assertSecureStorage()
      const value: unknown = JSON.parse(this.options.secureStorage.decryptString(encrypted))
      if (!isRecord(value) || value.version !== 1 || typeof value.origin !== 'string'
        || typeof value.deviceId !== 'string' || !devicePattern.test(value.deviceId)
        || typeof value.privateKey !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(value.privateKey)) {
        throw new EnterpriseBridgeError('secureStorage')
      }
      this.profile = {
        ...parseCredentials(value), origin: normalizeOrigin(value.origin, this.options.allowLoopbackHttp,
          value.officeHttp === true ? this.options.officeHttpOrigin : undefined),
        deviceId: value.deviceId, privateKey: value.privateKey,
        ...(value.officeHttp === true ? { officeHttp: true as const } : {}),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new EnterpriseBridgeError('secureStorage')
      this.profile = null
    }
    return this.profile
  }

  private async save(profile: Profile) {
    const destination = this.options.profilePath
    const temporary = `${destination}.${randomUUID()}.tmp`
    // Retain rotated credentials in memory if the filesystem fails after the server consumed the previous token.
    this.profile = profile
    this.profileDirty = true
    try {
      this.assertSecureStorage()
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const encrypted = this.options.secureStorage.encryptString(JSON.stringify({ version: 1, ...profile }))
      await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600, flush: true })
      await rename(temporary, destination)
      this.profileDirty = false
    } catch {
      await unlink(temporary).catch(() => {})
      throw new EnterpriseBridgeError('secureStorage')
    }
  }

  private async request(origin: string, route: string, options?: RequestOptions): Promise<unknown> {
    const body = options?.body
    const deadline = AbortSignal.timeout(options?.timeoutMs ?? 10_000)
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline
    let response: Response
    try {
      signal.throwIfAborted()
      response = await (this.options.fetch ?? fetch)(new URL(route, origin), {
        method: options?.method ?? (body ? 'POST' : 'GET'),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(options?.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
          ...options?.headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
      })
    } catch {
      throw new EnterpriseBridgeError('network')
    }
    if (signal.aborted) {
      await response.body?.cancel().catch(() => {})
      throw new EnterpriseBridgeError('network')
    }
    if (!response.ok) {
      let code: string | undefined
      if (options?.captureServerCode) {
        const errorBody = await readJson(response).catch(() => null)
        if (isRecord(errorBody) && isRecord(errorBody.error) && typeof errorBody.error.code === 'string'
          && /^[A-Z_]{1,100}$/.test(errorBody.error.code)) code = errorBody.error.code
      } else await response.body?.cancel().catch(() => {})
      const rejected = response.status >= 400 && response.status < 500 && response.status !== 429
      throw new EnterpriseBridgeError(rejected && options?.rejected ? options.rejected : 'network', response.status, code)
    }
    const value = await readJson(response, options?.responseLimit)
    if (signal.aborted) throw new EnterpriseBridgeError('network')
    return value
  }

  private async deviceRequest(route: string, options: RequestOptions, feature?: typeof enterpriseFeatures[number], deviceId?: string) {
    const profile = await this.enqueue(async () => {
      options.signal?.throwIfAborted()
      const active = await this.usableProfile()
      if (!active || (deviceId && deviceId !== active.deviceId)) throw new EnterpriseBridgeError('bindingExpired')
      if (feature) {
        if (!this.bootstrap || Date.parse(this.bootstrap.policy.expiresAt) <= this.now()) await this.synchronize(false)
        if (!this.bootstrap?.policy.features[feature]) throw new EnterpriseBridgeError('network', 403)
      }
      return this.profile ?? active
    })
    const send = (current: Profile) => this.request(current.origin, route, {
      ...options, bearer: current.accessToken, captureServerCode: true,
    })
    let value: unknown
    try { value = await send(profile) } catch (error) {
      if (!(error instanceof EnterpriseBridgeError) || error.httpStatus !== 401 || error.serverCode === 'MODEL_GRANT_EXPIRED') throw error
      const current = await this.enqueue(async () => {
        options.signal?.throwIfAborted()
        const active = await this.getProfile()
        if (!active || active.deviceId !== profile.deviceId) throw new EnterpriseBridgeError('bindingExpired')
        return active.accessToken === profile.accessToken ? this.renew(active) : active
      })
      value = await send(current)
    }
    options.signal?.throwIfAborted()
    if (this.profile?.deviceId !== profile.deviceId) throw new EnterpriseBridgeError('bindingExpired')
    if (feature && !this.bootstrap?.policy.features[feature]) throw new EnterpriseBridgeError('network', 403)
    return value
  }

  private async renew(profile: Profile): Promise<Profile> {
    this.assertSecureStorage()
    const { deviceId, refreshToken } = profile
    const signature = deviceSignature(profile.privateKey, ['enterprise-refresh-v1', deviceId, refreshToken])
    const credentials = parseCredentials(await this.request(profile.origin, '/api/v1/devices/refresh', {
      body: { deviceId, refreshToken, signature }, rejected: 'bindingExpired',
    }))
    const next = { ...profile, ...credentials }
    await this.save(next)
    return next
  }

  private now() {
    return (this.options.now ?? Date.now)()
  }

  private async usableProfile(): Promise<Profile | null> {
    const profile = await this.getProfile()
    if (!profile) return null
    if (this.profileDirty) await this.save(profile)
    return Date.parse(profile.expiresAt) <= this.now() + 5_000 ? this.renew(profile) : profile
  }

  private async authorizedRequest(profile: Profile, route: string, body?: Record<string, unknown>, bindingStatus = false, signal?: AbortSignal) {
    const send = (token: string) => this.request(profile.origin, route, { bearer: token, body, signal })
    try {
      return await send(profile.accessToken)
    } catch (error) {
      if (!(error instanceof EnterpriseBridgeError)) throw error
      if (bindingStatus && error.httpStatus === 403) throw new EnterpriseBridgeError('bindingExpired')
      if (error.httpStatus !== 401) throw error
      signal?.throwIfAborted()
      const renewed = await this.renew(profile)
      return send(renewed.accessToken).catch((retryError: unknown) => {
        if (bindingStatus && retryError instanceof EnterpriseBridgeError && [401, 403].includes(retryError.httpStatus ?? 0)) {
          throw new EnterpriseBridgeError('bindingExpired')
        }
        throw retryError
      })
    }
  }

  private async synchronize(incremental: boolean): Promise<EnterpriseConnection> {
    const profile = await this.usableProfile()
    if (!profile) return disconnected
    const now = this.now()
    const authorized = (route: string) => this.authorizedRequest(this.profile ?? profile, route, undefined, true)
    if (incremental && this.bootstrap && Date.parse(this.bootstrap.policy.expiresAt) > now) {
      try {
        const cursor = this.bootstrap.cursor
        const page = parseEventPage(await authorized(`/api/v1/events?cursor=${cursor}`), cursor)
        if (!page.count) {
          this.bootstrap = { ...this.bootstrap, cursor: page.cursor }
          return { origin: profile.origin, state: 'connected', bootstrap: this.bootstrap }
        }
      } catch (error) {
        if (!(error instanceof EnterpriseBridgeError) || (error.httpStatus !== 409 && error.httpStatus !== 410)) throw error
      }
    }
    this.bootstrap = parseBootstrap(await authorized('/api/v1/bootstrap'), profile.deviceId)
    if (Date.parse(this.bootstrap.policy.expiresAt) <= this.now()) throw new EnterpriseBridgeError('invalidResponse')
    return { origin: profile.origin, state: 'connected', bootstrap: this.bootstrap }
  }
}
