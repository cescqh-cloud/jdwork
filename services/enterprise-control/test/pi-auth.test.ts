import { describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { loadControlConfig } from '../src/config'
import { PiAuthenticator, type PiCredential } from '../src/pi-auth'

const origin = 'http://192.168.254.203:8787'
const piOrigin = 'http://192.168.254.203:8080'
const key = randomBytes(32).toString('base64url')
const tenantId = randomUUID()
const userId = randomUUID()
const firstInstance = randomUUID()
const baseEnv = {
  ENTERPRISE_DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1/enterprise_test',
  ENTERPRISE_REDIS_URL: 'redis://127.0.0.1:6379',
}
const intranetEnv = {
  ...baseEnv,
  ENTERPRISE_INTRANET_ORIGIN: origin,
  ENTERPRISE_PI_AUTH_ORIGIN: piOrigin,
  ENTERPRISE_PI_TENANT: 'liyuan',
  ENTERPRISE_PI_AUTH_ENCRYPTION_KEY: key,
  ENTERPRISE_HOST: '192.168.254.203',
  ENTERPRISE_PORT: '8787',
}
const piToken: PiCredential = { kind: 'token', value: 'fixture-pi-token-'.repeat(4) }
const piSession: PiCredential = { kind: 'session', value: 'a'.repeat(64) }

describe('explicit intranet identity configuration', () => {
  test('requires an explicitly pinned private IP, origin, listener and complete Pi setup', () => {
    expect(loadControlConfig(intranetEnv)).toMatchObject({
      origin, host: '192.168.254.203', port: 8787, localLogin: false,
      piAuth: { origin: piOrigin, tenant: 'liyuan' },
    })
    for (const changes of [
      { ENTERPRISE_INTRANET_ORIGIN: undefined },
      { ENTERPRISE_INTRANET_ORIGIN: 'http://example.com:8787' },
      { ENTERPRISE_INTRANET_ORIGIN: 'http://8.8.8.8:8787' },
      { ENTERPRISE_INTRANET_ORIGIN: 'http://0xc0a8feCB:8787' },
      { ENTERPRISE_INTRANET_ORIGIN: 'http://192.168.254.203.:8787' },
      { ENTERPRISE_INTRANET_ORIGIN: 'http://192.168.254.203:8787/path' },
      { ENTERPRISE_ORIGIN: 'http://192.168.254.204:8787' },
      { ENTERPRISE_HOST: '0.0.0.0' },
      { ENTERPRISE_HOST: '192.168.254.204' },
      { ENTERPRISE_PORT: '8788' },
      { ENTERPRISE_PI_AUTH_ORIGIN: 'http://192.168.254.204:8080' },
      { ENTERPRISE_PI_AUTH_ORIGIN: 'http://192.168.254.203:8080/path' },
      { ENTERPRISE_PI_TENANT: undefined },
      { ENTERPRISE_PI_AUTH_ENCRYPTION_KEY: undefined },
      { ENTERPRISE_PI_AUTH_ENCRYPTION_KEY: 'not-a-valid-encryption-key' },
      { ENTERPRISE_LOCAL_LOGIN: 'true' },
    ]) {
      expect(() => loadControlConfig({ ...intranetEnv, ...changes })).toThrow()
    }
  })

  test('keeps the existing development and HTTPS/OIDC defaults', () => {
    expect(loadControlConfig({ ...baseEnv, ENTERPRISE_LOCAL_LOGIN: 'true' })).toMatchObject({
      origin: 'http://127.0.0.1:8787', localLogin: true,
    })
    expect(() => loadControlConfig({ ...baseEnv, ENTERPRISE_ORIGIN: origin })).toThrow()
    expect(loadControlConfig({ ...baseEnv, ENTERPRISE_ORIGIN: 'https://control.example.test' })).toMatchObject({
      origin: 'https://control.example.test', localLogin: false,
    })
  })
})

describe('Pi credential verification', () => {
  test('uses only the pinned /api/me endpoint and sends the corresponding credential', async () => {
    const calls: { url: string, init: RequestInit }[] = []
    const verifier = new PiAuthenticator({ origin: piOrigin, tenant: 'liyuan', encryptionKey: Buffer.from(key, 'base64url') },
      async (url, init = {}) => {
        calls.push({ url: String(url), init })
        return Response.json({ identity: { id: 'admin', name: '管理员', admin: true, source: 'token' },
          authState: { instanceId: firstInstance } })
      })
    const identity = await verifier.probe(piToken)
    expect(identity).toMatchObject({ id: 'admin', admin: true, source: 'token', instanceId: firstInstance })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(piOrigin + '/api/me')
    expect(calls[0]!.init.redirect).toBe('error')
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer ' + piToken.value)
    expect(new Headers(calls[0]!.init.headers).has('cookie')).toBe(false)
  })

  test('supports existing Pi workbench /api/me responses without authState.instanceId', async () => {
    let active = true
    const verifier = new PiAuthenticator({ origin: piOrigin, tenant: 'liyuan', encryptionKey: Buffer.from(key, 'base64url') },
      async () => {
        if (!active) return new Response(null, { status: 401 })
        return Response.json({
          identity: { id: 'admin', name: '项目管理员', admin: true, source: 'token' },
          csrfToken: '',
          project: { id: 'default', name: '默认项目', description: '' },
        })
      })
    const identity = await verifier.probe(piToken)
    expect(identity).toEqual({ id: 'admin', name: '项目管理员', admin: true, source: 'token' })
    const sealed = verifier.seal({ credential: piToken, identity }, tenantId, userId)
    expect(await verifier.verify(sealed, tenantId, userId)).toEqual(identity)
    active = false
    await expect(verifier.verify(sealed, tenantId, userId)).rejects.toMatchObject({ status: 401 })
  })

  test('encrypts proofs, binds them to the account and detects revocation, demotion and restart', async () => {
    let active = true
    let isAdmin = true
    let instanceId = firstInstance
    const verifier = new PiAuthenticator({ origin: piOrigin, tenant: 'liyuan', encryptionKey: Buffer.from(key, 'base64url') },
      async (_url, init = {}) => {
        expect(new Headers(init.headers).get('cookie')).toBe('pi_session=' + piSession.value)
        if (!active) return new Response(null, { status: 401 })
        return Response.json({ identity: { id: 'dingtalk:corp:employee', name: '员工', admin: isAdmin,
          source: 'dingtalk', userId: 'employee' }, authState: { instanceId } })
      })
    const identity = await verifier.probe(piSession)
    const sealed = verifier.seal({ credential: piSession, identity }, tenantId, userId)
    expect(sealed).not.toContain(piSession.value)
    expect((await verifier.verify(sealed, tenantId, userId)).admin).toBe(true)
    await expect(verifier.verify(sealed, tenantId, randomUUID())).rejects.toMatchObject({ status: 401 })
    isAdmin = false
    await expect(verifier.verify(sealed, tenantId, userId)).rejects.toMatchObject({ status: 401 })
    isAdmin = true
    instanceId = randomUUID()
    await expect(verifier.verify(sealed, tenantId, userId)).rejects.toMatchObject({ status: 401 })
    instanceId = firstInstance
    active = false
    await expect(verifier.verify(sealed, tenantId, userId)).rejects.toMatchObject({ status: 401 })
  })

  test('fails closed for outage, redirect, invalid authState and invalid credentials', async () => {
    for (const response of [
      () => { throw new Error('network unavailable') },
      () => new Response(null, { status: 302, headers: { Location: 'http://unrelated.invalid/' } }),
      () => Response.json({ identity: { id: 'admin', name: '管理员', admin: true, source: 'token' }, authState: { instanceId: 'not-a-uuid' } }),
      () => Response.json({ identity: { id: 'someone-else', name: '员工', admin: true, source: 'dingtalk' },
        authState: { instanceId: firstInstance } }),
    ]) {
      const verifier = new PiAuthenticator({ origin: piOrigin, tenant: 'liyuan', encryptionKey: Buffer.from(key, 'base64url') },
        async () => response())
      await expect(verifier.probe(piToken)).rejects.toBeDefined()
    }
  })
})
