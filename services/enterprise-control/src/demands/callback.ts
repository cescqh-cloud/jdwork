import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { ControlError } from '../contract'
import { dingTalkId, evidenceHash, processCode } from './contract'
import { instanceId } from './dingtalk'

const maxClockSkew = 10 * 60_000
const invalidCallback = () => new ControlError(403, 'INVALID_DINGTALK_CALLBACK', 'The DingTalk callback could not be verified.')
const signatureArgs = z.object({ signature: z.string().regex(/^[a-f0-9]{40}$/iu),
  timestamp: z.string().regex(/^(?:\d{10}|\d{13})$/u), nonce: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/u) })
const bodySchema = z.strictObject({ encrypt: z.string().min(44).max(16_384).regex(/^[A-Za-z0-9+/]+={0,2}$/u) })
const eventSchema = z.object({
  EventType: z.literal('bpms_instance_change'), CorpId: dingTalkId, EventTime: z.number().int().nonnegative().optional(),
  eventId: dingTalkId.optional(), BizId: dingTalkId.optional(), processCode, processInstanceId: instanceId,
  type: z.enum(['start', 'finish', 'terminate']),
})

export type DingTalkEvent = { eventId: string, corpId: string, processCode: string, instanceId: string, type: 'start' | 'finish' | 'terminate' }
export interface DingTalkCallbackConfig { token: string, encodingAesKey: string, receiverId: string }

function padding(value: Buffer) {
  const amount = 32 - (value.length % 32)
  return Buffer.concat([value, Buffer.alloc(amount, amount)])
}

export function createDingTalkCallback(config: DingTalkCallbackConfig, now = Date.now) {
  const key = Buffer.from(`${config.encodingAesKey}=`, 'base64')
  if (key.length !== 32 || key.toString('base64').slice(0, -1) !== config.encodingAesKey ||
      !/^[A-Za-z0-9]{3,32}$/u.test(config.token) || !dingTalkId.safeParse(config.receiverId).success) {
    throw new Error('DingTalk callback configuration is invalid')
  }
  const iv = key.subarray(0, 16)
  const receiver = Buffer.from(config.receiverId, 'utf8')
  const sign = (timestamp: string, nonce: string, cipher: string) =>
    createHash('sha1').update([config.token, timestamp, nonce, cipher].sort().join(''), 'utf8').digest()

  function decrypt(encrypted: string) {
    const bytes = Buffer.from(encrypted, 'base64')
    if (bytes.length % 32 || bytes.toString('base64') !== encrypted) throw invalidCallback()
    const decipher = createDecipheriv('aes-256-cbc', key, iv).setAutoPadding(false)
    const clear = Buffer.concat([decipher.update(bytes), decipher.final()])
    const pad = clear.at(-1) ?? 0
    if (pad < 1 || pad > 32 || clear.length - pad < 20 || !clear.subarray(-pad).every(value => value === pad)) throw invalidCallback()
    const content = clear.subarray(0, clear.length - pad)
    const end = 20 + content.readUInt32BE(16)
    if (end > content.length || !receiver.equals(content.subarray(end))) throw invalidCallback()
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(20, end))) as unknown
  }

  return {
    receive(query: unknown, body: unknown): DingTalkEvent | undefined {
      const headers = signatureArgs.safeParse(query)
      const payload = bodySchema.safeParse(body)
      if (!headers.success || !payload.success) throw invalidCallback()
      const { timestamp, nonce, signature } = headers.data
      const millis = Number(timestamp) * (timestamp.length === 10 ? 1000 : 1)
      const cipher = payload.data.encrypt
      if (Math.abs(millis - now()) > maxClockSkew || !timingSafeEqual(sign(timestamp, nonce, cipher), Buffer.from(signature, 'hex'))) {
        throw invalidCallback()
      }
      let decoded: unknown
      try { decoded = decrypt(cipher) } catch { throw invalidCallback() }
      const eventType = z.object({ EventType: z.string() }).safeParse(decoded)
      if (!eventType.success) throw invalidCallback()
      if (eventType.data.EventType !== 'bpms_instance_change') return undefined
      const event = eventSchema.safeParse(decoded)
      if (!event.success) throw invalidCallback()
      const value = event.data
      return { eventId: value.eventId ?? `fallback.${evidenceHash(value)}`, corpId: value.CorpId, processCode: value.processCode,
        instanceId: value.processInstanceId, type: value.type }
    },
    ack() {
      const timeStamp = String(Math.floor(now() / 1000))
      const nonce = randomBytes(12).toString('hex')
      const success = Buffer.from('success', 'utf8')
      const length = Buffer.alloc(4)
      length.writeUInt32BE(success.length)
      const cipher = createCipheriv('aes-256-cbc', key, iv).setAutoPadding(false)
      const encrypt = Buffer.concat([cipher.update(padding(Buffer.concat([randomBytes(16), length, success, receiver]))), cipher.final()]).toString('base64')
      return { msg_signature: sign(timeStamp, nonce, encrypt).toString('hex'), timeStamp, nonce, encrypt }
    },
  }
}

export type DingTalkCallback = ReturnType<typeof createDingTalkCallback>
