import type { EnterpriseDemandIssue, EnterpriseDemandRequest } from '../../src/lib/desktopHost/enterpriseDemand'

export function enterpriseDemandRoute(input: EnterpriseDemandRequest): {
  route: string; method?: 'POST' | 'PATCH'; body?: Record<string, unknown>; timeoutMs?: number
} {
  const prefix = '/api/v1/demands'
  switch (input.action) {
    case 'list': return { route: `${prefix}?limit=30&offset=${input.offset ?? 0}` }
    case 'status':
    case 'templates': return { route: `${prefix}/${input.action}` }
    case 'create': return { route: prefix, method: 'POST', body: { draft: input.draft, idempotencyKey: input.idempotencyKey } }
    case 'get': return { route: `${prefix}/${input.id}` }
    case 'edit': return {
      route: `${prefix}/${input.id}`, method: 'PATCH',
      body: { expectedDraftRevision: input.expectedDraftRevision, draft: input.draft, idempotencyKey: input.idempotencyKey },
    }
    case 'precheck': return {
      route: `${prefix}/${input.id}/precheck`, method: 'POST', body: { expectedDraftRevision: input.expectedDraftRevision }, timeoutMs: 40_000,
    }
    case 'submit': return {
      route: `${prefix}/${input.id}/submit`, method: 'POST',
      body: { expectedDraftRevision: input.expectedDraftRevision, processCode: input.processCode, idempotencyKey: input.idempotencyKey, approverSelections: input.approverSelections },
    }
    case 'reconcile': return { route: `${prefix}/${input.id}/reconcile`, method: 'POST' }
  }
}

const demandIssues: Record<string, EnterpriseDemandIssue> = {
  DEMAND_FIELDS_INCOMPLETE: 'incomplete',
  DEMAND_PRECHECK_REQUIRED: 'incomplete',
  DEMAND_PRECHECK_UNAVAILABLE: 'precheck',
  DINGTALK_NOT_CONFIGURED: 'dingtalk',
  DINGTALK_TEMPLATE_NOT_ALLOWED: 'dingtalk',
  DINGTALK_IDENTITY_REQUIRED: 'identity',
  DEMAND_APPROVER_SELECTION: 'approvers',
  DEMAND_APPROVAL_IN_PROGRESS: 'inProgress',
  DEMAND_NEW_REVISION_REQUIRED: 'conflict',
  DEMAND_NOT_FOUND: 'notFound',
  DEMAND_CREDENTIALS_IN_DRAFT: 'sensitive',
}

export function enterpriseDemandIssue(status?: number, code?: string): EnterpriseDemandIssue {
  if (code && Object.hasOwn(demandIssues, code)) return demandIssues[code]!
  switch (status) {
    case 400: return 'invalid'
    case 401: return 'unbound'
    case 403: return 'forbidden'
    case 404: return 'notFound'
    case 409: return 'conflict'
    default: return 'unavailable'
  }
}
