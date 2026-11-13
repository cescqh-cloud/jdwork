import { describe, expect, mock, test } from 'bun:test'
import { createControlApp } from '../src/app'
import type { PiCredential } from '../src/pi-auth'
import type { ControlStore } from '../src/store'

const origin = 'http://192.168.254.203:8787'
const token = 'fixture-admin-token-'.repeat(3)
const session = 'a'.repeat(64)

describe('Pi console sign-in', () => {
  test('validates the console origin before accepting a token or upstream cookie', async () => {
    const authenticate = mock(async (_credential: PiCredential) => ({
      accessToken: 'b'.repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }))
    const store = { signInPi: authenticate } as unknown as ControlStore
    const app = createControlApp(store, { origin, localLogin: false, piAuth: { tenant: 'liyuan' },
      async allowLoginAttempt() { return true }, notify() {}, async health() { return { redis: true } } })
    const landing = await app.request(origin + '/')
    expect(await landing.text()).toContain('/console/pi-token')
    const denied = await app.request(origin + '/console/pi-token', {
      method: 'POST', headers: { Origin: 'http://other.invalid' }, body: new URLSearchParams({ token }),
    })
    expect(denied.status).toBe(403)
    expect(authenticate).not.toHaveBeenCalled()
    const signedIn = await app.request(origin + '/console/pi-token', {
      method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ token, role: 'platform_admin' }),
    })
    expect(signedIn.status).toBe(303)
    expect(signedIn.headers.getSetCookie()[0]).toContain('enterprise-dev-session=')
    expect(authenticate.mock.calls[0]).toEqual([{ kind: 'token', value: token }])
    const cookieLogin = await app.request(origin + '/console/pi-session', {
      method: 'POST', headers: { Origin: origin, Cookie: 'pi_session=' + session },
    })
    expect(cookieLogin.status).toBe(303)
    expect(authenticate.mock.calls[1]).toEqual([{ kind: 'session', value: session }])
  })

  test('does not expose Pi login when the mode is disabled', async () => {
    const store = {} as ControlStore
    const app = createControlApp(store, { origin: 'https://control.example.test', localLogin: false,
      async allowLoginAttempt() { return true }, notify() {}, async health() { return { redis: true } } })
    expect(await (await app.request('https://control.example.test/')).text()).not.toContain('/console/pi-token')
    expect((await app.request('https://control.example.test/console/pi-token', { method: 'POST',
      headers: { Origin: 'https://control.example.test' }, body: new URLSearchParams({ token }) })).status).toBe(404)
  })
})
