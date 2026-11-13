import type { EnterpriseMemoryIssue, EnterpriseMemoryRequest } from '../../src/lib/desktopHost/enterpriseMemory'

export function enterpriseMemoryRoute(input: EnterpriseMemoryRequest): {
  route: string; method?: 'POST' | 'PATCH' | 'DELETE'; body?: Record<string, unknown>
  headers?: Record<string, string>; responseLimit?: number
} {
  const memory = '/api/v1/memories'
  const knowledge = '/api/v1/knowledge'
  switch (input.action) {
    case 'changes': return { route: `${memory}/changes?cursor=${input.cursor}`, responseLimit: 2 * 1024 * 1024 }
    case 'scopes':
    case 'candidates': return { route: `${memory}/${input.action}` }
    case 'searchMemory': return { route: `${memory}/search`, body: { query: input.query, scope: input.scope, limit: 30 } }
    case 'searchKnowledge': return { route: `${knowledge}/search`, body: { query: input.query, limit: 30 } }
    case 'getMemory': return { route: `${memory}/${input.id}` }
    case 'getKnowledge': return { route: `${knowledge}/${input.id}?revision=${input.revision}` }
    case 'create': return {
      route: `${memory}/candidates`, body: { body: input.body, scope: input.scope, projectId: input.projectId, departmentId: input.departmentId, sourceRef: input.sourceRef },
      headers: { 'Idempotency-Key': input.idempotencyKey },
    }
    case 'edit': return {
      route: `${memory}/${input.id}`, method: 'PATCH', body: { body: input.body }, headers: { 'If-Match': `"${input.revision}"` },
    }
    case 'publish': return { route: `${memory}/${input.id}/publish`, method: 'POST', headers: { 'If-Match': `"${input.revision}"` } }
    case 'delete': return { route: `${memory}/${input.id}`, method: 'DELETE', headers: { 'If-Match': `"${input.revision}"` } }
  }
}

export function enterpriseMemoryIssue(status?: number, code?: string): EnterpriseMemoryIssue {
  if (code === 'MEMORY_SYNC_REQUIRED') return 'reset'
  if (code === 'MEMORY_SENSITIVE_CONTENT') return 'sensitive'
  switch (status) {
    case 400: return 'invalid'
    case 401: return 'unbound'
    case 403: return 'forbidden'
    case 404:
    case 410: return 'notFound'
    case 409: return 'conflict'
    default: return 'unavailable'
  }
}
