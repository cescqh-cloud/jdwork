import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'

import { updateManifestLimit, validEnterpriseReleaseId, validEnterpriseReleaseVersion, verifyEnterpriseManifest, verifyEnterpriseRelease,
  type EnterpriseRelease, type EnterpriseReleaseTrust } from './enterpriseReleaseProof'
import type { EnterpriseUpdateTransport } from './enterpriseUpdateRouting'

type Stage = 'downloaded' | 'installed' | 'healthy' | 'failed'
type ReadyRelease = { release: EnterpriseRelease, transport: EnterpriseUpdateTransport, verifiedFile?: string }
type Receipt = { releaseId: string, version: string, binding: string, installedEvent: string, healthEvent: string, failedEvent: string }
type EnterpriseUpdaterOptions = {
  trust: EnterpriseReleaseTrust
  currentVersion: string
  arch: string
  receiptPath: string
  transport(): Promise<EnterpriseUpdateTransport | null>
  applyFeed(url: string, allowPrerelease: boolean): void
  verifySigner?: (filePath: string, fingerprint: string) => Promise<void>
}

const unavailable = () => new Error('This enterprise update is no longer available to the current device.')
const invalidFile = () => new Error('The downloaded update failed the signed hash or publisher check.')
const malformedReply = () => new Error('The enterprise update service returned an invalid response.')
const reportPath = '/api/v1/client/update-reports'

async function boundedResponse(response: Response, maximum: number): Promise<Buffer> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw unavailable()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) throw malformedReply()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

const runFile = promisify(execFile)
const authenticodeScript = String.raw`
$ErrorActionPreference = 'Stop'
$sig = Get-AuthenticodeSignature -LiteralPath $env:ENTERPRISE_UPDATE_INSTALLER
if ($sig.Status -ne 'Valid' -or $sig.SignatureType -ne 'Authenticode' -or $null -eq $sig.SignerCertificate) { exit 32 }
$hash = [System.Security.Cryptography.SHA256]::Create()
try { [System.BitConverter]::ToString($hash.ComputeHash($sig.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() }
finally { $hash.Dispose() }
`

async function verifyAuthenticode(filePath: string, expected: string) {
  if (process.platform !== 'win32') throw invalidFile()
  const { SystemRoot, TEMP, TMP } = process.env
  const executable = join(SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await runFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(authenticodeScript, 'utf16le').toString('base64')], {
    env: { SystemRoot, TEMP, TMP, ENTERPRISE_UPDATE_INSTALLER: filePath }, windowsHide: true, timeout: 90_000, maxBuffer: 4096,
  }).catch(() => { throw invalidFile() })
  if (stdout.trim() !== expected) throw invalidFile()
}

async function verifyDownloadedFile(filePath: string, release: EnterpriseRelease) {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.size !== release.artifact.size) throw invalidFile()
  const hash256 = createHash('sha256')
  const hash512 = createHash('sha512')
  for await (const chunk of createReadStream(filePath)) { hash256.update(chunk); hash512.update(chunk) }
  if (hash256.digest('hex') !== release.artifact.sha256 || hash512.digest('base64') !== release.artifact.sha512) throw invalidFile()
}

function sameRelease(left: EnterpriseRelease, right: EnterpriseRelease) {
  return left.releaseId === right.releaseId && left.version === right.version && left.manifestSha256 === right.manifestSha256 &&
    left.artifact.sha256 === right.artifact.sha256 && left.artifact.sha512 === right.artifact.sha512 && left.artifact.size === right.artifact.size
}

export class EnterpriseUpdater {
  private server: Server | undefined
  private ready: ReadyRelease | undefined

  constructor(private readonly options: EnterpriseUpdaterOptions) {}

  private async candidate(transport: EnterpriseUpdateTransport) {
    const query = new URLSearchParams({ platform: 'win32', arch: this.options.arch,
      currentVersion: this.options.currentVersion, channel: this.options.trust.channel })
    const response = await transport.request(`/api/v1/updates/check?${query}`, { signal: AbortSignal.timeout(12_000) })
    const bytes = await boundedResponse(response, 24 * 1024)
    return verifyEnterpriseRelease(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      this.options.trust, this.options.currentVersion, this.options.arch)
  }

  async prepare() {
    this.closeFeed()
    this.ready = undefined
    const transport = await this.options.transport()
    if (!transport) return null
    const release = await this.candidate(transport)
    if (!release) return null
    const manifest = await boundedResponse(await transport.request(`${release.feedPath}latest.yml`, { signal: AbortSignal.timeout(12_000) }), updateManifestLimit)
    verifyEnterpriseManifest(manifest, release)
    const url = await this.openFeed({ release, transport }, manifest)
    this.ready = { release, transport }
    this.options.applyFeed(url, this.options.trust.channel !== 'stable')
    return release
  }

  private async openFeed(ready: ReadyRelease, manifest: Buffer) {
    const prefix = `/${randomBytes(24).toString('base64url')}/`
    let host = ''
    const server = createServer((request, response) => {
      void this.serve(ready, manifest, host, prefix, request, response).catch(() => {
        if (response.headersSent) response.destroy()
        else { response.writeHead(502); response.end() }
      })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') { this.closeFeed(); throw unavailable() }
    host = `127.0.0.1:${address.port}`
    return `http://${host}${prefix}`
  }

  private async serve(ready: ReadyRelease, manifest: Buffer, host: string, prefix: string, request: IncomingMessage, response: ServerResponse) {
    const { method, headers } = request
    const path = request.url?.split('?', 1)[0]
    const name = encodeURIComponent(ready.release.artifact.name)
    if (headers.host !== host || (method !== 'GET' && method !== 'HEAD') ||
        (path !== `${prefix}latest.yml` && path !== `${prefix}${name}`)) {
      response.writeHead(404); response.end(); return
    }
    response.setHeader('Cache-Control', 'no-store')
    if (path === `${prefix}latest.yml`) {
      response.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Content-Length': manifest.length })
      response.end(method === 'HEAD' ? undefined : manifest)
      return
    }
    const abort = new AbortController()
    response.on('close', () => { if (!response.writableEnded) abort.abort() })
    const range = headers.range
    if (range !== undefined && !/^bytes=(?:\d{1,12}-\d{0,12}|-\d{1,12})$/u.test(range)) {
      response.writeHead(416); response.end(); return
    }
    const reply = await ready.transport.request(`${ready.release.feedPath}${name}`, { method, range, signal: abort.signal })
    if (![200, 206, 416].includes(reply.status)) {
      await reply.body?.cancel().catch(() => {})
      response.writeHead(reply.status === 401 || reply.status === 403 || reply.status === 404 ? 404 : 502); response.end(); return
    }
    for (const field of ['Content-Length', 'Content-Range', 'Accept-Ranges']) {
      const value = reply.headers.get(field)
      if (value !== null) response.setHeader(field, value)
    }
    response.writeHead(reply.status, { 'Content-Type': 'application/octet-stream' })
    if (!reply.body || method === 'HEAD') { await reply.body?.cancel().catch(() => {}); response.end(); return }
    await pipeline(Readable.fromWeb(reply.body as NodeReadableStream<Uint8Array>), response, { signal: abort.signal })
  }

  async authorize() {
    const ready = this.ready
    const transport = await this.options.transport()
    if (!ready || !transport || transport.binding !== ready.transport.binding) throw unavailable()
    const current = await this.candidate(transport)
    if (!current || !sameRelease(ready.release, current)) throw unavailable()
    return ready
  }

  async validateDownload(files: unknown) {
    const ready = this.ready
    if (!ready || !Array.isArray(files) || files.length !== 1 || typeof files[0] !== 'string') throw invalidFile()
    await verifyDownloadedFile(files[0], ready.release)
    await (this.options.verifySigner ?? verifyAuthenticode)(files[0], this.options.trust.publisherSha256)
    ready.verifiedFile = files[0]
    this.closeFeed()
    void this.report(ready.transport, ready.release.releaseId, randomUUID(), 'downloaded').catch(() => {})
  }

  downloadFailed() {
    const ready = this.ready
    if (ready) void this.report(ready.transport, ready.release.releaseId, randomUUID(), 'failed', 'UPDATE_DOWNLOAD_FAILED').catch(() => {})
  }

  async prepareInstall() {
    const ready = await this.authorize()
    if (!ready.verifiedFile) throw invalidFile()
    await verifyDownloadedFile(ready.verifiedFile, ready.release)
    const receipt: Receipt = { releaseId: ready.release.releaseId, version: ready.release.version, binding: ready.transport.binding,
      installedEvent: randomUUID(), healthEvent: randomUUID(), failedEvent: randomUUID() }
    const path = this.options.receiptPath
    const pending = `${path}.${randomUUID()}.tmp`
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(pending, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' })
      await rename(pending, path)
    } finally { await unlink(pending).catch(() => {}) }
  }

  async reportStartup(healthy: boolean) {
    const path = this.options.receiptPath
    let receipt: Receipt
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.size > 4096) return
      receipt = JSON.parse(await readFile(path, 'utf8')) as Receipt
      if (!receipt || receipt.version !== this.options.currentVersion || !validEnterpriseReleaseVersion(receipt.version) ||
          ![receipt.releaseId, receipt.installedEvent, receipt.healthEvent, receipt.failedEvent].every(validEnterpriseReleaseId)) return
    } catch { return }
    const transport = await this.options.transport()
    if (!transport || receipt.binding !== transport.binding) return
    await this.report(transport, receipt.releaseId, receipt.installedEvent, 'installed')
    if (healthy) {
      await this.report(transport, receipt.releaseId, receipt.healthEvent, 'healthy')
      await unlink(path).catch(() => {})
    } else await this.report(transport, receipt.releaseId, receipt.failedEvent, 'failed', 'UPDATE_STARTUP_FAILED')
  }

  private async report(transport: EnterpriseUpdateTransport, releaseId: string, eventId: string, stage: Stage, errorCode?: string) {
    const response = await transport.request(reportPath, { method: 'POST', body: { releaseId, eventId, stage, errorCode }, signal: AbortSignal.timeout(8000) })
    await response.body?.cancel().catch(() => {})
    if (!response.ok) throw unavailable()
  }

  closeFeed() {
    const server = this.server
    this.server = undefined
    if (!server) return
    server.close()
    server.closeAllConnections()
  }
}
