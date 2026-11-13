import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopEnterpriseHost, EnterpriseBootstrap } from './enterprise'
import type { EnterpriseMemoryHost, EnterpriseMemoryIssue, EnterpriseMemoryScopes, EnterpriseMemorySummary } from './enterpriseMemory'
import { memoryEntryExpiresAt, pruneMemoryCache, syncMemoryCache, type EnterpriseMemoryCache } from './enterpriseMemoryCache'

export function useEnterpriseMemory(host: DesktopEnterpriseHost, memory: EnterpriseMemoryHost) {
  const [cache, setCache] = useState<EnterpriseMemoryCache | null>(null)
  const [user, setUser] = useState<EnterpriseBootstrap['user'] | null>(null)
  const [candidates, setCandidates] = useState<EnterpriseMemorySummary[]>([])
  const [scopes, setScopes] = useState<EnterpriseMemoryScopes | null>(null)
  const [issue, setIssue] = useState<EnterpriseMemoryIssue | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [generation, setGeneration] = useState(0)
  const identity = useRef<string | null>(null)
  const epoch = useRef(0)
  const live = useRef(false)
  const snapshot = useRef<EnterpriseMemoryCache | null>(null)
  const pending = useRef<Promise<void> | null>(null)
  const commit = useCallback((next: EnterpriseMemoryCache | null) => {
    snapshot.current = next
    setCache(next)
  }, [])
  const clear = useCallback(() => {
    epoch.current++
    setGeneration(epoch.current)
    commit(null)
    setCandidates([])
    setScopes(null)
  }, [commit])
  const prune = useCallback(() => {
    const now = Date.now()
    const current = snapshot.current
    const next = pruneMemoryCache(current, now)
    if (current && !next) clear()
    else if (current !== next) commit(next)
    setCandidates(items => items.filter(item => !item.expiresAt || Date.parse(item.expiresAt) > now))
  }, [clear, commit])

  const refresh = useCallback(() => {
    if (pending.current) return pending.current
    prune()
    setSyncing(true)
    const run = (async () => {
      const connection = await host.sync(true)
      if (!live.current) return
      const bootstrap = connection.bootstrap
      if (connection.state === 'unavailable') {
        setCandidates([])
        setIssue('unavailable')
        return
      }
      if (connection.state !== 'connected' || !bootstrap?.policy.features.memories) {
        identity.current = null
        clear()
        setUser(null)
        setIssue(connection.state === 'connected' ? 'forbidden' : 'unbound')
        return
      }
      const key = `${connection.origin}|${bootstrap.device.id}|${bootstrap.user.id}`
      if (key !== identity.current) {
        clear()
        identity.current = key
      }
      const policyExpiry = Date.parse(bootstrap.policy.expiresAt)
      const result = await syncMemoryCache(memory, snapshot.current, policyExpiry, () => { if (live.current) clear() })
      if (!live.current || identity.current !== key) return
      if (!result.ok) {
        if (result.issue !== 'unavailable') clear()
        setCandidates([])
        setIssue(result.issue)
        return
      }
      if (snapshot.current && snapshot.current.aclVersion !== result.cache.aclVersion) clear()
      commit(result.cache)
      setUser(bootstrap.user)
      setIssue(null)
      const [memberships, drafts] = await Promise.all([memory({ action: 'scopes' }), memory({ action: 'candidates' })])
      if (!live.current || identity.current !== key || snapshot.current !== result.cache) return
      if ([memberships, drafts].some(response => !response.ok && response.issue === 'unbound')) {
        clear()
        setUser(null)
        setIssue('unbound')
        return
      }
      setScopes(memberships.ok ? memberships.data : null)
      setCandidates(drafts.ok ? drafts.data.items.filter(item => !item.expiresAt || Date.parse(item.expiresAt) > Date.now()) : [])
    })().catch(() => {
      if (live.current) {
        setCandidates([])
        setIssue('unavailable')
      }
    }).finally(() => {
      if (pending.current === run) pending.current = null
      if (live.current) setSyncing(false)
    })
    pending.current = run
    return run
  }, [clear, commit, host, memory, prune])

  const refreshAfterMutation = useCallback(async () => {
    await pending.current
    if (live.current) await refresh()
  }, [refresh])

  useEffect(() => {
    live.current = true
    void refresh()
    const interval = window.setInterval(() => void refresh(), 15_000)
    const onFocus = () => { prune(); void refresh() }
    window.addEventListener('focus', onFocus)
    return () => {
      live.current = false
      epoch.current++
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [prune, refresh])

  useEffect(() => {
    if (!cache) return
    let deadline = cache.expiresAt
    for (const entry of cache.entries.values()) deadline = Math.min(deadline, memoryEntryExpiresAt(entry))
    for (const item of candidates) if (item.expiresAt) deadline = Math.min(deadline, Date.parse(item.expiresAt))
    const timer = window.setTimeout(prune, Math.max(0, Math.min(deadline - Date.now(), 2_147_483_647)))
    return () => window.clearTimeout(timer)
  }, [cache, candidates, prune])

  return { cache, user, scopes, candidates, issue, syncing, refresh, refreshAfterMutation, clear, generation, epoch, live }
}
