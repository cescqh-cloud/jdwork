import type { SQL, TransactionSQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { ControlError, type Role } from '../contract'
import type { Classification } from '../models/contract'
import type { Actor } from '../store'
import type { ErpEnvironment, ErpQueryTemplate, RunErpQueryInput } from './contract'
import { KingdeeReadConnector } from './kingdee'
import { ErpPlanStore, type SandboxErpWriter } from './plans'

interface ProjectAccess { tenant: string, id: string, name: string, roles: Role[], classification: Classification }
const inaccessible = () => new ControlError(404, 'ERP_SCOPE_NOT_FOUND', '当前账号无权访问此项目的金蝶查询。')
const cancelled = () => new ControlError(409, 'ERP_QUERY_CANCELLED', '本次金蝶查询已取消。')
const queryInfo = ({ id, label, kind }: ErpQueryTemplate) => ({ id, label, kind, requiresNumber: kind === 'document' })
const queryView = (template: ErpQueryTemplate) => ({ ...queryInfo(template), columns: template.columns })

export class ErpService {
  readonly plans: ErpPlanStore
  private readonly sources: { environment: ErpEnvironment, reader: KingdeeReadConnector }[]
  private readonly projectIds: string[]

  constructor(private readonly database: SQL, environments: readonly ErpEnvironment[], sandboxWriter?: SandboxErpWriter) {
    this.sources = environments.map(environment => ({ environment, reader: new KingdeeReadConnector(environment) }))
    this.projectIds = [...new Set(environments.flatMap(env => env.scopes.map(scope => scope.projectId)))]
    this.plans = new ErpPlanStore(database, this, sandboxWriter)
  }

  private async membership(actor: Actor, projectIds: string[], database: SQL | TransactionSQL = this.database) {
    if (!projectIds.length || actor.expiresAt.getTime() <= Date.now()) return []
    return database<ProjectAccess[]>`SELECT t.slug AS tenant, p.id, p.name, u.roles, p.classification
      FROM enterprise_project_members m JOIN enterprise_projects p ON (p.tenant_id, p.id) = (m.tenant_id, m.project_id)
      JOIN enterprise_users u ON (u.tenant_id, u.id) = (m.tenant_id, m.user_id)
      JOIN enterprise_tenants t ON t.id = m.tenant_id
      WHERE m.tenant_id = ${actor.tenantId} AND m.user_id = ${actor.id} AND t.active AND p.active AND u.active
        AND p.id = ANY(${database.array(projectIds, 'UUID')}) ORDER BY p.name, p.id`
  }

  private scope(environment: ErpEnvironment, project: ProjectAccess) {
    if (project.tenant !== environment.tenant) return undefined
    return environment.scopes.find(scope => scope.projectId === project.id &&
      scope.roles.some(role => project.roles.includes(role)))
  }

  async list(actor: Actor) {
    return (await this.accessibleEnvironments(actor)).map(({ environment, projects }) => {
      const { id, name, mode, kind, queries } = environment
      return { id, name, mode, kind, projects: projects.map(({ id, name, writeApprovalEnabled }) => ({ id, name, writeApprovalEnabled })),
        queries: queries.map(queryView) }
    })
  }

  async listForAssistant(actor: Actor, policy: { projectId: string | null, classifications: Classification[] }) {
    const available = await this.accessibleEnvironments(actor, policy.projectId)
    return available.flatMap(({ environment, projects }) => {
      const { id, name, mode } = environment
      if (mode === 'production') return []
      const queries = environment.queries.filter(query => query.allowAssistant).map(queryInfo)
      const allowed = projects.filter(project => policy.classifications.includes(project.classification))
        .map(({ id, name }) => ({ id, name }))
      return queries.length && allowed.length ? [{ id, name, mode, projects: allowed, queries }] : []
    })
  }

  private async accessibleEnvironments(actor: Actor, projectId: string | null = null) {
    const memberships = await this.membership(actor, projectId ? [projectId] : this.projectIds)
    return this.sources.flatMap(({ environment }) => {
      const projects = memberships.flatMap(project => {
        const scope = this.scope(environment, project)
        return scope ? [{ id: project.id, name: project.name, classification: project.classification,
          writeApprovalEnabled: Boolean(scope.writeReviewRoles.length) }] : []
      })
      return projects.length ? [{ environment, projects }] : []
    })
  }

  async authorize(actor: Actor, environmentId: string, projectId: string, database?: SQL | TransactionSQL) {
    const [project] = await this.membership(actor, [projectId], database)
    if (!project) throw inaccessible()
    const source = this.sources.find(({ environment }) => environment.id === environmentId && environment.tenant === project.tenant)
    const scope = source && this.scope(source.environment, project)
    if (!source || !scope) throw inaccessible()
    return { ...source, scope, project }
  }

  private async finish(requestId: string, outcome: 'succeeded' | 'failed' | 'denied', count: number | null = null) {
    await this.database`UPDATE enterprise_erp_activity SET outcome = ${outcome}, returned_count = ${count}, finished_at = now()
      WHERE request_id = ${requestId} AND outcome = 'started'`
  }

  async read(actor: Actor, environmentId: string, input: RunErpQueryInput, signal: AbortSignal, reauthenticate: () => Promise<Actor>,
    audience: 'human' | 'assistant' = 'human') {
    const { projectId, operation, number } = input
    const { environment, reader } = await this.authorize(actor, environmentId, projectId)
    const template = environment.queries.find(query => query.id === operation)
    if (!template || (audience === 'assistant' && (environment.mode === 'production' || !template.allowAssistant))) {
      throw new ControlError(404, 'ERP_QUERY_NOT_FOUND', '当前入口没有登记这项查询。')
    }
    if ((template.kind === 'document') !== Boolean(number)) throw new ControlError(400, 'ERP_DOCUMENT_NUMBER_REQUIRED', '请按查询类型填写单据编号。')
    if (signal.aborted) throw cancelled()
    const requestId = randomUUID()
    await this.database`INSERT INTO enterprise_erp_activity (request_id, tenant_id, actor_id, project_id, environment_id, operation_key, outcome)
      VALUES (${requestId}, ${actor.tenantId}, ${actor.id}, ${projectId}, ${environmentId}, ${operation}, 'started')`
    let result: Awaited<ReturnType<KingdeeReadConnector['read']>>
    try {
      result = await reader.read(template, number, signal)
    } catch (error) {
      await this.finish(requestId, 'failed')
      throw error
    }
    try {
      const current = await reauthenticate()
      if (current.id !== actor.id || current.tenantId !== actor.tenantId || current.device?.id !== actor.device?.id) throw inaccessible()
      await this.authorize(current, environmentId, projectId)
      if (signal.aborted) throw cancelled()
    } catch (error) {
      await this.finish(requestId, 'denied')
      throw error
    }
    let rows = result.rows
    if (audience === 'assistant') {
      const encoder = new TextEncoder()
      let size = 0
      rows = []
      for (const row of result.rows.slice(0, 10)) {
        size += encoder.encode(JSON.stringify(row)).byteLength
        if (size > 64 * 1024) break
        rows.push(row)
      }
    }
    await this.finish(requestId, 'succeeded', rows.length)
    return { requestId, projectId, environmentId, environmentName: environment.name, mode: environment.mode,
      operation, query: queryView(template), checkedAt: new Date().toISOString(), rows,
      truncated: result.truncated || rows.length < result.rows.length }
  }
}
