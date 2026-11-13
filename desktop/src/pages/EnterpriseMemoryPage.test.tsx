import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { browserHost } from '@/lib/desktopHost/browserHost'
import type { EnterpriseKnowledgeDetail, EnterpriseMemory, EnterpriseMemoryHost, EnterpriseMemoryRequest, EnterpriseMemoryResult } from '@/lib/desktopHost/enterpriseMemory'
import { useSettingsStore } from '@/stores/settingsStore'
import { EnterpriseMemoryPage } from './EnterpriseMemoryPage'

const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const userId = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'
const deviceId = 'cccccccc-cccc-4ccc-accc-cccccccccccc'
const expiry = () => new Date(Date.now() + 60_000).toISOString()
const timestamp = '2026-11-10T08:30:00Z'

function native(memory: (input: EnterpriseMemoryRequest) => Promise<EnterpriseMemoryResult>, revoked = () => false) {
  useSettingsStore.setState({ locale: 'zh' })
  window.desktopHost = { ...browserHost, isDesktop: true, kind: 'electron', enterprise: {
    memory: memory as EnterpriseMemoryHost, demand: vi.fn(), models: vi.fn(), enroll: vi.fn(), disconnect: vi.fn(),
    sync: async () => revoked() ? { state: 'revoked', origin: 'https://control.example.test' } : ({ state: 'connected', origin: 'https://control.example.test', bootstrap: {
      user: { id: userId, displayName: 'Fixture', roles: ['developer'] }, device: { id: deviceId, platform: 'win32', clientVersion: '0.7.7' },
      policy: { revision: 1, expiresAt: expiry(), features: { demands: true, models: true, memories: true, updates: false } }, cursor: 0,
    } }),
  } }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'desktopHost')
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
})

it('shows authorized knowledge details and clears them when its cursor replay delivers a revocation', async () => {
  let revoked = false
  const detail: EnterpriseKnowledgeDetail = { id, revision: 2, scope: 'enterprise_reference', projectId: null, departmentId: null,
    title: '采购收货指南', excerpt: '目录摘要', body: '采购收货流程原文，仅授权可见。', source: { label: '采购流程文档' },
    citation: { documentId: id, revision: 2, checksum: 'a'.repeat(64) }, status: 'ready', classification: 'internal', updatedAt: timestamp,
  }
  const request = vi.fn(async (input: EnterpriseMemoryRequest): Promise<EnterpriseMemoryResult> => {
    if (input.action === 'changes') return { ok: true, data: { cursor: revoked ? 2 : 1, hasMore: false, aclVersion: 1, cacheExpiresAt: expiry(),
      changes: revoked ? [{ sequence: 2, resourceType: 'knowledge', operation: 'tombstone', id, revision: 2, reason: 'access_revoked' }]
        : [{ sequence: 1, resourceType: 'knowledge', operation: 'upsert', id, revision: 2, record: detail }],
    } }
    if (input.action === 'getKnowledge') return { ok: true, data: detail }
    if (input.action === 'searchKnowledge') return { ok: true, data: { items: [{ id, revision: 2 }] } }
    if (input.action === 'scopes') return { ok: true, data: { projects: [], department: null } }
    return { ok: true, data: { items: [] } }
  })
  native(request)
  render(<EnterpriseMemoryPage />)
  fireEvent.click(await screen.findByRole('button', { name: '知识库' }))
  fireEvent.change(screen.getByRole('textbox', { name: '搜索关键词' }), { target: { value: '采购收货' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '搜索关键词' })) })
  expect(request).toHaveBeenCalledWith({ action: 'searchKnowledge', query: '采购收货' })
  fireEvent.click(await screen.findByRole('button', { name: /采购收货指南/ }))
  expect(await screen.findByText(detail.body)).toBeVisible()
  expect(request).toHaveBeenCalledWith({ action: 'getKnowledge', id, revision: 2 })
  revoked = true
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
  await waitFor(() => expect(screen.queryByText(detail.body)).not.toBeInTheDocument())
  expect(screen.queryByRole('button', { name: /采购收货指南/ })).not.toBeInTheDocument()
  expect(request).toHaveBeenCalledWith({ action: 'changes', cursor: 1 })
})

it('lets the owner save and activate a private candidate with a versioned request', async () => {
  let record: EnterpriseMemory | null = null
  const body = '采购核对需要收货组织与供应商。'
  const request = vi.fn(async (input: EnterpriseMemoryRequest): Promise<EnterpriseMemoryResult> => {
    if (input.action === 'changes') return { ok: true, data: { cursor: 0, hasMore: false, aclVersion: 1, cacheExpiresAt: expiry(), changes: [] } }
    if (input.action === 'scopes') return { ok: true, data: { projects: [], department: null } }
    if (input.action === 'candidates') return { ok: true, data: { items: record?.status === 'candidate' ? [{ ...record, excerpt: record.body }] : [] } }
    if (input.action === 'create') {
      record = { id, revision: 1, scope: input.scope, body: input.body, ownerId: userId, projectId: null, departmentId: null,
        status: 'candidate', lastVerifiedAt: null, expiresAt: null, classification: 'internal', updatedAt: timestamp }
      return { ok: true, data: record }
    }
    if (input.action === 'publish') record = { ...record!, revision: 2, status: 'active' }
    return { ok: true, data: record! }
  })
  native(request)
  render(<EnterpriseMemoryPage />)
  fireEvent.click(await screen.findByRole('button', { name: '新建记忆' }))
  fireEvent.change(screen.getByRole('textbox', { name: '记忆内容' }), { target: { value: body } })
  fireEvent.click(screen.getByRole('button', { name: '保存为候选' }))
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(body) }))
  const activate = await screen.findByRole('button', { name: '启用记忆' })
  await act(async () => { fireEvent.click(activate) })
  expect(request).toHaveBeenCalledWith({ action: 'publish', id, revision: 1 })
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', scope: 'user_private', body, idempotencyKey: expect.any(String) }))
})

function privateMemoryFixture() {
  let record: EnterpriseMemory = { id, revision: 2, scope: 'user_private', ownerId: userId, projectId: null, departmentId: null,
    body: '打开时的私人记忆。', status: 'active', lastVerifiedAt: null, expiresAt: null, classification: 'internal', updatedAt: timestamp }
  let removed = false
  let revoked = false
  let pendingRead: Promise<void> | null = null
  const request = vi.fn(async (input: EnterpriseMemoryRequest): Promise<EnterpriseMemoryResult> => {
    if (input.action === 'changes') return { ok: true, data: {
      cursor: record.revision, aclVersion: 1, hasMore: false, cacheExpiresAt: expiry(),
      changes: input.cursor === record.revision ? [] : removed
        ? [{ sequence: record.revision, operation: 'tombstone', resourceType: 'memory', id, revision: record.revision, reason: 'deleted' }]
        : [{ sequence: record.revision, operation: 'upsert', resourceType: 'memory', id, revision: record.revision, record: { ...record, excerpt: record.body } }],
    } }
    if (input.action === 'scopes') return { ok: true, data: { projects: [], department: null } }
    if (input.action === 'candidates') return { ok: true, data: { items: [] } }
    if (removed) return { ok: false, issue: 'notFound' }
    if (input.action === 'getMemory' && pendingRead) {
      const wait = pendingRead
      const version = record
      pendingRead = null
      await wait
      return { ok: true, data: version }
    }
    if (input.action === 'edit') {
      if (input.revision !== record.revision) return { ok: false, issue: 'conflict' }
      record = { ...record, body: input.body, revision: record.revision + 1 }
    }
    return { ok: true, data: record }
  })
  native(request, () => revoked)
  return { request, setCloud: (body: string) => { record = { ...record, body, revision: record.revision + 1 } },
    remove: () => { record = { ...record, revision: record.revision + 1, status: 'deleted', body: '' }; removed = true },
    revoke: () => { revoked = true },
    deferRead: () => {
      let release = () => {}
      pendingRead = new Promise<void>(resolve => { release = resolve })
      return () => release()
    } }
}

it('compares both private versions and preserves the original and hand-edited drafts through a second conflict', async () => {
  const fixture = privateMemoryFixture()
  render(<EnterpriseMemoryPage />)
  fireEvent.click(await screen.findByRole('button', { name: /打开时的私人记忆/ }))
  const input = await screen.findByRole('textbox', { name: '记忆内容' })
  fireEvent.change(input, { target: { value: '这台设备尚未保存的编辑。' } })
  fixture.setCloud('另一台设备提交的修订。')
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  expect(await screen.findByRole('textbox', { name: '本机编辑稿' })).toHaveValue('这台设备尚未保存的编辑。')
  expect(await screen.findByRole('textbox', { name: '云端当前版' })).toHaveValue('另一台设备提交的修订。')
  fireEvent.click(screen.getByRole('button', { name: '以本机稿为底稿' }))
  fireEvent.change(screen.getByRole('textbox', { name: '准备保存的内容' }), { target: { value: '我手工合并两份版本。' } })
  fixture.setCloud('另一台设备再次提交的修订。')
  fireEvent.click(screen.getByRole('button', { name: '保存所选内容' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: '云端当前版' })).toHaveValue('另一台设备再次提交的修订。'))
  expect(screen.getByRole('textbox', { name: '本机编辑稿' })).toHaveValue('这台设备尚未保存的编辑。')
  expect(screen.getByRole('textbox', { name: '准备保存的内容' })).toHaveValue('我手工合并两份版本。')
  expect(screen.getByRole('button', { name: '保存所选内容' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '继续用手工稿' }))
  fireEvent.click(screen.getByRole('button', { name: '保存所选内容' }))
  await waitFor(() => expect(fixture.request).toHaveBeenCalledWith({ action: 'edit', id, revision: 4, body: '我手工合并两份版本。' }))
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '本机编辑稿' })).not.toBeInTheDocument())
  expect(fixture.request).toHaveBeenCalledWith({ action: 'edit', id, revision: 2, body: '这台设备尚未保存的编辑。' })
  expect(fixture.request).toHaveBeenCalledWith({ action: 'edit', id, revision: 3, body: '我手工合并两份版本。' })
})

it('offers comparison when sync observes a newer revision and clears both texts on a tombstone', async () => {
  const fixture = privateMemoryFixture()
  render(<EnterpriseMemoryPage />)
  fireEvent.click(await screen.findByRole('button', { name: /打开时的私人记忆/ }))
  fireEvent.change(await screen.findByRole('textbox', { name: '记忆内容' }), { target: { value: '私有本机稿甲。' } })
  fixture.setCloud('云端私有改动乙。')
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
  fireEvent.click(await screen.findByRole('button', { name: '对比本机和云端' }))
  expect(await screen.findByRole('textbox', { name: '本机编辑稿' })).toHaveValue('私有本机稿甲。')
  expect(await screen.findByRole('textbox', { name: '云端当前版' })).toHaveValue('云端私有改动乙。')
  fireEvent.click(screen.getByRole('button', { name: '以云端版为底稿' }))
  expect(screen.getByRole('textbox', { name: '准备保存的内容' })).toHaveValue('云端私有改动乙。')
  fixture.remove()
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
  await waitFor(() => {
    expect(screen.queryByRole('textbox', { name: '本机编辑稿' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '云端当前版' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '准备保存的内容' })).not.toBeInTheDocument()
  })
  expect(fixture.request.mock.calls.some(([request]) => request.action === 'edit')).toBe(false)
})

it.each(['remove', 'revoke'] as const)('discards a late private comparison after %s', async action => {
  const fixture = privateMemoryFixture()
  render(<EnterpriseMemoryPage />)
  fireEvent.click(await screen.findByRole('button', { name: /打开时的私人记忆/ }))
  fireEvent.change(await screen.findByRole('textbox', { name: '记忆内容' }), { target: { value: '待清除的本机编辑。' } })
  fixture.setCloud('迟到的云端正文。')
  const release = fixture.deferRead()
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  expect(await screen.findByRole('textbox', { name: '本机编辑稿' })).toBeVisible()
  fixture[action]()
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '本机编辑稿' })).not.toBeInTheDocument())
  await act(async () => release())
  expect(screen.queryByRole('textbox', { name: '本机编辑稿' })).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '云端当前版' })).not.toBeInTheDocument()
  expect(screen.queryByText('迟到的云端正文。')).not.toBeInTheDocument()
})
