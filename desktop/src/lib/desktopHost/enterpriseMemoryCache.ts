import type { EnterpriseMemoryChanges, EnterpriseMemoryHost, EnterpriseMemoryIssue } from './enterpriseMemory'

type Upsert = Extract<EnterpriseMemoryChanges['changes'][number], { operation: 'upsert' }>
export type EnterpriseMemoryEntry = Pick<Upsert, 'id' | 'revision'> & (Omit<Extract<Upsert, { resourceType: 'memory' }>, 'sequence' | 'operation' | 'id' | 'revision'>
  | Omit<Extract<Upsert, { resourceType: 'knowledge' }>, 'sequence' | 'operation' | 'id' | 'revision'>)
export type EnterpriseMemoryCache = {
  cursor: number
  aclVersion: number
  expiresAt: number
  entries: Map<string, EnterpriseMemoryEntry>
}

export function memoryEntryKey(resourceType: EnterpriseMemoryEntry['resourceType'], id: string): string {
  return `${resourceType}:${id}`
}

export function memoryEntryExpiresAt(entry: EnterpriseMemoryEntry): number {
  return entry.resourceType === 'memory' && entry.record.expiresAt ? Date.parse(entry.record.expiresAt) : Infinity
}

export function pruneMemoryCache(cache: EnterpriseMemoryCache | null, now: number): EnterpriseMemoryCache | null {
  if (!cache || cache.expiresAt <= now) return null
  const expired = [...cache.entries].filter(([, entry]) => memoryEntryExpiresAt(entry) <= now)
  if (!expired.length) return cache
  const entries = new Map(cache.entries)
  for (const [key] of expired) entries.delete(key)
  return { ...cache, entries }
}

type ReplayResult = { ok: true; cache: EnterpriseMemoryCache } | { ok: false; issue: EnterpriseMemoryIssue }

async function readPages(host: EnterpriseMemoryHost, previous: EnterpriseMemoryCache | null, policyExpiry: number, now: () => number): Promise<ReplayResult> {
  let cursor = previous?.cursor ?? 0
  let expiresAt = policyExpiry
  const entries = new Map(previous?.entries)
  // A history page can omit obsolete upserts. Apply sequence, including a
  // re-grant of the same record revision, and advance to the server cursor.
  for (let pageNumber = 0; pageNumber < 200; pageNumber++) {
    const page = await host({ action: 'changes', cursor })
    if (!page.ok) return page
    const { data } = page
    if (data.cursor < cursor || (data.hasMore && data.cursor === cursor)) return { ok: false, issue: 'reset' }
    let sequence = cursor
    for (const change of data.changes) {
      if (change.sequence <= sequence || change.sequence > data.cursor) return { ok: false, issue: 'reset' }
      sequence = change.sequence
      const key = memoryEntryKey(change.resourceType, change.id)
      if (change.operation === 'tombstone') {
        entries.delete(key)
      } else {
        if (change.id !== change.record.id || change.revision !== change.record.revision
          || (change.resourceType === 'memory' && change.record.status !== 'active')
          || (change.resourceType === 'knowledge' && (change.record.citation.documentId !== change.id
            || change.record.citation.revision !== change.revision))) return { ok: false, issue: 'reset' }
        entries.set(key, change)
      }
    }
    cursor = data.cursor
    expiresAt = Math.min(expiresAt, Date.parse(data.cacheExpiresAt))
    if (!data.hasMore) {
      const cache = pruneMemoryCache({ cursor, aclVersion: data.aclVersion, expiresAt, entries }, now())
      return cache ? { ok: true, cache } : { ok: false, issue: 'reset' }
    }
  }
  return { ok: false, issue: 'reset' }
}

export async function syncMemoryCache(host: EnterpriseMemoryHost, previous: EnterpriseMemoryCache | null, policyExpiry: number,
  clear: () => void, now = Date.now): Promise<ReplayResult> {
  const live = pruneMemoryCache(previous, now())
  if (previous && !live) clear()
  const result = await readPages(host, live, policyExpiry, now)
  if (!result.ok && result.issue === 'reset') {
    clear()
    if (live?.cursor) return readPages(host, null, policyExpiry, now)
  }
  return result
}
