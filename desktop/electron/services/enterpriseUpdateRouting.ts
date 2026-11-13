import { isEnterpriseProjectId } from '../../../src/shared/enterpriseModels'

type UpdateRequestOptions = { method?: 'GET' | 'HEAD' | 'POST'; body?: Record<string, unknown>; range?: string; signal?: AbortSignal }
export type EnterpriseUpdateTransport = { binding: string; request(path: string, init?: UpdateRequestOptions): Promise<Response> }

const checkKeys = new Set(['platform', 'arch', 'currentVersion', 'channel'])
const artifactName = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,166}\.exe$/i
const reservedName = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i

export function enterpriseUpdateRequestAllowed(path: string, init?: UpdateRequestOptions): boolean {
  const method = init?.method ?? 'GET'
  if (path.length > 600 || /[\u0000-\u0020\u007f\\#]/.test(path)) return false
  if (path.startsWith('/api/v1/updates/check?') && method === 'GET' && !init?.body && !init?.range) {
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
    const keys = [...query.keys()]
    return ['platform', 'arch', 'currentVersion'].every(key => query.has(key)) && new Set(keys).size === keys.length
      && keys.every(key => checkKeys.has(key) && /^[A-Za-z0-9.+_-]{1,96}$/.test(query.get(key) ?? ''))
  }
  if (path === '/api/v1/client/update-reports' && method === 'POST' && init?.body && !init.range) {
    const { releaseId, eventId, stage, errorCode, ...other } = init.body
    return Object.keys(other).length === 0 && isEnterpriseProjectId(releaseId) && isEnterpriseProjectId(eventId)
      && (stage === 'failed' ? typeof errorCode === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(errorCode)
        : (stage === 'downloaded' || stage === 'installed' || stage === 'healthy') && errorCode === undefined)
  }
  if ((method !== 'GET' && method !== 'HEAD') || init?.body || (init?.range && !/^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/.test(init.range))) return false
  const match = /^\/api\/v1\/updates\/feed\/([^/]+)\/([^/?]+)$/.exec(path)
  if (!match || !isEnterpriseProjectId(match[1])) return false
  if (match[2] === 'latest.yml') return !init?.range
  try {
    const decoded = decodeURIComponent(match[2]!)
    return encodeURIComponent(decoded) === match[2] && artifactName.test(decoded) && !reservedName.test(decoded) && !/[. ]\.exe$/i.test(decoded)
  } catch { return false }
}
