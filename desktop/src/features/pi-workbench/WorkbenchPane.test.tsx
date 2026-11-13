import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { lazy } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { LOCALE_STORAGE_KEY } from '@/i18n/locale'
import { WorkbenchPane } from './WorkbenchPane'

afterEach(() => {
  cleanup()
  localStorage.removeItem(LOCALE_STORAGE_KEY)
  vi.restoreAllMocks()
})

it('keeps navigation usable and offers a page refresh when a panel download fails', async () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const OfflinePanel = lazy(async () => { throw new TypeError('Failed to fetch dynamically imported module') })
  const navigate = vi.fn()
  render(<>
    <button type="button" onClick={navigate}>New task</button>
    <WorkbenchPane loadingLabel="Loading conversation"><OfflinePanel /></WorkbenchPane>
  </>)

  expect(await screen.findByRole('alert')).toHaveTextContent('This panel could not load.')
  expect(screen.getByRole('button', { name: 'Refresh page' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'New task' }))
  expect(navigate).toHaveBeenCalledOnce()
})
