import { createHash } from 'node:crypto'
import { z } from 'zod'

export const platform = z.enum(['win32', 'darwin', 'linux'])
export const architecture = z.enum(['x64', 'arm64', 'ia32'])
export const channel = z.enum(['dev', 'canary', 'stable'])
export type Platform = z.infer<typeof platform>
export type Architecture = z.infer<typeof architecture>
export type Channel = z.infer<typeof channel>

const semver = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
export const clientVersion = z.string().max(96).regex(semver).refine(value =>
  !semver.exec(value)?.[4]?.split('.').some(part => /^0\d+$/u.test(part)), 'Use a valid SemVer version.')
export const releaseVersion = clientVersion.refine(value => !value.includes('+'), 'Release versions cannot include build metadata.')

export function compareVersions(a: string, b: string): number {
  const left = semver.exec(a)
  const right = semver.exec(b)
  if (!left || !right) throw new Error('Release version is not valid SemVer')
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index])
    if (difference) return Math.sign(difference)
  }
  if (!left[4] || !right[4]) return Number(!left[4]) - Number(!right[4])
  const l = left[4].split('.')
  const r = right[4].split('.')
  for (let index = 0; index < Math.min(l.length, r.length); index++) {
    const x = l[index]!
    const y = r[index]!
    if (x === y) continue
    const numericX = /^\d+$/u.test(x)
    const numericY = /^\d+$/u.test(y)
    if (numericX !== numericY) return numericX ? -1 : 1
    if (numericX && x.length !== y.length) return Math.sign(x.length - y.length)
    return x < y ? -1 : 1
  }
  return Math.sign(l.length - r.length)
}

export const sha256 = z.string().regex(/^[0-9a-f]{64}$/u)
export const sha512 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/u)
  .refine(value => Buffer.from(value, 'base64').toString('base64') === value, 'Use the SHA-512 value produced by electron-builder.')
const unsafeWindowsBasename = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/iu
export const artifactName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,166}\.exe$/iu).refine(value =>
  !unsafeWindowsBasename.test(value) && !/[. ]\.exe$/iu.test(value), 'Use a safe relative Windows installer filename.')
export const maxArtifactBytes = 2 * 1024 ** 3
export const artifactMeta = z.strictObject({ name: artifactName, size: z.number().int().min(1).max(maxArtifactBytes), sha256, sha512 })
export const signerInfo = z.strictObject({ kind: z.enum(['authenticode', 'test-fixture']), fingerprint: sha256, publisher: z.string().trim().min(1).max(250) })
export type ArtifactMeta = z.infer<typeof artifactMeta>
export type SignerInfo = z.infer<typeof signerInfo>

const audience = z.array(z.uuid()).max(250).default([]).refine(ids => new Set(ids).size === ids.length, 'Target IDs must be unique.')
const rollout = z.object({
  rolloutPercent: z.number().int().min(0).max(100), targetDeviceIds: audience, targetUserIds: audience, targetDepartmentIds: audience,
  minClientVersion: releaseVersion.nullable().default(null), maxTestedVersion: releaseVersion.nullable().default(null), securityRequired: z.boolean().default(false),
  failureMinSample: z.number().int().min(1).max(1000).default(3), failureThresholdPercent: z.number().int().min(1).max(100).default(40),
})
export const createReleaseInput = z.strictObject({ platform: z.literal('win32'), arch: architecture, channel, version: releaseVersion, ...rollout.shape })
  .superRefine((value, ctx) => {
    if (value.channel === 'stable' && value.version.includes('-')) ctx.addIssue({ code: 'custom', path: ['version'], message: 'Stable releases require a final version.' })
    if (value.channel === 'dev' && !value.targetDeviceIds.length && !value.targetUserIds.length && !value.targetDepartmentIds.length) {
      ctx.addIssue({ code: 'custom', path: ['targetDeviceIds'], message: 'Development releases need an explicit audience.' })
    }
    if ((value.securityRequired && !value.minClientVersion) || (value.minClientVersion && compareVersions(value.minClientVersion, value.version) > 0)) {
      ctx.addIssue({ code: 'custom', path: ['minClientVersion'], message: 'The minimum version must be reachable with this release.' })
    }
    if (value.maxTestedVersion && compareVersions(value.maxTestedVersion, value.version) < 0) {
      ctx.addIssue({ code: 'custom', path: ['maxTestedVersion'], message: 'The tested maximum must include this release.' })
    }
  })
export type CreateReleaseInput = z.infer<typeof createReleaseInput>

export const expectedRevision = z.number().int().min(1).max(2_147_483_647)
export const publishInput = z.strictObject({ expectedRevision, testEvidence: z.string().trim().min(3).max(500) })
export const pauseInput = z.strictObject({ expectedRevision, reason: z.string().trim().min(3).max(250) })
export const checkInput = z.strictObject({ platform, arch: architecture, currentVersion: clientVersion, channel: channel.default('stable') })
export type CheckInput = z.infer<typeof checkInput>

const stage = z.enum(['downloaded', 'installed', 'healthy', 'failed'])
export const reportInput = z.strictObject({ releaseId: z.uuid(), eventId: z.uuid(), stage,
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u).optional() }).superRefine((input, ctx) => {
  if ((input.stage === 'failed') !== (input.errorCode !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['errorCode'], message: 'Include a sanitized error code only for failed updates.' })
  }
})
export type ReportInput = z.infer<typeof reportInput>
export type ReportStage = z.infer<typeof stage>
export type ReleaseStatus = 'DRAFT' | 'PUBLISHED' | 'PAUSED' | 'WITHDRAWN'

export const releaseProof = z.strictObject({ keyId: sha256, publicKey: z.string().regex(/^[A-Za-z0-9_-]{59}$/u),
  payload: z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/u), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u) })
export const releaseProofPayload = z.strictObject({ schema: z.literal(1), releaseId: z.uuid(), version: releaseVersion, platform, arch: architecture, channel,
  artifact: artifactMeta, manifestSha256: sha256, signer: signerInfo, publishedAt: z.iso.datetime() })
export type ReleaseProof = z.infer<typeof releaseProof>
export type ReleaseProofPayload = z.infer<typeof releaseProofPayload>

export const candidateOutput = z.strictObject({ releaseId: z.uuid(), version: releaseVersion, platform, arch: architecture, channel,
  feedPath: z.string(), artifact: artifactMeta, manifestSha256: sha256, proof: releaseProof, publishedAt: z.iso.datetime() })
export const checkOutput = z.strictObject({ currentVersion: clientVersion, channel, minClientVersion: releaseVersion.nullable(),
  maxTestedVersion: releaseVersion.nullable(), compatibility: z.enum(['SUPPORTED', 'UPDATE_RECOMMENDED', 'UPDATE_REQUIRED', 'UNTESTED']),
  candidate: candidateOutput.nullable() })
export type Candidate = z.infer<typeof candidateOutput>
export type CheckOutput = z.infer<typeof checkOutput>

export function rolloutBucket(tenantId: string, platform: Platform, arch: Architecture, channel: Channel, deviceId: string) {
  return createHash('sha256').update(JSON.stringify(['enterprise-rollout-v1', tenantId, platform, arch, channel, deviceId])).digest().readUInt32BE(0) % 10_000
}
