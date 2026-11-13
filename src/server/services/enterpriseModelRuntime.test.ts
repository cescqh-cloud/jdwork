import { expect, test } from 'bun:test'
import { enterpriseModelPaths, type EnterpriseModel } from '../../shared/enterpriseModels.js'
import { EnterpriseModelRuntime } from './enterpriseModelRuntime.js'

const officeOrigin = 'http://192.168.254.203:8081'
const model: EnterpriseModel = {
  providerId: 'enterprise:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa:company',
  modelId: 'fixture-model',
  displayName: 'Fixture model',
  protocol: 'openai',
  capabilities: ['text', 'tools'],
  contextWindow: 64000,
  maxOutputTokens: 1024,
  defaultEffort: null,
  proxyEndpoint: enterpriseModelPaths.openai,
  projectId: null,
  isDefault: true,
  quota: { dailyTokens: null, softDailyTokens: null },
}

test('a model grant permits only the explicitly configured office HTTP origin', async () => {
  let target = officeOrigin
  const broker = { origin: 'http://127.0.0.1:18877', secret: 'x'.repeat(43) }
  const fetchBroker = (async () => Response.json({
    origin: target,
    accessToken: 'fixture-token-with-at-least-twenty-characters',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    proxyEndpoint: model.proxyEndpoint,
  })) as typeof fetch

  const withoutOffice = new EnterpriseModelRuntime(broker, fetchBroker)
  expect(await withoutOffice.grant(model, 'session-one')).toBeNull()

  const withOffice = new EnterpriseModelRuntime({ ...broker, officeOrigin }, fetchBroker)
  expect(await withOffice.grant(model, 'session-one')).toMatchObject({ origin: officeOrigin })

  for (const other of ['http://192.168.254.203:8080', 'http://192.168.254.204:8787', 'http://example.com:8787']) {
    target = other
    expect(await withOffice.grant(model, 'session-one')).toBeNull()
  }
  target = officeOrigin
  const arbitraryOffice = new EnterpriseModelRuntime({ ...broker, officeOrigin: 'http://example.com:8787' }, fetchBroker)
  expect(await arbitraryOffice.grant(model, 'session-one')).toBeNull()
})
