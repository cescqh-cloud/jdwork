import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isWorkbenchNavigation, normalizeEnvironmentDefaults, normalizeWorkbenchOrigin, workbenchEntry } from './pi-workbench-policy'

describe('Pi enterprise desktop destinations', () => {
  it('accepts HTTPS and exact loopback HTTP by default', () => {
    assert.equal(normalizeWorkbenchOrigin(' https://pi.example.internal:8443/ '), 'https://pi.example.internal:8443')
    assert.equal(normalizeWorkbenchOrigin('http://127.0.0.1:8091'), 'http://127.0.0.1:8091')
    for (const url of ['http://192.168.1.3:8080', 'https://user:password@host', 'https://host/path', 'https://host/?x=y', 'file:///x', 'http://localhost.example.com']) {
      assert.throws(() => normalizeWorkbenchOrigin(url))
    }
  })
  it('accepts the packaged private HTTP address without trusting other hosts or ports', () => {
    const origin = 'http://192.168.22.3:8080'
    assert.equal(normalizeWorkbenchOrigin(origin + '/', origin), origin)
    for (const target of [
      'http://192.168.22.3:8081', 'http://192.168.22.4:8080', origin + '/desktop/',
      'http://user:secret@192.168.22.3:8080',
    ]) {
      assert.throws(() => normalizeWorkbenchOrigin(target, origin))
    }
    for (const target of ['http://10.example.com', 'http://172.32.1.2', 'http://8.8.8.8']) {
      assert.throws(() => normalizeWorkbenchOrigin(target, target))
    }
  })
  it('limits the top-level renderer to the chosen origin and DingTalk sign-in', () => {
    const origin = 'https://pi.example.internal'
    assert.equal(isWorkbenchNavigation(workbenchEntry(origin), origin), true)
    assert.equal(isWorkbenchNavigation('https://login.dingtalk.com/oauth2/auth?state=example', origin), true)
    for (const target of ['https://login.dingtalk.com.evil.example/', 'http://login.dingtalk.com/', 'file:///C:/secret', 'javascript:alert(1)', 'https://u@pi.example.internal/', 'https://pi.example.internal:444/']) {
      assert.equal(isWorkbenchNavigation(target, origin), false)
    }
  })
})

describe('packaged connections', () => {
  it('keeps the business browser and mini program endpoints separate and omits private fields', () => {
    const environment = { name: 'Sandbox UAT', url: 'http://192.168.22.3:8022/ierp/', password: 'fixture-password' }
    assert.deepEqual(normalizeEnvironmentDefaults({
      environment, miniProgramApiUrl: 'https://mini.example.internal/ext', appSecret: 'fixture-secret',
    }), {
      environment: { name: 'Sandbox UAT', url: 'http://192.168.22.3:8022/ierp/', dataCenter: '' },
      miniProgramApiUrl: 'https://mini.example.internal/ext',
    })
  })
  it('rejects embedded credentials, query parameters and cleartext mini program endpoints', () => {
    for (const url of ['https://user:secret@host/ext', 'https://host/ext?token=fixture', 'http://host/ext', 'file:///C:/fixture']) {
      assert.throws(() => normalizeEnvironmentDefaults({ miniProgramApiUrl: url }))
    }
  })
})
