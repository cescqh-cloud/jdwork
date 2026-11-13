import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPiApi } from './api'

const clientKey = 'pi-workbench-client-v1'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.removeItem(clientKey)
})

function requests() {
  const received: Headers[] = []
  vi.stubGlobal('fetch', async (_path: string, options?: RequestInit) => {
    received.push(new Headers(options?.headers))
    return Response.json({})
  })
  return received
}

describe('Pi workbench request identity', () => {
  it('adds a stable browser-profile ID while retaining bearer and cookie protections', async () => {
    const headers = requests()
    localStorage.setItem(clientKey, 'older-invalid-value')
    await createPiApi().get('/auth/config')
    await createPiApi('fixture-admin-token').write('/api/tasks', 'POST', { kind: 'research', prompt: 'Fixture' })
    await createPiApi('', 'fixture-csrf').write('/api/desktop/model', 'PUT', { source: 'server' })

    const id = localStorage.getItem(clientKey)
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(headers.map((header) => header.get('x-pi-client'))).toEqual([id, id, id])
    expect(headers[1]?.get('authorization')).toBe('Bearer fixture-admin-token')
    expect(headers[2]?.get('x-csrf-token')).toBe('fixture-csrf')
  })

  it('uses the same in-page ID if persistent storage is unavailable', async () => {
    const headers = requests()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Unavailable', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Unavailable', 'SecurityError') })
    await createPiApi().get('/api/desktop/model')
    await createPiApi().get('/api/desktop/usage?days=7')

    const id = headers[0]?.get('x-pi-client')
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(headers[1]?.get('x-pi-client')).toBe(id)
  })

  it('reuses the ID allocated by a same-origin legacy workbench', async () => {
    const headers = requests()
    const existing = 'ab'.repeat(32)
    localStorage.setItem(clientKey, existing)
    await createPiApi().get('/api/desktop/usage?days=30')

    expect(headers[0]?.get('x-pi-client')).toBe(existing)
    expect(localStorage.getItem(clientKey)).toBe(existing)
  })
})
