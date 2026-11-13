import { afterEach, expect, it, vi } from 'vitest'
import { browserHost } from '../lib/desktopHost/browserHost'
import { installEnterpriseModelSync, useEnterpriseModelStore } from './enterpriseModelStore'

afterEach(() => {
  useEnterpriseModelStore.getState().clear()
  Reflect.deleteProperty(window, 'desktopHost')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('refreshes without opening settings and removes policy when the client goes offline', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const deviceId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const models = vi.fn()
    .mockResolvedValueOnce({ deviceId, revision: 3, expiresAt: new Date(Date.now() + 30_000).toISOString(), models: [] })
    .mockResolvedValueOnce({ deviceId, revision: 4, expiresAt: new Date(Date.now() + 55_000).toISOString(), models: [] })
    .mockRejectedValueOnce(new Error('disconnected'))
  window.desktopHost = {
    ...browserHost,
    enterprise: { models, enroll: vi.fn(), sync: vi.fn(), disconnect: vi.fn(), demand: vi.fn() },
  }
  const stop = installEnterpriseModelSync()!
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(useEnterpriseModelStore.getState().catalog?.revision).toBe(3)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(useEnterpriseModelStore.getState().catalog?.revision).toBe(4)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(useEnterpriseModelStore.getState().catalog).toBeNull()
  } finally { stop() }
})
