import type { SQL, TransactionSQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { ControlError, loginName, randomToken, tokenDigest, verifyDeviceProof, type EnrollInput, type LoginInput, type RefreshInput, type Role, type UserInput } from './contract'
import type { VerifiedOidcIdentity } from './identity'
import { bindOidcIdentity } from './identity/bind'
import { PiAuthenticator, type PiCredential } from './pi-auth'

const accessLifetime = 15 * 60 * 1000
const refreshLifetime = 30 * 24 * 60 * 60 * 1000
const browserLifetime = 8 * 60 * 60 * 1000
const enrollmentLifetime = 5 * 60 * 1000
const eventPageSize = 100
const accessRequired = () => new ControlError(401, 'AUTH_REQUIRED', 'Sign in again or reconnect the desktop device.')
const adminRequired = () => new ControlError(403, 'ADMIN_REQUIRED', 'This action requires a platform administrator in the web console.')

export interface Actor {
  tenantId: string
  id: string
  displayName: string
  roles: Role[]
  expiresAt: Date
  device: { id: string, platform: EnrollInput['platform'], clientVersion: string } | null
  /** Encrypted upstream proof, kept inside the server and never returned by the API. */
  piAuthorization?: string
}

interface UserRow {
  tenant_id: string
  user_id: string
  display_name: string
  roles: Role[]
  expires_at: Date
  pi_authorization: string | null
}

interface DeviceRow extends UserRow {
  device_id: string
  platform: EnrollInput['platform']
  client_version: string
}

interface DeviceView {
  id: string
  platform: string
  clientVersion: string
  owner: string
  lastSeenAt: Date
  revokedAt: Date | null
}

interface DeviceTokens { accessToken: string, refreshToken: string, expiresAt: string }
interface EventRow {
  eventId: string
  sequence: string
  type: string
  resourceId: string
  revision: number
  occurredAt: Date
}

export function requireAdmin(actor: Actor) {
  if (actor.device || !actor.roles.includes('platform_admin')) throw adminRequired()
}

function asActor(row: UserRow, device: Actor['device']): Actor {
  return { tenantId: row.tenant_id, id: row.user_id, displayName: row.display_name, roles: row.roles, expiresAt: row.expires_at, device }
}

async function issueDeviceTokens(sql: TransactionSQL, deviceId: string): Promise<DeviceTokens> {
  const accessToken = randomToken()
  const refreshToken = randomToken()
  const expiresAt = new Date(Date.now() + accessLifetime)
  await sql`
    INSERT INTO enterprise_device_sessions (device_id, access_digest, refresh_digest, access_expires_at, refresh_expires_at)
    VALUES (${deviceId}, ${tokenDigest(accessToken)}, ${tokenDigest(refreshToken)}, ${expiresAt}, ${new Date(Date.now() + refreshLifetime)})
    ON CONFLICT (device_id) DO UPDATE SET
      access_digest = EXCLUDED.access_digest, refresh_digest = EXCLUDED.refresh_digest,
      access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at
  `
  return { accessToken, refreshToken, expiresAt: expiresAt.toISOString() }
}

async function appendDeviceChange(sql: TransactionSQL, tenantId: string, actorId: string, userId: string, deviceId: string, type: string) {
  // Locking the tenant counter orders visible events by transaction commit, not allocation time.
  const [position] = await sql<{ event_sequence: string, policy_revision: number }[]>`
    UPDATE enterprise_tenants SET event_sequence = event_sequence + 1 WHERE id = ${tenantId}
    RETURNING event_sequence::text, policy_revision
  `
  if (!position) throw accessRequired()
  await sql`
    INSERT INTO enterprise_events (tenant_id, sequence, event_id, user_id, event_type, resource_id, revision)
    VALUES (${tenantId}, ${position.event_sequence}, ${randomUUID()}, ${userId}, ${type}, ${deviceId}, ${position.policy_revision})
  `
  await sql`
    INSERT INTO enterprise_audit (id, tenant_id, actor_id, action, target_id)
    VALUES (${randomUUID()}, ${tenantId}, ${actorId}, ${type}, ${deviceId})
  `
}

export class ControlStore {
  constructor(private readonly database: SQL, private readonly piAuth?: PiAuthenticator) {}

  private async piIdentity(value: string | null, tenantId: string, userId: string) {
    if (!value) return undefined
    if (!this.piAuth) throw accessRequired()
    return this.piAuth.verify(value, tenantId, userId)
  }

  private async verifiedActor(row: UserRow, device: Actor['device']) {
    const current = await this.piIdentity(row.pi_authorization, row.tenant_id, row.user_id)
    const actor = asActor(row, device)
    if (current && row.pi_authorization) {
      actor.piAuthorization = row.pi_authorization
      if (!current.admin && actor.roles.includes('platform_admin')) throw accessRequired()
    }
    return actor
  }

  async createLocalUser(tenantName: string, input: UserInput) {
    return this.createUser(tenantName, input, await Bun.password.hash(input.password, 'argon2id'))
  }

  createExternalUser(tenantName: string, input: Omit<UserInput, 'password'>) {
    return this.createUser(tenantName, input, null)
  }

  private async createUser(tenantName: string, input: Omit<UserInput, 'password'>, hash: string | null): Promise<string> {
    const id = randomUUID()
    await this.database.begin(async sql => {
      await sql`
        INSERT INTO enterprise_tenants (id, slug, name) VALUES (${randomUUID()}, ${input.tenant}, ${tenantName})
        ON CONFLICT (slug) DO NOTHING
      `
      const [tenant] = await sql<{ id: string }[]>`SELECT id FROM enterprise_tenants WHERE slug = ${input.tenant} AND active`
      if (!tenant) throw new ControlError(409, 'TENANT_DISABLED', 'This tenant is disabled.')
      const [created] = await sql<{ id: string }[]>`
        INSERT INTO enterprise_users (tenant_id, id, login, display_name, password_hash, roles)
        VALUES (${tenant.id}, ${id}, ${input.login}, ${input.displayName}, ${hash}, ${sql.array([...new Set(input.roles)], 'TEXT')})
        ON CONFLICT (tenant_id, login) DO NOTHING RETURNING id
      `
      if (!created) throw new ControlError(409, 'USER_EXISTS', 'This login already exists in the tenant.')
    })
    return id
  }

  async signIn(input: LoginInput) {
    const [user] = await this.database<{ tenant_id: string, id: string, password_hash: string | null }[]>`
      SELECT u.tenant_id, u.id, u.password_hash
      FROM enterprise_users u JOIN enterprise_tenants t ON t.id = u.tenant_id
      WHERE t.slug = ${input.tenant} AND u.login = ${input.login} AND u.active AND t.active
    `
    if (!user?.password_hash || !await Bun.password.verify(input.password, user.password_hash)) {
      throw new ControlError(401, 'LOGIN_FAILED', 'Check the tenant, account and password.')
    }
    const token = randomToken()
    const expiresAt = new Date(Date.now() + browserLifetime)
    await this.database`
      INSERT INTO enterprise_web_sessions (token_digest, tenant_id, user_id, expires_at)
      VALUES (${tokenDigest(token)}, ${user.tenant_id}, ${user.id}, ${expiresAt})
    `
    return { accessToken: token, expiresAt: expiresAt.toISOString() }
  }

  async signOut(token: string): Promise<void> {
    await this.database`DELETE FROM enterprise_web_sessions WHERE token_digest = ${tokenDigest(token)}`
  }

  async signInExternal(identity: VerifiedOidcIdentity) {
    const accessToken = randomToken()
    const expiresAt = new Date(Date.now() + browserLifetime)
    const [session] = await this.database`INSERT INTO enterprise_web_sessions (token_digest, tenant_id, user_id, expires_at)
      SELECT ${tokenDigest(accessToken)}, u.tenant_id, u.id, ${expiresAt}
      FROM enterprise_external_identities e JOIN enterprise_users u ON (u.tenant_id, u.id) = (e.tenant_id, e.user_id)
      JOIN enterprise_tenants t ON t.id = e.tenant_id
      WHERE t.slug = ${identity.tenant} AND e.issuer = ${identity.issuer} AND e.subject = ${identity.subject} AND t.active AND u.active
      RETURNING user_id`
    if (!session) throw new ControlError(403, 'IDENTITY_NOT_MAPPED', '此企业身份尚未获得该组织的工作台权限。')
    return { accessToken, expiresAt: expiresAt.toISOString() }
  }

  async signInPi(credential: PiCredential) {
    if (!this.piAuth) throw accessRequired()
    const identity = await this.piAuth.probe(credential)
    const token = randomToken()
    const expiresAt = new Date(Date.now() + browserLifetime)
    return this.database.begin(async sql => {
      const [user] = await sql<{ tenant_id: string, id: string, roles: Role[] }[]>`
        SELECT u.tenant_id, u.id, u.roles FROM enterprise_external_identities e
        JOIN enterprise_users u ON (u.tenant_id, u.id) = (e.tenant_id, e.user_id)
        JOIN enterprise_tenants t ON t.id = e.tenant_id
        WHERE t.slug = ${this.piAuth!.config.tenant} AND e.issuer = ${this.piAuth!.config.origin}
          AND e.subject = ${identity.id} AND t.active AND u.active
        FOR SHARE OF t, u
      `
      if (!user) throw new ControlError(403, 'IDENTITY_NOT_MAPPED', '此工作台账号尚未获得企业权限。')
      if (!identity.admin && user.roles.includes('platform_admin')) throw accessRequired()
      const proof = this.piAuth!.seal({ identity, credential }, user.tenant_id, user.id)
      await sql`INSERT INTO enterprise_web_sessions (token_digest, tenant_id, user_id, expires_at, pi_authorization)
        VALUES (${tokenDigest(token)}, ${user.tenant_id}, ${user.id}, ${expiresAt}, ${proof})`
      return { accessToken: token, expiresAt: expiresAt.toISOString() }
    })
  }

  async bindPiAdministrator(credential: PiCredential, input: { tenantName: string, login: string, displayName: string }) {
    if (!this.piAuth) throw accessRequired()
    const identity = await this.piAuth.probe(credential)
    if (!identity.admin) throw adminRequired()
    const login = loginName.parse(input.login)
    const tenantName = input.tenantName.trim()
    const displayName = input.displayName.trim()
    if (!tenantName || tenantName.length > 120 || !displayName || displayName.length > 120) {
      throw new ControlError(400, 'INVALID_INPUT', '请提供有效的组织和管理员名称。')
    }
    return this.database.begin(async sql => {
      await sql`INSERT INTO enterprise_tenants (id, slug, name)
        VALUES (${randomUUID()}, ${this.piAuth!.config.tenant}, ${tenantName}) ON CONFLICT (slug) DO NOTHING`
      const [tenant] = await sql<{ id: string }[]>`SELECT id FROM enterprise_tenants
        WHERE slug = ${this.piAuth!.config.tenant} AND active FOR UPDATE`
      if (!tenant) throw new ControlError(409, 'TENANT_DISABLED', '此组织已停用。')
      let [user] = await sql<{ id: string, roles: Role[], active: boolean }[]>`
        SELECT id, roles, active FROM enterprise_users WHERE tenant_id = ${tenant.id} AND login = ${login} FOR UPDATE`
      if (!user) {
        const [count] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM enterprise_users WHERE tenant_id = ${tenant.id}`
        if (!count || count.total !== 0) {
          throw new ControlError(403, 'ADMIN_BOOTSTRAP_DENIED', '请先由已有管理员为该工作台身份配置授权。')
        }
        const [created] = await sql<{ id: string, roles: Role[], active: boolean }[]>`
          INSERT INTO enterprise_users (tenant_id, id, login, display_name, roles)
          VALUES (${tenant.id}, ${randomUUID()}, ${login}, ${displayName}, ARRAY['platform_admin']::text[])
          RETURNING id, roles, active`
        user = created
      }
      if (!user?.active || !user.roles.includes('platform_admin')) {
        throw new ControlError(403, 'ADMIN_BOOTSTRAP_DENIED', '已有账户的角色不会由身份绑定修改。')
      }
      const [binding] = await sql<{ user_id: string }[]>`
        INSERT INTO enterprise_external_identities (tenant_id, user_id, issuer, subject)
        VALUES (${tenant.id}, ${user.id}, ${this.piAuth!.config.origin}, ${identity.id})
        ON CONFLICT (tenant_id, issuer, subject) DO NOTHING
        RETURNING user_id`
      if (!binding) {
        const [existing] = await sql<{ user_id: string }[]>`SELECT user_id FROM enterprise_external_identities
          WHERE tenant_id = ${tenant.id} AND issuer = ${this.piAuth!.config.origin} AND subject = ${identity.id}`
        if (existing?.user_id !== user.id) throw new ControlError(409, 'IDENTITY_BINDING_EXISTS', '此工作台身份已绑定其他账户。')
      } else {
        await sql`INSERT INTO enterprise_audit (id, tenant_id, action, target_id)
          VALUES (${randomUUID()}, ${tenant.id}, 'identity.bound', ${user.id})`
      }
      return { userId: user.id }
    })
  }

  async bindPiUser(credential: PiCredential, input: { login: string, subject: string }) {
    if (!this.piAuth) throw accessRequired()
    const identity = await this.piAuth.probe(credential)
    if (!identity.admin) throw adminRequired()
    return bindOidcIdentity(this.database, { issuer: this.piAuth.config.origin },
      { tenant: this.piAuth.config.tenant, login: input.login, subject: input.subject })
  }

  async authenticate(token: string, deviceAllowed: boolean): Promise<Actor> {
    const digest = tokenDigest(token)
    if (deviceAllowed) {
      const [row] = await this.database<DeviceRow[]>`
        SELECT d.tenant_id, d.id AS device_id, d.platform, d.client_version, u.id AS user_id, u.display_name, u.roles,
          s.access_expires_at AS expires_at, d.pi_authorization
        FROM enterprise_device_sessions s JOIN enterprise_devices d ON d.id = s.device_id
        JOIN enterprise_users u ON (u.tenant_id, u.id) = (d.tenant_id, d.user_id)
        JOIN enterprise_tenants t ON t.id = d.tenant_id
        WHERE s.access_digest = ${digest} AND s.access_expires_at > now() AND d.revoked_at IS NULL AND u.active AND t.active
      `
      if (row) return this.verifiedActor(row, { id: row.device_id, platform: row.platform, clientVersion: row.client_version })
    }
    const [row] = await this.database<UserRow[]>`
      SELECT u.tenant_id, u.id AS user_id, u.display_name, u.roles, s.expires_at, s.pi_authorization
      FROM enterprise_web_sessions s JOIN enterprise_users u ON (u.tenant_id, u.id) = (s.tenant_id, s.user_id)
      JOIN enterprise_tenants t ON t.id = u.tenant_id
      WHERE s.token_digest = ${digest} AND s.expires_at > now() AND u.active AND t.active
    `
    if (!row) throw accessRequired()
    return this.verifiedActor(row, null)
  }

  async issueChallenge(actor: Actor) {
    if (actor.device) throw new ControlError(403, 'WEB_SESSION_REQUIRED', 'Sign in to the control console to bind a device.')
    const challenge = randomToken()
    const expiresAt = new Date(Math.min(Date.now() + enrollmentLifetime, actor.expiresAt.getTime()))
    await this.database`
      INSERT INTO enterprise_enrollment_challenges (token_digest, tenant_id, user_id, expires_at, pi_authorization)
      VALUES (${tokenDigest(challenge)}, ${actor.tenantId}, ${actor.id}, ${expiresAt}, ${actor.piAuthorization ?? null})
    `
    return { challenge, expiresAt: expiresAt.toISOString() }
  }

  async issueIntranetChallenge(tenantSlug = 'liyuan') {
    const [user] = await this.database<{ id: string, tenant_id: string }[]>`
      SELECT u.id, u.tenant_id FROM enterprise_users u
      JOIN enterprise_tenants t ON t.id = u.tenant_id
      WHERE t.slug = ${tenantSlug} AND u.login = 'admin' AND u.active AND t.active LIMIT 1
    `
    if (!user) throw new ControlError(404, 'TENANT_NOT_FOUND', '内网默认租户或管理员账号未就绪。')
    const challenge = randomToken()
    const expiresAt = new Date(Date.now() + enrollmentLifetime)
    await this.database`
      INSERT INTO enterprise_enrollment_challenges (token_digest, tenant_id, user_id, expires_at)
      VALUES (${tokenDigest(challenge)}, ${user.tenant_id}, ${user.id}, ${expiresAt})
    `
    return { challenge, expiresAt: expiresAt.toISOString() }
  }

  async enroll(input: EnrollInput): Promise<{ tokens: DeviceTokens, tenantId: string, userId: string }> {
    const { challenge, deviceId, publicKey, platform, clientVersion, signature } = input
    if (!verifyDeviceProof(publicKey, signature, ['enterprise-enroll-v1', challenge, deviceId, publicKey, platform, clientVersion])) {
      throw new ControlError(403, 'DEVICE_PROOF_INVALID', 'The device could not verify its enrollment request.')
    }
    return this.database.begin(async sql => {
      const digest = tokenDigest(challenge)
      const [binding] = await sql<{ tenant_id: string, user_id: string, pi_authorization: string | null }[]>`
        SELECT c.tenant_id, c.user_id, c.pi_authorization FROM enterprise_enrollment_challenges c
        JOIN enterprise_users u ON (u.tenant_id, u.id) = (c.tenant_id, c.user_id)
        JOIN enterprise_tenants t ON t.id = c.tenant_id
        WHERE c.token_digest = ${digest} AND c.expires_at > now() AND c.consumed_at IS NULL AND u.active AND t.active
        FOR UPDATE OF c
      `
      if (!binding) throw new ControlError(410, 'ENROLLMENT_CODE_EXPIRED', 'Generate a new device binding code in the control console.')
      await this.piIdentity(binding.pi_authorization, binding.tenant_id, binding.user_id)
      const [registered] = await sql<{ id: string }[]>`
        INSERT INTO enterprise_devices (id, tenant_id, user_id, public_key, platform, client_version, pi_authorization)
        VALUES (${deviceId}, ${binding.tenant_id}, ${binding.user_id}, ${publicKey}, ${platform}, ${clientVersion}, ${binding.pi_authorization})
        ON CONFLICT (id) DO UPDATE SET platform = EXCLUDED.platform, client_version = EXCLUDED.client_version,
          pi_authorization = EXCLUDED.pi_authorization, last_seen_at = now()
          WHERE enterprise_devices.tenant_id = EXCLUDED.tenant_id AND enterprise_devices.user_id = EXCLUDED.user_id
            AND enterprise_devices.public_key = EXCLUDED.public_key AND enterprise_devices.revoked_at IS NULL
        RETURNING id
      `
      if (!registered) throw new ControlError(409, 'DEVICE_BINDING_CONFLICT', 'Reset the local device connection before binding it again.')
      await sql`UPDATE enterprise_enrollment_challenges SET consumed_at = now() WHERE token_digest = ${digest}`
      const tokens = await issueDeviceTokens(sql, deviceId)
      await appendDeviceChange(sql, binding.tenant_id, binding.user_id, binding.user_id, deviceId, 'device.enrolled')
      return { tokens, tenantId: binding.tenant_id, userId: binding.user_id }
    })
  }

  async refresh(input: RefreshInput): Promise<DeviceTokens> {
    return this.database.begin(async sql => {
      const [row] = await sql<{ public_key: string, pi_authorization: string | null, tenant_id: string, user_id: string }[]>`
        SELECT d.public_key, d.pi_authorization, d.tenant_id, d.user_id FROM enterprise_devices d
        JOIN enterprise_users u ON (u.tenant_id, u.id) = (d.tenant_id, d.user_id)
        JOIN enterprise_tenants t ON t.id = d.tenant_id
        WHERE d.id = ${input.deviceId} AND d.revoked_at IS NULL AND u.active AND t.active FOR UPDATE OF d
      `
      const [session] = row ? await sql`SELECT device_id FROM enterprise_device_sessions
        WHERE device_id = ${input.deviceId} AND refresh_digest = ${tokenDigest(input.refreshToken)} AND refresh_expires_at > now()` : []
      if (!row || !session) throw new ControlError(401, 'DEVICE_REVOKED_OR_EXPIRED', 'Reconnect the device with a fresh binding code.')
      if (!verifyDeviceProof(row.public_key, input.signature, ['enterprise-refresh-v1', input.deviceId, input.refreshToken])) {
        throw new ControlError(403, 'DEVICE_PROOF_INVALID', 'The device could not verify its refresh request.')
      }
      await this.piIdentity(row.pi_authorization, row.tenant_id, row.user_id)
      await sql`UPDATE enterprise_devices SET last_seen_at = now() WHERE id = ${input.deviceId}`
      return issueDeviceTokens(sql, input.deviceId)
    })
  }

  async devices(actor: Actor): Promise<DeviceView[]> {
    requireAdmin(actor)
    return this.database<DeviceView[]>`
      SELECT d.id, d.platform, d.client_version AS "clientVersion", u.display_name AS owner,
        d.last_seen_at AS "lastSeenAt", d.revoked_at AS "revokedAt"
      FROM enterprise_devices d JOIN enterprise_users u ON (u.tenant_id, u.id) = (d.tenant_id, d.user_id)
      WHERE d.tenant_id = ${actor.tenantId} ORDER BY d.last_seen_at DESC, d.id LIMIT 200
    `
  }

  async revoke(actor: Actor, deviceId: string): Promise<{ changed: boolean, userId: string }> {
    requireAdmin(actor)
    return this.database.begin(async sql => {
      const [row] = await sql<{ user_id: string, revoked_at: Date | null }[]>`
        SELECT user_id, revoked_at FROM enterprise_devices WHERE tenant_id = ${actor.tenantId} AND id = ${deviceId} FOR UPDATE
      `
      if (!row) throw new ControlError(404, 'DEVICE_NOT_FOUND', 'This device is not in your tenant.')
      if (row.revoked_at) return { changed: false, userId: row.user_id }
      await sql`UPDATE enterprise_devices SET revoked_at = now() WHERE id = ${deviceId}`
      await sql`DELETE FROM enterprise_device_sessions WHERE device_id = ${deviceId}`
      await appendDeviceChange(sql, actor.tenantId, actor.id, row.user_id, deviceId, 'device.revoked')
      return { changed: true, userId: row.user_id }
    })
  }

  private async tenantState(actor: Actor) {
    const [row] = await this.database<{ policy_revision: number, event_sequence: string }[]>`
      SELECT policy_revision, event_sequence::text FROM enterprise_tenants WHERE id = ${actor.tenantId} AND active
    `
    if (!row) throw accessRequired()
    return { revision: row.policy_revision, sequence: Number(row.event_sequence) }
  }

  async bootstrap(actor: Actor) {
    const { revision, sequence } = await this.tenantState(actor)
    if (actor.device) {
      await this.database`UPDATE enterprise_devices SET last_seen_at = now()
        WHERE id = ${actor.device.id} AND revoked_at IS NULL AND last_seen_at < now() - interval '1 minute'`
    }
    return {
      user: { id: actor.id, displayName: actor.displayName, roles: actor.roles },
      device: actor.device,
      policy: {
        revision, expiresAt: actor.expiresAt.toISOString(),
        features: { demands: false, models: false, memories: false, updates: false },
      },
      cursor: sequence,
    }
  }

  async events(actor: Actor, cursor: number) {
    const { sequence } = await this.tenantState(actor)
    if (cursor > sequence) throw new ControlError(409, 'SYNC_REQUIRED', 'Reload the control snapshot before resuming events.')
    const allDevices = !actor.device && actor.roles.includes('platform_admin')
    const rows = await this.database<EventRow[]>`
      SELECT event_id AS "eventId", enterprise_events.sequence::text, event_type AS type, resource_id AS "resourceId", revision, occurred_at AS "occurredAt"
      FROM enterprise_events WHERE tenant_id = ${actor.tenantId} AND enterprise_events.sequence > ${cursor} AND enterprise_events.sequence <= ${sequence}
        AND (${allDevices} OR user_id IS NULL OR user_id = ${actor.id})
      ORDER BY enterprise_events.sequence ASC LIMIT ${eventPageSize + 1}
    `
    const events = rows.slice(0, eventPageSize).map(row => ({ ...row, sequence: Number(row.sequence) }))
    return { events, cursor: rows.length > eventPageSize ? events.at(-1)!.sequence : sequence }
  }
}
