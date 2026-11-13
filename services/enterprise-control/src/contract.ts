import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { z } from 'zod'

export const controlTitle = '力源金蝶研发工作台'
export const role = z.enum(['platform_admin', 'it_lead', 'project_owner', 'developer', 'requester', 'approver', 'auditor'])
export type Role = z.infer<typeof role>
export const tenantSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/u)
export const loginName = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._@-]{0,119}$/u)
export const password = z.string().min(12).max(256)
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
const deviceSignature = z.string().regex(/^[A-Za-z0-9_-]{86}$/u)
export const loginInput = z.strictObject({ tenant: tenantSlug, login: loginName, password })
export const userInput = loginInput.extend({ displayName: z.string().trim().min(1).max(120), roles: z.array(role).min(1).max(7) })
export const enrollInput = z.strictObject({
  challenge: tokenSchema,
  deviceId: z.uuid(),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{59}$/u),
  platform: z.enum(['win32', 'darwin', 'linux']),
  clientVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)*$/u).max(64),
  signature: deviceSignature,
})
export const refreshInput = z.strictObject({ deviceId: z.uuid(), refreshToken: tokenSchema, signature: deviceSignature })
export const revokeInput = z.strictObject({ deviceId: z.uuid() })
export type LoginInput = z.infer<typeof loginInput>
export type UserInput = z.infer<typeof userInput>
export type EnrollInput = z.infer<typeof enrollInput>
export type RefreshInput = z.infer<typeof refreshInput>

export class ControlError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 503, readonly code: string, message: string) {
    super(message)
  }
}

export const randomToken = () => randomBytes(32).toString('base64url')
export const tokenDigest = (value: string) => createHash('sha256').update(value).digest('hex')

export function verifyDeviceProof(publicKey: string, signature: string, payload: readonly string[]): boolean {
  try {
    const spki = Buffer.from(publicKey, 'base64url')
    const bytes = Buffer.from(signature, 'base64url')
    if (spki.toString('base64url') !== publicKey || bytes.toString('base64url') !== signature) return false
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(JSON.stringify(payload)), key, bytes)
  } catch {
    return false
  }
}
