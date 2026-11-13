import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import { enterpriseDemandDraftSchema, type EnterpriseDemandDraft } from '../../src/lib/desktopHost/enterpriseDemand'
import {
  enterpriseDemandLocalRecordSchema, type EnterpriseDemandCloudDraft, type EnterpriseDemandLocalRecord,
  type EnterpriseDemandLatestDraft, type EnterpriseDemandLocalRequest, type EnterpriseDemandLocalSummary,
} from '../../src/lib/desktopHost/enterpriseDemandLocal'

const maxDrafts = 150
const maxEncryptedSize = 256 * 1024
const filePattern = /^[a-f0-9-]{36}\.enc$/u
const fields = {
  binding: z.string(), record: enterpriseDemandLocalRecordSchema,
  pending: z.strictObject({ key: z.uuid(), draft: enterpriseDemandDraftSchema }).nullable(),
}
const vaultEntryV2 = z.strictObject({ version: z.literal(2), ...fields, baseDraft: enterpriseDemandDraftSchema.nullable() })
const vaultEntry = z.discriminatedUnion('version', [z.strictObject({ version: z.literal(1), ...fields }), vaultEntryV2])
type VaultEntry = z.infer<typeof vaultEntryV2>
export type DemandDraftScope = { origin: string; deviceId: string }
type DemandDraftEncryption = { encryptString(value: string): Buffer; decryptString(value: Buffer): string }
type Save = Extract<EnterpriseDemandLocalRequest, { action: 'save' }>
type Sync = Extract<EnterpriseDemandLocalRequest, { action: 'sync' }>
type Merge = Extract<EnterpriseDemandLocalRequest, { action: 'merge' }>

export class DemandDraftVaultError extends Error {
  constructor(readonly issue: 'localStorage' | 'conflict' | 'notFound') { super(issue) }
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function sameDraft(left: EnterpriseDemandDraft, right: EnterpriseDemandDraft) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class EnterpriseDemandDraftVault {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly directory: string, private readonly encryption: DemandDraftEncryption) {}

  list(scope: DemandDraftScope) {
    return this.serial(async () => {
      const drafts: EnterpriseDemandLocalSummary[] = []
      let unreadable = 0
      for (const name of await this.entries(scope)) {
        try {
          const entry = await this.read(scope, name.slice(0, -4))
          if (!entry) continue
          const { draft, ...summary } = entry.record
          drafts.push({ ...summary, title: draft.title })
        } catch { unreadable++ }
      }
      drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      return { deviceId: scope.deviceId, drafts, unreadable }
    })
  }

  get(scope: DemandDraftScope, id: string, expectedRevision?: number) {
    return this.serial(async () => (await this.require(scope, id, expectedRevision)).record)
  }

  comparison(scope: DemandDraftScope, id: string, expectedRevision?: number) {
    return this.serial(async () => {
      const entry = await this.require(scope, id, expectedRevision)
      return { local: entry.record, baseDraft: entry.baseDraft, hasPending: entry.pending !== null }
    })
  }

  save(scope: DemandDraftScope, input: Save) {
    return this.serial(async () => {
      const prior = await this.read(scope, input.id)
      if ((prior?.record.revision ?? null) !== input.expectedLocalRevision) throw new DemandDraftVaultError('conflict')
      if (!prior && (await this.entries(scope)).length >= maxDrafts) throw new DemandDraftVaultError('localStorage')
      if (prior && sameDraft(prior.record.draft, input.draft)) return prior.record
      const record = enterpriseDemandLocalRecordSchema.parse({
        id: input.id, revision: (prior?.record.revision ?? 0) + 1, updatedAt: new Date().toISOString(),
        cloud: prior ? prior.record.cloud : input.cloud, draft: input.draft,
      })
      const baseDraft = prior ? prior.baseDraft : input.cloud ? input.baseDraft ?? null : null
      await this.write(scope, { version: 2, binding: this.binding(scope), record, pending: prior?.pending ?? null, baseDraft })
      return record
    })
  }

  prepare(scope: DemandDraftScope, input: Sync) {
    return this.serial(async () => {
      const entry = await this.require(scope, input.id, input.expectedLocalRevision)
      const pending = entry.pending ?? { key: randomUUID(), draft: entry.record.draft }
      // Preserve the exact request across timeouts, process restarts and further local edits.
      if (!entry.pending) await this.write(scope, { ...entry, pending })
      return { cloud: entry.record.cloud, pending }
    })
  }

  rejectConflict(scope: DemandDraftScope, id: string, key: string, cloud: EnterpriseDemandCloudDraft) {
    return this.serial(async () => {
      const entry = await this.require(scope, id)
      if (entry.pending?.key !== key || entry.record.cloud?.id !== cloud.id || entry.record.cloud.draftRevision !== cloud.draftRevision) {
        throw new DemandDraftVaultError('conflict')
      }
      await this.write(scope, { ...entry, pending: null })
    })
  }

  merge(scope: DemandDraftScope, input: Merge, prior: EnterpriseDemandCloudDraft, latest: EnterpriseDemandLatestDraft) {
    return this.serial(async () => {
      const entry = await this.require(scope, input.id, input.expectedLocalRevision)
      if (entry.pending || entry.record.cloud?.id !== prior.id || entry.record.cloud.draftRevision !== prior.draftRevision ||
          latest.cloud.id !== prior.id || latest.cloud.draftRevision <= prior.draftRevision || latest.cloud.draftRevision !== input.expectedCloudRevision) {
        throw new DemandDraftVaultError('conflict')
      }
      const record = enterpriseDemandLocalRecordSchema.parse({
        ...entry.record, revision: entry.record.revision + 1, updatedAt: new Date().toISOString(),
        cloud: latest.cloud, draft: input.draft,
      })
      await this.write(scope, { ...entry, record, baseDraft: latest.draft })
      return record
    })
  }

  acknowledge(scope: DemandDraftScope, id: string, key: string, cloud: EnterpriseDemandCloudDraft) {
    return this.serial(async () => {
      const entry = await this.read(scope, id)
      if (!entry) return null
      if (entry.pending?.key !== key) {
        if (!entry.pending && entry.record.cloud?.id === cloud.id && entry.record.cloud.draftRevision === cloud.draftRevision) return entry.record
        throw new DemandDraftVaultError('conflict')
      }
      if (sameDraft(entry.record.draft, entry.pending.draft)) {
        await unlink(this.file(scope, id))
        return null
      }
      const record = { ...entry.record, cloud }
      await this.write(scope, { ...entry, record, pending: null, baseDraft: entry.pending.draft })
      return record
    })
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.then(() => {}, () => {})
    return result
  }

  private binding(scope: DemandDraftScope) {
    return createHash('sha256').update(JSON.stringify([scope.origin, scope.deviceId])).digest('hex')
  }

  private file(scope: DemandDraftScope, id: string) {
    if (!z.uuid().safeParse(id).success) throw new DemandDraftVaultError('notFound')
    return join(this.directory, this.binding(scope), `${id}.enc`)
  }

  private async entries(scope: DemandDraftScope) {
    try {
      const entries = await readdir(join(this.directory, this.binding(scope)), { withFileTypes: true })
      return entries.filter(entry => entry.isFile() && filePattern.test(entry.name)).map(entry => entry.name)
    } catch (error) {
      if (missing(error)) return []
      throw new DemandDraftVaultError('localStorage')
    }
  }

  private async require(scope: DemandDraftScope, id: string, revision?: number) {
    const entry = await this.read(scope, id)
    if (!entry) throw new DemandDraftVaultError('notFound')
    if (revision !== undefined && entry.record.revision !== revision) throw new DemandDraftVaultError('conflict')
    return entry
  }

  private async read(scope: DemandDraftScope, id: string): Promise<VaultEntry | null> {
    const file = this.file(scope, id)
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.size > maxEncryptedSize) throw new DemandDraftVaultError('localStorage')
      const buffer = await readFile(file)
      const result = vaultEntry.parse(JSON.parse(this.encryption.decryptString(buffer)))
      if (result.binding !== this.binding(scope) || result.record.id !== id) throw new DemandDraftVaultError('localStorage')
      return result.version === 1 ? { ...result, version: 2, baseDraft: null } : result
    } catch (error) {
      if (missing(error)) return null
      throw new DemandDraftVaultError('localStorage')
    }
  }

  private async write(scope: DemandDraftScope, entry: VaultEntry) {
    const destination = this.file(scope, entry.record.id)
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const encrypted = this.encryption.encryptString(JSON.stringify(entry))
      if (encrypted.byteLength > maxEncryptedSize) throw new DemandDraftVaultError('localStorage')
      await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600, flush: true })
      await rename(temporary, destination)
    } catch {
      await unlink(temporary).catch(() => {})
      throw new DemandDraftVaultError('localStorage')
    }
  }
}

export function exportDemandDraft(record: EnterpriseDemandLocalRecord) {
  const { draft } = record
  const fields: [string, string][] = [
    ['需求标题', draft.title], ['涉及系统', draft.systemKey], ['需求类别', draft.category],
    ['业务背景', draft.businessContext], ['预期收益', draft.expectedValue], ['验收要求', draft.acceptanceCriteria],
    ['业务责任人', draft.businessOwner], ['期望时间或紧急程度', draft.priority],
    ['附件引用', draft.attachmentRefs.map(file => `${file.name}（${file.id}）`).join('\n')],
  ]
  return ['# 需求草稿 · 未送审', `本机保存时间 ${record.updatedAt}`,
    ...fields.filter(([, value]) => value).map(([label, value]) => `## ${label}\n\n${value}`), ''].join('\n\n')
}
