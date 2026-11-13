export const OIDC_MOUNT_PATH = '/console/sso'
export const OIDC_START_PATH = OIDC_MOUNT_PATH + '/start'
export const OIDC_CALLBACK_PATH = OIDC_MOUNT_PATH + '/callback'

const keys = {
  issuer: 'ENTERPRISE_OIDC_ISSUER',
  authorizationEndpoint: 'ENTERPRISE_OIDC_AUTHORIZATION_URL',
  tokenEndpoint: 'ENTERPRISE_OIDC_TOKEN_URL',
  jwksUri: 'ENTERPRISE_OIDC_JWKS_URL',
  clientId: 'ENTERPRISE_OIDC_CLIENT_ID',
  clientSecret: 'ENTERPRISE_OIDC_CLIENT_SECRET',
  tokenAuthMethod: 'ENTERPRISE_OIDC_TOKEN_AUTH_METHOD',
} as const

export interface OidcConfig {
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly jwksUri: string
  readonly clientId: string
  readonly clientSecret: string
  readonly tokenAuthMethod: 'client_secret_basic' | 'client_secret_post'
  readonly redirectUri: string
}

function required(value: string | undefined, field: string, maxLength: number): string {
  if (!value || value.length > maxLength || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${field} requires a configured value`)
  }
  return value
}

function providerUrl(value: string | undefined, field: string): string {
  const address = required(value, field, 2048)
  let url: URL
  try { url = new URL(address) }
  catch { throw new Error(`${field} requires an HTTPS URL`) }
  if (!address.startsWith('https://') || /[\s\\?#]/u.test(address) || url.username || url.password) {
    throw new Error(`${field} requires an HTTPS URL without credentials, query or fragment`)
  }
  // The issuer in an ID token must match the configured identifier exactly.
  return address
}

export function loadOidcConfig(env: Record<string, string | undefined>, origin: string): OidcConfig | undefined {
  if (!Object.values(keys).some(key => env[key] !== undefined)) return undefined
  const tokenAuthMethod = env[keys.tokenAuthMethod] ?? 'client_secret_basic'
  if (tokenAuthMethod !== 'client_secret_basic' && tokenAuthMethod !== 'client_secret_post') {
    throw new Error(`${keys.tokenAuthMethod} must use client_secret_basic or client_secret_post`)
  }
  return {
    issuer: providerUrl(env[keys.issuer], keys.issuer),
    authorizationEndpoint: providerUrl(env[keys.authorizationEndpoint], keys.authorizationEndpoint),
    tokenEndpoint: providerUrl(env[keys.tokenEndpoint], keys.tokenEndpoint),
    jwksUri: providerUrl(env[keys.jwksUri], keys.jwksUri),
    clientId: required(env[keys.clientId], keys.clientId, 256),
    clientSecret: required(env[keys.clientSecret], keys.clientSecret, 1024),
    tokenAuthMethod,
    redirectUri: new URL(OIDC_CALLBACK_PATH, origin).href,
  }
}
