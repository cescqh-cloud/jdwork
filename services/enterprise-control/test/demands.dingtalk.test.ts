import { describe, expect, test } from 'bun:test'
import { createDecipheriv, createHash } from 'node:crypto'
import { createDingTalkCallback } from '../src/demands/callback'
import { authoritativeState, createDingTalkTransport, DingTalkDispatchError } from '../src/demands/dingtalk'
import { loadDingTalkConnections } from '../src/demands/service'
import { encryptedEvent, fixtureCallback } from './demands-fixtures'

const event = { EventType: 'bpms_instance_change', EventTime: 1_700_000_000_000, CorpId: 'mock-tenant', eventId: 'event-1',
  processCode: 'PROC-FIXTURE', processInstanceId: 'instance-1', type: 'finish', result: 'agree' }

describe('DingTalk OA callback envelope', () => {
  test('verifies timestamp, SHA1, padding, receiver and emits the provider success format', () => {
    const now = 1_700_000_000_000
    const callback = createDingTalkCallback(fixtureCallback, () => now)
    const payload = encryptedEvent(event, { now })
    expect(callback.receive(payload.query, payload.body)).toEqual({ eventId: 'event-1', corpId: 'mock-tenant', processCode: 'PROC-FIXTURE',
      instanceId: 'instance-1', type: 'finish' })
    expect(() => callback.receive({ ...payload.query, signature: '0'.repeat(40) }, payload.body)).toThrow('could not be verified')
    const stale = encryptedEvent(event, { now: now - 10 * 60_000 - 1000 })
    expect(() => callback.receive(stale.query, stale.body)).toThrow('could not be verified')
    const otherApp = encryptedEvent(event, { now, receiverId: 'different-app' })
    expect(() => callback.receive(otherApp.query, otherApp.body)).toThrow('could not be verified')
    const checkUrl = encryptedEvent({ EventType: 'check_url' }, { now })
    expect(callback.receive(checkUrl.query, checkUrl.body)).toBeUndefined()

    const ack = callback.ack()
    expect(createHash('sha1').update([fixtureCallback.token, ack.timeStamp, ack.nonce, ack.encrypt].sort().join('')).digest('hex')).toBe(ack.msg_signature)
    const key = Buffer.from(fixtureCallback.encodingAesKey + '=', 'base64')
    const decrypt = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16)).setAutoPadding(false)
    const clear = Buffer.concat([decrypt.update(Buffer.from(ack.encrypt, 'base64')), decrypt.final()])
    expect(clear.subarray(20, 20 + clear.readUInt32BE(16)).toString()).toBe('success')
  })

  test('rejects partial callback setup and keeps result text out of events', () => {
    expect(loadDingTalkConnections({}).size).toBe(0)
    expect(() => loadDingTalkConnections({ ENTERPRISE_DINGTALK_TENANT: 'fixture' })).toThrow('configuration')
    const now = Date.now()
    const payload = encryptedEvent({ ...event, eventId: undefined }, { now })
    const callback = createDingTalkCallback(fixtureCallback)
    const verified = callback.receive(payload.query, payload.body)
    expect(verified?.eventId).toStartWith('fallback.')
    expect(verified).not.toHaveProperty('result')
  })
})

describe('DingTalk OA REST transport', () => {
  test('uses documented token and OA endpoint shapes, validates IDs, and never retries a lost create response', async () => {
    const calls: Array<{ url: URL, method: string | undefined, headers: Headers, body: unknown }> = []
    const mock = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input)
      const headers = new Headers(init?.headers)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null
      calls.push({ url, method: init?.method, headers, body })
      if (url.pathname === '/v1.0/oauth2/accessToken') return Response.json({ accessToken: 'fake-token', expireIn: 7200 })
      if (url.pathname.endsWith('/instanceIds/query')) return Response.json({ success: true, result: { list: ['fixture+/='], nextToken: '30' } })
      if (init?.method === 'POST') throw new Error('simulated timeout after possible create')
      return Response.json({ result: { title: 'Fixture', originatorUserId: 'staff-1', status: 'COMPLETED', result: 'agree',
        formComponentValues: [{ id: 'Field-1', name: '内容', value: 'fixture' }], approverUserIds: ['lead-1'] } })
    }) as typeof fetch
    const transport = createDingTalkTransport({ appKey: 'fixture-key', appSecret: 'fixture-secret' }, mock)
    await expect(transport.create({ RequestId: 'request-1', processCode: 'PROC-FIXTURE', originatorUserId: 'staff-1',
      deptId: 1, formComponentValues: [{ name: '内容', value: 'fixture' }] })).rejects.toEqual(new DingTalkDispatchError('UNCONFIRMED'))
    expect(await transport.list({ processCode: 'PROC-FIXTURE', startTime: 100, endTime: 200, nextToken: 0, userIds: ['staff-1'] }))
      .toEqual({ ids: ['fixture+/='], nextToken: 30 })
    expect((await transport.get('fixture+/=')).state).toBe('AGREE')
    expect(calls.map(call => [call.method, call.url.origin, call.url.pathname])).toEqual([
      ['POST', 'https://api.dingtalk.com', '/v1.0/oauth2/accessToken'], ['POST', 'https://api.dingtalk.com', '/v1.0/workflow/processInstances'],
      ['POST', 'https://api.dingtalk.com', '/v1.0/workflow/processes/instanceIds/query'], ['GET', 'https://api.dingtalk.com', '/v1.0/workflow/processInstances'],
    ])
    expect(calls[1]?.headers.get('x-acs-dingtalk-access-token')).toBe('fake-token')
    expect(calls[2]?.body).toMatchObject({ userIds: ['staff-1'], maxResults: 20, nextToken: 0 })
    expect(calls[3]?.url.searchParams.get('processInstanceId')).toBe('fixture+/=')
    expect(await transport.get('another-instance')).toMatchObject({ instanceId: 'another-instance', state: 'AGREE', approverUserIds: ['lead-1'] })
    expect(calls.filter(call => call.url.pathname.includes('/oauth2/'))).toHaveLength(1)
  })

  test('holds unknown outcomes and differentiates known provider refusals from system failures', async () => {
    expect(authoritativeState('RUNNING', 'agree')).toBe('RUNNING')
    expect(authoritativeState('COMPLETED', undefined)).toBe('UNKNOWN')
    expect(authoritativeState('COMPLETED', 'refuse')).toBe('REFUSE')
    expect(authoritativeState('TERMINATED', undefined)).toBe('TERMINATED')
    expect(authoritativeState('finish', 'agree')).toBe('UNKNOWN')
    const request = { RequestId: 'request-1', processCode: 'PROC-FIXTURE', originatorUserId: 'staff-1', deptId: 1, formComponentValues: [] }
    for (const [code, disposition] of [['targetSelectApproverMissing', 'DECLINED'], ['internalError', 'UNCONFIRMED']] as const) {
      const transport = createDingTalkTransport({ appKey: 'fixture-key', appSecret: 'fixture-secret' }, (async (input: string | URL) =>
        new URL(input).pathname.includes('/oauth2/') ? Response.json({ accessToken: 'fake-token', expireIn: 7200 }) : Response.json({ code }, { status: 400 })) as typeof fetch)
      await expect(transport.create(request)).rejects.toEqual(new DingTalkDispatchError(disposition))
    }
  })
})
