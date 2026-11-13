import { createHash } from 'node:crypto'
import { ControlError } from '../contract'
import type { Actor } from '../store'
import { compareVersions, releaseProofPayload, type Candidate, type CheckInput, type CheckOutput, type ReportInput } from './contract'
import { readManifestBody, validateBuilderManifest } from './manifest'
import { validateTrustedSigner, verifyReleaseProof, type ReleaseConfig } from './signatures'
import { installerResponse, LocalReleaseStorage, verifyPortableExecutable, type ReleaseStorage } from './storage'
import { artifact, ReleaseStore, signedPayload, signer, type ReleaseRow } from './store'

const unverified = () => new ControlError(409, 'UPDATE_RELEASE_UNVERIFIED', 'Upload and verify both the original manifest and installer first.')
const corrupt = () => new ControlError(503, 'UPDATE_RELEASE_PROOF_INVALID', 'The release no longer matches trusted signing metadata. Contact the administrator.')
const notFound = () => new ControlError(404, 'UPDATE_FILE_NOT_FOUND', 'The requested file is unavailable for this release.')
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

export class ReleaseService {
  readonly storage: ReleaseStorage

  constructor(readonly store: ReleaseStore, private readonly config: ReleaseConfig, origin: string, storage?: ReleaseStorage) {
    const address = new URL(origin)
    if (config.allowFixtureSignatures && (address.protocol !== 'http:' || address.hostname !== '127.0.0.1')) {
      throw new Error('Fixture signatures can only be used with an isolated loopback update server')
    }
    this.storage = storage ?? new LocalReleaseStorage(config.directory)
  }

  key() { return { keyId: this.config.signer.keyId, publicKey: this.config.signer.publicKey } }

  async uploadManifest(actor: Actor, id: string, body: ReadableStream<Uint8Array> | null) {
    const row = await this.store.get(actor, id)
    const manifest = validateBuilderManifest(await readManifestBody(body), row.version, this.config.maxBytes)
    return this.store.saveManifest(actor, id, manifest, row.revision)
  }

  async uploadInstaller(actor: Actor, id: string, request: Request) {
    const row = await this.store.get(actor, id)
    if (row.status !== 'DRAFT' || !row.manifest_bytes || !row.manifest_sha256 || !request.body) throw unverified()
    const manifest = validateBuilderManifest(row.manifest_bytes, row.version, this.config.maxBytes)
    if (manifest.manifestSha256 !== row.manifest_sha256) throw corrupt()
    const length = request.headers.get('Content-Length')
    if (length && (!/^\d{1,12}$/u.test(length) || Number(length) !== manifest.size)) {
      throw new ControlError(400, 'UPDATE_INSTALLER_LENGTH_MISMATCH', 'The installer length differs from latest.yml.')
    }
    const staged = await this.storage.stage(actor.tenantId, id, request.body, manifest.size, request.signal)
    try {
      if (staged.size !== manifest.size || staged.sha512 !== manifest.sha512 ||
          (manifest.legacySha256 && staged.sha256 !== manifest.legacySha256)) {
        throw new ControlError(409, 'UPDATE_INSTALLER_HASH_MISMATCH', 'The uploaded installer differs from the builder manifest.')
      }
      if (!await verifyPortableExecutable(staged.path)) {
        throw new ControlError(400, 'UPDATE_INSTALLER_NOT_WINDOWS_EXE', 'The uploaded file is not a Windows executable installer.')
      }
      const trusted = validateTrustedSigner(await this.config.verifier(staged.path), this.config)
      request.signal.throwIfAborted()
      await staged.commit()
      return this.store.saveArtifact(actor, id, manifest.manifestSha256,
        { name: manifest.name, size: staged.size, sha512: staged.sha512, sha256: staged.sha256 }, trusted)
    } finally { await staged.discard() }
  }

  async publish(actor: Actor, id: string, expectedRevision: number, testEvidence: string) {
    const row = await this.store.get(actor, id)
    if (row.status !== 'DRAFT' || row.revision !== expectedRevision) {
      throw new ControlError(409, 'UPDATE_RELEASE_CONFLICT', 'The release changed. Refresh before publishing.')
    }
    const meta = artifact(row)
    if (!meta || !row.manifest_bytes || !row.manifest_sha256) throw unverified()
    validateTrustedSigner(signer(row), this.config)
    if (sha256(row.manifest_bytes) !== row.manifest_sha256) throw corrupt()
    await this.storage.verify(actor.tenantId, id, meta)
    return this.store.publish(actor, id, expectedRevision, testEvidence, this.config.signer)
  }

  private candidate(row: ReleaseRow): Candidate {
    const meta = artifact(row)
    if (!meta || !row.manifest_sha256 || !row.manifest_bytes || !row.proof || !row.published_at) throw corrupt()
    const publishedAt = row.published_at.toISOString()
    const proof = verifyReleaseProof(row.proof, this.config.signer.publicKey)
    if (!proof || sha256(row.manifest_bytes) !== row.manifest_sha256 ||
        JSON.stringify(proof) !== JSON.stringify(releaseProofPayload.parse(signedPayload(row, publishedAt)))) throw corrupt()
    validateTrustedSigner(proof.signer, this.config)
    return { releaseId: row.id, version: row.version, platform: row.platform, arch: row.arch, channel: row.channel,
      feedPath: `/api/v1/updates/feed/${row.id}/`, artifact: meta, manifestSha256: row.manifest_sha256, proof: row.proof, publishedAt }
  }

  async check(actor: Actor, input: CheckInput): Promise<CheckOutput> {
    const { currentVersion, row } = await this.store.select(actor, input)
    const base = { currentVersion, channel: input.channel, minClientVersion: null, maxTestedVersion: null,
      compatibility: 'SUPPORTED' as const, candidate: null }
    if (!row) return base
    let candidate: Candidate | null = null
    if (compareVersions(row.version, currentVersion) > 0) {
      candidate = this.candidate(row)
      // A missing object must not be announced as a downloadable required upgrade.
      await this.storage.artifact(row.tenant_id, row.id, candidate.artifact)
      if (!await this.store.rememberOffer(actor, row, currentVersion)) return base
    }
    const belowMinimum = Boolean(row.min_client_version && compareVersions(currentVersion, row.min_client_version) < 0)
    const aboveTested = Boolean(row.max_tested_version && compareVersions(currentVersion, row.max_tested_version) > 0)
    const compatibility = belowMinimum && row.security_required && candidate ? 'UPDATE_REQUIRED' : candidate || belowMinimum ? 'UPDATE_RECOMMENDED'
      : aboveTested ? 'UNTESTED' : 'SUPPORTED'
    return { ...base, minClientVersion: row.min_client_version, maxTestedVersion: row.max_tested_version, compatibility, candidate }
  }

  async feed(actor: Actor, id: string, filename: string, request: Request) {
    const row = await this.store.feed(actor, id)
    const value = this.candidate(row)
    if (filename === 'latest.yml') {
      const etag = `"sha256-${value.manifestSha256}"`
      const headers = new Headers({ 'Content-Type': 'application/yaml; charset=utf-8', 'Cache-Control': 'private, no-store',
        ETag: etag, 'X-Enterprise-Release-Key-Id': value.proof.keyId })
      if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers })
      const bytes = Buffer.from(row.manifest_bytes!)
      headers.set('Content-Length', String(bytes.byteLength))
      return new Response(request.method === 'HEAD' ? null : bytes, { headers })
    }
    if (filename !== value.artifact.name) throw notFound()
    return installerResponse(await this.storage.artifact(row.tenant_id, row.id, value.artifact), value.artifact, request)
  }

  report(actor: Actor, input: ReportInput) { return this.store.report(actor, input) }
}
