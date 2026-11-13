import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCALE_STORAGE_KEY } from '@/i18n/locale'
import { PiWorkbenchApp } from './PiWorkbenchApp'
import type { ClientConnections } from './api'

const project = { id: 'fixture', name: 'Business workbench', description: 'Team workspace' }
const catalog = {
  projectId: project.id, name: project.name, description: project.description, revision: 1,
  agents: [{ id: 'requirements', kind: 'research', label: 'Requirements assistant', summary: 'Define the scope', category: 'office', starter: 'Describe the change' }],
  enabledAgentIds: ['requirements'],
  groups: [{ id: 'requirements', label: 'Requirements' }],
  requirementSections: [{ id: 'overview', label: 'Overview' }],
}
const task = {
  id: 'task-one', kind: 'research', title: 'Change request', status: 'completed', agentId: 'requirements',
  groupId: 'requirements', updatedAt: '2026-11-01T10:00:00Z', ownerId: 'member',
  messages: [{ role: 'user', text: 'Explain the change', at: '2026-11-01T10:00:00Z' }], tools: [],
}
const revision = {
  revision: 2, title: 'Current scope', status: 'draft', updatedAt: '2026-11-01T10:00:00Z', updatedBy: 'member', source: 'manual',
}
const earlier = { ...revision, revision: 1, title: 'Earlier scope' }
const published = {
  id: 'release-one', version: '0.9.11', filename: 'Pi-Setup.exe', state: 'published',
  bytes: 2048, sha256: 'f'.repeat(64), notes: 'Offline fixture', publishedAt: '2026-11-01T10:00:00Z',
}
const lazyTimeout = { timeout: 4000 }

function mockServer({
  ownerId = 'member', initialDocument = true, release = null as typeof published | null, localClient = false,
  managementOnly = false, computerAvailable = true, miniProgramApiUrl = '', models = {} as ClientConnections['models'], management = '',
  environment = undefined as ClientConnections['environment'], computerEnabled = false, contextKeySaved = false,
} = {}) {
  let generated = initialDocument
  let turns = 0
  let clientRevision = 0
  let computerUse = computerEnabled
  let hasContextKey = contextKeySaved
  const calls: { path: string, init: RequestInit }[] = []
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    calls.push({ path, init })
    if (path === '/auth/config') return Response.json({ project, tokenLogin: !localClient, dingTalkLogin: !localClient, localClient, managementOnly })
    if (path === '/api/me') return Response.json({ project, csrfToken: 'csrf-fixture', identity: { id: 'member', name: 'Member', admin: managementOnly } })
    if (path === '/api/desktop/workbench') return Response.json(localClient ? {
      ...catalog,
      agents: [...catalog.agents, { id: 'knowledge', kind: 'research', label: 'Knowledge', summary: 'Search knowledge', category: 'office', starter: '' }],
      enabledAgentIds: [...catalog.enabledAgentIds, 'knowledge'],
    } : catalog)
    if (path === '/api/desktop/releases/latest') return Response.json({ release })
    if (path === '/api/search?q=receipt') return Response.json([{ path: 'manuals/receiving.md', line: 2, text: 'Check the receipt number.' }])
    if (path === '/api/vault/note?path=manuals%2Freceiving.md') return Response.json({ title: 'Receiving guide', path: 'manuals/receiving.md',
      content: '# Receiving guide\nCheck the receipt number.\nCheck the organization.' })
    if (path === '/api/memories?scope=project&state=active&q=receipt') return Response.json({ memories: [
      { id: 'shared', title: 'Shared receipt guide', content: 'Shared receipt advice', scope: 'project', state: 'active' },
      { id: 'archived', title: 'Old procedure', content: 'Archived receipt note', scope: 'project', state: 'archived' },
      { id: 'private', title: 'Private receipt reminder', content: 'Private receipt advice', scope: 'personal', state: 'active' },
    ] })
    if (path === '/api/search?q=not-found') return Response.json([])
    if (path === '/api/desktop/releases' && managementOnly) return Response.json({ requiresReview: true, configured: true, releases: [{ ...published, state: 'draft' }] })
    if (path === '/api/client/settings') {
      if (init.method === 'PUT') {
        const settings = JSON.parse(String(init.body))
        if (settings.revision !== clientRevision) return Response.json({ error: 'Invalid revision' }, { status: 409 })
        if (settings.section === 'computer') computerUse = settings.value.enabled
        else if (settings.section === 'model') {
          const { scene, name, baseUrl, imageInput } = settings.value
          models = { ...models, [scene]: { name, baseUrl, imageInput, hasKey: true } }
        } else if (settings.section === 'management') {
          hasContextKey = management === settings.value.url && hasContextKey
          management = settings.value.url
        } else if (settings.section === 'context') {
          hasContextKey = !settings.value.clear && Boolean(settings.value.key)
        } else return Response.json({ error: 'Invalid settings' }, { status: 400 })
        clientRevision++
      }
      return Response.json({
        revision: clientRevision, workspace: '', models, computerUse, computerAvailable, management, hasContextKey, environment,
        runtime: { version: '0.2.6', engine: 'cc-haha', engineVersion: '0.7.7' },
        ...(miniProgramApiUrl && { miniProgramApiUrl }),
      })
    }
    if (path === '/api/client/test' && init.method === 'POST') {
      const { section } = JSON.parse(String(init.body))
      if (section === 'open-environment') return Response.json({ ok: true, text: 'Opened the query window' })
      if (section === 'computer-windows') return Response.json({ ok: true, text: 'Found one window', windows: [{ id: 'w-23', title: 'Fixture order window' }] })
      if (section === 'context-search') return Response.json({ ok: true, text: 'Found one passage', matches: [{ path: 'orders.md', line: 14, text: 'Verify the receipt.' }] })
      return Response.json({ ok: true, text: section === 'mini-program' ? 'API address is reachable'
        : section === 'context' ? 'Server resources connected' : 'Native component is ready' })
    }
    if (path === '/api/desktop/attachments' && init.method === 'POST') {
      const attachment = (init.body as FormData).get('files')
      if (!(attachment instanceof File)) return Response.json({ error: 'Missing file' }, { status: 400 })
      return Response.json({ attachments: [{ id: 'staged-attachment', name: attachment.name, warnings: [] }] }, { status: 201 })
    }
    if (path === '/api/tasks' && init.method === 'POST') {
      turns++
      if (JSON.parse(String(init.body)).requirementAction) generated = true
      return Response.json({ id: task.id }, { status: 202 })
    }
    if (path === '/api/tasks') return Response.json([task])
    if (path === '/api/tasks/task-one') return Response.json({
      ...task, ownerId,
      messages: [...task.messages, ...Array.from({ length: turns }, () => task.messages[0])],
    })
    if (path === '/api/tasks/task-one/artifacts') return Response.json([])
    if (path.startsWith('/api/tasks/task-one/requirements')) {
      if (!generated) return Response.json({ document: null, revisions: [] })
      const selected = path.endsWith('revision=1') ? earlier : revision
      return Response.json({
        document: { ...selected, taskId: task.id, sections: { overview: selected.title } },
        revisions: [revision, earlier],
      })
    }
    throw new Error(`Unexpected request ${path}`)
  })
  return calls
}

beforeAll(async () => {
  // Compile the upstream Markdown graph outside the interaction assertions.
  await import('./RequirementsPanel')
}, 30_000)

beforeEach(() => {
  window.history.replaceState(null, '', '/desktop/')
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
})

afterEach(() => {
  cleanup()
  localStorage.removeItem(LOCALE_STORAGE_KEY)
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('enterprise Pi workbench', () => {
  it('submits an actual requirements draft turn with cookie CSRF and opens the resulting task', async () => {
    const calls = mockServer()
    render(<PiWorkbenchApp />)

    fireEvent.click(await screen.findByRole('radio', { name: 'Generate a draft now' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Task instructions' }), { target: { value: '  Define the change  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send task' }))

    expect(await screen.findByRole('heading', { name: 'Change request' })).toBeInTheDocument()
    const request = calls.find((call) => call.path === '/api/tasks' && call.init.method === 'POST')?.init
    const headers = new Headers(request?.headers)
    expect(headers.get('x-csrf-token')).toBe('csrf-fixture')
    expect(headers.has('authorization')).toBe(false)
    expect(JSON.parse(String(request?.body))).toEqual({
      kind: 'research',
      agentId: 'requirements',
      groupId: 'requirements',
      prompt: 'Define the change',
      requirementAction: { type: 'draft' },
    })
  })

  it('clarifies first, then uses the follow-up prompt and attachments when generating a draft', async () => {
    const calls = mockServer({ initialDocument: false })
    render(<PiWorkbenchApp />)

    expect(await screen.findByRole('radio', { name: 'Clarify requirements first' })).toBeChecked()
    fireEvent.change(screen.getByRole('textbox', { name: 'Task instructions' }), { target: { value: 'Define the change' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send task' }))
    const generate = await screen.findByRole('button', { name: 'Generate a draft' }, lazyTimeout)
    const followUpPrompt = 'The manager must approve within three business days'
    fireEvent.change(screen.getByRole('textbox', { name: 'Task instructions' }), { target: { value: followUpPrompt } })
    fireEvent.change(screen.getByLabelText('Add attachments', { selector: 'input' }), {
      target: { files: [new File(['Approval rule'], 'approval.txt', { type: 'text/plain' })] },
    })
    expect(await screen.findByText('approval.txt')).toBeInTheDocument()
    fireEvent.click(generate)

    await waitFor(() => expect(calls.filter((call) => call.path === '/api/tasks' && call.init.method === 'POST')).toHaveLength(2))
    const [first, followUp] = calls.filter((call) => call.path === '/api/tasks' && call.init.method === 'POST')
      .map((call) => JSON.parse(String(call.init.body)))
    expect(first).not.toHaveProperty('requirementAction')
    expect(followUp).toMatchObject({
      kind: 'research', taskId: task.id, prompt: followUpPrompt, attachmentIds: ['staged-attachment'],
      requirementAction: { type: 'draft', revision: 0 },
    })
    expect(followUp).not.toHaveProperty('agentId')
    expect(await screen.findByRole('heading', { name: 'Current scope' }, lazyTimeout)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Task instructions' })).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Remove attachment approval.txt' })).not.toBeInTheDocument()
  })

  it('shows a historical revision without allowing edits or a follow-up in another owner’s task', async () => {
    mockServer({ ownerId: 'another-member' })
    window.history.replaceState(null, '', '/desktop/?task=task-one')
    render(<PiWorkbenchApp />)

    const versions = await screen.findByRole('combobox', { name: 'Document version' }, lazyTimeout)
    fireEvent.change(versions, { target: { value: '1' } })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Earlier scope' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Edit document' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Task instructions' })).not.toBeInTheDocument()
  })

  it('opens the release page from the desktop menu and compares installed versions numerically', async () => {
    mockServer({ release: published })
    window.history.replaceState(null, '', '/desktop/?view=updates')
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 PiWorkbenchDesktop/0.10.0')
    render(<PiWorkbenchApp />)

    expect(await screen.findByText('Installed version is newer', {}, lazyTimeout)).toBeInTheDocument()
    expect(screen.getByText('Installed 0.10.0')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download installer' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Publish version' })).not.toBeInTheDocument()
  })

  it('opens the same composer with local connection settings and no management login', async () => {
    const calls = mockServer({ localClient: true })
    render(<PiWorkbenchApp />)
    await screen.findByRole('textbox', { name: 'Task instructions' })
    expect(screen.queryByRole('button', { name: 'Sign in with access token' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'R&D Assistant' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '力源金蝶研发工作台' })).toBeInTheDocument()
    expect(document.title).toBe('力源金蝶研发工作台')
    expect(screen.queryByText('Runs on the server')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }))
    expect(await screen.findByRole('heading', { name: 'Connections' }, lazyTimeout)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'MCP connections' }))
    expect(screen.getByRole('heading', { name: 'MCP connections' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Computer Use' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Computer Use' }))
    expect(await screen.findByRole('heading', { name: 'Computer Use' }, lazyTimeout)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check component' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Test saved connection' })).not.toBeInTheDocument()
    expect(window.location.search).toBe('?view=connections&section=computer')
    expect(calls.some(call => call.path === '/api/client/settings')).toBe(true)
  })

  it('opens the web query from its own route and displays a cited line of the original note', async () => {
    const calls = mockServer()
    window.history.replaceState(null, '', '/desktop/?view=query')
    render(<PiWorkbenchApp />)

    expect(await screen.findByRole('heading', { name: 'Web query workbench' }, lazyTimeout)).toBeInTheDocument()
    const search = screen.getByRole('region', { name: 'Search project resources' })
    const keyword = within(search).getByRole('textbox', { name: 'Keyword' })
    fireEvent.change(keyword, { target: { value: ' receipt ' } })
    fireEvent.click(within(search).getByRole('button', { name: 'Search resources' }))
    expect(await within(search).findByText('manuals/receiving.md:2')).toBeInTheDocument()
    fireEvent.click(within(search).getByRole('button', { name: 'View source near line 2' }))
    const excerpt = await within(search).findByRole('region', { name: 'Source excerpt' })
    expect(await within(excerpt).findByText('Check the receipt number.')).toHaveAttribute('data-match', 'true')
    expect(within(excerpt).getByText('Check the organization.')).toBeInTheDocument()

    fireEvent.click(within(search).getByRole('radio', { name: 'Shared project memory' }))
    expect(await within(search).findByText('Shared receipt advice')).toBeInTheDocument()
    expect(within(search).queryByText('Private receipt advice')).not.toBeInTheDocument()
    expect(within(search).queryByText('Archived receipt note')).not.toBeInTheDocument()
    expect(within(search).queryByRole('region', { name: 'Source excerpt' })).not.toBeInTheDocument()
    expect(calls.some(call => call.path === '/api/memories?scope=project&state=active&q=receipt')).toBe(true)
    expect(calls.some(call => call.path.startsWith('/api/client/') || call.init.method === 'POST')).toBe(false)
  })

  it('leaves the web query accessible from the sidebar and reports an empty keyword result', async () => {
    mockServer()
    render(<PiWorkbenchApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Website query' }))
    const search = await screen.findByRole('region', { name: 'Search project resources' }, lazyTimeout)
    expect(window.location.search).toBe('?view=query')
    expect(within(search).getByRole('button', { name: 'Search resources' })).toBeDisabled()
    fireEvent.change(within(search).getByRole('textbox', { name: 'Keyword' }), { target: { value: 'not-found' } })
    fireEvent.click(within(search).getByRole('button', { name: 'Search resources' }))
    expect(await within(search).findByText('No matches. Try a shorter keyword.')).toBeInTheDocument()
  })

  it('opens the saved website and adds a document lookup to the existing draft before sending', async () => {
    const calls = mockServer({ localClient: true, environment: { name: 'Fixture UAT', url: 'http://uat.example.invalid/', dataCenter: '' } })
    render(<PiWorkbenchApp />)

    const tools = await screen.findByRole('region', { name: 'Quick tools' })
    expect(screen.getByText('Desktop 0.2.6 · cc-haha 0.7.7')).toBeInTheDocument()
    expect(within(tools).getByText('Fixture UAT')).toBeInTheDocument()
    fireEvent.click(within(tools).getByRole('button', { name: 'Website query' }))
    const panel = within(tools).getByRole('region', { name: 'Website query' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Open query window' }))
    await within(panel).findByText('Opened the query window')
    expect(JSON.parse(String(calls.find(call => call.path === '/api/client/test')?.init.body))).toEqual({ section: 'open-environment' })

    const composer = screen.getByRole('textbox', { name: 'Task instructions' }) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'Keep this context' } })
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Document type' }), { target: { value: 'order' } })
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Document number' }), { target: { value: ' PO-2419 ' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Add lookup to chat' }))
    expect(composer.value).toMatch(/^Keep this context[\s\S]+Purchase order[\s\S]+PO-2419/)
    expect(composer).toHaveFocus()
    expect(calls.some(call => call.path === '/api/tasks' && call.init.method === 'POST')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Send task' }))
    await screen.findByRole('heading', { name: 'Change request' })
    const taskRequest = calls.find(call => call.path === '/api/tasks' && call.init.method === 'POST')
    expect(JSON.parse(String(taskRequest?.init.body))).toMatchObject({ agentId: 'knowledge', kind: 'research', prompt: expect.stringContaining('PO-2419') })
  })

  it('reads window titles and cited server excerpts from tools without creating a conversation', async () => {
    const calls = mockServer({ localClient: true, computerEnabled: true, contextKeySaved: true, management: 'https://fixture.example.invalid' })
    render(<PiWorkbenchApp />)
    const tools = await screen.findByRole('region', { name: 'Quick tools' })

    fireEvent.click(within(tools).getByRole('button', { name: 'Computer Use' }))
    fireEvent.click(within(tools).getByRole('button', { name: 'View available windows' }))
    fireEvent.click(await within(tools).findByRole('button', { name: 'Fixture order window' }))
    expect((screen.getByRole('textbox', { name: 'Task instructions' }) as HTMLTextAreaElement).value).toContain('w-23')

    fireEvent.click(within(tools).getByRole('button', { name: 'Server resources' }))
    const panel = within(tools).getByRole('region', { name: 'Server resources' })
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Keyword' }), { target: { value: ' receipt ' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Search resources' }))
    expect(await within(panel).findByText('orders.md:14')).toBeInTheDocument()
    expect(within(panel).getByText('Verify the receipt.')).toBeInTheDocument()
    expect(calls.filter(call => call.path === '/api/client/test').map(call => JSON.parse(String(call.init.body))))
      .toEqual([{ section: 'computer-windows' }, { section: 'context-search', query: 'receipt' }])
    expect(calls.some(call => call.path === '/api/tasks' && call.init.method === 'POST')).toBe(false)

    fireEvent.click(within(panel).getByRole('button', { name: 'Connection settings' }))
    expect(await screen.findByRole('radio', { name: 'Server resources' }, lazyTimeout)).toBeChecked()
    expect(window.location.search).toBe('?view=connections&section=context')
  })

  it('deep-links to the installed computer component and applies the global switch only after consent', async () => {
    const calls = mockServer({ localClient: true })
    window.history.replaceState(null, '', '/desktop/?view=connections&section=computer')
    render(<PiWorkbenchApp />)

    expect(await screen.findByText('Component installed', {}, lazyTimeout)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Computer Use' })).toBeChecked()
    const writes = () => calls.filter(call => call.path === '/api/client/settings' && call.init.method === 'PUT')
      .map(call => JSON.parse(String(call.init.body)))

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    const consent = await screen.findByRole('dialog')
    expect(within(consent).getByText(/inspect windows in this Windows session/)).toBeInTheDocument()
    expect(writes()).toHaveLength(0)
    fireEvent.click(within(consent).getByRole('button', { name: 'Cancel' }))
    expect(writes()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Enable' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeEnabled()
    expect(writes()).toEqual([
      { revision: 0, section: 'computer', value: { enabled: true } },
      { revision: 1, section: 'computer', value: { enabled: false } },
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Check component' }))
    expect(await screen.findByText('Native component is ready')).toBeInTheDocument()
    expect(calls.filter(call => call.path === '/api/client/test').map(call => JSON.parse(String(call.init.body))))
      .toEqual([{ section: 'computer', scene: 'default' }])
  })

  it('shows the unavailable computer component without permitting enablement', async () => {
    mockServer({ localClient: true, computerAvailable: false })
    window.history.replaceState(null, '', '/desktop/?view=connections&section=computer')
    render(<PiWorkbenchApp />)

    expect(await screen.findByText('Component unavailable', {}, lazyTimeout)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enable' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Check component' })).toBeDisabled()
  })

  it('shows the mini program as its own environment card and tests only the address', async () => {
    const miniProgramApiUrl = 'https://mini-program.example.invalid/api'
    const calls = mockServer({ localClient: true, miniProgramApiUrl })
    window.history.replaceState(null, '', '/desktop/?view=connections&section=environment')
    render(<PiWorkbenchApp />)

    const card = await screen.findByRole('region', { name: 'Kingdee Xinghan WeChat Mini Program' }, lazyTimeout)
    expect(within(card).getByText(miniProgramApiUrl)).toBeInTheDocument()
    expect(within(card).getByText('This check only tests whether the address is reachable.')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Test API address' }))
    expect(await within(card).findByText('API address is reachable')).toBeInTheDocument()
    const request = calls.find(call => call.path === '/api/client/test')
    expect(JSON.parse(String(request?.init.body))).toEqual({ section: 'mini-program' })
  })

  it('uses a dedicated write-only resource token from the saved server settings', async () => {
    const calls = mockServer({ localClient: true, management: 'https://fixture.example.invalid' })
    window.history.replaceState(null, '', '/desktop/?view=connections&section=context')
    render(<PiWorkbenchApp />)

    const card = await screen.findByRole('region', { name: 'Server resources' }, lazyTimeout)
    const token = within(card).getByLabelText('Resource connection token')
    const test = within(card).getByRole('button', { name: 'Test saved connection' })
    expect(token).toHaveAttribute('type', 'password')
    expect(test).toBeDisabled()
    fireEvent.change(token, { target: { value: 'F'.repeat(43) } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(test).toBeEnabled())
    expect(token).toHaveValue('')
    expect(calls.filter(call => call.path === '/api/client/settings' && call.init.method === 'PUT').map(call => JSON.parse(String(call.init.body))))
      .toEqual([{ revision: 0, section: 'context', value: { key: 'F'.repeat(43) } }])

    fireEvent.click(test)
    expect(await within(card).findByText('Server resources connected')).toBeInTheDocument()
    expect(calls.filter(call => call.path === '/api/client/test').map(call => JSON.parse(String(call.init.body))))
      .toEqual([{ section: 'context' }])
    fireEvent.click(screen.getByRole('radio', { name: 'Updates' }))
    fireEvent.change(screen.getByDisplayValue('https://fixture.example.invalid'), { target: { value: 'https://other.example.invalid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved')
    fireEvent.click(screen.getByRole('radio', { name: 'Server resources' }))
    expect(within(await screen.findByRole('region', { name: 'Server resources' })).getByRole('button', { name: 'Test saved connection' })).toBeDisabled()
  })

  it('saves the image input setting per model and treats missing settings as disabled', async () => {
    const model = { name: 'Fixture model', baseUrl: 'https://model.example.invalid/v1', hasKey: true }
    const calls = mockServer({ localClient: true, models: { default: model, review: { ...model, imageInput: true } } })
    window.history.replaceState(null, '', '/desktop/?view=connections&section=model')
    render(<PiWorkbenchApp />)

    const imageInput = await screen.findByRole('checkbox', { name: 'Supports image input' }, lazyTimeout)
    const scene = screen.getByRole('combobox', { name: 'Task scenarios' })
    expect(imageInput).not.toBeChecked()
    fireEvent.change(scene, { target: { value: 'review' } })
    expect(imageInput).toBeChecked()
    fireEvent.change(scene, { target: { value: 'default' } })
    expect(imageInput).not.toBeChecked()
    fireEvent.click(imageInput)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(calls.some(call => call.path === '/api/client/settings' && call.init.method === 'PUT')).toBe(true))
    const saved = calls.find(call => call.path === '/api/client/settings' && call.init.method === 'PUT')
    expect(JSON.parse(String(saved?.init.body))).toMatchObject({ section: 'model', value: { scene: 'default', imageInput: true } })
  })

  it('exposes the approval queue in management mode without loading conversations', async () => {
    const calls = mockServer({ managementOnly: true })
    render(<PiWorkbenchApp />)
    expect(await screen.findByRole('button', { name: 'Submit for review' }, lazyTimeout)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publish version' })).not.toBeInTheDocument()
    expect(calls.some(call => call.path === '/api/tasks')).toBe(false)
  })
})
