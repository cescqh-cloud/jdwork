import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ControlError } from '../contract'
import type { ArtifactMeta } from './contract'

interface Digests { size: number, sha256: string, sha512: string }
export interface StagedInstaller extends Digests {
  path: string
  commit(): Promise<void>
  discard(): Promise<void>
}

export interface ReleaseStorage {
  stage(tenantId: string, releaseId: string, body: ReadableStream<Uint8Array>, maximum: number, signal?: AbortSignal): Promise<StagedInstaller>
  artifact(tenantId: string, releaseId: string, metadata: ArtifactMeta): Promise<Blob>
  verify(tenantId: string, releaseId: string, metadata: ArtifactMeta): Promise<void>
}

const safeUuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu
const digestName = /^[0-9a-f]{64}$/u
const unavailable = () => new ControlError(503, 'UPDATE_ARTIFACT_UNAVAILABLE', 'The verified installer object is not available.')

async function ensureDirectory(path: string, create: boolean) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 })
  const status = await lstat(path)
  if (!status.isDirectory() || status.isSymbolicLink() || (process.platform !== 'win32' && (status.mode & 0o022))) {
    throw new Error('The release object directory must be private and cannot be a symlink')
  }
}

async function digestFile(path: string, limit: number): Promise<Digests> {
  const status = await lstat(path)
  if (!status.isFile() || status.isSymbolicLink() || status.size !== limit) throw unavailable()
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  const stream = Bun.file(path).stream()
  const reader = stream.getReader()
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > limit) throw unavailable()
      sha256.update(next.value)
      sha512.update(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

export async function verifyPortableExecutable(path: string) {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(64)
    if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length || header.toString('ascii', 0, 2) !== 'MZ') return false
    const offset = header.readUInt32LE(60)
    if (offset < 64 || offset > 65_536) return false
    const pe = Buffer.alloc(26)
    if ((await file.read(pe, 0, pe.length, offset)).bytesRead !== pe.length || pe.readUInt32LE(0) !== 0x00004550) return false
    const flags = pe.readUInt16LE(22)
    return (flags & 0x0002) !== 0 && (flags & 0x2000) === 0 && pe.readUInt16LE(20) >= 96 && [0x010b, 0x020b].includes(pe.readUInt16LE(24))
  } finally { await file.close() }
}

export class LocalReleaseStorage implements ReleaseStorage {
  private root: Promise<string> | undefined

  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new Error('Release storage requires an absolute private directory')
  }

  private async folder(tenantId: string, releaseId: string, create: boolean) {
    if (!safeUuid.test(tenantId) || !safeUuid.test(releaseId)) throw unavailable()
    this.root ??= ensureDirectory(this.directory, true).then(() => realpath(this.directory)).catch(error => { this.root = undefined; throw error })
    const tenant = join(await this.root, tenantId)
    await ensureDirectory(tenant, create)
    const release = join(tenant, releaseId)
    await ensureDirectory(release, create)
    return release
  }

  async stage(tenantId: string, releaseId: string, body: ReadableStream<Uint8Array>, maximum: number, signal?: AbortSignal): Promise<StagedInstaller> {
    const folder = await this.folder(tenantId, releaseId, true)
    const path = join(folder, `.upload-${randomUUID()}.exe`)
    const file = await open(path, 'wx', 0o600)
    const reader = body.getReader()
    const sha256 = createHash('sha256')
    const sha512 = createHash('sha512')
    let size = 0
    const discard = () => unlink(path).catch(() => {})
    try {
      for (;;) {
        signal?.throwIfAborted()
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > maximum) throw new ControlError(413, 'UPDATE_INSTALLER_SIZE_EXCEEDED', 'The installer exceeds the verified manifest size.')
        sha256.update(next.value)
        sha512.update(next.value)
        await file.writeFile(next.value)
      }
      await file.sync()
    } catch (error) {
      await file.close().catch(() => {})
      await discard()
      if (error instanceof ControlError) throw error
      throw new ControlError(409, 'UPDATE_UPLOAD_INTERRUPTED', 'The installer upload was interrupted. Retry the upload.')
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      await file.close().catch(() => {})
    }
    const digests = { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
    const destination = join(folder, `${digests.sha256}.exe`)
    return { path, ...digests, discard,
      async commit() {
        try { await link(path, destination) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const existing = await digestFile(destination, digests.size)
          if (existing.sha256 !== digests.sha256 || existing.sha512 !== digests.sha512) throw unavailable()
        }
      },
    }
  }

  private async objectPath(tenantId: string, releaseId: string, digest: string) {
    if (!digestName.test(digest)) throw unavailable()
    try { return join(await this.folder(tenantId, releaseId, false), `${digest}.exe`) }
    catch { throw unavailable() }
  }

  async artifact(tenantId: string, releaseId: string, metadata: ArtifactMeta): Promise<Blob> {
    const path = await this.objectPath(tenantId, releaseId, metadata.sha256)
    const status = await lstat(path).catch(() => { throw unavailable() })
    if (!status.isFile() || status.isSymbolicLink() || status.size !== metadata.size) throw unavailable()
    return Bun.file(path)
  }

  async verify(tenantId: string, releaseId: string, metadata: ArtifactMeta) {
    const path = await this.objectPath(tenantId, releaseId, metadata.sha256)
    const actual = await digestFile(path, metadata.size).catch(() => { throw unavailable() })
    if (actual.sha256 !== metadata.sha256 || actual.sha512 !== metadata.sha512 || actual.size !== metadata.size) throw unavailable()
  }
}

interface ByteRange { start: number, end: number }

function singleRange(header: string, size: number): ByteRange | undefined {
  const match = /^bytes=(\d{0,16})-(\d{0,16})$/u.exec(header)
  if (!match || (!match[1] && !match[2])) return undefined
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
  if (!Number.isSafeInteger(start) || (match[2] && !Number.isSafeInteger(Number(match[2]))) || start < 0 || start >= size || end < start) return undefined
  return { start, end }
}

export function installerResponse(file: Blob, metadata: ArtifactMeta, request: Request) {
  const etag = `"sha256-${metadata.sha256}"`
  const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${metadata.name}"`, 'Cache-Control': 'private, no-store', ETag: etag })
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers })
  const range = request.headers.get('Range')
  const ifRange = request.headers.get('If-Range')
  if (range && (!ifRange || ifRange === etag)) {
    const chunk = singleRange(range, metadata.size)
    if (!chunk) {
      headers.set('Content-Range', `bytes */${metadata.size}`)
      return new Response(null, { status: 416, headers })
    }
    headers.set('Content-Length', String(chunk.end - chunk.start + 1))
    headers.set('Content-Range', `bytes ${chunk.start}-${chunk.end}/${metadata.size}`)
    return new Response(request.method === 'HEAD' ? null : file.slice(chunk.start, chunk.end + 1), { status: 206, headers })
  }
  headers.set('Content-Length', String(metadata.size))
  return new Response(request.method === 'HEAD' ? null : file, { headers })
}
