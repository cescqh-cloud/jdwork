import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { browserHost } from '@/lib/desktopHost/browserHost'
import {
  blankDemandDraft, type EnterpriseDemandDetail, type EnterpriseDemandHost, type EnterpriseDemandRequest, type EnterpriseDemandResult,
} from '@/lib/desktopHost/enterpriseDemand'
import type {
  EnterpriseDemandLocalHost, EnterpriseDemandLocalRecord, EnterpriseDemandLocalRequest, EnterpriseDemandLocalResult,
} from '@/lib/desktopHost/enterpriseDemandLocal'
import { useSettingsStore } from '@/stores/settingsStore'
import { EnterpriseDemandPage } from './EnterpriseDemandPage'

const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const userId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const versionId = 'cccccccc-cccc-4ccc-accc-cccccccccccc'
const timestamp = '2026-11-10T08:30:00Z'
const processCode = 'PROC-fixture'

function native(demand: (input: EnterpriseDemandRequest) => Promise<EnterpriseDemandResult>,
  offline?: { local: EnterpriseDemandLocalHost; online: () => boolean }) {
  useSettingsStore.setState({ locale: 'zh' })
  window.desktopHost = {
    ...browserHost, isDesktop: true, kind: 'electron',
    enterprise: {
      demand: demand as EnterpriseDemandHost,
      demandLocal: offline?.local,
      enroll: vi.fn(), disconnect: vi.fn(), models: vi.fn(),
      sync: async () => offline && !offline.online() ? { state: 'unavailable', origin: 'https://control.example.test', issue: 'network' } : ({
        state: 'connected', origin: 'https://control.example.test',
        bootstrap: {
          user: { id: userId, displayName: '测试员工', roles: ['requester'] },
          device: { id, platform: 'win32', clientVersion: '0.7.7' },
          policy: { revision: 1, expiresAt: timestamp, features: { demands: true, models: false, memories: false, updates: false } },
          cursor: 0,
        },
      }),
    },
  }
}

function details(): EnterpriseDemandDetail {
  const draft = {
    ...blankDemandDraft, title: '采购日报', systemKey: 'ERP', category: '报表', businessContext: '需要查询当日收货。',
  }
  return {
    id, title: draft.title, ownerId: userId, demandNo: 'REQ-001', state: 'DRAFT', origin: 'WORKBENCH', revision: 1,
    draftRevision: 1, createdAt: timestamp, updatedAt: timestamp, draft, validation: { missing: [], warnings: [] },
    precheck: null, activeVersion: null, approvedVersion: null, unsubmittedChanges: false, submission: null, approval: null,
  }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'desktopHost')
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
})

it('creates a draft, prechecks its revision, retains the submission key on retry, and displays approval progress', async () => {
  let saved: EnterpriseDemandDetail | null = null
  let attempts = 0
  const requests = vi.fn(async (input: EnterpriseDemandRequest): Promise<EnterpriseDemandResult> => {
    switch (input.action) {
      case 'status': return { ok: true, data: { oaConfigured: true, callbackConfigured: true, aiPrecheckConfigured: true } }
      case 'templates': return { ok: true, data: { templates: [{ processCode, label: '信息化提案', approverOptions: [{ actionerKey: 'lead', label: '部门负责人', allowedUserIds: ['fixture-approver'] }] }] } }
      case 'list': return { ok: true, data: { demands: saved ? [{ ...saved, approvedVersionId: null }] : [] } }
      case 'create':
        saved = { ...details(), draft: input.draft, title: input.draft.title }
        return { ok: true, data: saved }
      case 'precheck':
        saved = { ...saved!, state: 'AI_PRECHECK', precheck: { summary: '建议核对收货组织。', questions: [], risks: [], draftRevision: input.expectedDraftRevision, checkedAt: timestamp } }
        return { ok: true, data: saved }
      case 'submit':
        if (++attempts === 1) return { ok: false, issue: 'unavailable' }
        saved = {
          ...saved!, state: 'PENDING', submission: { state: 'LINKED', errorCode: null, versionId },
          activeVersion: { id: versionId, versionNo: 1, createdAt: timestamp, snapshot: { draftRevision: 1, draft: saved!.draft!, precheck: saved!.precheck } },
          approval: { instanceId: 'fixture-approval', processCode, state: 'RUNNING', verifiedAt: timestamp, decision: null },
        }
        return { ok: true, data: { versionId, reused: true, demand: saved } }
      default: return { ok: true, data: saved! }
    }
  })
  native(requests)
  render(<EnterpriseDemandPage />)
  const add = await screen.findByRole('button', { name: '新建需求' })
  await waitFor(() => expect(add).not.toBeDisabled())
  fireEvent.click(add)
  for (const [name, value] of [['需求标题', '采购日报'], ['涉及系统', 'ERP'], ['需求类别', '报表'], ['业务背景', '需要查询当日收货。']] as const) {
    fireEvent.change(screen.getByLabelText(name), { target: { value } })
  }
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
  const precheck = await screen.findByRole('button', { name: 'AI 预审' })
  await waitFor(() => expect(precheck).not.toBeDisabled())
  fireEvent.click(precheck)
  expect(await screen.findByText('建议核对收货组织。')).toBeVisible()
  const submit = screen.getByRole('button', { name: '提交钉钉审批' })
  expect(submit).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: 'fixture-approver' }))
  fireEvent.click(submit)
  expect(await screen.findByRole('alert')).toHaveTextContent('企业服务暂时不可用')
  fireEvent.click(submit)
  expect(await screen.findByText(/钉钉审批单 fixture-approval/)).toBeVisible()
  expect(submit).toBeDisabled()
  expect(screen.getByLabelText('需求标题')).not.toHaveAttribute('readonly')
  fireEvent.click(screen.getByText('送审快照 · 第 1 版'))
  fireEvent.change(screen.getByLabelText('需求标题'), { target: { value: '采购日报第二稿' } })
  expect(screen.getByText('现在可以编辑下一稿。钉钉审批对应下方的冻结快照。')).toBeVisible()
  expect(screen.getAllByText('采购日报').length).toBeGreaterThan(0)
  expect(submit).toBeDisabled()
  const submissions = requests.mock.calls.map(([input]) => input).filter(input => input.action === 'submit')
  expect(submissions).toHaveLength(2)
  expect(submissions[0]).toEqual(submissions[1])
  expect(submissions[0]).toMatchObject({
    id, processCode, expectedDraftRevision: 1,
    approverSelections: [{ actionerKey: 'lead', actionerUserIds: ['fixture-approver'] }],
  })
})

it('saves and reopens a draft offline, exports explicitly and keeps the saved copy on a cloud conflict', async () => {
  let online = false
  let saved: EnterpriseDemandLocalRecord | null = null
  const local = vi.fn(async (input: EnterpriseDemandLocalRequest): Promise<EnterpriseDemandLocalResult> => {
    switch (input.action) {
      case 'list': return { ok: true, data: { deviceId: id, unreadable: 0, drafts: saved ? [{ ...saved, title: saved.draft.title }] : [] } }
      case 'get': return { ok: true, data: saved! }
      case 'save':
        saved = { id: input.id, draft: input.draft, revision: (saved?.revision ?? 0) + 1, updatedAt: timestamp, cloud: input.cloud }
        return { ok: true, data: saved }
      case 'export': return { ok: true, data: { saved: true } }
      case 'sync': return { ok: false, issue: 'conflict' }
      case 'merge': return { ok: false, issue: 'invalid' }
    }
  })
  const cloud = vi.fn(async (input: EnterpriseDemandRequest): Promise<EnterpriseDemandResult> => {
    switch (input.action) {
      case 'status': return { ok: true, data: { oaConfigured: true, callbackConfigured: true, aiPrecheckConfigured: true } }
      case 'templates': return { ok: true, data: { templates: [] } }
      case 'list': return { ok: true, data: { demands: [] } }
      default: return { ok: false, issue: 'unavailable' }
    }
  })
  native(cloud, { local: local as EnterpriseDemandLocalHost, online: () => online })
  const first = render(<EnterpriseDemandPage />)
  fireEvent.click(await screen.findByRole('button', { name: '新建需求' }))
  fireEvent.change(screen.getByLabelText('需求标题'), { target: { value: '断网期间的采购草稿' } })
  fireEvent.click(screen.getByRole('button', { name: '保存到本机' }))
  expect(await screen.findByText('已保存在本机，重启后可继续编辑。')).toBeVisible()
  first.unmount()

  render(<EnterpriseDemandPage />)
  fireEvent.click(await screen.findByRole('button', { name: /断网期间的采购草稿/ }))
  const title = await screen.findByLabelText('需求标题')
  expect(title).toHaveValue('断网期间的采购草稿')
  fireEvent.change(title, { target: { value: '断网期间的采购草稿第二稿' } })
  fireEvent.click(screen.getByRole('button', { name: '导出 Markdown' }))
  expect(await screen.findByText('已导出本机草稿。')).toBeVisible()
  expect(local.mock.calls.map(([request]) => request.action)).not.toContain('sync')
  expect(cloud).not.toHaveBeenCalled()

  online = true
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '保存到云端' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: '保存到云端' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('本机副本已保留')
  expect(title).toHaveValue('断网期间的采购草稿第二稿')
  expect(local.mock.calls.map(([request]) => request.action).filter(action => action === 'sync')).toHaveLength(1)
  expect(cloud.mock.calls.map(([request]) => request.action)).not.toContain('submit')
})

it('keeps entered text if the cloud draft revision changed', async () => {
  const saved = details()
  native(async input => {
    switch (input.action) {
      case 'status': return { ok: true, data: { oaConfigured: false, callbackConfigured: false, aiPrecheckConfigured: true } }
      case 'templates': return { ok: true, data: { templates: [] } }
      case 'list': return { ok: true, data: { demands: [{ ...saved, approvedVersionId: null }] } }
      case 'get': return { ok: true, data: saved }
      case 'edit': return { ok: false, issue: 'conflict' }
      default: return { ok: false, issue: 'invalid' }
    }
  })
  render(<EnterpriseDemandPage />)
  const row = await screen.findByRole('button', { name: /采购日报/ })
  await waitFor(() => expect(row).not.toBeDisabled())
  fireEvent.click(row)
  const title = await screen.findByLabelText('需求标题')
  fireEvent.change(title, { target: { value: '采购日报补充字段' } })
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('草稿版本已变化')
  expect(title).toHaveValue('采购日报补充字段')
})

it('compares offline and cloud edits by field, then saves the reviewed draft without sending it for approval', async () => {
  const base = details()
  let online = true
  let latest = base
  let saved: EnterpriseDemandLocalRecord | null = null
  let baseDraft = base.draft
  const cloudRef = () => ({ id, draftRevision: latest.draftRevision, demandNo: latest.demandNo })
  const conflict = (): EnterpriseDemandLocalResult => ({ ok: false, issue: 'conflict',
    conflict: { local: saved!, baseDraft, latest: { cloud: cloudRef(), draft: latest.draft! } } })
  const local = vi.fn(async (input: EnterpriseDemandLocalRequest): Promise<EnterpriseDemandLocalResult> => {
    switch (input.action) {
      case 'list': return { ok: true, data: { deviceId: id, unreadable: 0, drafts: saved ? [{ ...saved, title: saved.draft.title }] : [] } }
      case 'get': return { ok: true, data: saved! }
      case 'save':
        saved = { id: input.id, draft: input.draft, revision: (saved?.revision ?? 0) + 1, updatedAt: timestamp, cloud: input.cloud }
        baseDraft = input.baseDraft ?? baseDraft
        return { ok: true, data: saved }
      case 'merge':
        if (latest.draftRevision === 2) {
          latest = { ...latest, revision: 3, draftRevision: 3, draft: { ...latest.draft!, expectedValue: '云端追加了实际收益口径' } }
          return conflict()
        }
        expect(input.expectedLocalRevision).toBe(saved?.revision)
        expect(input.expectedCloudRevision).toBe(3)
        saved = { ...saved!, draft: input.draft, revision: saved!.revision + 1, cloud: cloudRef() }
        return { ok: true, data: saved }
      case 'sync':
        if (saved!.cloud?.draftRevision !== latest.draftRevision) return conflict()
        latest = { ...latest, title: saved!.draft.title, draft: saved!.draft, draftRevision: 4, revision: 4 }
        saved = null
        return { ok: true, data: { demand: latest, draft: null } }
      case 'export': return { ok: true, data: { saved: true } }
    }
  })
  const cloud = vi.fn(async (input: EnterpriseDemandRequest): Promise<EnterpriseDemandResult> => {
    switch (input.action) {
      case 'status': return { ok: true, data: { oaConfigured: false, callbackConfigured: false, aiPrecheckConfigured: false } }
      case 'templates': return { ok: true, data: { templates: [] } }
      case 'list': return { ok: true, data: { demands: [{ ...latest, approvedVersionId: null }] } }
      case 'get': return { ok: true, data: latest }
      default: return { ok: false, issue: 'invalid' }
    }
  })
  native(cloud, { local: local as EnterpriseDemandLocalHost, online: () => online })
  render(<EnterpriseDemandPage />)
  const row = await screen.findByRole('button', { name: /采购日报/ })
  await waitFor(() => expect(row).not.toBeDisabled())
  fireEvent.click(row)
  const title = await screen.findByLabelText('需求标题')
  online = false
  fireEvent.change(title, { target: { value: '采购日报（本机口径）' } })
  fireEvent.change(screen.getByLabelText('业务背景'), { target: { value: '断网期间补充了收货场景。' } })
  fireEvent.click(screen.getByRole('button', { name: '保存到本机' }))
  expect(await screen.findByText('已保存在本机，重启后可继续编辑。')).toBeVisible()
  expect(local.mock.calls.map(([input]) => input).find(input => input.action === 'save')).toMatchObject({ baseDraft: base.draft })

  latest = { ...base, revision: 2, draftRevision: 2, title: '采购日报（云端口径）',
    draft: { ...base.draft!, title: '采购日报（云端口径）', expectedValue: '另一台电脑补充收益', attachmentRefs: [{ id: 'guide-001', name: '收货口径.md' }] } }
  online = true
  fireEvent.click(screen.getByRole('button', { name: '保存到云端' }))
  let review = await screen.findByRole('region', { name: '合并需求草稿' })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(within(review).getByText('采购日报（本机口径）')).toBeVisible()
  expect(within(review).getByText('采购日报（云端口径）')).toBeVisible()
  const pickLocalTitle = () => fireEvent.click(within(within(review).getByRole('group', { name: '需求标题' })).getByRole('radio', { name: '保留本机' }))
  const apply = () => within(review).getByRole('button', { name: '应用合并稿' })
  expect(apply()).toBeDisabled()
  expect(within(within(review).getByRole('group', { name: '业务背景' })).getByRole('radio', { name: '保留本机' })).toBeChecked()
  expect(within(within(review).getByRole('group', { name: '预期收益' })).getByRole('radio', { name: '保留云端' })).toBeChecked()
  pickLocalTitle()
  fireEvent.click(apply())
  expect(await screen.findByText('云端追加了实际收益口径')).toBeVisible()
  review = screen.getByRole('region', { name: '合并需求草稿' })
  expect(apply()).toBeDisabled()
  pickLocalTitle()
  fireEvent.click(apply())
  expect(await screen.findByText('合并稿已保存在本机，可继续编辑或保存到云端。')).toBeVisible()
  expect(screen.getByLabelText('需求标题')).toHaveValue('采购日报（本机口径）')
  expect(screen.getByLabelText('业务背景')).toHaveValue('断网期间补充了收货场景。')
  expect(screen.getByLabelText('预期收益')).toHaveValue('云端追加了实际收益口径')
  expect(screen.getByText('收货口径.md')).toBeVisible()
  expect(local.mock.calls.map(([input]) => input.action).filter(action => action === 'sync')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '保存到云端' }))
  expect(await screen.findByText('草稿已保存到云端。送审需另行提交。')).toBeVisible()
  expect(latest.draftRevision).toBe(4)
  expect(cloud.mock.calls.map(([request]) => request.action)).not.toContain('submit')
})
