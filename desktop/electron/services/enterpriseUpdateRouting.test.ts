import { expect, it } from 'vitest'
import { enterpriseUpdateRequestAllowed } from './enterpriseUpdateRouting'

const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const feed = `/api/v1/updates/feed/${id}`

it('limits the device update token to check, manifest, safe Windows artifacts, and typed reports', () => {
  expect(enterpriseUpdateRequestAllowed('/api/v1/updates/check?platform=win32&arch=x64&currentVersion=0.7.7&channel=stable')).toBe(true)
  expect(enterpriseUpdateRequestAllowed(`${feed}/latest.yml`)).toBe(true)
  expect(enterpriseUpdateRequestAllowed(`${feed}/WorkBench%20Setup.exe`, { method: 'HEAD' })).toBe(true)
  expect(enterpriseUpdateRequestAllowed(`${feed}/WorkBench.exe`, { range: 'bytes=0-99' })).toBe(true)
  expect(enterpriseUpdateRequestAllowed('/api/v1/client/update-reports', { method: 'POST', body: { releaseId: id, eventId: id, stage: 'failed', errorCode: 'HASH_MISMATCH' } })).toBe(true)
  for (const path of ['//bad.invalid/api/v1/updates/check', '/api/v1/memories/scopes', `${feed}/..%2FWorkBench.exe`,
    `${feed}/CON.exe`, `${feed}/WorkBench.exe?redirect=https://bad.invalid`, `${feed}/latest.yml#hash`,
    '/api/v1/updates/check?platform=win32&arch=x64&currentVersion=0.7.7&platform=linux']) {
    expect(enterpriseUpdateRequestAllowed(path)).toBe(false)
  }
  expect(enterpriseUpdateRequestAllowed(`${feed}/WorkBench.exe`, { range: 'bytes=0-99,101-299' })).toBe(false)
})
