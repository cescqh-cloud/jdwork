import { create } from 'zustand'
import type { EnterpriseModelCatalog } from '../../../src/shared/enterpriseModels'
import { getDesktopHost } from '../lib/desktopHost'

const refreshIntervalMs = 20_000
let pending: Promise<EnterpriseModelCatalog | null> | null = null
let expiry: ReturnType<typeof setTimeout> | undefined
let generation = 0

export const useEnterpriseModelStore = create<{
  catalog: EnterpriseModelCatalog | null
  refresh: () => Promise<EnterpriseModelCatalog | null>
  clear: () => void
}>((set) => ({
  catalog: null,
  refresh() {
    if (pending) return pending
    const host = getDesktopHost().enterprise
    if (!host?.models) return Promise.resolve(null)
    const id = generation
    const task = Promise.resolve().then(() => host.models()).catch(() => null).then(catalog => {
      if (id !== generation) return null
      clearTimeout(expiry)
      const remaining = catalog ? Date.parse(catalog.expiresAt) - Date.now() : 0
      if (remaining <= 0) catalog = null
      set({ catalog })
      if (catalog) expiry = setTimeout(() => set({ catalog: null }), remaining)
      return catalog
    }).finally(() => { if (pending === task) pending = null })
    pending = task
    return task
  },
  clear() {
    generation++
    pending = null
    clearTimeout(expiry)
    set({ catalog: null })
  },
}))

export function installEnterpriseModelSync() {
  if (!getDesktopHost().enterprise?.models) return
  const refreshVisible = () => {
    if (document.visibilityState !== 'hidden') void useEnterpriseModelStore.getState().refresh()
  }
  refreshVisible()
  const timer = window.setInterval(refreshVisible, refreshIntervalMs)
  window.addEventListener('focus', refreshVisible)
  document.addEventListener('visibilitychange', refreshVisible)
  return () => {
    window.clearInterval(timer)
    window.removeEventListener('focus', refreshVisible)
    document.removeEventListener('visibilitychange', refreshVisible)
    useEnterpriseModelStore.getState().clear()
  }
}
