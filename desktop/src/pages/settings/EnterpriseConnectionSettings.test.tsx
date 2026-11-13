import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { browserHost } from '@/lib/desktopHost/browserHost'
import type { DesktopEnterpriseHost, EnterpriseConnection } from '@/lib/desktopHost/enterprise'
import { DEFAULT_IDLE_POWER_SETTINGS } from '@/lib/idlePower'
import { useOpenTargetStore } from '@/stores/openTargetStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { EnterpriseConnectionSettings } from './EnterpriseConnectionSettings'
import { GeneralSettings } from './GeneralSettings'

vi.mock('@/lib/desktopNotifications', () => ({
  getDesktopNotificationPermission: async () => 'unsupported',
  getDesktopNotificationPlatform: () => 'other',
  notifyDesktop: vi.fn(),
  openDesktopNotificationSettings: vi.fn(),
  requestDesktopNotificationPermission: async () => 'unsupported',
}))

const origin = 'https://control.example.test'
const officeOrigin = 'http://192.168.254.203:8081'
const challenge = 'b'.repeat(43)
const disconnected = { origin: null, state: 'disconnected' } as const
const connected: EnterpriseConnection = {
  origin, state: 'connected',
  bootstrap: {
    user: { id: 'worker-id', displayName: '测试员工', roles: ['member'] },
    device: { id: 'device-1', platform: 'win32', clientVersion: '0.7.7' },
    policy: {
      revision: 2,
      expiresAt: '2026-11-10T12:00:00Z',
      features: { demands: true, models: false, memories: false, updates: false },
    },
    cursor: 3,
  },
}

describe('native enterprise connection settings', () => {
  const host = {
    enroll: vi.fn<DesktopEnterpriseHost['enroll']>(),
    sync: vi.fn<DesktopEnterpriseHost['sync']>(),
    disconnect: vi.fn<DesktopEnterpriseHost['disconnect']>(),
    models: vi.fn<DesktopEnterpriseHost['models']>().mockResolvedValue(null),
    demand: async () => ({ ok: false, issue: 'unavailable' } as const),
  }

  beforeEach(() => {
    localStorage.clear()
    host.enroll.mockReset().mockResolvedValue(connected)
    host.sync.mockReset().mockResolvedValue(disconnected)
    host.disconnect.mockReset().mockResolvedValue(disconnected)
    window.desktopHost = {
      ...browserHost, kind: 'electron', isDesktop: true, enterprise: host,
      power: {
        ...browserHost.power,
        getIdleActionState: async () => ({
          settings: { ...DEFAULT_IDLE_POWER_SETTINGS },
          capabilities: { lock: false, sleep: false, hibernate: false, shutdown: false },
          countdown: null, lastAction: null, notice: null,
        }),
      },
    }
    useSettingsStore.setState({ locale: 'zh', fetchOutputStyles: async () => {}, fetchAppMode: async () => {} })
    useOpenTargetStore.setState({ ensureTargets: async () => {} })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'desktopHost')
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useOpenTargetStore.setState(useOpenTargetStore.getInitialState(), true)
  })

  it('places the enterprise connection on the native General settings page', async () => {
    await act(async () => { render(<GeneralSettings />) })
    expect(screen.getByRole('heading', { name: '企业连接' })).toBeVisible()
  })

  it('binds, displays policy, refreshes and disconnects', async () => {
    render(<EnterpriseConnectionSettings />)
    const code = await screen.findByLabelText(/^一次性绑定码/)
    expect(code).toHaveAttribute('type', 'password')
    expect(screen.getByRole('status', { name: '连接状态' })).toHaveTextContent('未绑定')
    fireEvent.change(screen.getByLabelText(/^企业服务器地址/), { target: { value: origin } })
    fireEvent.change(code, { target: { value: challenge } })
    fireEvent.click(screen.getByRole('button', { name: '绑定本机' }))
    expect(host.enroll).toHaveBeenCalledWith({ origin, challenge })
    expect(await screen.findByText('测试员工')).toBeVisible()
    expect(screen.getByText('device-1')).toBeVisible()
    expect(screen.getByText('业务需求 · 已启用')).toBeVisible()
    expect(screen.getByText('企业模型 · 未启用')).toBeVisible()
    expect(screen.queryByLabelText(/^一次性绑定码/)).toBeNull()
    expect(Object.values(localStorage).join(' ')).not.toContain(challenge)

    host.sync.mockResolvedValueOnce({ origin, state: 'revoked', issue: 'bindingExpired' })
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
    expect(await screen.findByText('绑定已失效')).toBeVisible()
    expect(screen.queryByText('测试员工')).toBeNull()
    expect(screen.getByLabelText(/^一次性绑定码/)).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '解除本机绑定' }))
    await waitFor(() => expect(screen.getByRole('status', { name: '连接状态' })).toHaveTextContent('未绑定'))
    expect(host.disconnect).toHaveBeenCalledOnce()
  })

  it('uses incremental synchronization while mounted and stops when the settings close', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    host.sync.mockResolvedValue(connected)
    const { unmount } = render(<EnterpriseConnectionSettings />)
    await act(async () => {})
    expect(host.sync.mock.calls).toEqual([[]])
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(host.sync.mock.calls).toEqual([[], [true]])
    unmount()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(host.sync).toHaveBeenCalledTimes(2)
  })

  it('allows the built-in office connection only after selecting it and clears it when switched off', async () => {
    host.sync.mockResolvedValue({ ...disconnected, officeHttpOrigin: officeOrigin })
    render(<EnterpriseConnectionSettings />)
    const option = await screen.findByRole('checkbox', { name: '使用办公网服务器（HTTP）' })
    const address = screen.getByLabelText(/^企业服务器地址/)
    expect(option).not.toBeChecked()
    expect(screen.getByLabelText(/^一次性绑定码/)).toBeVisible()
    fireEvent.change(address, { target: { value: origin } })
    fireEvent.click(option)
    expect(address).toHaveValue(officeOrigin)
    expect(screen.queryByLabelText(/^一次性绑定码/)).toBeNull()
    fireEvent.click(option)
    expect(address).toHaveValue(origin)
    expect(screen.getByLabelText(/^一次性绑定码/)).toBeVisible()
    fireEvent.change(address, { target: { value: officeOrigin } })
    fireEvent.change(screen.getByLabelText(/^一次性绑定码/), { target: { value: challenge } })
    fireEvent.click(screen.getByRole('button', { name: '绑定本机' }))
    expect(host.enroll).toHaveBeenCalledWith({ origin: officeOrigin, challenge })
    expect(await screen.findByText('测试员工')).toBeVisible()

    host.enroll.mockClear()
    host.sync.mockResolvedValue({ ...disconnected, officeHttpOrigin: officeOrigin })
    cleanup()
    render(<EnterpriseConnectionSettings />)
    const selected = await screen.findByRole('checkbox', { name: '使用办公网服务器（HTTP）' })
    fireEvent.click(selected)
    expect(screen.queryByLabelText(/^一次性绑定码/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '内网一键直连' }))
    expect(host.enroll).toHaveBeenCalledWith({ origin: officeOrigin, officeHttp: true })
    expect(await screen.findByText('测试员工')).toBeVisible()
    host.disconnect.mockResolvedValue({ ...disconnected, officeHttpOrigin: officeOrigin })
    fireEvent.click(screen.getByRole('button', { name: '解除本机绑定' }))
    expect(await screen.findByRole('checkbox', { name: '使用办公网服务器（HTTP）' })).not.toBeChecked()
    expect(screen.getByLabelText(/^企业服务器地址/)).toHaveValue('')
  })

  it('keeps the native connection out of the browser host', () => {
    Reflect.deleteProperty(window, 'desktopHost')
    render(<EnterpriseConnectionSettings />)
    expect(screen.queryByRole('heading', { name: '企业连接' })).toBeNull()
    expect(host.sync).not.toHaveBeenCalled()
  })
})
