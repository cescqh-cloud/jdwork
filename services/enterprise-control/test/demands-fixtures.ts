import { createCipheriv, createHash } from 'node:crypto'
import type { DingTalkCallbackConfig } from '../src/demands/callback'

export const fixtureCallback: DingTalkCallbackConfig = {
  token: 'mockSignatureToken', encodingAesKey: Buffer.alloc(32, 0x6a).toString('base64').slice(0, -1), receiverId: 'fixture-app',
}

export function encryptedEvent(event: unknown, options: Partial<DingTalkCallbackConfig> & { now?: number } = {}) {
  const config = { ...fixtureCallback, ...options }
  const aes = Buffer.from(config.encodingAesKey + '=', 'base64')
  const message = Buffer.from(JSON.stringify(event))
  const receiver = Buffer.from(config.receiverId)
  const size = 20 + message.length + receiver.length
  const pad = 32 - size % 32
  const framed = Buffer.alloc(size + pad, pad)
  Buffer.alloc(16, 0x13).copy(framed)
  framed.writeUInt32BE(message.length, 16)
  message.copy(framed, 20)
  receiver.copy(framed, 20 + message.length)
  const cipher = createCipheriv('aes-256-cbc', aes, aes.subarray(0, 16))
  cipher.setAutoPadding(false)
  const encrypt = Buffer.concat([cipher.update(framed), cipher.final()]).toString('base64')
  const timestamp = String(Math.floor((options.now ?? Date.now()) / 1000))
  const nonce = 'fixture-nonce'
  const signature = createHash('sha1').update([config.token, timestamp, nonce, encrypt].sort().join('')).digest('hex')
  return { query: { timestamp, nonce, signature }, body: { encrypt } }
}
