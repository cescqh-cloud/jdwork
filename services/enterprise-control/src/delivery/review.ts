import { z } from 'zod'
import { tokenDigest } from '../contract'
import { evidenceHash, redactDemandText, validateDemand, type DemandDraft } from '../demands/contract'
import type { CheckInput, KnowledgeReference } from './contract'

export const deliveryRuleVersion = 'delivery-v1'
export type Verdict = 'PASS' | 'WARN' | 'BLOCK'

export interface ReviewBasis {
  demandNo: string
  draft: DemandDraft
  approvedVersionId: string
  snapshotHash: string
  bindingId: string
  gitRevision: string
}

interface Evidence {
  path: string
  line?: number
  sha256?: string
}

const frontmatter = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(160),
  kind: z.enum(['general', 'report', 'erp-requirement', 'supplier-approval']),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(20).nullable().optional(),
  approvalAmountThreshold: z.number().finite().positive().optional(),
  sqlImpact: z.object({
    environment: z.literal('test'), expectedRows: z.number().int().min(0).max(100_000),
    rollbackPlan: z.string().trim().min(1).max(500),
  }).optional(),
})

export function redactDeliveryText(text: string) {
  return redactDemandText(text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, '[私钥已脱敏]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[令牌已脱敏]')
    .replace(/((?:身份证号?|手机号|护照号|银行卡号|家庭住址)\s*[:=：]\s*)\S{4,}/gu, '$1[已脱敏]')
}

export function knowledgeReferenceKey(ref: KnowledgeReference) {
  return `${ref.documentId}:${ref.revision}:${ref.checksum}`
}

function parseRequest(text: string) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
  const header = match?.[1]
  if (!header || header.length > 4096 || /(?:^|[\s:[{,])[&*!][A-Za-z0-9_-]/u.test(header)) return undefined
  try {
    const result = frontmatter.safeParse(Bun.YAML.parse(header))
    return result.success ? result.data : undefined
  } catch { return undefined }
}

function normalizedPath(path: string) {
  return path.normalize('NFKC').toLowerCase()
}

function lineNumber(text: string, index: number) {
  return text.slice(0, index).split('\n').length
}

function acceptanceLine(text: string) {
  return text.normalize('NFKC').trim().replace(/^(?:[-*•]\s+|\d+[.)、]\s*)/u, '').replace(/\s+/gu, ' ').trim()
}

const writeSql = /\b(?:INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|MERGE\s+INTO|DROP\s+\w+|ALTER\s+\w+|CREATE\s+(?:TABLE|INDEX|VIEW|FUNCTION|PROCEDURE|TRIGGER)|TRUNCATE\b|GRANT\b|REVOKE\b|CALL\s+\w+|EXEC(?:UTE)?\s+\w+|COPY\s+\w+|SELECT[^;\r\n]+\bINTO\b)/iu

export function inspectDeliveryFiles(basis: ReviewBasis, input: CheckInput, authorizedKnowledge: ReadonlySet<string>, detectedAt = new Date().toISOString()) {
  const manifest = input.files.map(file => ({ path: file.path, sha256: tokenDigest(file.text), text: redactDeliveryText(file.text) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.sha256.localeCompare(right.sha256))
  const refs = [...(input.knowledgeRefs ?? [])].sort((left, right) => knowledgeReferenceKey(left).localeCompare(knowledgeReferenceKey(right)))
  const inputHash = evidenceHash({ approvedVersionId: basis.approvedVersionId, snapshotHash: basis.snapshotHash,
    bindingId: basis.bindingId, gitRevision: basis.gitRevision, files: manifest.map(({ path, sha256 }) => ({ path, sha256 })), refs })
  const findings: { ruleId: string, status: Verdict, severity: 'info' | 'warning' | 'critical', message: string, guidance: string,
    evidence: Evidence[], ruleVersion: string, inputHash: string, detectedAt: string }[] = []
  function finding(ruleId: string, status: Verdict, message: string, guidance: string, evidence: Evidence[] = []) {
    findings.push({ ruleId, status, severity: status === 'BLOCK' ? 'critical' : status === 'WARN' ? 'warning' : 'info',
      message, guidance, evidence: evidence.slice(0, 12), ruleVersion: deliveryRuleVersion, inputHash, detectedAt })
  }
  const paths = new Set(manifest.map(file => normalizedPath(file.path)))
  const request = input.files.find(file => normalizedPath(file.path) === 'request.md')
  const requestEvidence = { path: 'request.md', line: 1, ...(request ? { sha256: tokenDigest(request.text) } : {}) }
  const requestData = request ? parseRequest(request.text) : undefined
  finding('structure.file-manifest', paths.size === manifest.length ? 'PASS' : 'BLOCK',
    paths.size === manifest.length ? '文件路径唯一。' : '文件路径重复。', '提交同一工作树中路径唯一的材料。')
  finding('structure.request', requestData ? 'PASS' : 'BLOCK',
    requestData ? '需求文件的结构可读取。' : '需求文件或 YAML 头缺失，或字段格式无效。', '补充 request.md 的编号、标题、类型和验收标准。', [requestEvidence])
  const localAcceptance = requestData?.acceptanceCriteria ?? []
  const acceptanceComplete = localAcceptance.length > 0 && new Set(localAcceptance).size === localAcceptance.length
  finding('structure.acceptance', acceptanceComplete ? 'PASS' : 'BLOCK',
    acceptanceComplete ? '文件包含可逐项核对的验收标准。' : '文件中的验收标准缺失或重复。', '在 acceptanceCriteria 写入可核验的条目。', [requestEvidence])
  const frozen = validateDemand(basis.draft)
  const approvedComplete = !frozen.missing.length && Boolean(basis.draft.acceptanceCriteria)
  const aligned = requestData?.id === basis.demandNo && requestData.title === basis.draft.title
  finding('domain.approved-scope', aligned && approvedComplete ? 'PASS' : 'BLOCK',
    aligned && approvedComplete ? '文件编号和标题与已批准版本一致。' : '文件标识与已批准版本不符，或已批准版本缺少必需业务信息。',
    '用当前冻结需求的编号和标题。若改变业务范围或补充批准条件，请发起需求变更审批。', [requestEvidence])
  const approvedCriteria = new Set(basis.draft.acceptanceCriteria.split(/\r?\n/u).map(acceptanceLine).filter(Boolean))
  const fileCriteria = new Set(localAcceptance.map(acceptanceLine).filter(Boolean))
  const acceptanceAligned = approvedCriteria.size > 0 && approvedCriteria.size === fileCriteria.size &&
    [...approvedCriteria].every(criteria => fileCriteria.has(criteria))
  finding('domain.acceptance-alignment', acceptanceAligned ? 'PASS' : 'BLOCK',
    acceptanceAligned ? '文件验收标准与批准版本一致。' : '文件验收标准与批准版本不一致。',
    '保留冻结版本的验收标准。业务条件改变时，提交需求变更审批。', [requestEvidence])
  const supplier = requestData?.kind === 'supplier-approval' || /供应商(?:准入|审批)|supplier\s+(?:approval|onboarding)/iu
    .test(basis.draft.category + ' ' + basis.draft.title)
  if (supplier) {
    finding('domain.amount-threshold', requestData?.approvalAmountThreshold ? 'PASS' : 'BLOCK',
      requestData?.approvalAmountThreshold ? '供应商审批金额阈值已声明。' : '供应商审批缺少金额阈值。',
      '补齐业务确认的正数审批阈值，并由审核人核对口径。', [requestEvidence])
  }

  const sensitive = input.files.flatMap(file => {
    const index = file.text.split(/\r?\n/u).findIndex(line => redactDeliveryText(line) !== line)
    return redactDeliveryText(file.text) !== file.text ? [{ path: file.path, line: Math.max(1, index + 1), sha256: tokenDigest(file.text) }] : []
  })
  if (Object.values(basis.draft).some(value => typeof value === 'string' && redactDeliveryText(value) !== value)) {
    sensitive.push({ path: 'approved-demand', line: 1, sha256: basis.snapshotHash })
  }
  finding('security.credentials', sensitive.length ? 'BLOCK' : 'PASS',
    sensitive.length ? '检测到疑似凭据或敏感字段，已遮盖。' : '提交材料通过常见凭据和敏感字段筛查。',
    '清除凭据和个人敏感字段后重新提交。', sensitive)
  const sqlEvidence: Evidence[] = []
  for (const file of input.files) {
    const scripts = /\.sql$/iu.test(file.path) ? [{ text: file.text, index: 0 }] :
      Array.from(file.text.matchAll(/\x60\x60\x60sql[^\r\n]*\r?\n([\s\S]*?)\x60\x60\x60/giu), match => ({
        text: match[1] ?? '', index: match.index + match[0].indexOf('\n') + 1,
      }))
    for (const script of scripts) {
      const match = writeSql.exec(script.text)
      if (match) sqlEvidence.push({ path: file.path, line: lineNumber(file.text, script.index + match.index), sha256: tokenDigest(file.text) })
    }
  }
  finding('security.sql-change', sqlEvidence.length ? requestData?.sqlImpact ? 'WARN' : 'BLOCK' : 'PASS',
    sqlEvidence.length ? '材料含可能写入或变更结构的 SQL。' : '提交的 SQL 片段未命中变更语句筛查。',
    '需明确测试环境、预估影响行数和回滚计划，并走独立的操作授权。', sqlEvidence)

  const missingFiles: Evidence[] = []
  const external: Evidence[] = []
  for (const file of input.files.filter(item => /\.md$/iu.test(item.path))) {
    for (const match of file.text.matchAll(/\[[^\]\r\n]*\]\(([^)\r\n]+)\)/gu)) {
      const target = match[1]?.trim().split('#', 1)[0]
      if (!target) continue
      const evidence = { path: file.path, line: lineNumber(file.text, match.index), sha256: tokenDigest(file.text) }
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)) external.push(evidence)
      else {
        const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : ''
        if (!paths.has(normalizedPath(folder + target.replace(/^\.\//u, '')))) missingFiles.push(evidence)
      }
    }
  }
  finding('reference.files', missingFiles.length ? 'BLOCK' : 'PASS',
    missingFiles.length ? '材料引用了未提交的文件。' : '本次可核对的相对文件引用齐全。', '提交相应的授权文本或修正引用路径。', missingFiles)
  if (external.length) finding('reference.external', 'WARN', '外部链接待人工核对。', '由审核人核对来源和访问范围。', external)
  const unknownKnowledge = refs.filter(ref => !authorizedKnowledge.has(knowledgeReferenceKey(ref)))
  finding('reference.knowledge', unknownKnowledge.length ? 'BLOCK' : 'PASS',
    unknownKnowledge.length ? '存在无法核对的知识引用。' : '已核对本次提交的结构化知识引用。',
    '使用当前授权且已发布的知识编号、修订和校验值。')

  const verdict: Verdict = findings.some(result => result.status === 'BLOCK') ? 'BLOCK' :
    findings.some(result => result.status === 'WARN') ? 'WARN' : 'PASS'
  return { verdict, ruleVersion: deliveryRuleVersion, inputHash, manifest, knowledgeRefs: refs, findings }
}

export type DeliveryInspection = ReturnType<typeof inspectDeliveryFiles>
