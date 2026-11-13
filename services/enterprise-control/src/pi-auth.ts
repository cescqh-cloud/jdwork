import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { ControlError, tenantSlug, tokenSchema } from './contract'

const invalidIdentity = () => new ControlError(401, 'PI_IDENTITY_REQUIRED', '请重新登录原工作台并绑定设备。')
const upstreamUnavailable = () => new ControlError(503, 'PI_IDENTITY_UNAVAILABLE', '原工作台身份服务暂不可用。')
const instanceId = z.uuid()
const credential = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('token'), value: z.string().regex(/^[\x21-\x7e]{32,256}$/u) }),
  z.strictObject({ kind: z.literal('session'), value: z.string().regex(/^[0-9a-f]{64}$/u) }),
])
const identity = z.object({
  id: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u),
  name: z.string().min(1).max(120),
  admin: z.boolean(),
  source: z.enum(['token', 'dingtalk']),
  userId: z.string().min(1).max(256).optional(),
})
const response = z.object({ identity, authState: z.object({ instanceId }).optional() })
const savedProof = z.strictObject({
  credential,
  identity: identity.extend({ instanceId: instanceId.optional() }),
})

export type PiCredential = z.infer<typeof credential>
export type PiIdentity = z.infer<typeof identity> & { instanceId?: string }
export interface PiAuthConfig { origin: string, tenant: string, encryptionKey: Uint8Array }

function privateIp(host: string): boolean {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host)) return false
  const octets = host.split('.').map(Number)
  if (octets.some(octet => octet > 255)) return false
  const [first, second] = octets
  return first === 10 || (first === 172 && second! >= 16 && second! <= 31) || (first === 192 && second === 168)
}

export function privateHttpOrigin(value: string, name: string): string {
  const literal = /^http:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?\/?$/u.exec(value)
  let url: URL
  try { url = new URL(value) }
  catch { throw new Error(`${name} requires a fixed private IPv4 HTTP origin`) }
  if (!literal || literal[1] !== url.hostname || url.protocol !== 'http:' || !privateIp(url.hostname) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || /[\s\\]/u.test(value)) {
    throw new Error(`${name} requires a fixed private IPv4 HTTP origin`)
  }
  return url.origin
}

export function loadPiAuthConfig(env: Record<string, string | undefined>, intranetOrigin?: string): PiAuthConfig | undefined {
  const names = ['ENTERPRISE_PI_AUTH_ORIGIN', 'ENTERPRISE_PI_TENANT', 'ENTERPRISE_PI_AUTH_ENCRYPTION_KEY'] as const
  if (!names.some(name => env[name] !== undefined)) return undefined
  if (!intranetOrigin || names.some(name => !env[name])) throw new Error('Complete the intranet Pi identity configuration.')
  const origin = privateHttpOrigin(env.ENTERPRISE_PI_AUTH_ORIGIN!, 'ENTERPRISE_PI_AUTH_ORIGIN')
  if (new URL(origin).hostname !== new URL(intranetOrigin).hostname) {
    throw new Error('The Pi identity server must use the configured intranet host.')
  }
  const tenant = tenantSlug.parse(env.ENTERPRISE_PI_TENANT)
  const value = tokenSchema.parse(env.ENTERPRISE_PI_AUTH_ENCRYPTION_KEY)
  const encryptionKey = Buffer.from(value, 'base64url')
  if (encryptionKey.length !== 32 || encryptionKey.toString('base64url') !== value) throw new Error('Invalid Pi identity encryption key.')
  return { origin, tenant, encryptionKey }
}

async function limitedJson(result: Response): Promise<unknown> {
  if (!result.body) throw upstreamUnavailable()
  const reader = result.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > 65_536) throw upstreamUnavailable()
      chunks.push(item.value)
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export class PiAuthenticator {
  constructor(readonly config: PiAuthConfig,
    private readonly fetcher: (input: string | URL, init?: RequestInit) => Promise<Response> = fetch) {}

  async probe(input: PiCredential): Promise<PiIdentity> {
    const parsedCredential = credential.safeParse(input)
    if (!parsedCredential.success) throw invalidIdentity()
    const headers = new Headers({ Accept: 'application/json' })
    if (input.kind === 'token') headers.set('Authorization', `Bearer ${input.value}`)
    else headers.set('Cookie', `pi_session=${input.value}`)
    let result: Response
    try {
      result = await this.fetcher(new URL('/api/me', this.config.origin), {
        method: 'GET', headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(4_000),
      })
    } catch { throw upstreamUnavailable() }
    if (result.status === 401 || result.status === 403) throw invalidIdentity()
    if (!result.ok || result.redirected || result.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw upstreamUnavailable()
    }
    let body: z.infer<typeof response>
    try { body = response.parse(await limitedJson(result)) }
    catch { throw upstreamUnavailable() }
    if (input.kind === 'token' && (body.identity.source !== 'token' || body.identity.id !== 'admin')) throw invalidIdentity()
    if (input.kind === 'session' && (body.identity.source !== 'dingtalk' || !body.identity.userId ||
        !body.identity.id.startsWith('dingtalk:') || !body.identity.id.endsWith(':' + body.identity.userId))) {
      throw invalidIdentity()
    }
    return body.authState ? { ...body.identity, instanceId: body.authState.instanceId } : { ...body.identity }
  }

  seal(proof: { credential: PiCredential, identity: PiIdentity }, tenantId: string, userId: string): string {
    const data = savedProof.parse(proof)
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.config.encryptionKey, nonce)
    cipher.setAAD(this.associatedData(tenantId, userId))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
    return ['v1', nonce.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
  }

  async verify(value: string, tenantId: string, userId: string): Promise<PiIdentity> {
    let proof: z.infer<typeof savedProof>
    try {
      const [version, nonce, data, tag, extra] = value.split('.')
      if (version !== 'v1' || !nonce || !data || !tag || extra) throw new Error('Invalid proof')
      const decipher = createDecipheriv('aes-256-gcm', this.config.encryptionKey, Buffer.from(nonce, 'base64url'))
      decipher.setAAD(this.associatedData(tenantId, userId))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      proof = savedProof.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')))
    } catch { throw invalidIdentity() }
    const current = await this.probe(proof.credential)
    if (current.id !== proof.identity.id || current.source !== proof.identity.source || current.instanceId !== proof.identity.instanceId ||
        (proof.identity.admin && !current.admin)) {
      throw invalidIdentity()
    }
    return current
  }

  private associatedData(tenantId: string, userId: string): Buffer {
    return Buffer.from(JSON.stringify(['pi-auth-v1', this.config.origin, this.config.tenant, tenantId, userId]))
  }
}
