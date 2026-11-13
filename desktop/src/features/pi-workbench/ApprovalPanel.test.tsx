import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LOCALE_STORAGE_KEY } from '@/i18n/locale'
import { PiWorkbenchApp } from './PiWorkbenchApp'

const project = { id: 'fixture', name: 'Business workbench', description: '' }
const member = { id: 'member', name: 'Applicant', admin: false }
const administrator = { id: 'admin', name: 'Reviewer', admin: true }
const date = '2026-11-10T02:00:00Z'
const requirement = {
  id: 'fixture-requirement', title: 'Requirements for issue review', kind: 'requirement', status: 'pending',
  submittedBy: member, submittedAt: date, snapshotHash: 'a'.repeat(64),
  snapshot: { revision: 3, content: '# Frozen requirements\n\n<script>alert(1)</script>' },
}

function mockServer({ identity = administrator, managementOnly = false, localClient = false, records = [requirement], older = [] as typeof requirement[] } = {}) {
  let approvals = [...records]
  const requests: { path: string, method?: string, body: unknown, csrf: string | null }[] = []
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const path = String(input)
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, method: init.method, body, csrf: new Headers(init.headers).get('x-csrf-token') })
    if (path === '/auth/config') return Response.json({ project, tokenLogin: false, dingTalkLogin: true, managementOnly, localClient })
    if (path === '/api/me') return Response.json({ project, identity, csrfToken: 'fixture-csrf' })
    if (path === '/api/desktop/workbench') return Response.json({
      name: project.name, agents: [], enabledAgentIds: [], groups: [], requirementSections: [],
    })
    if (path === '/api/tasks') return Response.json([])
    if (path === '/api/desktop/model' || path === '/api/client/settings') return Response.json({})
    if (path === '/api/approvals' && init.method === 'GET') return Response.json({ approvals, nextCursor: older.length ? 'fixture+/' : undefined })
    if (path === '/api/approvals?before=fixture%2B%2F') return Response.json({ approvals: older })
    if (path === '/api/approvals' && init.method === 'POST') {
      const approval = { ...body, id: 'fixture-submission', status: 'pending', submittedBy: identity, submittedAt: date, snapshotHash: 'b'.repeat(64) }
      approvals = [approval, ...approvals]
      return Response.json({ approval }, { status: 201 })
    }
    if (path === `/api/approvals/${requirement.id}` && init.method === 'PATCH') {
      const approval = { ...requirement, status: body.action === 'return' ? 'returned' : 'approved', decision: { by: identity, at: date, comment: body.comment } }
      approvals = approvals.map((item) => item.id === requirement.id ? approval : item)
      return Response.json({ approval })
    }
    throw new Error(`Unexpected request ${path}`)
  })
  return requests
}

beforeEach(() => {
  window.history.replaceState(null, '', '/desktop/?view=approvals')
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
})

afterEach(() => {
  cleanup()
  localStorage.removeItem(LOCALE_STORAGE_KEY)
  vi.unstubAllGlobals()
})

it('opens the server approval center, submits an ERP proposal and reviews an immutable requirements snapshot', async () => {
  const calls = mockServer({ managementOnly: true })
  render(<PiWorkbenchApp />)

  expect(await screen.findByRole('heading', { name: 'Approval center' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Desktop client' })).toHaveAttribute('href', '/desktop/?view=updates')
  fireEvent.change(screen.getByLabelText('Request type'), { target: { value: 'erp_write' } })
  fireEvent.change(screen.getByLabelText('Request title', { exact: false }), { target: { value: 'Change order quantity' } })
  fireEvent.change(screen.getByLabelText('Target environment'), { target: { value: 'test' } })
  fireEvent.change(screen.getByLabelText('ERP object or form', { exact: false }), { target: { value: 'Purchase order' } })
  fireEvent.change(screen.getByLabelText('Document number', { exact: false }), { target: { value: 'PO-001' } })
  fireEvent.change(screen.getByLabelText('Proposed change', { exact: false }), { target: { value: 'Quantity: 4 → 5' } })
  fireEvent.change(screen.getByLabelText('Reason for change', { exact: false }), { target: { value: 'Correct the planned receipt quantity' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }))
  expect(await screen.findByText('Change order quantity')).toBeInTheDocument()
  expect(calls.find((call) => call.method === 'POST')).toMatchObject({
    path: '/api/approvals', csrf: 'fixture-csrf', body: {
      kind: 'erp_write', title: 'Change order quantity', snapshot: {
        environment: 'test', object: 'Purchase order', documentNumber: 'PO-001', change: 'Quantity: 4 → 5', reason: 'Correct the planned receipt quantity',
      },
    },
  })

  const title = screen.getByText(requirement.title)
  const record = title.closest('details')!
  fireEvent.click(title.closest('summary')!)
  expect(within(record).getByText(/<script>alert\(1\)<\/script>/u)).toBeInTheDocument()
  expect(record.querySelector('script')).toBeNull()
  fireEvent.click(within(record).getByRole('button', { name: 'Return for changes' }))
  const decision = screen.getByRole('dialog')
  expect(within(decision).getByRole('button', { name: 'Return for changes' })).toBeDisabled()
  fireEvent.change(within(decision).getByLabelText('Review comment', { exact: false }), { target: { value: 'Add the affected system' } })
  fireEvent.click(within(decision).getByRole('button', { name: 'Return for changes' }))

  const history = await screen.findByRole('region', { name: 'Approval history' })
  await waitFor(() => expect(within(history).getByText(requirement.title)).toBeInTheDocument())
  expect(calls.find((call) => call.method === 'PATCH')).toMatchObject({
    path: `/api/approvals/${requirement.id}`, csrf: 'fixture-csrf', body: { action: 'return', comment: 'Add the affected system' },
  })
})

it('lets a member submit their requirements revision and only withdraw their own pending requests', async () => {
  const calls = mockServer({ identity: member, records: [] })
  render(<PiWorkbenchApp />)

  fireEvent.change(await screen.findByLabelText('Request title', { exact: false }), { target: { value: 'Order requirements' } })
  fireEvent.change(screen.getByLabelText('Document version', { exact: false }), { target: { value: '2' } })
  fireEvent.change(screen.getByLabelText('Requirements text', { exact: false }), { target: { value: '# Order requirements\n\nRead-only query' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }))

  const title = await screen.findByText('Order requirements')
  fireEvent.click(title.closest('summary')!)
  expect(screen.getByRole('button', { name: 'Withdraw request' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
    kind: 'requirement', title: 'Order requirements', snapshot: { revision: 2, content: '# Order requirements\n\nRead-only query' },
  })
})

it('prefills a Workbench Markdown revision and finds older approval records', async () => {
  const older = { ...requirement, id: 'older', title: 'Previously approved scope', status: 'approved' }
  const calls = mockServer({ older: [older] })
  render(<PiWorkbenchApp />)

  const markdown = '# Exported requirements\r\n\r\n任务 fixture · 修订 7 · 草稿 · 2026-11-10 · member · 手工编辑\r\n\r\n## Scope\r\n\r\nRead the receipt.'
  const file = new File([markdown], 'scope.md', { type: 'text/markdown' })
  Object.defineProperty(file, 'text', { value: async () => markdown })
  fireEvent.change(await screen.findByLabelText('Import Markdown'), { target: { files: [file] } })
  await waitFor(() => expect(screen.getByLabelText('Request title', { exact: false })).toHaveValue('Exported requirements'))
  expect(screen.getByLabelText('Document version', { exact: false })).toHaveValue('7')
  expect(screen.getByLabelText('Requirements text', { exact: false })).toHaveValue(markdown.replaceAll('\r', ''))

  fireEvent.click(await screen.findByRole('button', { name: 'Load more records' }))
  expect(await screen.findByText('Previously approved scope')).toBeInTheDocument()
  expect(calls.some((call) => call.path === '/api/approvals?before=fixture%2B%2F')).toBe(true)
  expect(screen.queryByRole('button', { name: 'Load more records' })).not.toBeInTheDocument()
})

it('does not open the server-only approval route in local client mode', async () => {
  const calls = mockServer({ localClient: true })
  render(<PiWorkbenchApp />)

  expect(await screen.findByRole('button', { name: 'New task' })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Approval center' })).not.toBeInTheDocument()
  expect(calls.some((call) => call.path === '/api/approvals')).toBe(false)
})
