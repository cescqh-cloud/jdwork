import type { SQL, TransactionSQL } from 'bun'
import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { ControlError, randomToken, tokenDigest, type Role } from '../contract'
import type { AssistantErpInput } from '../erp/contract'
import type { PiAuthenticator } from '../pi-auth'
import { requireAdmin, type Actor } from '../store'
import { approvedUpstream, proxyEndpoint, sealKey, type ApiKind, type Capability, type Classification, type Effort,
  type ModelGatewayConfig, type ModelInput, type Protocol, type ProviderInput,
  type departmentInput, type grantInput, type membershipInput, type projectInput, type userDepartmentInput } from './contract'

const grantLifetime = 120_000
const catalogLifetime = 28_000
const dayStart = "date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
const deviceRequired = () => new ControlError(401, 'DEVICE_REQUIRED', 'Bind an active desktop device to use enterprise models.')
const modelDenied = () => new ControlError(403, 'MODEL_NOT_ALLOWED', 'This model is unavailable in the current role or project.')
const unavailableGrant = () => new ControlError(401, 'MODEL_GRANT_EXPIRED', 'Get a new model access grant and retry.')

interface ModelRow {
  id: string
  provider_id: string
  upstream_model: string
  display_name: string
  capabilities: Capability[]
  context_window: number
  max_output_tokens: number
  default_effort: Effort | null
  project_id: string | null
  is_default: boolean
  allow_context: boolean
  allow_erp_read: boolean
  daily_tokens: string | null
  soft_daily_tokens: string | null
  protocol: Protocol
  base_url: string
  sealed_key: string
  auth_header: 'bearer' | 'x-api-key'
  stream_usage: boolean
  classifications: Classification[]
}

interface CallActor {
  tenant_id: string
  user_id: string
  device_id: string | null
  department_id: string | null
  roles: Role[]
  project_id: string | null
  session_id: string
}
type GrantActor = CallActor & { model_id: string, pi_authorization?: string | null }

export type CallOutcome = 'completed' | 'cancelled' | 'timed_out' | 'upstream_error'
export interface CallUsage { inputTokens: number | null, outputTokens: number | null, complete: boolean }
export interface ModelCall {
  id: string
  tenantId: string
  model: ModelRow
  outputTokens: number
  reservation: number
  softLimitReached: boolean
  kind: ApiKind
}
export interface ModelUsageRow {
  day: string
  userId: string
  deviceId: string | null
  departmentId: string | null
  projectId: string | null
  modelId: string
  purpose: 'interactive' | 'demand_precheck'
  requests: number
  reportedInputTokens: string
  reportedOutputTokens: string
  chargedTokens: string
  errors: number
  softLimitReached: boolean
}

export class ModelStore {
  constructor(private readonly db: SQL, readonly config: ModelGatewayConfig, private readonly notify: (tenantId: string) => void,
    private readonly piAuth?: PiAuthenticator) {}

  private async mutate<T>(actor: Actor, action: string, write: (sql: TransactionSQL) => Promise<{ value: T, target: string }>): Promise<T> {
    requireAdmin(actor)
    const result = await this.db.begin(async sql => {
      const [position] = await sql<{ revision: number, sequence: string }[]>`
        UPDATE enterprise_tenants SET policy_revision = policy_revision + 1, event_sequence = event_sequence + 1
        WHERE id = ${actor.tenantId} AND active RETURNING policy_revision AS revision, event_sequence::text AS sequence
      `
      if (!position) throw new ControlError(403, 'TENANT_DISABLED', 'The organization is disabled.')
      const change = await write(sql)
      await sql`
        INSERT INTO enterprise_events (tenant_id, sequence, event_id, event_type, resource_id, revision)
        VALUES (${actor.tenantId}, ${position.sequence}, ${randomUUID()}, 'model.policy.changed', ${actor.tenantId}, ${position.revision})
      `
      await sql`INSERT INTO enterprise_audit (id, tenant_id, actor_id, action, target_id)
        VALUES (${randomUUID()}, ${actor.tenantId}, ${actor.id}, ${action}, ${change.target})`
      return change.value
    })
    this.notify(actor.tenantId)
    return result
  }

  setProvider(actor: Actor, input: ProviderInput) {
    return this.mutate(actor, 'models.provider.saved', async sql => {
      const base = approvedUpstream(input.baseUrl, this.config)
      const [previous] = await sql<{ sealed_key: string, base_url: string, protocol: Protocol, auth_header: string }[]>`
        SELECT sealed_key, base_url, protocol, auth_header FROM enterprise_model_providers
        WHERE tenant_id = ${actor.tenantId} AND id = ${input.id}
      `
      const needsKey = !previous || previous.base_url !== base || previous.protocol !== input.protocol || previous.auth_header !== input.authHeader
      if (!input.apiKey && needsKey) throw new ControlError(400, 'PROVIDER_KEY_REQUIRED', 'Supply a new provider key for this API base and authentication method.')
      const sealed = input.apiKey ? sealKey(input.apiKey, this.config.encryptionKey, actor.tenantId, input.id) : previous!.sealed_key
      await sql`
        INSERT INTO enterprise_model_providers (tenant_id, id, display_name, protocol, base_url, sealed_key, auth_header, classifications, stream_usage, enabled)
        VALUES (${actor.tenantId}, ${input.id}, ${input.displayName}, ${input.protocol}, ${base}, ${sealed}, ${input.authHeader},
          ${sql.array([...new Set(input.classifications)], 'TEXT')}, ${input.streamUsage}, ${input.enabled})
        ON CONFLICT (tenant_id, id) DO UPDATE SET display_name = EXCLUDED.display_name, protocol = EXCLUDED.protocol,
          base_url = EXCLUDED.base_url, sealed_key = EXCLUDED.sealed_key, auth_header = EXCLUDED.auth_header,
          classifications = EXCLUDED.classifications, stream_usage = EXCLUDED.stream_usage, enabled = EXCLUDED.enabled
      `
      return { value: { id: input.id }, target: actor.tenantId }
    })
  }

  setModel(actor: Actor, input: ModelInput) {
    return this.mutate(actor, 'models.catalog.saved', async sql => {
      const [provider] = await sql`SELECT id FROM enterprise_model_providers WHERE tenant_id = ${actor.tenantId} AND id = ${input.providerId}`
      if (!provider) throw new ControlError(404, 'PROVIDER_NOT_FOUND', 'Configure a provider in this organization first.')
      if (input.projectId) await this.requireProject(sql, actor.tenantId, input.projectId)
      if (input.enabled && input.isDefault) await sql`UPDATE enterprise_models SET is_default = false
        WHERE tenant_id = ${actor.tenantId} AND id <> ${input.id} AND project_id IS NOT DISTINCT FROM ${input.projectId}::uuid AND is_default`
      await sql`
        INSERT INTO enterprise_models (tenant_id, id, provider_id, upstream_model, display_name, capabilities, context_window,
          max_output_tokens, default_effort, allowed_roles, project_id, is_default, daily_tokens, soft_daily_tokens, enabled, allow_context, allow_erp_read)
        VALUES (${actor.tenantId}, ${input.id}, ${input.providerId}, ${input.upstreamModel}, ${input.displayName},
          ${sql.array([...new Set(input.capabilities)], 'TEXT')}, ${input.contextWindow}, ${input.maxOutputTokens}, ${input.defaultEffort},
          ${sql.array([...new Set(input.allowedRoles)], 'TEXT')}, ${input.projectId}, ${input.isDefault},
          ${input.dailyTokens}, ${input.softDailyTokens}, ${input.enabled}, ${input.allowContext}, ${input.allowErpRead})
        ON CONFLICT (tenant_id, id) DO UPDATE SET provider_id = EXCLUDED.provider_id, upstream_model = EXCLUDED.upstream_model,
          display_name = EXCLUDED.display_name, capabilities = EXCLUDED.capabilities, context_window = EXCLUDED.context_window,
          max_output_tokens = EXCLUDED.max_output_tokens, default_effort = EXCLUDED.default_effort, allowed_roles = EXCLUDED.allowed_roles,
          project_id = EXCLUDED.project_id, is_default = EXCLUDED.is_default, daily_tokens = EXCLUDED.daily_tokens,
          soft_daily_tokens = EXCLUDED.soft_daily_tokens, enabled = EXCLUDED.enabled, allow_context = EXCLUDED.allow_context,
          allow_erp_read = EXCLUDED.allow_erp_read
      `
      return { value: { id: input.id }, target: input.projectId ?? actor.tenantId }
    })
  }

  private async requireProject(sql: SQL | TransactionSQL, tenantId: string, projectId: string) {
    const [project] = await sql`SELECT id FROM enterprise_projects WHERE tenant_id = ${tenantId} AND id = ${projectId}`
    if (!project) throw new ControlError(404, 'PROJECT_NOT_FOUND', 'The project is not in this organization.')
  }

  setProject(actor: Actor, input: z.infer<typeof projectInput>) {
    return this.mutate(actor, 'projects.saved', async sql => {
      const id = input.id ?? randomUUID()
      await sql`INSERT INTO enterprise_projects (tenant_id, id, name, classification, active)
        VALUES (${actor.tenantId}, ${id}, ${input.name}, ${input.classification}, ${input.active})
        ON CONFLICT (tenant_id, id) DO UPDATE SET name = EXCLUDED.name, classification = EXCLUDED.classification, active = EXCLUDED.active`
      return { value: { id }, target: id }
    })
  }

  setMembership(actor: Actor, input: z.infer<typeof membershipInput>) {
    return this.mutate(actor, 'projects.membership.saved', async sql => {
      await this.requireProject(sql, actor.tenantId, input.projectId)
      const [user] = await sql`SELECT id FROM enterprise_users WHERE tenant_id = ${actor.tenantId} AND id = ${input.userId} AND active`
      if (!user) throw new ControlError(404, 'USER_NOT_FOUND', 'The user is not active in this organization.')
      if (input.enabled) await sql`INSERT INTO enterprise_project_members (tenant_id, project_id, user_id)
        VALUES (${actor.tenantId}, ${input.projectId}, ${input.userId}) ON CONFLICT DO NOTHING`
      else await sql`DELETE FROM enterprise_project_members WHERE tenant_id = ${actor.tenantId} AND project_id = ${input.projectId} AND user_id = ${input.userId}`
      return { value: { enabled: input.enabled }, target: input.projectId }
    })
  }

  setDepartment(actor: Actor, input: z.infer<typeof departmentInput>) {
    return this.mutate(actor, 'departments.saved', async sql => {
      const id = input.id ?? randomUUID()
      await sql`INSERT INTO enterprise_departments (tenant_id, id, name) VALUES (${actor.tenantId}, ${id}, ${input.name})
        ON CONFLICT (tenant_id, id) DO UPDATE SET name = EXCLUDED.name`
      return { value: { id }, target: id }
    })
  }

  assignDepartment(actor: Actor, input: z.infer<typeof userDepartmentInput>) {
    return this.mutate(actor, 'departments.assignment.saved', async sql => {
      if (input.departmentId) {
        const [department] = await sql`SELECT id FROM enterprise_departments WHERE tenant_id = ${actor.tenantId} AND id = ${input.departmentId}`
        if (!department) throw new ControlError(404, 'DEPARTMENT_NOT_FOUND', 'The department is not in this organization.')
      }
      const [user] = await sql`UPDATE enterprise_users SET department_id = ${input.departmentId} WHERE tenant_id = ${actor.tenantId} AND id = ${input.userId} RETURNING id`
      if (!user) throw new ControlError(404, 'USER_NOT_FOUND', 'The user is not in this organization.')
      return { value: { userId: input.userId }, target: input.userId }
    })
  }

  async admin(actor: Actor) {
    requireAdmin(actor)
    const [providers, models, projects, members, departments, users] = await Promise.all([
      this.db<{id: string, displayName: string, protocol: Protocol, baseUrl: string, authHeader: string, classifications: Classification[], streamUsage: boolean, enabled: boolean}[]>`
        SELECT id, display_name AS "displayName", protocol, base_url AS "baseUrl", auth_header AS "authHeader", classifications,
          stream_usage AS "streamUsage", enabled FROM enterprise_model_providers WHERE tenant_id = ${actor.tenantId} ORDER BY id`,
      this.db<ModelInput[]>`SELECT id, provider_id AS "providerId", display_name AS "displayName", upstream_model AS "upstreamModel", capabilities,
          context_window AS "contextWindow", max_output_tokens AS "maxOutputTokens", default_effort AS "defaultEffort", allowed_roles AS "allowedRoles",
          project_id AS "projectId", is_default AS "isDefault", daily_tokens::int AS "dailyTokens", soft_daily_tokens::int AS "softDailyTokens", enabled,
          allow_context AS "allowContext", allow_erp_read AS "allowErpRead"
        FROM enterprise_models WHERE tenant_id = ${actor.tenantId} ORDER BY id`,
      this.db<{id: string, name: string, classification: Classification, active: boolean}[]>`
        SELECT id, name, classification, active FROM enterprise_projects WHERE tenant_id = ${actor.tenantId} ORDER BY name`,
      this.db<{projectId: string, userId: string}[]>`SELECT project_id AS "projectId", user_id AS "userId"
        FROM enterprise_project_members WHERE tenant_id = ${actor.tenantId} ORDER BY project_id, user_id`,
      this.db<{id: string, name: string}[]>`SELECT id, name FROM enterprise_departments WHERE tenant_id = ${actor.tenantId} ORDER BY name`,
      this.db<{id: string, displayName: string, departmentId: string | null}[]>`SELECT id, display_name AS "displayName", department_id AS "departmentId"
        FROM enterprise_users WHERE tenant_id = ${actor.tenantId} AND active ORDER BY display_name`,
    ])
    return { providers, models, projects, members, departments, users }
  }

  private async available(sql: SQL | TransactionSQL, tenantId: string, userId: string, roles: Role[], projectId: string | null, modelId?: string, dataClass: Classification = 'general') {
    if (projectId) {
      const [project] = await sql<{ classification: Classification }[]>`
        SELECT p.classification FROM enterprise_projects p JOIN enterprise_project_members member ON
          (member.tenant_id, member.project_id) = (p.tenant_id, p.id)
        WHERE p.tenant_id = ${tenantId} AND p.id = ${projectId} AND p.active AND member.user_id = ${userId}
      `
      if (!project) throw new ControlError(403, 'PROJECT_ACCESS_DENIED', 'The project is unavailable to this user.')
      dataClass = project.classification
    }
    return sql<ModelRow[]>`
      SELECT m.id, m.provider_id, m.upstream_model, m.display_name, m.capabilities, m.context_window, m.max_output_tokens,
        m.default_effort, m.project_id, m.is_default, m.daily_tokens::text, m.soft_daily_tokens::text, m.allow_context, m.allow_erp_read,
        p.protocol, p.base_url, p.sealed_key, p.auth_header, p.stream_usage, p.classifications
      FROM enterprise_models m JOIN enterprise_model_providers p ON (p.tenant_id, p.id) = (m.tenant_id, m.provider_id)
      WHERE m.tenant_id = ${tenantId} AND m.enabled AND p.enabled AND m.allowed_roles && ${sql.array(roles, 'TEXT')}
        AND ${dataClass}::text = ANY(p.classifications) AND (m.project_id IS NULL OR m.project_id = ${projectId}::uuid)
        AND (${modelId ?? null}::text IS NULL OR m.id = ${modelId ?? null}::text)
      ORDER BY (m.project_id IS NOT NULL) DESC, m.is_default DESC, m.display_name, m.id
      LIMIT 500
    `
  }

  async catalog(actor: Actor, projectId: string | null) {
    if (!actor.device) throw deviceRequired()
    return this.db.begin(async sql => {
      const [policy] = await sql<{ revision: number }[]>`SELECT policy_revision AS revision FROM enterprise_tenants
        WHERE id = ${actor.tenantId} AND active FOR SHARE`
      if (!policy) throw deviceRequired()
      const rows = await this.available(sql, actor.tenantId, actor.id, actor.roles, projectId)
      const defaultId = rows.find(row => row.is_default)?.id
      return {
        revision: policy.revision, expiresAt: new Date(Math.min(Date.now() + catalogLifetime, actor.expiresAt.getTime())).toISOString(),
        models: rows.map(row => ({
          providerId: row.provider_id, modelId: row.id, displayName: row.display_name, protocol: row.protocol,
          capabilities: row.capabilities, contextWindow: row.context_window, maxOutputTokens: row.max_output_tokens, defaultEffort: row.default_effort,
          proxyEndpoint: proxyEndpoint(row.protocol), projectId: row.project_id, isDefault: row.id === defaultId,
          canSearchContext: row.allow_context,
          canQueryErp: row.allow_erp_read && row.capabilities.includes('tools') && this.config.allowedUpstreams.has(row.base_url),
          quota: { dailyTokens: row.daily_tokens === null ? null : Number(row.daily_tokens), softDailyTokens: row.soft_daily_tokens === null ? null : Number(row.soft_daily_tokens) },
        })),
      }
    })
  }

  async contextPolicy(actor: Actor, modelId: string, projectId: string | null) {
    const deviceId = actor.device?.id
    if (!deviceId || actor.expiresAt.getTime() <= Date.now()) throw deviceRequired()
    return this.db.begin(async sql => {
      const [caller] = await sql<{ roles: Role[], revision: number }[]>`
        SELECT u.roles, t.policy_revision AS revision FROM enterprise_tenants t JOIN enterprise_users u ON u.tenant_id = t.id
        JOIN enterprise_devices d ON (d.tenant_id, d.user_id) = (u.tenant_id, u.id)
        WHERE t.id = ${actor.tenantId} AND u.id = ${actor.id} AND d.id = ${deviceId} AND d.revoked_at IS NULL AND u.active AND t.active
        FOR SHARE OF t
      `
      if (!caller) throw deviceRequired()
      const roles = caller.roles.filter(role => actor.roles.includes(role))
      const [model] = await this.available(sql, actor.tenantId, actor.id, roles, projectId, modelId)
      if (!model || !model.allow_context || !this.config.allowedUpstreams.has(model.base_url)) {
        throw new ControlError(403, 'MODEL_CONTEXT_DENIED', 'This model is not authorized to use enterprise context.')
      }
      return { revision: caller.revision, classifications: model.classifications, modelProjectId: projectId }
    })
  }

  async erpPolicy(actor: Actor, input: AssistantErpInput) {
    const deviceId = actor.device?.id
    if (!deviceId || actor.expiresAt.getTime() <= Date.now()) throw deviceRequired()
    return this.db.begin(async sql => {
      const [grant] = await sql<{ roles: Role[], revision: number, project_id: string | null }[]>`
        SELECT u.roles, t.policy_revision AS revision, g.project_id FROM enterprise_model_grants g
        JOIN enterprise_devices d ON (d.tenant_id, d.id) = (g.tenant_id, g.device_id)
        JOIN enterprise_users u ON (u.tenant_id, u.id) = (d.tenant_id, d.user_id)
        JOIN enterprise_tenants t ON t.id = g.tenant_id
        WHERE g.token_digest = ${tokenDigest(input.modelGrant)} AND g.tenant_id = ${actor.tenantId}
          AND g.device_id = ${deviceId} AND d.user_id = ${actor.id} AND g.model_id = ${input.modelId}
          AND g.session_id = ${input.sessionId} AND g.expires_at > now() AND d.revoked_at IS NULL AND u.active AND t.active
        FOR SHARE OF t
      `
      if (!grant) throw unavailableGrant()
      const projectId = input.action === 'read' ? input.projectId : grant.project_id
      if (grant.project_id && grant.project_id !== projectId) throw modelDenied()
      const roles = grant.roles.filter(role => actor.roles.includes(role))
      const [model] = await this.available(sql, actor.tenantId, actor.id, roles, projectId, input.modelId)
      if (!model?.allow_erp_read || model.provider_id !== input.providerId || !model.capabilities.includes('tools')
        || !this.config.allowedUpstreams.has(model.base_url)) {
        throw new ControlError(403, 'MODEL_ERP_DENIED', '所选模型无权查询金蝶测试环境。')
      }
      return { revision: grant.revision, classifications: model.classifications, projectId }
    })
  }

  async grant(actor: Actor, input: z.infer<typeof grantInput>) {
    const device = actor.device
    if (!device) throw deviceRequired()
    const expiresAt = new Date(Math.min(Date.now() + grantLifetime, actor.expiresAt.getTime()))
    const accessToken = randomToken()
    const projectId = input.projectId ?? null
    return this.db.begin(async sql => {
      const [active] = await sql`SELECT id FROM enterprise_devices WHERE tenant_id = ${actor.tenantId}
        AND id = ${device.id} AND user_id = ${actor.id} AND revoked_at IS NULL FOR UPDATE`
      if (!active) throw deviceRequired()
      const [model] = await this.available(sql, actor.tenantId, actor.id, actor.roles, projectId, input.modelId)
      if (!model) throw modelDenied()
      const [existing] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM enterprise_model_grants WHERE device_id = ${device.id} AND expires_at > now()`
      if (!existing || existing.total >= 100) throw new ControlError(429, 'MODEL_GRANT_LIMIT', 'Too many model requests. Wait before trying again.')
      await sql`INSERT INTO enterprise_model_grants (token_digest, tenant_id, model_id, device_id, session_id, project_id, expires_at)
        VALUES (${tokenDigest(accessToken)}, ${actor.tenantId}, ${input.modelId}, ${device.id}, ${input.sessionId}, ${projectId}, ${expiresAt})`
      return { accessToken, expiresAt: expiresAt.toISOString(), proxyEndpoint: proxyEndpoint(model.protocol) }
    })
  }

  startCall(token: string, modelId: string, protocol: Protocol, kind: ApiKind, requestedOutput: number | null): Promise<ModelCall> {
    return this.db.begin(async sql => {
      const [grant] = await sql<GrantActor[]>`
        SELECT g.tenant_id, d.user_id, g.device_id, u.department_id, u.roles, g.model_id, g.project_id, g.session_id, d.pi_authorization
        FROM enterprise_model_grants g JOIN enterprise_devices d ON (d.tenant_id, d.id) = (g.tenant_id, g.device_id)
        JOIN enterprise_users u ON (u.tenant_id, u.id) = (d.tenant_id, d.user_id)
        JOIN enterprise_tenants t ON t.id = g.tenant_id
        WHERE g.token_digest = ${tokenDigest(token)} AND g.expires_at > now() AND d.revoked_at IS NULL AND u.active AND t.active
        FOR UPDATE OF u
      `
      if (!grant) throw unavailableGrant()
      if (grant.pi_authorization) {
        if (!this.piAuth) throw unavailableGrant()
        const identity = await this.piAuth.verify(grant.pi_authorization, grant.tenant_id, grant.user_id)
        if (!identity.admin && grant.roles.includes('platform_admin')) throw unavailableGrant()
      }
      if (grant.model_id !== modelId) throw modelDenied()
      const [model] = await this.available(sql, grant.tenant_id, grant.user_id, grant.roles, grant.project_id, modelId)
      if (model?.protocol !== protocol) throw modelDenied()
      return this.reserve(sql, grant, model, kind, requestedOutput, 'interactive')
    })
  }

  startDemandPrecheck(actor: Actor, modelId: string, demandId: string) {
    return this.db.begin(async sql => {
      const deviceId = actor.device?.id ?? null
      const [caller] = await sql<Pick<CallActor, 'roles' | 'department_id'>[]>`
        SELECT u.roles, u.department_id FROM enterprise_users u JOIN enterprise_tenants t ON t.id = u.tenant_id
        WHERE u.tenant_id = ${actor.tenantId} AND u.id = ${actor.id} AND u.active AND t.active
          AND (${deviceId}::uuid IS NULL OR EXISTS (SELECT 1 FROM enterprise_devices d WHERE d.id = ${deviceId}::uuid
            AND d.tenant_id = u.tenant_id AND d.user_id = u.id AND d.revoked_at IS NULL)) FOR UPDATE OF u
      `
      if (!caller) throw new ControlError(401, 'AUTH_REQUIRED', 'Sign in again before requesting a review.')
      const roles = caller.roles.filter(role => actor.roles.includes(role))
      const [model] = await this.available(sql, actor.tenantId, actor.id, roles, null, modelId, 'internal')
      if (!model) throw modelDenied()
      const principal = { ...caller, tenant_id: actor.tenantId, user_id: actor.id, device_id: deviceId, project_id: null, session_id: `demand-precheck-${demandId}` }
      return this.reserve(sql, principal, model, model.protocol === 'anthropic' ? 'messages' : 'chat_completions', Math.min(1800, model.max_output_tokens), 'demand_precheck')
    })
  }

  private async reserve(sql: TransactionSQL, caller: CallActor, model: ModelRow, kind: ApiKind, requestedOutput: number | null, purpose: ModelUsageRow['purpose']): Promise<ModelCall> {
    const outputTokens = kind === 'count_tokens' ? 0 : requestedOutput ?? model.max_output_tokens
    if (outputTokens > model.max_output_tokens) throw new ControlError(400, 'MODEL_OUTPUT_LIMIT', 'The requested output exceeds the configured limit for this model.')
    const reservation = kind === 'count_tokens' ? 0 : model.context_window + outputTokens
    const [usage] = await sql<{ concurrent: number, spent: string }[]>`
        SELECT (count(*) FILTER (WHERE status = 'streaming' AND started_at > now() - interval '6 minutes'))::int AS concurrent,
          coalesce(sum(coalesce(charged_tokens, reserved_tokens)) FILTER (WHERE model_id = ${model.id} AND started_at >= ${sql.unsafe(dayStart)}), 0)::text AS spent
        FROM enterprise_model_usage WHERE tenant_id = ${caller.tenant_id} AND user_id = ${caller.user_id}
          AND started_at >= least(${sql.unsafe(dayStart)}, now() - interval '6 minutes')
      `
    if (!usage || usage.concurrent >= 3) throw new ControlError(429, 'MODEL_CONCURRENCY_LIMIT', 'Three enterprise model requests are already running. Wait and retry.')
    const projected = Number(usage.spent) + reservation
    if (reservation > 0 && model.daily_tokens !== null && projected > Number(model.daily_tokens)) {
      throw new ControlError(429, 'MODEL_DAILY_TOKEN_LIMIT', 'The remaining UTC daily token allowance cannot cover this request.')
    }
    const softLimitReached = reservation > 0 && model.soft_daily_tokens !== null && projected >= Number(model.soft_daily_tokens)
    const id = randomUUID()
    await sql`INSERT INTO enterprise_model_usage (request_id, tenant_id, user_id, department_id, project_id, device_id, session_id,
        provider_id, model_id, api_kind, purpose, status, reserved_tokens, soft_limit_reached)
      VALUES (${id}, ${caller.tenant_id}, ${caller.user_id}, ${caller.department_id}, ${caller.project_id}, ${caller.device_id},
        ${caller.session_id}, ${model.provider_id}, ${model.id}, ${kind}, ${purpose}, 'streaming', ${reservation}, ${softLimitReached})`
    return { id, tenantId: caller.tenant_id, model, outputTokens, reservation, softLimitReached, kind }
  }

  async finish(call: ModelCall, outcome: CallOutcome, observed: CallUsage, upstreamStatus: number | null, attempted: boolean) {
    const complete = observed.complete && observed.inputTokens !== null && observed.outputTokens !== null
    const source = !attempted || call.kind === 'count_tokens' ? 'none' : complete ? 'provider' : 'reserved'
    const charged = source === 'provider' ? observed.inputTokens! + observed.outputTokens! : source === 'reserved' ? call.reservation : 0
    await this.db`UPDATE enterprise_model_usage SET status = ${outcome}, usage_source = ${source}, charged_tokens = ${charged},
      input_tokens = ${observed.inputTokens}, output_tokens = ${observed.outputTokens}, upstream_status = ${upstreamStatus}, finished_at = now()
      WHERE request_id = ${call.id} AND tenant_id = ${call.tenantId} AND status = 'streaming'`
  }

  async usage(actor: Actor, all: boolean) {
    if (all) requireAdmin(actor)
    return this.db<ModelUsageRow[]>`SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, user_id AS "userId",
        device_id AS "deviceId", department_id AS "departmentId", project_id AS "projectId", model_id AS "modelId", purpose,
        count(*)::int AS requests, coalesce(sum(input_tokens), 0)::text AS "reportedInputTokens",
        coalesce(sum(output_tokens), 0)::text AS "reportedOutputTokens", sum(coalesce(charged_tokens, reserved_tokens))::text AS "chargedTokens",
        (count(*) FILTER (WHERE status IN ('upstream_error', 'timed_out')))::int AS errors, bool_or(soft_limit_reached) AS "softLimitReached"
      FROM enterprise_model_usage WHERE tenant_id = ${actor.tenantId} AND (${all} OR user_id = ${actor.id})
        AND started_at >= now() - interval '7 days'
      GROUP BY day, user_id, device_id, department_id, project_id, model_id, purpose ORDER BY day DESC, "modelId", "userId", "deviceId" LIMIT 500`
  }

  async purgeExpiredGrants() {
    await this.db`DELETE FROM enterprise_model_grants WHERE expires_at <= now()`
  }
}
