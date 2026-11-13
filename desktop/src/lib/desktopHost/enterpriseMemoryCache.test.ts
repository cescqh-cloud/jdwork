import { expect, it, vi } from 'vitest'
import { enterpriseMemoryResponses, type EnterpriseMemoryChanges, type EnterpriseMemoryHost } from './enterpriseMemory'
import { memoryEntryKey, pruneMemoryCache, syncMemoryCache } from './enterpriseMemoryCache'

const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const expiry = '2026-11-10T12:05:00Z'
const recordExpiry = '2026-11-10T12:02:00Z'
const now = Date.parse('2026-11-10T12:00:00Z')
const key = memoryEntryKey('memory', id)
const identity = { resourceType: 'memory' as const, id, revision: 1 }
const upsert = (sequence: number) => ({
  ...identity, sequence, operation: 'upsert' as const, record: {
    id, revision: 1, scope: 'user_private' as const, ownerId: id, projectId: null, departmentId: null,
    excerpt: '采购资料', classification: 'internal' as const, status: 'active' as const,
    lastVerifiedAt: null, expiresAt: recordExpiry, updatedAt: new Date(now).toISOString(),
  },
})
const tombstone = (sequence: number) => ({ ...identity, sequence, operation: 'tombstone' as const, reason: 'access_revoked' as const })
const page = (cursor: number, hasMore: boolean, changes: EnterpriseMemoryChanges['changes']): EnterpriseMemoryChanges =>
  ({ cursor, hasMore, changes, aclVersion: 1, cacheExpiresAt: expiry })

it('uses cursor order for tombstones and same-revision re-grants, and never extends record expiry', async () => {
  const send = vi.fn(({ cursor }: { cursor: number }) => Promise.resolve({ ok: true, data: cursor === 0
    ? page(2, true, [upsert(1), tombstone(2)]) : page(4, false, [upsert(3)]) }))
  const replay = await syncMemoryCache(send as unknown as EnterpriseMemoryHost, null, Date.parse(expiry) + 1000, vi.fn(), () => now)
  expect(replay.ok).toBe(true)
  if (!replay.ok) return
  expect(send.mock.calls).toEqual([[{ action: 'changes', cursor: 0 }], [{ action: 'changes', cursor: 2 }]])
  expect(replay.cache.cursor).toBe(4)
  expect(replay.cache.entries.get(key)?.revision).toBe(1)
  expect(pruneMemoryCache(replay.cache, Date.parse(recordExpiry))?.entries.has(key)).toBe(false)
  expect(pruneMemoryCache(replay.cache, Date.parse(expiry))).toBeNull()
})

it('clears before replaying a stale cursor and rejects a misordered page', async () => {
  const previous = { cursor: 4, aclVersion: 1, expiresAt: Date.parse(expiry), entries: new Map([[key, upsert(1)]]) }
  const clear = vi.fn()
  const send = vi.fn(({ cursor }: { cursor: number }) => {
    if (cursor !== 0) return Promise.resolve({ ok: false, issue: 'reset' })
    expect(clear).toHaveBeenCalledTimes(1)
    return Promise.resolve({ ok: true, data: page(5, false, [upsert(4), tombstone(2)]) })
  })
  expect(await syncMemoryCache(send as unknown as EnterpriseMemoryHost, previous, Date.parse(expiry), clear, () => now)).toEqual({ ok: false, issue: 'reset' })
  expect(send.mock.calls.map(([input]) => input.cursor)).toEqual([4, 0])
})

it('projects synchronized bodies and arbitrary response fields to a bounded summary', () => {
  const event = upsert(1)
  const data = enterpriseMemoryResponses.changes.parse(page(1, false, [{ ...event, record: { ...event.record,
    ...{ body: '测试'.repeat(200), accessToken: 'must-not-return' },
  } }]))
  expect(data.changes[0]).toMatchObject({ record: { excerpt: '测试'.repeat(90) } })
  expect(JSON.stringify(data)).not.toContain('accessToken')
  expect(JSON.stringify(data)).not.toContain('"body"')
})
