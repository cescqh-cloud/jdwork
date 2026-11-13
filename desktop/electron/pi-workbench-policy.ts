import { isIPv4 } from 'node:net'

export const WORKBENCH_NAME = '力源金蝶研发工作台'
export const WORKBENCH_APP_ID = 'com.liyuan.piworkbench'

export type EnvironmentDefaults = {
  environment?: { name: string, url: string, dataCenter: string }
  miniProgramApiUrl?: string
}

export function normalizeEnvironmentDefaults(input: unknown): EnvironmentDefaults {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('预设环境配置无效。')
  const { environment, miniProgramApiUrl } = input as Record<string, unknown>
  const defaults: EnvironmentDefaults = {}
  const parseAddress = (value: unknown, allowHttp: boolean) => {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('预设连接地址无效。')
    const url = new URL(value)
    if (!(url.protocol === 'https:' || (allowHttp && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash) throw new Error('预设地址只接受无凭据的完整网页地址。')
    return url.href
  }
  if (environment !== undefined) {
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new Error('预设环境格式无效。')
    const { name, url } = environment as Record<string, unknown>
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
      throw new Error('预设环境名称无效。')
    }
    defaults.environment = { name: name.trim(), url: parseAddress(url, true), dataCenter: '' }
  }
  if (miniProgramApiUrl !== undefined) defaults.miniProgramApiUrl = parseAddress(miniProgramApiUrl, false)
  return defaults
}

const dingTalkLogin = 'https://login.dingtalk.com'

export function normalizeWorkbenchOrigin(input: unknown, intranetOrigin?: string): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 300) throw new Error('请输入服务器地址。')
  let parsed: URL
  try { parsed = new URL(input.trim()) }
  catch { throw new Error('请输入完整的服务器地址。') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  const [first, second = 0] = parsed.hostname.split('.').map(Number)
  const privateAddress = isIPv4(parsed.hostname) && (
    first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
  )
  const pinnedIntranet = parsed.origin === intranetOrigin && privateAddress
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (loopback || pinnedIntranet)))
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(intranetOrigin
      ? '请使用预设内网地址或 HTTPS 根地址。本机联调可使用 localhost。'
      : '请使用内网 HTTPS 根地址。本机联调可使用 HTTP 的 localhost 地址。')
  }
  return parsed.origin
}

export function isWorkbenchNavigation(target: string, origin: string): boolean {
  try {
    const url = new URL(target)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      && (url.origin === origin || url.origin === dingTalkLogin)
  } catch { return false }
}

export function workbenchEntry(origin: string, updates = false): string {
  return new URL(updates ? '/desktop/?view=updates' : '/desktop/', origin).href
}
