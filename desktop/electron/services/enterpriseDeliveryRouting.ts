import type { EnterpriseDeliveryIssue, EnterpriseDeliveryRequest, EnterpriseDeliveryRun } from '../../src/lib/desktopHost/enterpriseDelivery'
import type { DeliveryFile } from './enterpriseDeliveryWorkspace'

type CloudAction = Extract<EnterpriseDeliveryRequest, { action: 'list' | 'get' | 'getCheck' | 'review' | 'transition' }>
type Route = { route: string; method?: 'POST'; body?: Record<string, unknown>; headers?: Record<string, string>; responseLimit?: number }
const root = '/api/v1/deliveries'
const revisionHeader = (revision: number) => ({ 'If-Match': `"${revision}"` })

export function deliveryRoute(input: CloudAction): Route {
  switch (input.action) {
    case 'list': return { route: `${root}?limit=100${input.demandId ? '&demandId=' + input.demandId : ''}`, responseLimit: 512 * 1024 }
    case 'get': return { route: `${root}/${input.id}` }
    case 'getCheck': return { route: `${root}/${input.id}/checks/${input.runId}` }
    case 'review': return { route: `${root}/${input.id}/reviews`, method: 'POST', headers: revisionHeader(input.revision),
      body: { runId: input.runId, decision: input.decision, acknowledgeWarnings: input.acknowledgeWarnings, note: input.note } }
    case 'transition': return { route: `${root}/${input.id}/transition`, method: 'POST', headers: revisionHeader(input.revision), body: input.transition }
  }
}

export function deliveryBindRoute(id: string, revision: number, refs: { worktreeId: string; sessionId: string; gitRevision: string }): Route {
  return { route: `${root}/${id}/bind`, method: 'POST', headers: revisionHeader(revision), body: refs }
}

export function deliveryCheckRoute(id: string, revision: number, files: DeliveryFile[], selectionReceipt: string, idempotencyKey: string): Route {
  return { route: `${root}/${id}/checks`, method: 'POST',
    headers: { ...revisionHeader(revision), 'Idempotency-Key': idempotencyKey }, body: { files, selectionReceipt } }
}

export function deliveryMaterialsRoute(id: string, revision: number, runId: string, checksum: string | null): Route {
  return { route: `${root}/${id}/materials`, method: 'POST', headers: revisionHeader(revision), body: { runId, checksum } }
}

export function deliveryIssue(status?: number, code?: string): EnterpriseDeliveryIssue {
  if (code === 'DELIVERY_MATERIALS_UNVERIFIED') return 'materialsUnverified'
  if (code === 'DELIVERY_REVIEW_STALE') return 'materialsChanged'
  switch (status) {
    case 400: return 'invalid'
    case 401: return 'unbound'
    case 403: return 'forbidden'
    case 404: return 'notFound'
    case 409: return 'conflict'
    default: return 'unavailable'
  }
}

export function deliveryFixDraft(run: EnterpriseDeliveryRun, ruleId?: string) {
  const findings = run.findings.filter(finding => finding.status !== 'PASS' && (!ruleId || finding.ruleId === ruleId)).slice(0, 12)
  if (run.stale || !findings.length) return null
  const items = findings.map((finding, index) => {
    const refs = finding.evidence.map(item => item.path + (item.line ? `:${item.line}` : '')).join('、')
    return `${index + 1}. ${finding.ruleId} · ${finding.message}\n${finding.guidance}${refs ? '\n文件位置 ' + refs : ''}`
  })
  return [
    '请根据以下检查结果，在当前工作树准备整改。保留已批准的业务范围和验收条件。',
    `冻结版本 ${run.approvedVersionId}，检查输入 ${run.inputHash}。`,
    ...items,
    '完成后说明改动与验证结果，交由我重新提交检查。',
  ].join('\n\n').slice(0, 8000)
}
