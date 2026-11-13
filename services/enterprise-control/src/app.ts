import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { html } from 'hono/html'
import type { z } from 'zod'
import { mountAuditRoutes } from './audit/routes'
import { canReadAudit, type AuditStore } from './audit/store'
import { ControlError, controlTitle, enrollInput, loginInput, refreshInput, revokeInput, tokenDigest, tokenSchema, type LoginInput } from './contract'
import { mountDeliveryRoutes } from './delivery/routes'
import type { DeliveryStore } from './delivery/store'
import { mountDemandRoutes } from './demands/routes'
import type { DemandService } from './demands/service'
import { mountErpRoutes } from './erp/routes'
import type { ErpService } from './erp/service'
import { createOidcRoutes, OIDC_MOUNT_PATH, OIDC_START_PATH, type OidcLogin } from './identity'
import { mountMemoryRoutes } from './memory/routes'
import type { MemoryStore } from './memory/store'
import { mountModelRoutes } from './models/routes'
import type { ModelStore } from './models/store'
import { controlOpenApi } from './openapi'
import { mountPiContextRoutes, type ContextActor } from './pi-context-routes'
import type { PiContextInput } from './pi-context'
import { mountReleaseRoutes } from './releases/routes'
import type { ReleaseService } from './releases/service'
import type { ControlStore } from './store'

export interface ControlAppOptions {
  origin: string
  localLogin: boolean
  piAuth?: { tenant: string }
  piContext?: { context: { read(input: PiContextInput, signal?: AbortSignal): Promise<string> }, allowed(actor: ContextActor): Promise<boolean> }
  oidc?: OidcLogin
  models?: ModelStore
  demands?: DemandService
  memory?: MemoryStore
  releases?: ReleaseService
  delivery?: DeliveryStore
  erp?: ErpService
  audit?: AuditStore
  allowLoginAttempt(input: Pick<LoginInput, 'tenant' | 'login'>): Promise<boolean>
  notify(tenantId: string, userId: string | null): void
  health(): Promise<{ redis: boolean }>
}

export function bearer(authorization: string | null | undefined): string | undefined {
  if (!authorization?.startsWith('Bearer ')) return undefined
  const result = tokenSchema.safeParse(authorization.slice(7))
  return result.success ? result.data : undefined
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input)
  if (!value.success) throw new ControlError(400, 'INVALID_INPUT', 'Check the request fields and try again.')
  return value.data
}

async function json<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ControlError(400, 'JSON_REQUIRED', 'Send application/json for this endpoint.')
  }
  const value: unknown = await c.req.json().catch(() => undefined)
  return parse(schema, value)
}

function page(title: string, body: ReturnType<typeof html>) {
  return html`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title} · ${controlTitle}</title><link rel="stylesheet" href="/console.css"></head>
    <body><main><header><a href="/">${controlTitle}</a><h1>${title}</h1></header>${body}</main></body></html>`
}

const consoleCss = `
:root{font:16px/1.55 system-ui,sans-serif;color:#203043;background:#f5f7fa}*{box-sizing:border-box}
main{max-width:950px;margin:3rem auto;padding:0 1rem}header{margin-bottom:1.5rem}h1{margin:.45rem 0}a{color:#176657}
section,form.login{background:white;padding:1.2rem;border:1px solid #d7e0e8;border-radius:10px;margin-bottom:1rem}
form.login{max-width:28rem;display:grid;gap:.85rem}label{display:grid;gap:.3rem;font-weight:600}
input,button,select{font:inherit;border-radius:6px;padding:.55rem .8rem}input,select{border:1px solid #8d9bab;min-width:0}
form.login label.choice{display:flex;align-items:center;gap:.5rem;font-weight:500}fieldset{border:1px solid #d7e0e8;border-radius:6px}
details{margin:.8rem 0}summary{cursor:pointer;font-weight:600}.field-pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.7rem}
button{border:1px solid #176657;background:#176657;color:white;cursor:pointer}button.secondary{background:white;color:#176657}
code{display:block;overflow-wrap:anywhere;user-select:all;padding:.8rem;background:#edf4f4;border-radius:6px}
.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:570px}th,td{text-align:left;padding:.65rem;border-bottom:1px solid #d7e0e8}
:focus-visible{outline:3px solid #a55a07;outline-offset:2px}`

export function createControlApp(store: ControlStore, options: ControlAppOptions) {
  const app = new Hono<{ Variables: { requestId: string } }>()
  const secure = options.origin.startsWith('https:')
  const cookie = secure ? '__Host-enterprise-session' : 'enterprise-dev-session'

  app.use('*', async (c, next) => {
    const id = randomUUID()
    c.set('requestId', id)
    c.header('X-Request-Id', id)
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    // Keep a same-origin form's Origin header while limiting Referer to the origin.
    c.header('Referrer-Policy', 'strict-origin')
    const releasePage = options.releases && (c.req.path === '/console/releases' || c.req.path.startsWith('/console/releases/'))
    const releaseDirectives = releasePage ? "; script-src 'self'; connect-src 'self'" : ''
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'${releaseDirectives}`)
    const origin = c.req.header('Origin')
    if (origin !== undefined && origin !== options.origin) throw new ControlError(403, 'ORIGIN_DENIED', 'Use the configured control console origin.')
    await next()
  })
  const limit = (maxSize: number) => bodyLimit({ maxSize, onError: c => c.json({ error: { code: 'BODY_LIMIT', message: 'The request exceeds the allowed size.' }, requestId: c.get('requestId') }, 413) })
  const smallBody = limit(16_384)
  const modelBody = limit(20 * 1024 * 1024)
  const demandBody = limit(128 * 1024)
  const releaseManifestBody = limit(65_536)
  app.use('*', (c, next) => {
    const path = c.req.path
    if (options.releases && c.req.method === 'PUT' && /^\/api\/v1\/admin\/releases\/[a-f0-9-]{36}\/(?:manifest|package)$/iu.test(path)) {
      return path.endsWith('/package') ? next() : releaseManifestBody(c, next)
    }
    if (options.models && path.startsWith('/api/v1/model-gateway/')) return modelBody(c, next)
    if (options.memory && c.req.method === 'POST' && (path === '/console/knowledge/import' || path === '/api/v1/admin/knowledge/import')) {
      // The upload routes have their own multipart size limit.
      return next()
    }
    if (options.demands && /^(?:\/api\/v1\/(?:admin\/)?|\/console\/)demands(?:\/|$)/u.test(path)) return demandBody(c, next)
    return smallBody(c, next)
  })
  app.onError((error, c) => {
    const known = error instanceof ControlError
    const code = known ? error.code : 'CONTROL_UNAVAILABLE'
    const message = known ? error.message : 'The enterprise control service could not complete this request.'
    const status = known ? error.status : 503
    if (c.req.path === '/' || c.req.path.startsWith('/console/')) {
      return c.html(page('操作未完成', html`<p>${message}</p><a href="/">返回控制台</a>`), status)
    }
    return c.json({ error: { code, message }, requestId: c.get('requestId') }, status)
  })

  function webToken(c: Context) {
    const header = c.req.header('Authorization')
    if (header !== undefined) return bearer(header)
    const value = getCookie(c, cookie)
    if (!value) return undefined
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('Origin') !== options.origin) {
      throw new ControlError(403, 'ORIGIN_REQUIRED', 'Open the control console again and retry.')
    }
    return tokenSchema.safeParse(value).success ? value : undefined
  }

  async function actor(c: Context, deviceAllowed = true) {
    const token = webToken(c)
    if (!token) throw new ControlError(401, 'AUTH_REQUIRED', 'Sign in to the control console or bind a desktop device.')
    return store.authenticate(token, deviceAllowed)
  }

  async function signIn(input: LoginInput) {
    if (!options.localLogin) throw new ControlError(403, 'LOCAL_SIGN_IN_DISABLED', 'Enterprise identity sign-in is required.')
    if (!await options.allowLoginAttempt(input)) throw new ControlError(429, 'LOGIN_RATE_LIMIT', 'Too many attempts. Wait a few minutes before trying again.')
    return store.signIn(input)
  }

  function setSession(c: Context, session: { accessToken: string, expiresAt: string }) {
    setCookie(c, cookie, session.accessToken, { httpOnly: true, sameSite: 'Lax', secure, path: '/', expires: new Date(session.expiresAt) })
  }

  async function bootstrap(c: Context) {
    const state = await store.bootstrap(await actor(c))
    state.policy.features.models = Boolean(options.models)
    state.policy.features.demands = Boolean(options.demands)
    state.policy.features.memories = Boolean(options.memory)
    state.policy.features.updates = Boolean(options.releases)
    return state
  }

  app.get('/healthz', async c => {
    const { redis } = await options.health()
    return c.json({ ok: redis, redis }, redis ? 200 : 503)
  })
  app.get('/openapi.json', c => c.json(controlOpenApi))
  app.get('/console.css', c => c.text(consoleCss, 200, { 'Content-Type': 'text/css; charset=utf-8' }))
  app.get('/', async c => {
    const token = webToken(c)
    const user = token ? await store.authenticate(token, false).catch(error => {
      if (error instanceof ControlError && error.status === 401) return undefined
      throw error
    }) : undefined
    if (!user) return c.html(page('企业控制台登录', html`
      ${options.oidc ? html`<form class="login" method="post" action="${OIDC_START_PATH}">
        <label>组织代码<input name="tenant" required maxlength="48" autocomplete="organization"></label>
        <button>企业单点登录</button>
      </form>` : ''}
      ${options.localLogin ? html`<form class="login" method="post" action="/console/session">
        <label>组织代码<input name="tenant" required maxlength="48" autocomplete="organization"></label>
        <label>账号<input name="login" required maxlength="120" autocomplete="username"></label>
        <label>密码<input name="password" type="password" required maxlength="256" autocomplete="current-password"></label>
        <button>登录</button>
      </form>` : ''}
      ${options.piAuth ? html`<form class="login" method="post" action="/console/pi-session">
        <p>先在原工作台完成钉钉登录，再继续。</p><button>使用原工作台钉钉账号</button>
      </form><form class="login" method="post" action="/console/pi-token">
        <label>原工作台管理员口令<input name="token" type="password" required maxlength="256" autocomplete="off"></label>
        <button>管理员登录</button>
      </form>` : ''}
      ${!options.oidc && !options.localLogin && !options.piAuth ? html`<p>当前服务需要配置企业登录入口。</p>` : ''}`))
    const devices = user.roles.includes('platform_admin') ? await store.devices(user) : undefined
    return c.html(page('企业控制台', html`
      <section><h2>${user.displayName}</h2><p>角色 ${user.roles.join('、')}</p>
      <form method="post" action="/console/enrollment"><button>生成桌面绑定码</button></form>
      <p>在桌面客户端的「设置 → 通用」填写本控制台地址和绑定码。</p>
      ${options.models ? html`<a href="/console/model-usage">我的模型用量</a>` : ''}
      ${devices && options.models ? html` · <a href="/console/models">模型中心</a>` : ''}
      ${options.demands ? html`<p><a href="/console/demands">需求与审批</a></p>` : ''}
      ${options.delivery ? html`<p><a href="/console/deliveries">开发交付与验收</a></p>` : ''}
      ${options.erp ? html`<p><a href="/console/erp">金蝶只读查询</a></p>` : ''}
      ${options.audit && canReadAudit(user) ? html`<p><a href="/console/audit">操作审计</a></p>` : ''}
      ${options.memory ? html`<p><a href="/console/memories">记忆中心</a> · <a href="/console/knowledge">企业知识库</a></p>` : ''}
      ${devices && options.releases ? html`<p><a href="/console/releases">版本发布</a></p>` : ''}</section>
      ${devices ? html`<section><h2>设备</h2><div class="table-scroll"><table><thead><tr>
        <th>使用人</th><th>系统</th><th>版本</th><th>最后连接</th><th>状态</th>
      </tr></thead><tbody>${devices.map(device => html`<tr>
        <td>${device.owner}</td><td>${device.platform}</td><td>${device.clientVersion}</td><td>${device.lastSeenAt.toISOString()}</td>
        <td>${device.revokedAt ? '已撤销' : html`<form method="post" action="/console/revoke">
          <input type="hidden" name="deviceId" value="${device.id}"><button class="secondary">撤销设备</button></form>`}</td>
      </tr>`)}</tbody></table></div>${devices.length ? '' : html`<p>暂无已绑定设备。</p>`}</section>` : ''}
      <form method="post" action="/console/signout"><button class="secondary">退出登录</button></form>`))
  })
  app.post('/console/session', async c => {
    if (c.req.header('Origin') !== options.origin) throw new ControlError(403, 'ORIGIN_REQUIRED', 'Use the control console login form.')
    const result = await signIn(parse(loginInput, await c.req.parseBody()))
    setSession(c, result)
    return c.redirect('/', 303)
  })
  if (options.piAuth) {
    const piTenant = options.piAuth.tenant
    async function signInPi(c: Context, kind: 'token' | 'session', value: unknown) {
      if (c.req.header('Origin') !== options.origin) throw new ControlError(403, 'ORIGIN_REQUIRED', '请从企业控制台登录。')
      if (typeof value !== 'string' || value.length > 256) throw new ControlError(401, 'PI_IDENTITY_REQUIRED', '请先登录原工作台。')
      const attemptKey = kind === 'token' ? 'pi-admin' : `pi-session-${tokenDigest(value).slice(0, 32)}`
      if (!await options.allowLoginAttempt({ tenant: piTenant, login: attemptKey })) {
        throw new ControlError(429, 'LOGIN_RATE_LIMIT', '登录次数过多，请稍后重试。')
      }
      const session = await store.signInPi({ kind, value })
      setSession(c, session)
      return c.redirect('/', 303)
    }
    app.post('/console/pi-session', c => signInPi(c, 'session', getCookie(c, 'pi_session')))
    app.post('/console/pi-token', async c => {
      if (c.req.header('Origin') !== options.origin) throw new ControlError(403, 'ORIGIN_REQUIRED', '请从企业控制台登录。')
      const form = await c.req.parseBody()
      return signInPi(c, 'token', form.token)
    })
  }
  app.post('/console/signout', async c => {
    const token = webToken(c)
    if (token) await store.signOut(token)
    deleteCookie(c, cookie, { path: '/', secure })
    return c.redirect('/', 303)
  })
  app.post('/console/enrollment', async c => {
    const challenge = await store.issueChallenge(await actor(c, false))
    return c.html(page('桌面绑定码', html`<section><p>在客户端填写控制台地址和绑定码。绑定码仅能使用一次，有效期 5 分钟。</p>
      <p>控制台地址</p><code>${options.origin}</code><p>绑定码</p><code>${challenge.challenge}</code></section><a href="/">返回控制台</a>`))
  })
  app.post('/console/revoke', async c => {
    const user = await actor(c, false)
    const { deviceId } = parse(revokeInput, await c.req.parseBody())
    const result = await store.revoke(user, deviceId)
    if (result.changed) options.notify(user.tenantId, result.userId)
    return c.redirect('/', 303)
  })

  const api = app.basePath('/api/v1')
  api.post('/auth/exchange', async c => c.json(await signIn(await json(c, loginInput))))
  api.post('/devices/challenge', async c => c.json(await store.issueChallenge(await actor(c, false)), 201))
  api.post('/devices/intranet-challenge', async c => c.json(await store.issueIntranetChallenge(options.piAuth?.tenant ?? 'liyuan'), 201))
  api.post('/devices/enroll', async c => {
    const result = await store.enroll(await json(c, enrollInput))
    options.notify(result.tenantId, result.userId)
    return c.json(result.tokens, 201)
  })
  api.post('/devices/refresh', async c => c.json(await store.refresh(await json(c, refreshInput))))
  api.get('/admin/devices', async c => c.json({ devices: await store.devices(await actor(c, false)) }))
  api.post('/devices/revoke', async c => {
    const user = await actor(c, false)
    const { deviceId } = await json(c, revokeInput)
    const result = await store.revoke(user, deviceId)
    if (result.changed) options.notify(user.tenantId, result.userId)
    return c.json({ revoked: true })
  })
  api.get('/bootstrap', async c => c.json(await bootstrap(c)))
  api.get('/client/policy', async c => {
    const { policy } = await bootstrap(c)
    const version = `"policy-${tokenDigest(JSON.stringify(policy))}"`
    c.header('ETag', version)
    if (c.req.header('If-None-Match') === version) return c.body(null, 304)
    return c.json(policy)
  })
  api.get('/events', async c => {
    const cursor = c.req.query('cursor') ?? '0'
    if (!/^(?:0|[1-9]\d{0,15})$/u.test(cursor) || !Number.isSafeInteger(Number(cursor))) {
      throw new ControlError(400, 'INVALID_CURSOR', 'Use a non-negative event cursor.')
    }
    return c.json(await store.events(await actor(c), Number(cursor)))
  })

  if (options.oidc) app.route(OIDC_MOUNT_PATH, createOidcRoutes({ origin: options.origin, login: options.oidc,
    signIn: identity => store.signInExternal(identity), setSession }))
  if (options.piContext) mountPiContextRoutes(app, { ...options.piContext, actor })
  if (options.models) mountModelRoutes(app, { store: options.models, memory: options.memory, erp: options.erp, actor, parse, json, page })
  if (options.demands) mountDemandRoutes(app, { service: options.demands, actor })
  if (options.memory) mountMemoryRoutes(app, { store: options.memory, actor, parse, json, page })
  if (options.releases) mountReleaseRoutes(app, { service: options.releases, actor })
  if (options.delivery) mountDeliveryRoutes(app, { store: options.delivery, actor, parse, json, page, notify: options.notify })
  if (options.erp) mountErpRoutes(app, { service: options.erp, actor, parse, json, page })
  if (options.audit) mountAuditRoutes(app, { store: options.audit, actor, parse, json, page })

  return app
}
