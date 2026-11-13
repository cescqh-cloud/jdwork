import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { browserHost } from '@/lib/desktopHost/browserHost'
import type { DesktopEnterpriseHost } from '@/lib/desktopHost/enterprise'
import { useChatStore } from '@/stores/chatStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { EnterpriseDeliveryPage } from './EnterpriseDeliveryPage'

const taskId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const projectId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const userId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
const deviceId = 'dddddddd-dddd-4ddd-dddd-dddddddddddd'
const runId = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee'
const timestamp = '2026-11-10T08:30:00.000Z'
const permissions = { bind: false, submitChecks: false, start: false, startTesting: false, review: false,
  recordTest: false, accept: false, returnForRework: false }
const baseTask = {
  id: taskId, demandId: '11111111-1111-4111-8111-111111111111', demandNo: 'REQ-TEST-1', title: '采购收货验收',
  approvedVersionId: '22222222-2222-4222-8222-222222222222', snapshotHash: 'a'.repeat(64),
  projectId, projectName: '采购项目', assigneeId: userId, assigneeName: '实施人', state: 'DEVELOPING' as const, revision: 2,
  canAdvance: true, permissions, binding: null, latestRunId: null, acceptedRunId: null, latestTestOutcome: null,
  deliveryRef: null, history: [], createdAt: timestamp, updatedAt: timestamp,
}
const binding = { id: '33333333-3333-4333-8333-333333333333', deviceId, worktreeId: 'test-tree',
  sessionId: 'test-source-session', gitRevision: 'b'.repeat(40), createdAt: timestamp }
const report = {
  id: runId, bindingId: binding.id, approvedVersionId: baseTask.approvedVersionId, snapshotHash: baseTask.snapshotHash,
  submittedBy: userId, taskRevision: 3, inputHash: 'c'.repeat(64), ruleVersion: 'delivery-v1', verdict: 'BLOCK' as const, stale: false,
  files: [{ path: 'request.md', sha256: 'd'.repeat(64) }],
  findings: [{ ruleId: 'structure.acceptance', status: 'BLOCK' as const, severity: 'critical' as const, message: '验收标准缺失。',
    guidance: '补充验收标准。', evidence: [{ path: 'request.md', line: 3 }], ruleVersion: 'delivery-v1', inputHash: 'c'.repeat(64), detectedAt: timestamp }],
  review: null, createdAt: timestamp,
}

function connect(delivery: unknown, isRevoked = () => false) {
  useSettingsStore.setState({ locale: 'zh' })
  window.desktopHost = { ...browserHost, isDesktop: true, kind: 'electron', enterprise: {
    delivery, demand: vi.fn(), models: vi.fn(), enroll: vi.fn(), disconnect: vi.fn(),
    sync: async () => isRevoked() ? { state: 'revoked', origin: 'https://control.example.test' } : {
      state: 'connected', origin: 'https://control.example.test', bootstrap: {
        user: { id: userId, displayName: '测试用户', roles: ['developer'] },
        device: { id: deviceId, platform: 'win32', clientVersion: '0.7.7' },
        policy: { revision: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(),
          features: { demands: true, models: false, memories: false, updates: false } },
        cursor: 0,
      },
    },
  } as DesktopEnterpriseHost }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'desktopHost')
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
})

it('uses native worktree selection and keeps AI repair as an unsent draft in a real session', async () => {
  const openSession = vi.spyOn(useSessionStore.getState(), 'openHistoricalSession').mockImplementation(() => {})
  const draft = vi.spyOn(useChatStore.getState(), 'setComposerDraft').mockImplementation(() => {})
  const connectToSession = vi.spyOn(useChatStore.getState(), 'connectToSession').mockImplementation(() => {})
  const task = { ...baseTask, permissions: { ...permissions, bind: true, submitChecks: true } }
  const bound = { ...task, revision: 3, binding }
  const checked = { ...bound, revision: 4, latestRunId: runId }
  const request = vi.fn(async (input: { action: string }) => {
    if (input.action === 'list') return { ok: true, data: { items: [task] } }
    if (input.action === 'get') return { ok: true, data: task }
    if (input.action === 'bind') return { ok: true, data: { task: bound, sessionId: 'test-source-session', workDir: 'C:/fixture/tree' } }
    if (input.action === 'check') return { ok: true, data: { task: checked, run: report } }
    if (input.action === 'fix') return { ok: true, data: { task: checked, sessionId: 'test-fix-session', workDir: 'C:/fixture/tree',
      draftText: '按当前报告补充验收标准。' } }
    return { ok: true, data: report }
  })
  connect(request)
  render(<EnterpriseDeliveryPage />)
  fireEvent.click(await screen.findByRole('button', { name: /采购收货验收/ }))
  expect(await screen.findByRole('button', { name: '提交材料检查' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '绑定本机工作树' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '提交材料检查' })).toBeEnabled())
  expect(request).toHaveBeenCalledWith({ action: 'bind', id: taskId, revision: 2 })
  fireEvent.click(screen.getByRole('button', { name: '提交材料检查' }))
  expect(await screen.findByText('验收标准缺失。')).toBeVisible()
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'check', id: taskId, revision: 3 }))
  fireEvent.click(screen.getByRole('button', { name: '准备 AI 修复' }))
  await waitFor(() => expect(draft).toHaveBeenCalledWith('test-fix-session', { input: '按当前报告补充验收标准。', attachments: [] }))
  expect(request).toHaveBeenCalledWith({ action: 'fix', id: taskId, revision: 4, runId })
  expect(openSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'test-fix-session', workDir: 'C:/fixture/tree' }))
  expect(connectToSession).toHaveBeenCalledWith('test-fix-session')
})

it('requires warning acknowledgement for independent review and clears protected data on revocation', async () => {
  let revoked = false
  const task = { ...baseTask, latestRunId: runId, permissions: { ...permissions, review: true } }
  const warning = { ...report, verdict: 'WARN', findings: [] }
  const request = vi.fn(async (input: { action: string }) => {
    if (input.action === 'list') return { ok: true, data: { items: [task] } }
    if (input.action === 'getCheck') return { ok: true, data: warning }
    if (input.action === 'review') return { ok: true, data: { ...task, revision: 3, permissions } }
    return { ok: true, data: task }
  })
  connect(request, () => revoked)
  render(<EnterpriseDeliveryPage />)
  fireEvent.click(await screen.findByRole('button', { name: /采购收货验收/ }))
  fireEvent.click(await screen.findByRole('button', { name: '提交独立复审' }))
  fireEvent.change(screen.getByRole('textbox', { name: '说明' }), { target: { value: '已查证来源' } })
  expect(screen.getByRole('button', { name: '复审通过' })).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: '我已核对警告' }))
  fireEvent.click(screen.getByRole('button', { name: '复审通过' }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({
    action: 'review', id: taskId, revision: 2, runId, decision: 'ACCEPT', acknowledgeWarnings: true, note: '已查证来源',
  }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  revoked = true
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: /采购收货验收/ })).not.toBeInTheDocument())
  expect(screen.queryByText(report.inputHash)).not.toBeInTheDocument()
})

it('disables advancement for invalidated material and rechecks the same approved selection', async () => {
  const stale = { ...baseTask, binding, latestRunId: runId, materials: { state: 'changed', expiresAt: null },
    permissions: { ...permissions, submitChecks: true, startTesting: true } }
  const refreshedRunId = 'ffffffff-ffff-4fff-afff-ffffffffffff'
  const refreshed = { ...stale, revision: 3, latestRunId: refreshedRunId,
    materials: { state: 'current', expiresAt: new Date(Date.now() + 30_000).toISOString() },
    permissions: { ...permissions, submitChecks: true } }
  const request = vi.fn(async (input: { action: string }) => {
    if (input.action === 'list') return { ok: true, data: { items: [stale] } }
    if (input.action === 'getCheck') return { ok: true, data: { ...report, stale: true, canReuseMaterials: true } }
    if (input.action === 'recheck') return { ok: true, data: { task: refreshed,
      run: { ...report, id: refreshedRunId, verdict: 'PASS', findings: [], canReuseMaterials: true } } }
    if (input.action === 'watch') return { ok: true, data: { task: { ...refreshed, automaticRecheck: true }, run: null } }
    return { ok: true, data: stale }
  })
  connect(request)
  render(<EnterpriseDeliveryPage />)
  fireEvent.click(await screen.findByRole('button', { name: /采购收货验收/ }))
  expect(await screen.findByText(/原报告不能用于复审/)).toBeVisible()
  expect(screen.getByRole('button', { name: '进入测试' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: '准备 AI 修复' })).not.toBeInTheDocument()
  fireEvent.click(await screen.findByRole('button', { name: '复查上次所选文件' }))
  expect(await screen.findByText('绑定设备已核验当前材料。')).toBeVisible()
  expect(request).toHaveBeenCalledWith({ action: 'recheck', id: taskId, revision: 2 })
  fireEvent.click(screen.getByRole('button', { name: '开启自动复查' }))
  expect(await screen.findByRole('button', { name: '关闭自动复查' })).toBeVisible()
  expect(request).toHaveBeenCalledWith({ action: 'watch', id: taskId, revision: 3, enabled: true })
})

it('loads the newly completed report when the native watcher advances the task', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const initial = { ...baseTask, binding, latestRunId: runId, automaticRecheck: true }
  const nextId = 'abababab-abab-4bab-abab-abababababab'
  let task = initial
  const request = vi.fn(async (input: { action: string; runId?: string }) => {
    if (input.action === 'list') return { ok: true, data: { items: [initial] } }
    if (input.action === 'getCheck' && input.runId === nextId) {
      await new Promise(resolve => setTimeout(resolve, 100))
      return { ok: true, data: { ...report, id: nextId, verdict: 'PASS', findings: [{ ...report.findings[0],
        status: 'PASS', severity: 'info', message: '后台复查报告已更新。' }] } }
    }
    if (input.action === 'getCheck') return { ok: true, data: report }
    return { ok: true, data: task }
  })
  connect(request)
  render(<EnterpriseDeliveryPage />)
  fireEvent.click(await screen.findByRole('button', { name: /采购收货验收/ }))
  expect(await screen.findByText('验收标准缺失。')).toBeVisible()
  task = { ...initial, revision: 3, latestRunId: nextId }
  expect(await screen.findByText('后台复查报告已更新。', {}, { timeout: 6000 })).toBeVisible()
}, 8000)
