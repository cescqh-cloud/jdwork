import { expect, test } from 'bun:test'
import { draftInput } from '../src/demands/contract'
import { inspectDeliveryFiles, knowledgeReferenceKey } from '../src/delivery/review'
import { checkInput } from '../src/delivery/contract'

const basis = {
  demandNo: 'REQ-FIXTURE',
  approvedVersionId: '11111111-1111-4111-8111-111111111111',
  snapshotHash: 'a'.repeat(64),
  bindingId: '22222222-2222-4222-8222-222222222222',
  gitRevision: 'b'.repeat(40),
  draft: draftInput.parse({ title: '采购收货验收', category: '报表', systemKey: 'ERP', businessContext: '核对采购收货单字段',
    acceptanceCriteria: '收货组织和采购组织字段一致' }),
}
const valid = ['---', 'id: REQ-FIXTURE', 'title: 采购收货验收', 'kind: report', 'acceptanceCriteria:', '  - 收货组织和采购组织字段一致',
  '---', '核对测试输入的收货组织字段。'].join('\n')

test('freezes authorized files and emits reproducible PASS evidence for an approved requirement', () => {
  const files = [{ path: 'request.md', text: valid }, { path: 'context/demo.txt', text: 'test evidence' }]
  const review = inspectDeliveryFiles(basis, { files }, new Set(), '2026-11-10T08:00:00.000Z')
  const reordered = inspectDeliveryFiles(basis, { files: [...files].reverse() }, new Set(), '2026-11-10T08:05:00.000Z')
  expect(review.verdict).toBe('PASS')
  expect(review.inputHash).toBe(reordered.inputHash)
  expect(review.manifest.map(file => file.path)).toEqual(['context/demo.txt', 'request.md'])
  expect(review.findings.every(finding => finding.inputHash === review.inputHash && finding.ruleVersion === review.ruleVersion)).toBe(true)
  expect(inspectDeliveryFiles(basis, { files: [{ path: 'request.md', text: valid + '\n已修订' }] }, new Set()).inputHash).not.toBe(review.inputHash)
  const changedCriteria = { files: [{ path: 'request.md', text: valid.replace('收货组织和采购组织字段一致', '只要求页面打开') }] }
  expect(inspectDeliveryFiles(basis, changedCriteria, new Set()).findings.find(finding => finding.ruleId === 'domain.acceptance-alignment')?.status)
    .toBe('BLOCK')
})

test('blocks missing acceptance criteria and references without retaining sensitive input in evidence', () => {
  const files = [
    { path: 'request.md', text: valid.replace('  - 收货组织和采购组织字段一致', '').concat('\n[缺文件](evidence/missing.txt)') },
    { path: 'context/fixture.txt', text: 'api_key: fixture-private-key-value\n手机号: 10000000000' },
    { path: 'context/check.sql', text: 'UPDATE demo SET value = 1;' },
  ]
  const review = inspectDeliveryFiles(basis, { files }, new Set())
  expect(review.verdict).toBe('BLOCK')
  expect(review.findings.filter(finding => finding.status === 'BLOCK').map(finding => finding.ruleId))
    .toContain('structure.acceptance')
  expect(review.findings.filter(finding => finding.status === 'BLOCK').map(finding => finding.ruleId))
    .toContain('reference.files')
  expect(review.findings.filter(finding => finding.status === 'BLOCK').map(finding => finding.ruleId))
    .toContain('security.credentials')
  expect(review.findings.filter(finding => finding.status === 'BLOCK').map(finding => finding.ruleId))
    .toContain('security.sql-change')
  expect(JSON.stringify(review)).not.toContain('fixture-private-key-value')
  expect(JSON.stringify(review)).not.toContain('10000000000')
})

test('requires a supplier approval threshold and current authorized citations', () => {
  const supplier = { ...basis, draft: { ...basis.draft, category: '供应商准入' } }
  const reference = { documentId: '33333333-3333-4333-8333-333333333333', revision: 3, checksum: 'c'.repeat(64) }
  const check = { files: [{ path: 'request.md', text: valid }], knowledgeRefs: [reference] }
  const denied = inspectDeliveryFiles(supplier, check, new Set())
  expect(denied.findings.find(finding => finding.ruleId === 'domain.amount-threshold')?.status).toBe('BLOCK')
  expect(denied.findings.find(finding => finding.ruleId === 'reference.knowledge')?.status).toBe('BLOCK')
  const fixed = { files: [{ path: 'request.md', text: valid.replace('kind: report', 'kind: report\napprovalAmountThreshold: 12000') }], knowledgeRefs: [reference] }
  const ready = inspectDeliveryFiles(supplier, fixed, new Set([knowledgeReferenceKey(reference)]))
  expect(ready.verdict).toBe('PASS')
})

test('rejects absolute/traversal file labels and bounded input before inspection', () => {
  const text = 'fixture'
  expect(checkInput.safeParse({ files: [{ path: 'C:/Users/sample.txt', text }] }).success).toBe(false)
  expect(checkInput.safeParse({ files: [{ path: '../sample.txt', text }] }).success).toBe(false)
  expect(checkInput.safeParse({ files: [{ path: 'context/fixture.txt', text: '测试'.repeat(3100) }] }).success).toBe(false)
})

test('blocks unchecked DROP and DELETE in submitted SQL materials without running them', () => {
  const cases = [
    { path: 'context/schema.sql', text: 'DROP TABLE fixture_only;', line: 1 },
    { path: 'analysis.md', text: '示例草案\n```sql\nDELETE FROM fixture_only;\n```', line: 3 },
  ]
  for (const { line, ...file } of cases) {
    const review = inspectDeliveryFiles(basis, { files: [{ path: 'request.md', text: valid }, file] }, new Set())
    expect(review.verdict).toBe('BLOCK')
    expect(review.findings.find(item => item.ruleId === 'security.sql-change')).toMatchObject({ status: 'BLOCK', evidence: [{ path: file.path, line }] })
  }
  const readOnly = inspectDeliveryFiles(basis, { files: [{ path: 'request.md', text: valid }, { path: 'context/query.sql', text: 'SELECT count(*) FROM fixture_only;' }] }, new Set())
  expect(readOnly.findings.find(item => item.ruleId === 'security.sql-change')?.status).toBe('PASS')
})
