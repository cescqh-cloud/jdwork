import { RedisClient, SQL, type ServerWebSocket } from 'bun'
import { createControlApp, bearer } from './app'
import { AuditStore } from './audit/store'
import type { ControlConfig } from './config'
import { tokenDigest } from './contract'
import { DeliveryStore } from './delivery/store'
import { DemandService, startDemandWorker } from './demands/service'
import { DemandStore } from './demands/store'
import { startDingTalkStream } from './dingtalk-stream'
import { ErpService } from './erp/service'
import { createOidcLogin, redisOidcState } from './identity'
import { MemoryStore } from './memory/store'
import { assertMigrationsApplied } from './migrate'
import { createDemandPrechecker } from './models/demandPrecheck'
import { ModelStore } from './models/store'
import { ReleaseService } from './releases/service'
import { ReleaseStore } from './releases/store'
import { ControlStore } from './store'
import { PiAuthenticator } from './pi-auth'

interface SyncPeer { token: string, tenantId: string, userId: string, deviceId: string, checking: boolean }
const channel = 'enterprise-control:changes:v1'
const loginWindow = `local attempts = redis.call('INCR', KEYS[1]); if attempts == 1 then redis.call('EXPIRE', KEYS[1], 300); end; return attempts`

export async function startControlRuntime(config: ControlConfig) {
  const database = new SQL(config.databaseUrl)
  const redis = new RedisClient(config.redisUrl, { enableOfflineQueue: false, connectionTimeout: 2000 })
  const subscriber = new RedisClient(config.redisUrl, { connectionTimeout: 2000 })
  const sockets = new Set<ServerWebSocket<SyncPeer>>()
  const piAuth = config.piAuth ? new PiAuthenticator(config.piAuth) : undefined
  const piContext = config.piContext && config.piAuth ? {
    context: config.piContext,
    allowed: async (actor: { tenantId: string }) => {
      const [tenant] = await database`SELECT id FROM enterprise_tenants
        WHERE id = ${actor.tenantId}::uuid AND slug = ${config.piAuth!.tenant} AND active`
      return Boolean(tenant)
    },
  } : undefined
  const store = new ControlStore(database, piAuth)

  async function wake(socket: ServerWebSocket<SyncPeer>) {
    if (socket.data.checking) return
    socket.data.checking = true
    try {
      const actor = await store.authenticate(socket.data.token, true)
      if (actor.device?.id !== socket.data.deviceId) return socket.close(1008, 'Device session ended')
      if (sockets.has(socket)) socket.send(JSON.stringify({ type: 'sync.available' }))
    } catch {
      if (sockets.has(socket)) socket.close(1008, 'Device session ended')
    } finally {
      socket.data.checking = false
    }
  }

  function wakeUser(tenantId: string, userId: string | null) {
    for (const socket of sockets) {
      if (socket.data.tenantId === tenantId && (userId === null || socket.data.userId === userId)) void wake(socket)
    }
  }

  function notify(tenantId: string, userId: string | null) {
    wakeUser(tenantId, userId)
    void redis.publish(channel, JSON.stringify([tenantId, userId])).catch(() => {})
  }
  const models = config.modelGateway ? new ModelStore(database, config.modelGateway, tenantId => notify(tenantId, null), piAuth) : undefined
  const demands = new DemandService(new DemandStore(database), {
    connections: config.dingTalkConnections ?? new Map(),
    precheck: models && config.demandPrecheckModel ? createDemandPrechecker(models, config.demandPrecheckModel) : undefined,
  })
  const oidc = config.oidc ? createOidcLogin(config.oidc, redisOidcState(redis)) : undefined
  const releases = config.releases ? new ReleaseService(new ReleaseStore(database), config.releases, config.origin) : undefined
  const erp = config.erpEnvironments?.length ? new ErpService(database, config.erpEnvironments) : undefined

  const app = createControlApp(store, {
    origin: config.origin,
    localLogin: config.localLogin,
    piAuth: config.piAuth,
    piContext,
    models,
    oidc,
    demands,
    memory: new MemoryStore(database),
    delivery: new DeliveryStore(database),
    releases,
    erp,
    audit: new AuditStore(database),
    async allowLoginAttempt({ tenant, login }) {
      const key = `enterprise-control:login:${tokenDigest(`${tenant}\n${login}`)}`
      const attempts = await redis.send('EVAL', [loginWindow, '1', key])
      return typeof attempts === 'number' && attempts >= 1 && attempts <= 12
    },
    notify,
    async health() {
      await database`SELECT 1 FROM enterprise_schema_migrations LIMIT 1`
      const redisReady = await redis.ping().then(() => true, () => false)
      return { redis: redisReady }
    },
  })

  try {
    await assertMigrationsApplied(database)
    await redis.connect()
    await subscriber.subscribe(channel, message => {
      try {
        const event: unknown = JSON.parse(message)
        if (!Array.isArray(event) || event.length !== 2) return
        const [tenantId, userId] = event
        if (typeof tenantId === 'string' && (userId === null || typeof userId === 'string')) wakeUser(tenantId, userId)
      } catch { /* Redis hints never determine access or durable state. */ }
    })

    const server = Bun.serve<SyncPeer>({
      hostname: config.host, port: config.port, maxRequestBodySize: Math.max(20 * 1024 * 1024, config.releases?.maxBytes ?? 0),
      async fetch(request, listener) {
        const path = new URL(request.url).pathname
        if (path !== '/api/v1/sync/ws') {
          if (models && path.startsWith('/api/v1/model-gateway/')) listener.timeout(request, 120)
          if (releases && request.method === 'PUT' && /^\/api\/v1\/admin\/releases\/[a-f0-9-]{36}\/package$/iu.test(path)) listener.timeout(request, 120)
          if (erp && request.method === 'POST' && (path.startsWith('/api/v1/erp/') || path.startsWith('/console/erp/'))) listener.timeout(request, 25)
          return app.fetch(request)
        }
        const origin = request.headers.get('Origin')
        if (origin && origin !== config.origin) return new Response('Origin denied', { status: 403 })
        const token = bearer(request.headers.get('Authorization'))
        if (!token) return new Response('Device authorization required', { status: 401 })
        const actor = await store.authenticate(token, true).catch(() => null)
        if (!actor?.device) return new Response('Device authorization required', { status: 401 })
        if (sockets.size >= 1024 || [...sockets].filter(socket => socket.data.deviceId === actor.device!.id).length >= 2) {
          return new Response('Sync connections are busy', { status: 429 })
        }
        if (listener.upgrade(request, { data: { token, tenantId: actor.tenantId, userId: actor.id, deviceId: actor.device.id, checking: false } })) return
        return new Response('WebSocket upgrade required', { status: 400 })
      },
      websocket: {
        maxPayloadLength: 256,
        idleTimeout: 60,
        open(socket) { sockets.add(socket); void wake(socket) },
        message(socket) { socket.close(1003, 'This stream sends change hints') },
        close(socket) { sockets.delete(socket) },
      },
    })
    // A missed Redis notification is repaired by an authenticated replay on reconnect or the next hint.
    const heartbeat = setInterval(() => { for (const socket of sockets) void wake(socket) }, 20_000)
    const purge = models && setInterval(() => { void models.purgeExpiredGrants().catch(() => {}) }, 60_000)
    const stopDemandWorker = startDemandWorker(demands)
    const stopDingTalkStream = config.dingTalkStream && startDingTalkStream(config.dingTalkStream, (tenant, event) => demands.ingest(tenant, event), {
      report: status => { console.info(`[enterprise-control] DingTalk Stream ${status}`) },
    })
    return {
      server, store,
      async close() {
        clearInterval(heartbeat)
        if (purge) clearInterval(purge)
        const streamStopped = stopDingTalkStream?.()
        await server.stop(true)
        await streamStopped
        await stopDemandWorker()
        subscriber.close()
        redis.close()
        await database.close()
      },
    }
  } catch (error) {
    subscriber.close()
    redis.close()
    await database.close()
    throw error
  }
}
