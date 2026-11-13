import { describe, expect, test } from 'bun:test'
import {
  enterpriseDeviceFromProviderId, enterpriseModelPaths, isEnterpriseProviderId,
  parseEnterpriseGrantInput, parseEnterpriseModelCatalog,
} from './enterpriseModels.js'

const device = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const expiresAt = '2026-11-10T08:00:00.000Z'
const row = {
  providerId: 'provider-a', modelId: 'model-a', displayName: 'Fixture',
  protocol: 'anthropic', capabilities: ['text', 'tools'], contextWindow: 1000, maxOutputTokens: 128,
  defaultEffort: null, proxyEndpoint: enterpriseModelPaths.anthropic, projectId: null, isDefault: true,
  quota: { dailyTokens: 1000, softDailyTokens: null },
}

describe('enterprise model catalog identity', () => {
  test('namespaces model identities per bound device and removes vendor credentials', () => {
    const input = { revision: 1, expiresAt, models: [{ ...row, accessToken: 'redact-me' }] }
    const catalog = parseEnterpriseModelCatalog(input, device)!
    expect(catalog.models[0]?.providerId).toBe(`enterprise:${device}:provider-a`)
    expect(enterpriseDeviceFromProviderId(catalog.models[0]!.providerId)).toBe(device)
    expect(JSON.stringify(catalog)).not.toContain('redact-me')
    expect(parseEnterpriseModelCatalog(catalog, device, true)).toEqual(catalog)
    expect(parseEnterpriseModelCatalog(catalog, 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', true)).toBeNull()
    expect(enterpriseDeviceFromProviderId('personal-provider')).toBeNull()
    expect(isEnterpriseProviderId('personal-provider')).toBe(false)
  })

  test('rejects a wrong endpoint, malformed scope and duplicate identities', () => {
    expect(parseEnterpriseModelCatalog({ revision: 1, expiresAt, models: [{ ...row, proxyEndpoint: 'https://fixture.invalid/' }] }, device)).toBeNull()
    expect(parseEnterpriseModelCatalog({ revision: 1, expiresAt, models: [{ ...row, proxyEndpoint: enterpriseModelPaths.openai }] }, device)).toBeNull()
    expect(parseEnterpriseModelCatalog({ revision: 1, expiresAt, models: [row, row] }, device)).toBeNull()
    const input = { providerId: `enterprise:${device}:provider-a`, modelId: 'model-a', protocol: 'anthropic', sessionId: 'session-a' }
    expect(parseEnterpriseGrantInput(input)).toEqual(input)
    expect(parseEnterpriseGrantInput({ ...input, providerId: `enterprise:${device}:/traversal` })).toBeNull()
    expect(parseEnterpriseGrantInput({ ...input, sessionId: '../session-a' })).toBeNull()
    expect(parseEnterpriseGrantInput({ ...input, projectId: 'other-project' })).toBeNull()
  })

  test('projects a typed ERP capability and defaults existing model entries to disabled', () => {
    const catalog = (item: Record<string, unknown>) => parseEnterpriseModelCatalog({ revision: 1, expiresAt, models: [item] }, device)
    expect(catalog(row)?.models[0]?.canQueryErp).toBe(false)
    expect(catalog({ ...row, canQueryErp: true, erpCredential: 'fixture-private' })?.models[0]?.canQueryErp).toBe(true)
    expect(catalog({ ...row, canQueryErp: 'true' })).toBeNull()
    expect(JSON.stringify(catalog({ ...row, canQueryErp: true, erpCredential: 'fixture-private' }))).not.toContain('fixture-private')
  })
})
