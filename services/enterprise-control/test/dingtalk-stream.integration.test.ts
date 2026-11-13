import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { startDingTalkStream } from '../src/dingtalk-stream'
import { DemandService } from '../src/demands/service'
import { DemandStore } from '../src/demands/store'
import { migrate } from '../src/migrate'

const databaseUrl = Bun.env.ENTERPRISE_TEST_DATABASE_URL
const integration = databaseUrl ? test : test.skip

integration('an actual socket acknowledges after durable insertion and repeated delivery creates only one OA hint', async () => {
  const database = new URL(databaseUrl!)
  if (database.hostname !== '127.0.0.1' || !database.pathname.endsWith('_test') || !['postgres:', 'postgresql:'].includes(database.protocol)) {
    throw new Error('DingTalk Stream integration requires a disposable loopback database')
  }
  const sql = new SQL(databaseUrl!)
  const tenantId = randomUUID()
  const config = { tenant: `stream-fixture-${tenantId.slice(0, 8)}`, corpId: 'ding-test-corp', appKey: 'ding-stream-fixture', appSecret: 'fixture-secret-only' }
  const code = 'PROC-STREAM-ONLY'
  const instance = 'oa-fixture-unique'
  const { promise: acks, resolve, reject } = Promise.withResolvers<string[]>()
  const statuses: string[] = []
  let requests = 0
  function notice(messageId: string) {
    return JSON.stringify({ type: 'EVENT', headers: { messageId, eventType: 'bpms_instance_change', eventCorpId: config.corpId, eventId: 'same-event' },
      data: JSON.stringify({ processCode: code, processInstanceId: instance, type: 'finish', result: 'agree', title: 'fixture private text' }) })
  }
  const upstream = Bun.serve<{ attempt: number }>({ hostname: '127.0.0.1', port: 0,
    fetch(request, listener) {
      requests++
      if (new URL(request.url).pathname === '/connect' && listener.upgrade(request, { data: { attempt: 1 } })) return
      return new Response(null, { status: 404 })
    },
    websocket: {
      open(socket) { socket.send(notice('wire-first')) },
      async message(socket, raw) {
        try {
          const { headers, data } = JSON.parse(String(raw)) as { headers: { messageId: string }, data: string }
          expect(headers.messageId).toBe(socket.data.attempt === 1 ? 'wire-first' : 'wire-repeat')
          statuses.push((JSON.parse(data) as { status: string }).status)
          const result = await sql<{ event_id: string }[]>`SELECT event_id FROM enterprise_dingtalk_demand_inbox WHERE tenant_id = ${tenantId}`
          expect(result.map(row => row.event_id)).toEqual(['same-event'])
          if (socket.data.attempt++ === 1) socket.send(notice('wire-repeat'))
          else resolve(statuses)
        } catch (error) { reject(error) }
      },
    },
  })
  let stop: (() => Promise<void>) | undefined
  let providerCalls = 0
  const deadline = setTimeout(() => reject(new Error('Timed out waiting for two stream acknowledgements')), 7000)
  try {
    await migrate(sql)
    await sql`INSERT INTO enterprise_tenants (id, slug, name) VALUES (${tenantId}, ${config.tenant}, 'Stream fixture')`
    await sql`INSERT INTO enterprise_dingtalk_demand_templates (tenant_id, process_code, label, field_map, approver_options, submit_enabled, import_enabled)
      VALUES (${tenantId}, ${code}, 'Stream fixture template', '{}'::jsonb, '[]'::jsonb, false, true)`
    const unavailable = async (): Promise<never> => { providerCalls++; throw new Error('The upstream result is not part of this fixture') }
    const demand = new DemandService(new DemandStore(sql), { connections: new Map([[config.tenant, { corpId: config.corpId,
      transport: { create: unavailable, get: unavailable, list: unavailable } }]]) })
    stop = startDingTalkStream(config, (tenant, event) => demand.ingest(tenant, event), {
      fetcher: async () => Response.json({ endpoint: 'wss://wss-open-connection.dingtalk.com:443/connect', ticket: 'only-fixture-ticket' }),
      createSocket: pin => new WebSocket(`ws://${upstream.hostname}:${upstream.port}${pin.pathname}`),
    })
    expect(await acks).toEqual(['SUCCESS', 'SUCCESS'])
    expect(requests).toBe(1)
    expect(providerCalls).toBe(0)
    const [row] = await sql`SELECT count(*)::int AS count FROM enterprise_demand_approvals WHERE tenant_id = ${tenantId}`
    expect(row?.count).toBe(0)
  } finally {
    clearTimeout(deadline)
    await stop?.()
    await upstream.stop(true)
    await sql.close()
  }
}, 20_000)
