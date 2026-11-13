import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { ControlError, tenantSlug } from '../contract'
import { oidcFlowLifetimeSeconds, type OidcLogin, type VerifiedOidcIdentity } from './login'

interface WebSession {
  accessToken: string
  expiresAt: string
}

export interface OidcRouteOptions {
  origin: string
  login: OidcLogin
  signIn(identity: VerifiedOidcIdentity): Promise<WebSession>
  setSession(c: Context, session: WebSession): void
}

export function createOidcRoutes(options: OidcRouteOptions) {
  const routes = new Hono()
  const secure = options.origin.startsWith('https:')
  const cookie = secure ? '__Host-enterprise-oidc-flow' : 'enterprise-dev-oidc-flow'
  const cookieOptions = { httpOnly: true, sameSite: 'Lax', secure, path: '/' } as const

  routes.post('/start', async c => {
    if (c.req.header('Origin') !== options.origin) throw new ControlError(403, 'ORIGIN_REQUIRED', '请从企业控制台发起登录。')
    const form = await c.req.parseBody({ all: true })
    const tenant = tenantSlug.safeParse(form.tenant)
    if (!tenant.success) throw new ControlError(400, 'INVALID_INPUT', '请输入有效的组织代码。')
    const flow = await options.login.begin(tenant.data)
    setCookie(c, cookie, flow.browserBinding, { ...cookieOptions, maxAge: oidcFlowLifetimeSeconds })
    return c.redirect(flow.authorizationUrl, 303)
  })

  routes.get('/callback', async c => {
    const query = new URL(c.req.url).searchParams
    const identity = await options.login.complete(query, getCookie(c, cookie))
    const session = await options.signIn(identity)
    deleteCookie(c, cookie, cookieOptions)
    options.setSession(c, session)
    return c.redirect('/', 303)
  })
  return routes
}
