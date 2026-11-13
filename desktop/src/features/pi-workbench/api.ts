export type Identity = { id: string, name: string, admin: boolean }
type Project = { id: string, name: string, description: string }
export type LoginConfig = { project: Project, tokenLogin: boolean, dingTalkLogin: boolean, localClient?: boolean, managementOnly?: boolean }
export type Session = { identity: Identity, csrfToken: string, project: Project }

export type Category = 'office' | 'analysis' | 'development'
export type TaskKind = 'research' | 'bugfix' | 'report' | 'testing' | 'release' | 'review'
export type Agent = { id: string, kind: TaskKind, label: string, summary: string, category: Category, starter: string }
export type Workbench = {
  projectId: string
  name: string
  description: string
  revision: number
  agents: Agent[]
  enabledAgentIds: string[]
  groups: { id: string, label: string }[]
  requirementSections: { id: string, label: string }[]
}

export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type TaskSummary = {
  id: string, kind: TaskKind, title: string, status: TaskStatus, updatedAt: string, agentId?: string, groupId?: string
}
export type ToolEvent = {
  name: string, at: string, status?: 'started' | 'succeeded' | 'failed', callId?: string, area?: string, path?: string, durationMs?: number
}
export type Task = TaskSummary & {
  ownerId?: string
  messages: { role: 'user' | 'assistant', text: string, at: string, attachments?: string[] }[]
  tools: ToolEvent[]
  error?: string
  svnSource?: { path: string, revision: string }
  svnVersion?: { path: string, uatRevision: string, productionRevision: string }
  codeVersion?: { repositoryName: string, head: string, base: string }
}
export type RequirementAction = { type: 'draft', revision?: number } | { type: 'section', section: string, revision: number }
export type TaskInput = {
  kind: TaskKind
  prompt: string
  taskId?: string
  agentId?: string
  groupId?: string
  attachmentIds?: string[]
  requirementAction?: RequirementAction
}
type RequirementStatus = 'draft' | 'confirmed'
export type RequirementRevision = {
  revision: number, title: string, status: RequirementStatus, updatedAt: string, updatedBy: string, source: 'agent' | 'manual'
}
export type RequirementDocument = RequirementRevision & { taskId: string, sections: Record<string, string> }
export type RequirementResponse = { document: RequirementDocument | null, revisions: RequirementRevision[] }

export type Attachment = { id: string, name: string, warnings: string[] }
export type MemoryScope = 'personal' | 'project'
export type MemoryState = 'candidate' | 'active' | 'archived'
export type Memory = {
  id: string, title: string, content: string, scope: MemoryScope, state: MemoryState, revision: number, updatedAt: string
}
export type Release = {
  id: string, version: string, filename: string, bytes: number, sha256: string, notes: string,
  state: 'draft' | 'published' | 'withdrawn', publishedAt?: string
  review?: { state: 'pending' | 'approved' | 'rejected', submittedAt: string, decidedAt?: string }
}

export type ClientConnections = {
  revision: number
  runtime?: { version: string, engine: 'cc-haha' | 'pi', engineVersion: string }
  workspace: string
  models: Record<string, { baseUrl: string, name: string, hasKey: boolean, imageInput?: boolean } | undefined>
  computerUse: boolean
  computerAvailable: boolean
  environment?: { name: string, url: string, dataCenter: string }
  miniProgramApiUrl?: string
  mcp?: { name: string, url: string, hasHeaders: boolean }
  management: string
  hasReleaseKey: boolean
  hasContextKey?: boolean
}

export type ModelSource = 'server' | 'personal'
export type PersonalModelProfile = { id: string, name: string, baseUrl: string, model: string, target: string }
export type DesktopModel = {
  revision: number
  source: ModelSource
  profileId: string | null
  hasApiKey: boolean
  configured: boolean
  profiles: PersonalModelProfile[]
}
export type DesktopModelUpdate = {
  revision: number
  source: ModelSource
  profileId?: string
  apiKey?: string
  clearApiKey?: boolean
  target?: string
}

export type UsageDays = 7 | 30
export type ClientKind = 'desktop' | 'web' | 'unknown'
export type UsageCounts = {
  input: number, output: number, cacheRead: number, cacheWrite: number, totalTokens: number,
  reportedCalls: number, unreportedCalls: number
}
export type UsageRow = UsageCounts & {
  day: string, actorId: string, actorName: string, clientId: string, clientKind: ClientKind, credentials: ModelSource
}
export type DesktopUsage = {
  days: UsageDays
  from: string
  through: string
  timezone: 'UTC'
  client: { id: string, kind: ClientKind }
  totals: Record<ModelSource, UsageCounts>
  rows: UsageRow[]
}

const clientStorageKey = 'pi-workbench-client-v1'
let pageClientId: string | undefined

function getClientId() {
  try {
    const stored = localStorage.getItem(clientStorageKey)
    if (stored && /^[a-f0-9]{64}$/.test(stored)) {
      pageClientId = stored
      return stored
    }
  } catch {
    // A restricted browser profile can still identify this page in memory.
  }

  if (!pageClientId) {
    try {
      const random = crypto.getRandomValues(new Uint8Array(32))
      pageClientId = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')
    } catch {
      return undefined
    }
  }

  try {
    localStorage.setItem(clientStorageKey, pageClientId)
  } catch {
    // Keep the page-scoped value if storage is unavailable.
  }
  return pageClientId
}

export class PiApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'PiApiError'
  }
}

export function errorText(error: unknown, fallback: string) {
  return error instanceof PiApiError && error.message ? error.message : fallback
}

export function createPiApi(token = '', csrf = '', onUnauthorized?: () => void) {
  async function request(path: string, method: string, body?: unknown, signal?: AbortSignal) {
    const headers = new Headers()
    const clientId = getClientId()
    if (clientId) headers.set('X-Pi-Client', clientId)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    if (csrf && !token && method !== 'GET') headers.set('X-CSRF-Token', csrf)
    if (body !== undefined && !(body instanceof FormData)) headers.set('Content-Type', 'application/json')

    const response = await fetch(path, {
      method, headers, signal,
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
      body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
    })
    if (!response.ok) {
      if (response.status === 401 && !signal?.aborted) onUnauthorized?.()
      const data = await response.json().catch(() => null) as { error?: unknown } | null
      throw new PiApiError(response.status, typeof data?.error === 'string' ? data.error : '')
    }
    return response
  }

  return {
    async get<T>(path: string, signal?: AbortSignal): Promise<T> {
      return (await request(path, 'GET', undefined, signal)).json() as Promise<T>
    },
    async write<T = unknown>(path: string, method: 'POST' | 'PUT' | 'PATCH', data?: unknown, signal?: AbortSignal): Promise<T> {
      const response = await request(path, method, data, signal)
      return response.status === 204 ? undefined as T : response.json() as Promise<T>
    },
    async download(path: string, filename: string) {
      // Use the native download path for a cookie session so large installers
      // can stream to disk. Manual bearer sessions need an authenticated fetch.
      const href = token ? URL.createObjectURL(await (await request(path, 'GET')).blob()) : path
      const link = document.createElement('a')
      link.href = href
      link.download = filename.split(/[\\/]/).pop() || filename
      document.body.append(link)
      link.click()
      link.remove()
      if (token) window.setTimeout(() => URL.revokeObjectURL(href), 60_000)
    },
  }
}

export type PiApi = ReturnType<typeof createPiApi>

export function taskPath(id: string) {
  return `/api/tasks/${encodeURIComponent(id)}`
}

export function isRequirementTask(task: TaskSummary | undefined) {
  return task?.agentId === 'requirements' || (!task?.agentId && task?.kind === 'research' && task.groupId === 'requirements')
}

export function defaultGroup(workbench: Workbench, agent: Agent | undefined) {
  const preferred = agent?.id === 'requirements' ? 'requirements' : agent?.category === 'office' ? 'general' : agent?.category
  return workbench.groups.find((group) => group.id === preferred)?.id ?? workbench.groups[0]?.id ?? ''
}
