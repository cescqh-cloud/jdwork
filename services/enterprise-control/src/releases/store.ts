import type { SQL, TransactionSQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { ControlError } from '../contract'
import type { Actor } from '../store'
import { clientVersion, compareVersions, rolloutBucket, type Architecture, type ArtifactMeta, type Channel, type CheckInput,
  type CreateReleaseInput, type Platform, type ReleaseProof, type ReleaseProofPayload, type ReleaseStatus, type ReportInput,
  type ReportStage, type SignerInfo } from './contract'
import type { BuilderManifest } from './manifest'
import type { ReleaseSigner } from './signatures'

type Connection = SQL | TransactionSQL
const notFound = () => new ControlError(404, 'UPDATE_RELEASE_NOT_FOUND', 'This update is unavailable for your device or organization.')
const revisionConflict = () => new ControlError(409, 'UPDATE_RELEASE_CONFLICT', 'The release changed. Refresh the page before trying again.')
const invalidDevice = () => new ControlError(403, 'UPDATE_DEVICE_REQUIRED', 'Use an active enterprise-bound desktop device.')

export interface ReleaseRow {
  tenant_id: string
  id: string
  platform: Platform
  arch: Architecture
  channel: Channel
  version: string
  status: ReleaseStatus
  revision: number
  rollout_percent: number
  target_devices: string[] | string
  target_users: string[] | string
  target_departments: string[] | string
  min_client_version: string | null
  max_tested_version: string | null
  security_required: boolean
  failure_min_sample: number
  failure_threshold_percent: number
  manifest_bytes: Uint8Array | null
  manifest_sha256: string | null
  artifact_name: string | null
  artifact_size: number | string | bigint | null
  artifact_sha512: string | null
  artifact_sha256: string | null
  signer_fingerprint: string | null
  signer_publisher: string | null
  signer_kind: SignerInfo['kind'] | null
  proof: ReleaseProof | null
  test_evidence: string | null
  created_at: Date
  updated_at: Date
  published_at: Date | null
  paused_at: Date | null
  pause_reason: string | null
}

interface DeviceInfo {
  id: string
  user_id: string
  department_id: string | null
  platform: Platform
  client_version: string
}

interface DeviceProfile { arch: Architecture, installed_version: string }

export function requireReleaseAdmin(actor: Actor) {
  if (actor.device || !actor.roles.includes('platform_admin')) {
    throw new ControlError(403, 'UPDATE_ADMIN_REQUIRED', 'Sign in to the console as a platform administrator to manage releases.')
  }
}

export function artifact(row: ReleaseRow): ArtifactMeta | null {
  return row.artifact_name && row.artifact_size !== null && row.artifact_sha256 && row.artifact_sha512 ? {
    name: row.artifact_name, size: Number(row.artifact_size), sha256: row.artifact_sha256, sha512: row.artifact_sha512,
  } : null
}

export function signer(row: ReleaseRow): SignerInfo | null {
  return row.signer_fingerprint && row.signer_publisher && row.signer_kind ? {
    fingerprint: row.signer_fingerprint, publisher: row.signer_publisher, kind: row.signer_kind,
  } : null
}

export function signedPayload(row: ReleaseRow, publishedAt: string): ReleaseProofPayload {
  const packageMeta = artifact(row)
  const proof = signer(row)
  if (!packageMeta || !proof || !row.manifest_sha256) throw new ControlError(409, 'UPDATE_RELEASE_UNVERIFIED', 'Upload and verify both the manifest and installer first.')
  return { schema: 1, releaseId: row.id, version: row.version, platform: row.platform, arch: row.arch, channel: row.channel,
    artifact: packageMeta, manifestSha256: row.manifest_sha256, signer: proof, publishedAt }
}

function audienceIds(value: string[] | string): string[] {
  // Bun's PostgreSQL adapter can return UUID arrays as their textual form.
  if (Array.isArray(value)) return value
  if (value === '{}') return []
  if (!value.startsWith('{') || !value.endsWith('}')) throw new Error('Stored release audience is invalid')
  const ids = value.slice(1, -1).split(',')
  if (ids.some(id => !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(id))) throw new Error('Stored release audience is invalid')
  return ids
}

export function view(row: ReleaseRow, counts?: HealthCounts) {
  return { id: row.id, platform: row.platform, arch: row.arch, channel: row.channel, version: row.version, status: row.status,
    revision: row.revision, rolloutPercent: row.rollout_percent, targetDeviceIds: audienceIds(row.target_devices), targetUserIds: audienceIds(row.target_users),
    targetDepartmentIds: audienceIds(row.target_departments), minClientVersion: row.min_client_version, maxTestedVersion: row.max_tested_version,
    securityRequired: row.security_required, failureMinSample: row.failure_min_sample, failureThresholdPercent: row.failure_threshold_percent,
    manifest: row.manifest_sha256 && row.artifact_name && row.artifact_sha512 ? { sha256: row.manifest_sha256, name: row.artifact_name,
      size: Number(row.artifact_size), sha512: row.artifact_sha512 } : null,
    artifact: artifact(row), signer: signer(row), testEvidence: row.test_evidence, createdAt: row.created_at.toISOString(),
    publishedAt: row.published_at?.toISOString() ?? null, pausedAt: row.paused_at?.toISOString() ?? null, pauseReason: row.pause_reason,
    health: counts ?? { offered: 0, downloaded: 0, installed: 0, healthy: 0, failed: 0 },
  }
}

interface HealthCounts { offered: number, downloaded: number, installed: number, healthy: number, failed: number }

async function health(sql: Connection, tenantId: string, releaseId: string): Promise<HealthCounts> {
  const [count] = await sql<HealthCounts[]>`SELECT count(*)::int AS offered,
    count(*) FILTER (WHERE h.latest_stage = 'downloaded')::int AS downloaded,
    count(*) FILTER (WHERE h.latest_stage = 'installed')::int AS installed,
    count(*) FILTER (WHERE h.latest_stage = 'healthy')::int AS healthy,
    count(*) FILTER (WHERE h.latest_stage = 'failed')::int AS failed
    FROM enterprise_update_offers o LEFT JOIN enterprise_update_health h
      ON (h.tenant_id, h.release_id, h.device_id) = (o.tenant_id, o.release_id, o.device_id)
    WHERE o.tenant_id = ${tenantId} AND o.release_id = ${releaseId}`
  return count!
}

function eligible(row: ReleaseRow, device: DeviceInfo) {
  if (row.platform !== device.platform) return false
  const devices = audienceIds(row.target_devices)
  const users = audienceIds(row.target_users)
  const departments = audienceIds(row.target_departments)
  const targeted = devices.length + users.length + departments.length > 0
  if (targeted && !devices.includes(device.id) && !users.includes(device.user_id) &&
      !(device.department_id && departments.includes(device.department_id))) return false
  return rolloutBucket(row.tenant_id, row.platform, row.arch, row.channel, device.id) < row.rollout_percent * 100
}

async function deviceIdentity(sql: Connection, actor: Actor) {
  if (!actor.device) throw invalidDevice()
  const [device] = await sql<DeviceInfo[]>`SELECT d.id, d.user_id, d.platform, d.client_version, u.department_id
    FROM enterprise_devices d JOIN enterprise_users u ON (u.tenant_id, u.id) = (d.tenant_id, d.user_id)
    JOIN enterprise_tenants t ON t.id = d.tenant_id
    WHERE d.tenant_id = ${actor.tenantId} AND d.id = ${actor.device.id} AND d.user_id = ${actor.id}
      AND d.revoked_at IS NULL AND u.active AND t.active`
  if (!device) throw invalidDevice()
  return device
}

function storedVersion(device: DeviceInfo, profile?: DeviceProfile): string {
  const known = clientVersion.safeParse(device.client_version)
  if (!known.success) throw new ControlError(409, 'UPDATE_DEVICE_VERSION_INVALID', 'Reconnect the desktop with a valid client version before checking updates.')
  return profile && compareVersions(profile.installed_version, known.data) > 0 ? profile.installed_version : known.data
}

async function lockRelease(sql: TransactionSQL, tenantId: string, releaseId: string) {
  const [row] = await sql<ReleaseRow[]>`SELECT * FROM enterprise_client_releases WHERE tenant_id = ${tenantId} AND id = ${releaseId} FOR UPDATE`
  if (!row) throw notFound()
  return row
}

async function audit(sql: TransactionSQL, tenantId: string, releaseId: string, actorId: string | null, action: string) {
  await sql`INSERT INTO enterprise_audit (id, tenant_id, actor_id, action, target_id) VALUES
    (${randomUUID()}, ${tenantId}, ${actorId}, ${action}, ${releaseId})`
}

async function publishPolicy(sql: TransactionSQL, row: ReleaseRow, actorId: string | null, action: string) {
  await audit(sql, row.tenant_id, row.id, actorId, action)
  const [changed] = await sql<{ event_sequence: string, policy_revision: number }[]>`UPDATE enterprise_tenants
    SET event_sequence = event_sequence + 1, policy_revision = policy_revision + 1
    WHERE id = ${row.tenant_id} RETURNING event_sequence::text, policy_revision`
  if (!changed) throw notFound()
  // A generic tenant hint lets clients recheck without revealing which restricted release exists.
  await sql`INSERT INTO enterprise_events (tenant_id, sequence, event_id, event_type, resource_id, revision)
    VALUES (${row.tenant_id}, ${changed.event_sequence}, ${randomUUID()}, 'update.policy.changed', ${row.tenant_id}, ${changed.policy_revision})`
}

async function validateAudience(sql: TransactionSQL, tenantId: string, input: CreateReleaseInput) {
  const [counts] = await sql<{ devices: number, users: number, departments: number }[]>`SELECT
    (SELECT count(*)::int FROM enterprise_devices WHERE tenant_id = ${tenantId} AND id = ANY(${sql.array(input.targetDeviceIds, 'UUID')}) AND revoked_at IS NULL) AS devices,
    (SELECT count(*)::int FROM enterprise_users WHERE tenant_id = ${tenantId} AND id = ANY(${sql.array(input.targetUserIds, 'UUID')}) AND active) AS users,
    (SELECT count(*)::int FROM enterprise_departments WHERE tenant_id = ${tenantId} AND id = ANY(${sql.array(input.targetDepartmentIds, 'UUID')})) AS departments`
  if (counts?.devices !== input.targetDeviceIds.length || counts.users !== input.targetUserIds.length || counts.departments !== input.targetDepartmentIds.length) {
    throw new ControlError(400, 'UPDATE_AUDIENCE_INVALID', 'All selected devices, employees and departments must be active members of your organization.')
  }
}

const stagePriority: Record<ReportStage, number> = { downloaded: 1, installed: 2, failed: 3, healthy: 4 }

export class ReleaseStore {
  constructor(private readonly db: SQL) {}

  async list(actor: Actor, limit: number, offset: number) {
    requireReleaseAdmin(actor)
    const rows = await this.db<ReleaseRow[]>`SELECT * FROM enterprise_client_releases WHERE tenant_id = ${actor.tenantId}
      ORDER BY created_at DESC, id LIMIT ${limit} OFFSET ${offset}`
    return { releases: await Promise.all(rows.map(async row => view(row, await health(this.db, actor.tenantId, row.id)))) }
  }

  async get(actor: Actor, id: string) {
    requireReleaseAdmin(actor)
    const [row] = await this.db<ReleaseRow[]>`SELECT * FROM enterprise_client_releases WHERE tenant_id = ${actor.tenantId} AND id = ${id}`
    if (!row) throw notFound()
    return row
  }

  async audiences(actor: Actor, search: string) {
    requireReleaseAdmin(actor)
    const term = search.toLowerCase()
    const [devices, users, departments] = await Promise.all([
      this.db<Array<{ id: string, name: string, version: string }>>`SELECT d.id, u.display_name AS name, d.client_version AS version
        FROM enterprise_devices d JOIN enterprise_users u ON (u.tenant_id, u.id) = (d.tenant_id, d.user_id)
        WHERE d.tenant_id = ${actor.tenantId} AND d.revoked_at IS NULL AND d.platform = 'win32' AND u.active
          AND (${term} = '' OR strpos(lower(u.display_name), ${term}) > 0 OR starts_with(u.login, ${term}))
        ORDER BY d.last_seen_at DESC, d.id LIMIT 100`,
      this.db<Array<{ id: string, login: string, name: string }>>`SELECT id, login, display_name AS name FROM enterprise_users WHERE tenant_id = ${actor.tenantId} AND active
        AND (${term} = '' OR strpos(lower(display_name), ${term}) > 0 OR starts_with(login, ${term})) ORDER BY display_name, id LIMIT 100`,
      this.db<Array<{ id: string, name: string }>>`SELECT id, name FROM enterprise_departments WHERE tenant_id = ${actor.tenantId}
        AND (${term} = '' OR strpos(lower(name), ${term}) > 0) ORDER BY name, id LIMIT 100`,
    ])
    return { devices, users, departments }
  }

  async detail(actor: Actor, id: string) {
    return view(await this.get(actor, id), await health(this.db, actor.tenantId, id))
  }

  async create(actor: Actor, input: CreateReleaseInput) {
    requireReleaseAdmin(actor)
    return this.db.begin(async sql => {
      await validateAudience(sql, actor.tenantId, input)
      const [row] = await sql<ReleaseRow[]>`INSERT INTO enterprise_client_releases (tenant_id, id, platform, arch, channel, version,
        rollout_percent, target_devices, target_users, target_departments, min_client_version, max_tested_version, security_required,
        failure_min_sample, failure_threshold_percent, created_by) VALUES (${actor.tenantId}, ${randomUUID()}, ${input.platform}, ${input.arch},
        ${input.channel}, ${input.version}, ${input.rolloutPercent}, ${sql.array(input.targetDeviceIds, 'UUID')}, ${sql.array(input.targetUserIds, 'UUID')},
        ${sql.array(input.targetDepartmentIds, 'UUID')}, ${input.minClientVersion}, ${input.maxTestedVersion}, ${input.securityRequired},
        ${input.failureMinSample}, ${input.failureThresholdPercent}, ${actor.id}) ON CONFLICT DO NOTHING RETURNING *`
      if (!row) throw new ControlError(409, 'UPDATE_VERSION_EXISTS', 'This platform, architecture, channel and version already has a release.')
      await audit(sql, actor.tenantId, row.id, actor.id, 'update.release.created')
      return view(row)
    })
  }

  async saveManifest(actor: Actor, id: string, manifest: BuilderManifest, revision: number) {
    requireReleaseAdmin(actor)
    return this.db.begin(async sql => {
      const row = await lockRelease(sql, actor.tenantId, id)
      if (row.manifest_sha256 === manifest.manifestSha256) return view(row)
      if (row.status !== 'DRAFT' || row.artifact_sha256 || row.revision !== revision || row.version !== manifest.version) throw revisionConflict()
      const [updated] = await sql<ReleaseRow[]>`UPDATE enterprise_client_releases SET manifest_bytes = ${Buffer.from(manifest.bytes)},
        manifest_sha256 = ${manifest.manifestSha256}, artifact_name = ${manifest.name}, artifact_size = ${manifest.size}, artifact_sha512 = ${manifest.sha512},
        revision = revision + 1, updated_at = now() WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING *`
      await audit(sql, actor.tenantId, id, actor.id, 'update.release.manifest_verified')
      return view(updated!)
    })
  }

  async saveArtifact(actor: Actor, id: string, expectedManifest: string, meta: ArtifactMeta, trustedSigner: SignerInfo) {
    requireReleaseAdmin(actor)
    return this.db.begin(async sql => {
      const row = await lockRelease(sql, actor.tenantId, id)
      if (row.artifact_sha256 === meta.sha256 && row.manifest_sha256 === expectedManifest) return view(row)
      if (row.status !== 'DRAFT' || row.artifact_sha256 || row.manifest_sha256 !== expectedManifest || row.artifact_name !== meta.name ||
          Number(row.artifact_size) !== meta.size || row.artifact_sha512 !== meta.sha512) throw revisionConflict()
      const [updated] = await sql<ReleaseRow[]>`UPDATE enterprise_client_releases SET artifact_sha256 = ${meta.sha256},
        signer_fingerprint = ${trustedSigner.fingerprint}, signer_publisher = ${trustedSigner.publisher}, signer_kind = ${trustedSigner.kind},
        revision = revision + 1, updated_at = now() WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING *`
      await audit(sql, actor.tenantId, id, actor.id, 'update.release.installer_verified')
      return view(updated!)
    })
  }

  async publish(actor: Actor, id: string, revision: number, testEvidence: string, sign: ReleaseSigner) {
    requireReleaseAdmin(actor)
    return this.db.begin(async sql => {
      const row = await lockRelease(sql, actor.tenantId, id)
      if (row.status !== 'DRAFT' || row.revision !== revision) throw revisionConflict()
      const time = new Date()
      const payload = signedPayload(row, time.toISOString())
      await sql`SELECT id FROM enterprise_tenants WHERE id = ${actor.tenantId} FOR UPDATE`
      const history = await sql<Array<{ version: string, channel: Channel, artifact_sha256: string }>>`SELECT version, channel, artifact_sha256
        FROM enterprise_client_releases WHERE tenant_id = ${actor.tenantId} AND platform = ${row.platform} AND arch = ${row.arch} AND published_at IS NOT NULL
          AND (channel = ${row.channel} OR version = ${row.version})`
      if (history.some(other => other.channel === row.channel && compareVersions(other.version, row.version) >= 0)) {
        throw new ControlError(409, 'UPDATE_VERSION_ROLLBACK', 'Publish a version higher than the last release in this channel.')
      }
      if (history.some(other => other.version === row.version && other.artifact_sha256 !== payload.artifact.sha256)) {
        throw new ControlError(409, 'UPDATE_VERSION_CONTENT_CONFLICT', 'The same version must use the same installer across channels.')
      }
      const proof = sign.sign(payload)
      const [updated] = await sql<ReleaseRow[]>`UPDATE enterprise_client_releases SET status = 'PUBLISHED', proof = ${proof}::jsonb,
        test_evidence = ${testEvidence}, published_by = ${actor.id}, published_at = ${time}, updated_at = now(), revision = revision + 1
        WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING *`
      await publishPolicy(sql, updated!, actor.id, 'update.release.published')
      return view(updated!)
    })
  }

  async pause(actor: Actor, id: string, revision: number, reason: string) {
    requireReleaseAdmin(actor)
    return this.db.begin(async sql => {
      const row = await lockRelease(sql, actor.tenantId, id)
      if (row.status === 'PAUSED') return view(row, await health(sql, actor.tenantId, id))
      if (row.status !== 'PUBLISHED' || row.revision !== revision) throw revisionConflict()
      const updated = await this.pauseIn(sql, row, actor.id, reason, 'update.release.paused')
      return view(updated, await health(sql, actor.tenantId, id))
    })
  }

  private async pauseIn(sql: TransactionSQL, row: ReleaseRow, actorId: string | null, reason: string, action: string) {
    const [updated] = await sql<ReleaseRow[]>`UPDATE enterprise_client_releases SET status = 'PAUSED', pause_reason = ${reason},
      paused_at = now(), updated_at = now(), revision = revision + 1 WHERE tenant_id = ${row.tenant_id} AND id = ${row.id} RETURNING *`
    await publishPolicy(sql, updated!, actorId, action)
    return updated!
  }

  async select(actor: Actor, input: CheckInput) {
    return this.db.begin(async sql => {
      const device = await deviceIdentity(sql, actor)
      if (input.platform !== device.platform) throw new ControlError(409, 'UPDATE_PLATFORM_MISMATCH', 'The request platform differs from the enrolled device.')
      const known = storedVersion(device)
      await sql`INSERT INTO enterprise_update_devices (tenant_id, device_id, arch, installed_version)
        VALUES (${actor.tenantId}, ${device.id}, ${input.arch}, ${known}) ON CONFLICT DO NOTHING`
      const [profile] = await sql<DeviceProfile[]>`SELECT arch, installed_version FROM enterprise_update_devices
        WHERE tenant_id = ${actor.tenantId} AND device_id = ${device.id}`
      if (!profile || input.arch !== profile.arch) throw new ControlError(409, 'UPDATE_ARCH_MISMATCH', 'The request architecture differs from the device update profile.')
      const installed = storedVersion(device, profile)
      const currentVersion = compareVersions(installed, input.currentVersion) > 0 ? installed : input.currentVersion
      const rows = await sql<ReleaseRow[]>`SELECT * FROM enterprise_client_releases WHERE tenant_id = ${actor.tenantId}
        AND platform = ${input.platform} AND arch = ${profile.arch} AND channel = ${input.channel} AND status IN ('PUBLISHED', 'PAUSED')`
      const row = rows.sort((a, b) => compareVersions(b.version, a.version)).find(candidate => eligible(candidate, device))
      return { currentVersion, row: row?.status === 'PUBLISHED' ? row : undefined }
    })
  }

  async rememberOffer(actor: Actor, row: ReleaseRow, currentVersion: string) {
    if (!actor.device || row.tenant_id !== actor.tenantId) throw invalidDevice()
    const [offered] = await this.db<{ release_id: string }[]>`INSERT INTO enterprise_update_offers (tenant_id, release_id, device_id, offered_from_version)
      SELECT r.tenant_id, r.id, ${actor.device.id}, ${currentVersion} FROM enterprise_client_releases r WHERE r.tenant_id = ${actor.tenantId}
        AND r.id = ${row.id} AND r.status = 'PUBLISHED' ON CONFLICT (tenant_id, release_id, device_id) DO UPDATE
        SET expires_at = now() + interval '24 hours', offered_at = now(), offered_from_version = EXCLUDED.offered_from_version RETURNING release_id`
    return !!offered
  }

  async feed(actor: Actor, releaseId: string) {
    const device = await deviceIdentity(this.db, actor)
    const [row] = await this.db<Array<ReleaseRow & { profile_arch: Architecture, installed_version: string }>>`SELECT r.*, d.arch AS profile_arch, d.installed_version
      FROM enterprise_update_offers o JOIN enterprise_client_releases r ON (r.tenant_id, r.id) = (o.tenant_id, o.release_id)
      JOIN enterprise_update_devices d ON (d.tenant_id, d.device_id) = (o.tenant_id, o.device_id)
      WHERE o.tenant_id = ${actor.tenantId} AND o.device_id = ${device.id} AND o.release_id = ${releaseId}
        AND o.expires_at > now() AND r.status = 'PUBLISHED'`
    if (!row || row.profile_arch !== row.arch || !eligible(row, device) || compareVersions(row.version,
      storedVersion(device, { arch: row.profile_arch, installed_version: row.installed_version })) <= 0) throw notFound()
    return row
  }

  async report(actor: Actor, input: ReportInput) {
    return this.db.begin(async sql => {
      const device = await deviceIdentity(sql, actor)
      const row = await lockRelease(sql, actor.tenantId, input.releaseId)
      const [offer] = await sql<{ present: number }[]>`SELECT 1 AS present FROM enterprise_update_offers WHERE tenant_id = ${actor.tenantId}
        AND release_id = ${row.id} AND device_id = ${device.id} AND offered_at >= now() - interval '90 days'`
      if (!offer || !row.published_at) throw notFound()
      const error = input.errorCode ?? null
      const [created] = await sql<{ event_id: string }[]>`INSERT INTO enterprise_update_reports (tenant_id, device_id, event_id, release_id, stage, error_code)
        VALUES (${actor.tenantId}, ${device.id}, ${input.eventId}, ${row.id}, ${input.stage}, ${error}) ON CONFLICT DO NOTHING RETURNING event_id`
      if (!created) {
        const [prior] = await sql<Array<{ release_id: string, stage: ReportStage, error_code: string | null }>>`SELECT release_id, stage, error_code
          FROM enterprise_update_reports WHERE tenant_id = ${actor.tenantId} AND device_id = ${device.id} AND event_id = ${input.eventId}`
        if (prior?.release_id !== row.id || prior.stage !== input.stage || prior.error_code !== error) {
          throw new ControlError(409, 'UPDATE_REPORT_CONFLICT', 'The report ID already belongs to a different event.')
        }
        return { accepted: true as const, reused: true, paused: row.status === 'PAUSED' }
      }
      const [previous] = await sql<{ latest_stage: ReportStage }[]>`SELECT latest_stage FROM enterprise_update_health
        WHERE tenant_id = ${actor.tenantId} AND release_id = ${row.id} AND device_id = ${device.id}`
      if (!previous || stagePriority[input.stage] > stagePriority[previous.latest_stage]) {
        await sql`INSERT INTO enterprise_update_health (tenant_id, release_id, device_id, latest_stage, error_code)
          VALUES (${actor.tenantId}, ${row.id}, ${device.id}, ${input.stage}, ${error})
          ON CONFLICT (tenant_id, release_id, device_id) DO UPDATE SET latest_stage = EXCLUDED.latest_stage,
            error_code = EXCLUDED.error_code, updated_at = now()`
      }
      if (input.stage === 'healthy') {
        const [profile] = await sql<DeviceProfile[]>`SELECT arch, installed_version FROM enterprise_update_devices
          WHERE tenant_id = ${actor.tenantId} AND device_id = ${device.id} FOR UPDATE`
        if (profile && compareVersions(row.version, profile.installed_version) > 0) {
          await sql`UPDATE enterprise_update_devices SET installed_version = ${row.version}, updated_at = now()
            WHERE tenant_id = ${actor.tenantId} AND device_id = ${device.id}`
        }
      }
      let paused = row.status === 'PAUSED'
      if (row.status === 'PUBLISHED' && (input.stage === 'failed' || input.stage === 'healthy')) {
        const totals = await health(sql, actor.tenantId, row.id)
        const finished = totals.healthy + totals.failed
        if (finished >= row.failure_min_sample && totals.failed * 100 >= finished * row.failure_threshold_percent) {
          await this.pauseIn(sql, row, null, 'FAILURE_THRESHOLD_REACHED', 'update.release.auto_paused')
          paused = true
        }
      }
      return { accepted: true as const, reused: false, paused }
    })
  }
}
