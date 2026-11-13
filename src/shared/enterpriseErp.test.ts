import { expect, test } from 'bun:test'
import { enterpriseErpProviderCode, parseEnterpriseErpInput, parseEnterpriseErpResult, type EnterpriseErpQuery } from './enterpriseErp.js'

const device = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const projectId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const otherProject = 'cccccccc-cccc-4ccc-accc-cccccccccccc'
const scope = { providerId: `enterprise:${device}:fixture-cloud`, modelId: 'fixture-model', sessionId: 'fixture-session' }
const read = { action: 'read', projectId, environmentId: 'xh-test', operation: 'receipt', number: 'FIXTURE-001' } as const
const result = {
  requestId: device, projectId, environmentId: 'xh-test', environmentName: '模拟采购测试',
  mode: 'test', operation: 'receipt', checkedAt: '2026-11-10T08:00:00.000Z',
  query: { id: 'receipt', label: '收货查询', kind: 'document', requiresNumber: true, columns: [{ key: 'status', title: '状态' }] },
  rows: [{ status: '待收货', raw: { accessToken: 'never-projected' }, password: 'never-projected' }], truncated: false,
}

test('limits ERP arguments to known identifiers and keeps the provider/device scope internal', () => {
  expect(enterpriseErpProviderCode(scope.providerId)).toBe('fixture-cloud')
  expect(enterpriseErpProviderCode(`enterprise:${device}:hidden:provider`)).toBeNull()
  expect(parseEnterpriseErpInput({ ...scope, ...read })).toEqual({ ...scope, ...read })
  for (const candidate of [
    { ...scope, ...read, url: 'https://example.invalid' },
    { ...scope, ...read, modelGrant: 'foreign-grant' },
    { ...scope, ...read, providerId: 'personal' },
    { ...scope, ...read, modelProjectId: otherProject },
    { ...scope, ...read, action: 'write' },
  ]) expect(parseEnterpriseErpInput(candidate)).toBeNull()
})

test('projects only declared scalar fields and rejects an unrelated or production response', () => {
  const reply = { action: 'read', result, token: 'never-projected' }
  const parsed = parseEnterpriseErpResult(reply, read)
  expect(parsed).toMatchObject({ action: 'read', result: { rows: [{ status: '待收货' }] } })
  expect(JSON.stringify(parsed)).not.toContain('never-projected')
  for (const input of [
    { ...read, projectId: otherProject }, { ...read, operation: 'another' }, { ...read, environmentId: 'other' },
    { ...read, number: undefined },
  ]) expect(parseEnterpriseErpResult(reply, input)).toBeNull()
  for (const invalid of [
    { ...result, mode: 'production' }, { ...result, rows: Array(11).fill({ status: '待收货' }) },
    { ...result, query: { ...result.query, columns: [{ key: 'accessToken', title: '字段' }] } },
  ]) expect(parseEnterpriseErpResult({ action: 'read', result: invalid }, read)).toBeNull()
})

test('limits discovery to a pinned model project and strips backend metadata', () => {
  const list: EnterpriseErpQuery = { action: 'list' }
  const config = { id: 'xh-test', name: '模拟采购测试', mode: 'sandbox', secret: 'hidden',
    projects: [{ id: projectId, name: '采购项目', writeApprovalEnabled: true }],
    queries: [{ id: 'receipt', label: '收货查询', kind: 'document', requiresNumber: true, path: '/kapi/fixture/receipt' }] }
  const answer = parseEnterpriseErpResult({ action: 'list', environments: [config] }, { ...list, modelProjectId: projectId })
  expect(answer).toEqual({ action: 'list', environments: [{ id: 'xh-test', name: '模拟采购测试', mode: 'sandbox',
    projects: [{ id: projectId, name: '采购项目' }], queries: [{ id: 'receipt', label: '收货查询', kind: 'document', requiresNumber: true }],
  }] })
  expect(parseEnterpriseErpResult({ action: 'list', environments: [config] }, { ...list, modelProjectId: otherProject })).toBeNull()
})
