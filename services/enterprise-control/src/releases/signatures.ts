import { execFile } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { ControlError } from '../contract'
import { maxArtifactBytes, releaseProof, releaseProofPayload, sha256, signerInfo, type ReleaseProof, type ReleaseProofPayload, type SignerInfo } from './contract'

const runFile = promisify(execFile)
const digestKey = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const invalidSignature = () => new ControlError(409, 'UPDATE_INSTALLER_SIGNATURE_INVALID', 'The installer must have a valid Windows Authenticode signature from a trusted publisher.')

export function createReleaseSigner(privateKey: KeyObject) {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 release private key is required')
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url')
  const keyId = digestKey(Buffer.from(publicKey, 'base64url'))
  return { keyId, publicKey,
    sign(payload: ReleaseProofPayload): ReleaseProof {
      const clear = Buffer.from(JSON.stringify(releaseProofPayload.parse(payload)), 'utf8')
      return { keyId, publicKey, payload: clear.toString('base64url'), signature: sign(null, clear, privateKey).toString('base64url') }
    },
  }
}

export type ReleaseSigner = ReturnType<typeof createReleaseSigner>
export type PackageVerifier = (filePath: string) => Promise<SignerInfo>

/** The supplied trusted key must come from build or enrollment, never the proof being verified. */
export function verifyReleaseProof(value: unknown, trustedPublicKey: string): ReleaseProofPayload | undefined {
  const parsed = releaseProof.safeParse(value)
  if (!parsed.success || parsed.data.publicKey !== trustedPublicKey) return undefined
  try {
    const { publicKey, keyId, payload, signature } = parsed.data
    const der = Buffer.from(trustedPublicKey, 'base64url')
    const bytes = Buffer.from(payload, 'base64url')
    const sig = Buffer.from(signature, 'base64url')
    if (der.toString('base64url') !== publicKey || bytes.toString('base64url') !== payload || sig.toString('base64url') !== signature || digestKey(der) !== keyId) return undefined
    const key = createPublicKey({ key: der, type: 'spki', format: 'der' })
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, sig)) return undefined
    const result = releaseProofPayload.safeParse(JSON.parse(bytes.toString('utf8')))
    return result.success ? result.data : undefined
  } catch { return undefined }
}

const windowsVerifier = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$signature = Get-AuthenticodeSignature -LiteralPath $env:ENTERPRISE_VERIFY_INSTALLER
if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or $null -eq $signature.SignerCertificate) { exit 32 }
$certificate = $signature.SignerCertificate
$hash = [System.Security.Cryptography.SHA256]::Create()
try { $fingerprint = [System.BitConverter]::ToString($hash.ComputeHash($certificate.RawData)).Replace('-', '').ToLowerInvariant() }
finally { $hash.Dispose() }
$publisher = $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
@{ kind = 'authenticode'; fingerprint = $fingerprint; publisher = $publisher } | ConvertTo-Json -Compress
`

export function createAuthenticodeVerifier(command?: string): PackageVerifier {
  if (command && !isAbsolute(command)) throw new Error('The package signature verifier must be an absolute executable path')
  if (!command && process.platform !== 'win32') throw new Error('A trusted Authenticode verifier is required on this platform')
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const executable = command ?? join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return async filePath => {
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMP: process.env.TMP, TEMP: process.env.TEMP,
      ENTERPRISE_VERIFY_INSTALLER: filePath }
    const args = command ? [filePath] : ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsVerifier, 'utf16le').toString('base64')]
    try {
      const { stdout } = await runFile(executable, args, { env, windowsHide: true, timeout: 90_000, maxBuffer: 8192, encoding: 'utf8' })
      const result = signerInfo.parse(JSON.parse(stdout.trim()))
      if (result.kind !== 'authenticode') throw invalidSignature()
      return result
    } catch { throw invalidSignature() }
  }
}

export interface ReleaseConfig {
  directory: string
  maxBytes: number
  signer: ReleaseSigner
  verifier: PackageVerifier
  trustedFingerprints: ReadonlySet<string>
  allowFixtureSignatures?: boolean
}

export function loadReleaseConfig(env: Record<string, string | undefined>): ReleaseConfig | undefined {
  const values = {
    directory: env.ENTERPRISE_UPDATE_OBJECT_DIRECTORY, key: env.ENTERPRISE_UPDATE_SIGNING_KEY,
    fingerprints: env.ENTERPRISE_UPDATE_TRUSTED_SIGNERS, verifier: env.ENTERPRISE_UPDATE_VERIFY_COMMAND,
    maxBytes: env.ENTERPRISE_UPDATE_MAX_BYTES,
  }
  if (!Object.values(values).some(Boolean)) return undefined
  try {
    const parsed = z.object({ directory: z.string().min(1), key: z.string().min(1).max(4096), fingerprints: z.string().min(64),
      verifier: z.string().min(1).optional(), maxBytes: z.coerce.number().int().min(1).max(maxArtifactBytes).default(1024 ** 3) }).parse(values)
    if (!isAbsolute(parsed.directory)) throw new Error('Use an absolute object directory')
    const trustedFingerprints = new Set(z.array(sha256).min(1).max(16).parse(parsed.fingerprints.split(',').map(value => value.trim().toLowerCase())))
    const key = parsed.key.includes('-----BEGIN PRIVATE KEY-----') ? createPrivateKey(parsed.key) :
      createPrivateKey({ key: Buffer.from(parsed.key, 'base64url'), format: 'der', type: 'pkcs8' })
    return { directory: parsed.directory, maxBytes: parsed.maxBytes, signer: createReleaseSigner(key),
      verifier: createAuthenticodeVerifier(parsed.verifier), trustedFingerprints }
  } catch { throw new Error('The enterprise update directory, Ed25519 key, trusted signers, or Authenticode verifier is invalid') }
}

export function validateTrustedSigner(value: unknown, config: ReleaseConfig): SignerInfo {
  const signer = signerInfo.safeParse(value)
  if (!signer.success || !config.trustedFingerprints.has(signer.data.fingerprint) ||
      (signer.data.kind !== 'authenticode' && !config.allowFixtureSignatures)) throw invalidSignature()
  return signer.data
}
