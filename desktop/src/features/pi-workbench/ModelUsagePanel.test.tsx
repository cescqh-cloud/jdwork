import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCALE_STORAGE_KEY } from '@/i18n/locale'
import { createPiApi, type DesktopModel, type DesktopModelUpdate, type DesktopUsage, type UsageCounts } from './api'
import { ModelUsagePanel } from './ModelUsagePanel'

const profile = {
  id: 'connection-one', name: 'Project connection', baseUrl: 'https://provider.example.invalid/v1',
  model: 'fixture-model', target: 'fixture-endpoint-binding',
}
const emptyCounts: UsageCounts = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reportedCalls: 0, unreportedCalls: 0,
}
const usage: DesktopUsage = {
  days: 7, from: '2026-11-01', through: '2026-11-07', timezone: 'UTC',
  client: { id: 'current-client', kind: 'desktop' },
  totals: {
    server: { ...emptyCounts, input: 300, output: 30, totalTokens: 330, reportedCalls: 2, unreportedCalls: 1 },
    personal: { ...emptyCounts, input: 5, output: 6, totalTokens: 11, reportedCalls: 1 },
  },
  rows: [
    { ...emptyCounts, actorId: 'viewer', actorName: 'Ava', clientId: 'current-client', clientKind: 'desktop', credentials: 'server',
      day: '2026-11-06', input: 100, output: 10, totalTokens: 110, reportedCalls: 1 },
    { ...emptyCounts, actorId: 'viewer', actorName: 'Ava', clientId: 'current-client', clientKind: 'desktop', credentials: 'server',
      day: '2026-11-07', input: 200, output: 20, totalTokens: 220, reportedCalls: 1 },
    { ...emptyCounts, actorId: 'viewer', actorName: 'Ava', clientId: 'current-client', clientKind: 'desktop', credentials: 'personal',
      day: '2026-11-06', input: 5, output: 6, totalTokens: 11, reportedCalls: 1 },
    { ...emptyCounts, actorId: 'other-user', actorName: 'Sam', clientId: 'other-client', clientKind: 'web', credentials: 'server',
      day: '2026-11-07', unreportedCalls: 1 },
  ],
}

function mockServer() {
  let model: DesktopModel = { revision: 4, source: 'server', profileId: null, hasApiKey: false, configured: false, profiles: [profile] }
  const writes: DesktopModelUpdate[] = []
  const paths: string[] = []
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    paths.push(path)
    if (path.startsWith('/api/desktop/usage')) return Response.json(usage)
    if (path !== '/api/desktop/model') return Response.json({}, { status: 404 })
    if (init.method === 'PUT') {
      const request = JSON.parse(String(init.body)) as DesktopModelUpdate
      writes.push(request)
      const hasApiKey = request.clearApiKey ? false : !!request.apiKey || model.hasApiKey
      model = {
        ...model, revision: model.revision + 1, source: request.source, profileId: request.profileId ?? model.profileId,
        hasApiKey, configured: hasApiKey,
      }
    }
    return Response.json(model)
  })
  return { writes, paths }
}

beforeEach(() => localStorage.setItem(LOCALE_STORAGE_KEY, 'en'))
afterEach(() => {
  cleanup()
  localStorage.removeItem(LOCALE_STORAGE_KEY)
  localStorage.removeItem('pi-workbench-client-v1')
  vi.unstubAllGlobals()
})

describe('desktop model and usage panel', () => {
  it('sends a password only to the selected target, then clears it by switching to the server', async () => {
    const { writes } = mockServer()
    render(<ModelUsagePanel api={createPiApi()} identity={{ id: 'viewer', name: 'Ava', admin: false }} />)

    const personal = await screen.findByRole('radio', { name: 'Personal key' })
    expect(screen.queryByText('Setup needed')).not.toBeInTheDocument()
    fireEvent.click(personal)
    const secret = 'fixture-key-never-in-browser-storage'
    const input = screen.getByLabelText(/^Personal API key/)
    expect(input).toHaveAttribute('type', 'password')
    expect(screen.getByText(profile.baseUrl)).toBeInTheDocument()
    fireEvent.change(input, { target: { value: secret } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const clear = await screen.findByRole('button', { name: 'Clear personal key' })
    expect(writes[0]).toEqual({ revision: 4, source: 'personal', profileId: profile.id, apiKey: secret, target: profile.target })
    expect(input).toHaveValue('')
    expect(JSON.stringify({ ...localStorage })).not.toContain(secret)
    expect(screen.queryByRole('table', { name: 'Usage by client' })).not.toBeInTheDocument()
    expect(screen.queryByText('Sam')).not.toBeInTheDocument()

    fireEvent.click(clear)
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear personal key' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Server model' })).toBeChecked())
    expect(writes[1]).toEqual({ revision: 5, source: 'server', clearApiKey: true })
    expect(screen.queryByRole('button', { name: 'Clear personal key' })).not.toBeInTheDocument()
  })

  it('aggregates an admin’s rows by account, client and credential source without treating unknown usage as zero', async () => {
    const { paths } = mockServer()
    render(<ModelUsagePanel api={createPiApi()} identity={{ id: 'viewer', name: 'Ava', admin: true }} />)

    const table = await screen.findByRole('table', { name: 'Usage by client' })
    expect(within(table).getAllByRole('row')).toHaveLength(4)
    expect(within(table).getByRole('row', { name: /Ava.*Server model/ })).toHaveTextContent('330')
    expect(within(table).getByRole('row', { name: /Ava.*Personal key/ })).toHaveTextContent('11')
    expect(within(table).getByRole('row', { name: /Sam.*Server model/ })).toHaveTextContent('Not reported')
    expect(table).not.toHaveTextContent('current-client')

    fireEvent.click(screen.getByRole('radio', { name: '30 days' }))
    await waitFor(() => expect(paths).toContain('/api/desktop/usage?days=30'))
  })
})
