import { createHash, createPublicKey, verify } from 'node:crypto'
import { parseDocument } from 'yaml'

export const updateManifestLimit = 65_536
const digestPattern = /^[a-f0-9]{64}$/u
const publicKeyPattern = /^[A-Za-z0-9_-]{59}$/u
const releaseIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const installerPattern = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,166}\.exe$/iu
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u
const channels = ['stable', 'canary', 'dev'] as const
export type EnterpriseUpdateChannel = typeof channels[number]
export type EnterpriseReleaseTrust = { publicKey: string; publisherSha256: string; channel: EnterpriseUpdateChannel }
export type EnterpriseRelease = {
  releaseId: string; version: string; feedPath: string; manifestSha256: string; required: boolean; minimumVersion: string | null
  artifact: { name: string; size: number; sha256: string; sha512: string }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function textMatches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value)
}

const invalid = () => new Error('The enterprise update did not pass signature or file verification.')
export const releaseDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export function validEnterpriseReleaseId(value: unknown): value is string {
  return textMatches(value, releaseIdPattern)
}

export function validEnterpriseReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 96 && versionPattern.test(value) &&
    !versionPattern.exec(value)?.[4]?.split('.').some(part => /^0\d+$/u.test(part))
}

function decodeCanonical(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw invalid()
  return decoded
}

function checkedPublicKey(value: string) {
  const der = decodeCanonical(value)
  const key = createPublicKey({ key: der, type: 'spki', format: 'der' })
  if (key.asymmetricKeyType !== 'ed25519') throw invalid()
  return { key, der }
}

export function parseEnterpriseReleaseTrust(value: unknown): EnterpriseReleaseTrust {
  const input = object(value)
  if (!input || !textMatches(input.publicKey, publicKeyPattern) || !textMatches(input.publisherSha256, digestPattern) ||
      !channels.some(channel => channel === input.channel)) throw invalid()
  checkedPublicKey(input.publicKey)
  return { publicKey: input.publicKey, publisherSha256: input.publisherSha256, channel: input.channel as EnterpriseUpdateChannel }
}

function newerVersion(next: string, current: string): boolean {
  const a = versionPattern.exec(next)
  const b = versionPattern.exec(current.split('+', 1)[0]!)
  if (!a || !b) return false
  for (const index of [1, 2, 3]) {
    if (a[index] !== b[index]) return Number(a[index]) > Number(b[index])
  }
  if (!a[4] || !b[4]) return !a[4] && !!b[4]
  const left = a[4].split('.')
  const right = b[4].split('.')
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const x = left[index]!, y = right[index]!
    if (x === y) continue
    const numeric = /^\d+$/u.test(x), otherNumeric = /^\d+$/u.test(y)
    if (numeric !== otherNumeric) return !numeric
    if (numeric && x.length !== y.length) return x.length > y.length
    return x > y
  }
  return left.length > right.length
}

export function verifyEnterpriseRelease(value: unknown, trust: EnterpriseReleaseTrust, currentVersion: string, arch: string): EnterpriseRelease | null {
  const result = object(value)
  if (!result || result.currentVersion !== currentVersion || result.channel !== trust.channel ||
      !['SUPPORTED', 'UPDATE_RECOMMENDED', 'UPDATE_REQUIRED', 'UNTESTED'].includes(String(result.compatibility))) throw invalid()
  if (result.candidate === null) return null
  const candidate = object(result.candidate)
  const proof = object(candidate?.proof)
  if (!candidate || !proof || proof.publicKey !== trust.publicKey ||
      !textMatches(proof.payload, /^[A-Za-z0-9_-]{1,8192}$/u) || !textMatches(proof.signature, /^[A-Za-z0-9_-]{86}$/u)) throw invalid()
  const { key, der } = checkedPublicKey(trust.publicKey)
  const signed = decodeCanonical(proof.payload)
  if (releaseDigest(der) !== proof.keyId || !verify(null, signed, key, decodeCanonical(proof.signature))) throw invalid()
  const payload = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(signed)))
  const signer = object(payload?.signer)
  const artifact = object(payload?.artifact)
  const exposedArtifact = object(candidate.artifact)
  if (!payload || payload.schema !== 1 || !signer || signer.kind !== 'authenticode' || signer.fingerprint !== trust.publisherSha256 ||
      !validEnterpriseReleaseId(payload.releaseId) || !validEnterpriseReleaseVersion(payload.version) || !newerVersion(payload.version, currentVersion) ||
      payload.platform !== 'win32' || payload.arch !== arch || payload.channel !== trust.channel ||
      !textMatches(payload.manifestSha256, digestPattern) || !artifact || !exposedArtifact ||
      !textMatches(artifact.name, installerPattern) || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/iu.test(artifact.name) ||
      /[. ]\.exe$/iu.test(artifact.name) || !textMatches(artifact.sha256, digestPattern) ||
      !textMatches(artifact.sha512, /^[A-Za-z0-9+/]{86}==$/u) || Buffer.from(artifact.sha512, 'base64').toString('base64') !== artifact.sha512 ||
      typeof artifact.size !== 'number' || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > 2 * 1024 ** 3) throw invalid()
  for (const name of ['releaseId', 'version', 'platform', 'arch', 'channel', 'manifestSha256', 'publishedAt']) {
    if (candidate[name] !== payload[name]) throw invalid()
  }
  for (const name of ['name', 'size', 'sha256', 'sha512']) {
    if (exposedArtifact[name] !== artifact[name]) throw invalid()
  }
  const feedPath = `/api/v1/updates/feed/${payload.releaseId}/`
  if (candidate.feedPath !== feedPath) throw invalid()
  const minimumVersion = validEnterpriseReleaseVersion(result.minClientVersion) ? result.minClientVersion : null
  return { releaseId: payload.releaseId, version: payload.version, feedPath, manifestSha256: payload.manifestSha256,
    required: result.compatibility === 'UPDATE_REQUIRED' && minimumVersion !== null, minimumVersion,
    artifact: { name: artifact.name, size: artifact.size, sha256: artifact.sha256, sha512: artifact.sha512 } }
}

export function verifyEnterpriseManifest(bytes: Uint8Array, release: EnterpriseRelease) {
  if (!bytes.byteLength || bytes.byteLength > updateManifestLimit || releaseDigest(bytes) !== release.manifestSha256) throw invalid()
  const yaml = parseDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { schema: 'core', strict: true, uniqueKeys: true, merge: false })
  if (yaml.errors.length || yaml.warnings.length) throw invalid()
  const data = object(yaml.toJS({ maxAliasCount: 0 }))
  const file = Array.isArray(data?.files) && data.files.length === 1 ? object(data.files[0]) : undefined
  if (data?.version !== release.version || !file || file.url !== release.artifact.name || file.size !== release.artifact.size ||
      file.sha512 !== release.artifact.sha512 || (data.path !== undefined && data.path !== release.artifact.name) ||
      (data.sha512 !== undefined && data.sha512 !== release.artifact.sha512) || data.packages != null || data.stagingPercentage !== undefined) throw invalid()
}
