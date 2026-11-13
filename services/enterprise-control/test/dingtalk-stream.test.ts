import { expect, test } from 'bun:test'
import { loadControlConfig } from '../src/config'
import { loadDingTalkStream, startDingTalkStream } from '../src/dingtalk-stream'
import type { DingTalkEvent } from '../src/demands/callback'

const settings = {
  ENTERPRISE_DATABASE_URL: 'postgres://fixture@127.0.0.1:9/work_test', ENTERPRISE_REDIS_URL: 'redis://127.0.0.1:9',
  ENTERPRISE_DINGTALK_TENANT: 'fixture-org', ENTERPRISE_DINGTALK_CORP_ID: 'ding-fixture-org',
  ENTERPRISE_DINGTALK_APP_KEY: 'ding-fixture-app', ENTERPRISE_DINGTALK_APP_SECRET: 'fixture-secret-only',
}

test('uses DingTalk Stream only when expressly enabled with complete OA credentials', () => {
  expect(loadControlConfig(settings)).toMatchObject({ dingTalkStream: undefined })
  expect(loadControlConfig({ ...settings, ENTERPRISE_DINGTALK_STREAM: 'true' })).toMatchObject({ dingTalkStream: {
    tenant: 'fixture-org', corpId: 'ding-fixture-org', appKey: 'ding-fixture-app',
  } })
  expect(() => loadControlConfig({ ...settings, ENTERPRISE_DINGTALK_APP_SECRET: undefined, ENTERPRISE_DINGTALK_STREAM: 'true' })).toThrow()
  expect(() => loadControlConfig({ ...settings, ENTERPRISE_DINGTALK_STREAM: 'on' })).toThrow('ENTERPRISE_DINGTALK_STREAM')
})

const config = loadDingTalkStream({ ...settings, ENTERPRISE_DINGTALK_STREAM: 'true' })!
const endpoint = 'wss://wss-open-connection.dingtalk.com:443/connect'
const ticket = 'fixture-ticket+space&only'
type Ack = { code: number, headers: { messageId: string }, message: string, data: string }
class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING
  readonly sent: Ack[] = []
  asSocket() { return this as unknown as WebSocket }
  open() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event('open')) }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')) }
  send(text: string) { this.sent.push(JSON.parse(text) as Ack) }
  receive(frame: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })) }
}

function approval(messageId: string, corpId = config.corpId, eventType = 'bpms_instance_change') {
  return { type: 'EVENT', headers: { messageId, eventType, eventCorpId: corpId, eventId: 'header-fixture-id' }, data: JSON.stringify({
    type: 'finish', eventId: 'approval-fixture', processCode: 'PROC-STREAM-FIXTURE', processInstanceId: 'fixture-oa-instance',
    CorpId: corpId, result: 'agree', title: 'private fixture title',
  }) }
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await Bun.sleep(4)
  }
  throw new Error('Stream fixture did not reach the expected state')
}

test('uses the fixed provider endpoint, acknowledges only after queueing, and ignores other organizations and topics', async () => {
  const socket = new FakeSocket()
  const notifications: Array<[string, DingTalkEvent]> = []
  const { promise, resolve } = Promise.withResolvers<void>()
  const statuses: string[] = []
  const observed: { address?: string, method?: string, redirect?: string, payload?: unknown, socket?: string } = {}
  const stop = startDingTalkStream(config, async (tenant, event) => { notifications.push([tenant, event]); await promise }, {
    fetcher: async (url, init) => {
      Object.assign(observed, { address: url, method: init.method, redirect: init.redirect, payload: JSON.parse(String(init.body)) })
      return Response.json({ endpoint, ticket })
    },
    createSocket: url => { observed.socket = url.href; return socket.asSocket() }, report: status => statuses.push(status),
  })
  try {
    await waitFor(() => Boolean(observed.socket))
    expect(observed).toMatchObject({ address: 'https://api.dingtalk.com/v1.0/gateway/connections/open', method: 'POST', redirect: 'error',
      payload: { clientId: config.appKey, clientSecret: config.appSecret, subscriptions: [{ type: 'EVENT', topic: '*' }] } })
    expect(new URL(observed.socket!).searchParams.get('ticket')).toBe(ticket)
    socket.open()
    socket.receive({ type: 'SYSTEM', headers: { topic: 'ping', messageId: 'ping-fixture' }, data: '{"nonce":"fixture"}' })
    expect(socket.sent).toMatchObject([{ headers: { messageId: 'ping-fixture' }, code: 200, data: '{"nonce":"fixture"}' }])
    socket.receive(approval('good'))
    await waitFor(() => notifications.length === 1)
    expect(socket.sent).toHaveLength(1)
    socket.receive(approval('foreign', 'ding-unrelated-org'))
    socket.receive(approval('unrelated', config.corpId, 'user_add_org'))
    socket.receive({ ...approval('mismatched-body'), data: JSON.stringify({ type: 'finish', processCode: 'PROC-STREAM-FIXTURE', processInstanceId: 'fixture-oa-instance', CorpId: 'ding-unrelated-org' }) })
    socket.receive({ ...approval('malformed'), data: '{' })
    await waitFor(() => socket.sent.length === 5)
    expect(socket.sent.find(row => row.headers.messageId === 'malformed')?.data).toBe('{"status":"LATER"}')
    resolve()
    await waitFor(() => socket.sent.length === 6)
    expect(socket.sent.at(-1)).toMatchObject({ headers: { messageId: 'good' }, data: '{"status":"SUCCESS"}' })
    expect(statuses).toEqual(['connected'])
    expect(notifications).toEqual([[config.tenant, { corpId: config.corpId, processCode: 'PROC-STREAM-FIXTURE',
      instanceId: 'fixture-oa-instance', type: 'finish', eventId: 'approval-fixture' }]])
  } finally { resolve(); await stop() }
})

test('rejects an unexpected host, reconnects with fresh tickets, and stops while waiting to retry', async () => {
  const sockets: FakeSocket[] = []
  const socketUrls: string[] = []
  let attempts = 0
  const stop = startDingTalkStream(config, async () => {}, {
    fetcher: async () => Response.json({ endpoint: ++attempts === 1 ? 'wss://unexpected.invalid/connect' : endpoint, ticket: `new-ticket-${attempts}` }),
    createSocket: url => {
      socketUrls.push(url.href)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket.asSocket()
    }, retryDelay: () => 15,
  })
  try {
    await waitFor(() => sockets.length === 1)
    expect(attempts).toBe(2)
    sockets[0]!.open()
    sockets[0]!.receive({ type: 'SYSTEM', headers: { topic: 'disconnect', messageId: 'disconnect-fixture' }, data: '{}' })
    expect(sockets[0]!.sent.at(-1)?.headers.messageId).toBe('disconnect-fixture')
    await waitFor(() => sockets.length === 2)
    expect(socketUrls.map(url => new URL(url).searchParams.get('ticket'))).toEqual(['new-ticket-2', 'new-ticket-3'])
    sockets[1]!.close()
  } finally { await stop() }
  expect(attempts).toBe(3)
  expect(sockets.every(socket => socket.readyState === WebSocket.CLOSED)).toBe(true)
})

test('applies backpressure and requests retry when durable storage fails', async () => {
  const socket = new FakeSocket()
  const { promise, resolve } = Promise.withResolvers<void>()
  let calls = 0
  let attached = false
  const stop = startDingTalkStream(config, async () => { calls++; await promise; throw new Error('fixture storage unavailable') }, {
    fetcher: async () => Response.json({ endpoint, ticket }),
    createSocket: () => { attached = true; return socket.asSocket() },
  })
  try {
    await waitFor(() => attached)
    socket.open()
    for (let i = 0; i < 9; i++) socket.receive(approval(`busy-${i}`))
    expect(calls).toBe(8)
    expect(socket.sent).toMatchObject([{ headers: { messageId: 'busy-8' }, data: '{"status":"LATER"}' }])
    resolve()
    await waitFor(() => socket.sent.length === 9)
    expect(socket.sent.every(message => message.data === '{"status":"LATER"}')).toBe(true)
  } finally { resolve(); await stop() }
})
