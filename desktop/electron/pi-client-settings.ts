import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { readFile, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron'
import { createWorkbenchContext, validContextKey } from './pi-client-context'
import { connectRemoteMcp, openClientTools, runDeviceHelper, webAddress, type RemoteMcp } from './pi-client-tools'
import { createQueryBrowser } from './pi-query-browser'
import { normalizeWorkbenchOrigin, type EnvironmentDefaults } from './pi-workbench-policy'

const scenes = ['default', 'research', 'bugfix', 'report', 'testing', 'release', 'review'] as const
type Scene = typeof scenes[number]
type Model = { baseUrl: string, name: string, key: string, imageInput?: boolean }
type Environment = { name: string, url: string, dataCenter: string }
type Settings = {
  models: Partial<Record<Scene, Model>>
  workspace: string
  computerUse: boolean
  environment?: Environment | null
  mcp?: RemoteMcp
  management: string
  releaseKey?: string
  contextKey?: string
}
type Manifest = { version: string, platform: 'win32', arch: 'x64', filename: string, bytes: number, sha256: string, notes: string }
type Feed = { id: string, manifest: Manifest }
type Engine = 'cc-haha' | 'pi'
type Options = {
  dataDir: string, helper?: string, defaultManagement: string, intranetOrigin?: string, releaseKey?: string
  defaults?: EnvironmentDefaults, engine?: Engine
  owner: () => BrowserWindow | undefined
}

class ClientInputError extends Error {
  override name = 'ClientInputError'
}

function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClientInputError('配置格式无效')
  return value as Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function windowTitles(data: unknown[]) {
  const windows = new Map<string, { id: string, title: string }>()
  for (const item of data) {
    const window = record(item)
    const id = window?.id ?? window?.window_id
    if (typeof id !== 'string' || !/^(?:w-)?[1-9]\d{0,18}$/.test(id) || typeof window?.title !== 'string') continue
    const title = window.title.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 180)
    if (title) windows.set(id, { id, title })
    if (windows.size === 30) break
  }
  return [...windows.values()]
}

function sourcePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 1024) return false
  let decoded = value
  try { decoded = decodeURIComponent(value) } catch { /* A literal percent sign is valid in a note name. */ }
  return [value, decoded].every(path => !/[\x00-\x1f\x7f\\]/.test(path) && !/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(path)
    && !path.split('/').some(part => !part || part === '.' || part === '..'))
}

function sourceLines(sources: unknown[]) {
  const matches = new Map<string, { path: string, line: number, text: string }>()
  for (const item of sources) {
    const source = record(item)
    if (!source || !sourcePath(source.path) || !Array.isArray(source.lines)) continue
    for (const item of source.lines) {
      const line = record(item)
      if (typeof line?.line !== 'number' || !Number.isSafeInteger(line.line) || line.line < 1
        || typeof line.text !== 'string' || !line.text.trim()) continue
      const match = { path: source.path, line: line.line, text: line.text.slice(0, 600) }
      matches.set(`${match.path}:${match.line}`, match)
      if (matches.size === 20) return [...matches.values()]
    }
  }
  return [...matches.values()]
}

function string(value: unknown, name: string, limit: number, required = true) {
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value) || (required && !value.trim())) {
    throw new ClientInputError(`${name}格式无效`)
  }
  return value.trim()
}

function address(value: unknown, secure = false) {
  try { return webAddress(value, secure).href }
  catch { throw new ClientInputError(secure ? '请填写 HTTPS 地址，本机联调可使用 loopback' : '请填写有效的网页地址') }
}

function modelEndpoint(value: unknown) {
  const url = new URL(address(value, true))
  if (url.search || /\/chat\/completions\/?$/.test(url.pathname)) throw new ClientInputError('请填写模型 API 根地址，例如以 /v1 结尾')
  return url.href.replace(/\/$/, '')
}

function mcpHeaders(value: unknown) {
  if (value === undefined) return undefined
  const source = object(value)
  const headers: Record<string, string> = Object.create(null)
  if (Object.keys(source).length > 12) throw new ClientInputError('MCP 请求头最多 12 项')
  for (const [key, item] of Object.entries(source)) {
    if (!/^[a-z0-9-]{1,48}$/i.test(key) || /^(?:cookie|host|content-length|connection|accept|content-type|mcp-session-id|mcp-protocol-version)$/i.test(key)) {
      throw new ClientInputError('MCP 请求头名称无效')
    }
    headers[key] = string(item, '请求头', 4096)
  }
  return headers
}

function versionParts(value: unknown) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/.test(value)) return undefined
  return value.split('.').map(Number)
}

export function verifyClientFeed(value: unknown, releaseKey?: string): Feed {
  const { id, manifest } = object(value)
  const { version, platform, arch, filename, bytes, sha256, notes, signature } = object(manifest)
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || typeof version !== 'string' || !versionParts(version)
    || platform !== 'win32' || arch !== 'x64' || typeof filename !== 'string' || filename.length > 200
    || !filename.toLowerCase().endsWith('.exe') || /[\\/:<>"|?*\x00-\x1f\x7f]/.test(filename)
    || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 512 * 1024 * 1024
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || typeof notes !== 'string' || notes.length > 8000
    || typeof signature !== 'string' || signature.length !== 88) throw new ClientInputError('版本清单格式无效')
  if (!releaseKey) throw new ClientInputError('安装包未配置发布公钥，无法验证更新')
  const fields: Manifest = { version, platform, arch, filename, bytes, sha256, notes }
  let trusted = false
  try {
    const key = createPublicKey({ key: Buffer.from(releaseKey, 'base64'), format: 'der', type: 'spki' })
    trusted = key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(JSON.stringify(fields)), key, Buffer.from(signature, 'base64'))
  } catch {}
  if (!trusted) throw new ClientInputError('版本签名校验失败')
  return { id, manifest: fields }
}

export async function createClientSettings({ dataDir, helper, defaultManagement, intranetOrigin, releaseKey, defaults, owner, engine = 'pi' }: Options) {
  const browser = createQueryBrowser()
  const file = join(dataDir, 'connections.dpapi')
  const deviceHome = join(dataDir, 'computer-use')
  let settings: Settings = { models: {}, workspace: '', computerUse: false, management: defaultManagement }
  let revision = 0
  let pending: Promise<unknown> = Promise.resolve()
  let lastUpdate: { origin: string, feed: Feed } | undefined
  try {
    const stored = await readFile(file)
    if (stored.length > 130_000) throw new Error('本机连接配置过大')
    settings = JSON.parse(safeStorage.decryptString(stored)) as Settings
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取本机连接配置')
  }
  if (settings.environment === undefined && defaults?.environment) settings.environment = defaults.environment

  function view() {
    return {
      revision, workspace: settings.workspace, computerUse: !!helper && settings.computerUse, computerAvailable: !!helper,
      models: Object.fromEntries(Object.entries(settings.models).map(([scene, item]) =>
        [scene, { baseUrl: item?.baseUrl, name: item?.name, hasKey: !!item?.key, imageInput: item?.imageInput === true }])),
      environment: settings.environment ?? undefined,
      miniProgramApiUrl: defaults?.miniProgramApiUrl,
      mcp: settings.mcp ? { name: settings.mcp.name, url: settings.mcp.url, hasHeaders: !!Object.keys(settings.mcp.headers).length } : undefined,
      management: settings.management, hasReleaseKey: Boolean(settings.releaseKey || releaseKey),
      hasContextKey: validContextKey(settings.contextKey),
      runtime: { version: app.getVersion(), engine, engineVersion: engine === 'cc-haha' ? '0.7.7' : '1.4.0' },
    }
  }
  function write(update: (previous: Settings) => Settings) {
    const operation = pending.then(async () => {
      if (!safeStorage.isEncryptionAvailable()) throw new ClientInputError('Windows 凭据加密不可用')
      const next = update(settings)
      const temporary = file + '.' + randomUUID()
      try {
        await writeFile(temporary, safeStorage.encryptString(JSON.stringify(next)), { flag: 'wx', mode: 0o600 })
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }).catch(() => {}) }
      settings = next
      revision++
      return view()
    })
    pending = operation.catch(() => {})
    return operation
  }
  async function save(input: unknown) {
    const args = object(input)
    const part = object(args.value)
    return write(previous => {
      if (args.revision !== revision) throw new ClientInputError('连接配置有更新，请重新读取后再保存')
      if (args.section === 'model') {
        const scene = part.scene as Scene
        if (!scenes.includes(scene)) throw new ClientInputError('任务场景无效')
        const models = { ...previous.models }
        if (part.clear === true) { delete models[scene]; return { ...previous, models } }
        const baseUrl = modelEndpoint(part.baseUrl)
        const name = string(part.name, '模型名称', 120)
        const old = models[scene]
        const key = string(part.key ?? '', 'API Key', 4096, false) || (old?.baseUrl === baseUrl ? old.key : '')
        if (!key) throw new ClientInputError('请填写该接口的 API Key')
        if (part.imageInput !== undefined && typeof part.imageInput !== 'boolean') throw new ClientInputError('图片输入设置无效')
        const imageInput = part.imageInput ?? (old?.baseUrl === baseUrl && old.name === name && old.imageInput === true)
        models[scene] = { baseUrl, name, key, imageInput }
        return { ...previous, models }
      }
      if (args.section === 'environment') return { ...previous, environment: part.clear === true ? null : {
        name: string(part.name, '环境名称', 80), url: address(part.url), dataCenter: string(part.dataCenter ?? '', '数据中心', 120, false),
      } }
      if (args.section === 'mcp') {
        if (part.clear === true) return { ...previous, mcp: undefined }
        const name = string(part.name, 'MCP 名称', 64)
        if (!/^[\w-]+$/.test(name) || name.includes('__')) throw new ClientInputError('MCP 名称使用字母、数字、下划线或中划线')
        const url = address(part.url, true)
        const headers = mcpHeaders(part.headers) ?? (previous.mcp?.url === url ? previous.mcp.headers : {})
        return { ...previous, mcp: { name, url, headers } }
      }
      if (args.section === 'computer' && typeof part.enabled === 'boolean') {
        if (part.enabled && !helper) throw new ClientInputError('此安装包未包含 Computer Use 组件')
        return { ...previous, computerUse: part.enabled }
      }
      if (args.section === 'management') {
        let management: string
        try { management = normalizeWorkbenchOrigin(part.url, intranetOrigin) }
        catch { throw new ClientInputError('请填写管理服务器的 HTTPS 根地址或预设办公网地址') }
        const publicKey = string(part.releaseKey ?? '', '发布公钥', 256, false)
        if (publicKey) {
          try {
            const der = Buffer.from(publicKey, 'base64')
            if (der.toString('base64') !== publicKey
              || createPublicKey({ key: der, format: 'der', type: 'spki' }).asymmetricKeyType !== 'ed25519') throw new Error()
          } catch { throw new ClientInputError('发布公钥须为 Base64 Ed25519 公钥') }
        }
        const sameServer = previous.management === management
        return { ...previous, management, releaseKey: publicKey || (sameServer ? previous.releaseKey : undefined),
          contextKey: sameServer ? previous.contextKey : undefined }
      }
      if (args.section === 'context') {
        if (part.clear === true) return { ...previous, contextKey: undefined }
        try { normalizeWorkbenchOrigin(previous.management, intranetOrigin) }
        catch { throw new ClientInputError('请先保存管理服务器地址') }
        const contextKey = string(part.key, '资料连接口令', 128)
        if (!validContextKey(contextKey)) throw new ClientInputError('资料连接口令格式无效，请使用管理员提供的专用口令')
        return { ...previous, contextKey }
      }
      throw new ClientInputError('连接配置类型无效')
    })
  }
  const chosenModel = (scene: Scene) => settings.models[scene] ?? settings.models.default

  function contextConnection(signal: AbortSignal) {
    const { management, contextKey } = settings
    if (!validContextKey(contextKey)) return undefined
    try {
      return createWorkbenchContext(management, contextKey, intranetOrigin, signal,
        () => settings.management === management && settings.contextKey === contextKey)
    } catch { return undefined }
  }

  async function checkUpdates(input?: unknown) {
    const origin = settings.management
    if (!origin) throw new ClientInputError('请先填写管理端地址')
    if (object(input ?? {}).download === true) {
      if (!lastUpdate || origin !== lastUpdate.origin) throw new ClientInputError('请先检查可用版本')
      const { id, manifest } = lastUpdate.feed
      const window = owner()
      if (!window || window.isDestroyed()) return { downloaded: false }
      const chosen = await dialog.showSaveDialog(window, { defaultPath: manifest.filename, filters: [{ name: 'Windows 安装包', extensions: ['exe'] }] })
      if (chosen.canceled || !chosen.filePath) return { downloaded: false }
      const response = await fetch(new URL(`/api/desktop/release-feed/${id}/download`, origin), {
        redirect: 'error', signal: AbortSignal.timeout(180_000),
      })
      if (!response.ok || !response.body) throw new ClientInputError('无法下载该版本，可能已被撤回')
      const temporary = chosen.filePath + '.' + randomUUID() + '.part'
      const hash = createHash('sha256')
      let bytes = 0
      try {
        const digest = new Transform({ transform(chunk: Buffer, _encoding, next) {
          bytes += chunk.length
          if (bytes > manifest.bytes) { next(new Error('安装包长度不匹配')); return }
          hash.update(chunk)
          next(null, chunk)
        } })
        await pipeline(Readable.fromWeb(response.body as never), digest, createWriteStream(temporary, { flags: 'wx' }))
        if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256) throw new ClientInputError('安装包校验失败')
        await rename(temporary, chosen.filePath)
        shell.showItemInFolder(chosen.filePath)
        return { downloaded: true }
      } finally { await rm(temporary, { force: true }).catch(() => {}) }
    }
    lastUpdate = undefined
    const response = await fetch(new URL('/api/desktop/release-feed/latest', origin), {
      redirect: 'error', signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new ClientInputError('管理端未提供版本分发接口')
    const source = object(await response.json()).release
    if (!source) return { version: app.getVersion(), release: null }
    const feed = verifyClientFeed(source, settings.releaseKey || releaseKey)
    const current = versionParts(app.getVersion()) ?? [0, 0, 0]
    const next = versionParts(feed.manifest.version)!
    const newer = next.map((part, index) => part - current[index]!).find(diff => diff !== 0) ?? 0
    if (newer > 0) lastUpdate = { origin, feed }
    return { version: app.getVersion(), release: feed.manifest, updateAvailable: newer > 0 }
  }

  return {
    view, save, checkUpdates, closeBrowser: browser.close,
    async pickFolder() {
      const window = owner()
      if (!window || window.isDestroyed()) return view()
      const selected = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: '选择工作文件夹' })
      return selected.canceled || !selected.filePaths[0] ? view() : write(previous => ({ ...previous, workspace: selected.filePaths[0]! }))
    },
    async testConnection(input: unknown) {
      const { section, scene, query } = object(input)
      const signal = AbortSignal.timeout(15_000)
      if (section === 'context-search') {
        const connection = contextConnection(signal)
        if (!connection) return { ok: false, text: '请先保存服务器地址和资料连接口令。' }
        if (typeof query !== 'string') return { ok: false, text: '请输入要检索的关键词。' }
        const result = await connection.knowledge(query)
        if (!result.ok) return result
        try {
          const data = record(JSON.parse(result.text))
          if (data?.status === 'no_match') return { ok: true, text: '没有找到匹配的资料。', matches: [] }
          if (data?.status === 'matched' && Array.isArray(data.sources)) {
            const matches = sourceLines(data.sources)
            if (matches.length) return { ok: true, text: `找到 ${matches.length} 条资料原文。`, matches }
          }
        } catch { /* Invalid server responses use the same friendly error. */ }
        return { ok: false, text: '暂时无法读取服务器知识库，请稍后重试。' }
      }
      if (section === 'context') {
        const connection = contextConnection(signal)
        if (!connection) throw new ClientInputError('请先保存管理服务器地址和资料连接口令')
        return connection.test()
      }
      if (section === 'computer-windows') {
        if (!helper || !settings.computerUse) return { ok: false, text: '请在连接设置中启用电脑操作。' }
        try {
          const result = await runDeviceHelper(helper, deviceHome, ['list-windows'], signal)
          if (result.ok && Array.isArray(result.data)) {
            if (!settings.computerUse) return { ok: false, text: '电脑操作已停用。' }
            const windows = windowTitles(result.data)
            return { ok: true, text: windows.length ? `找到 ${windows.length} 个可查看的窗口。` : '没有可查看的窗口。', windows }
          }
        } catch { /* Do not expose native errors or process details. */ }
        return { ok: false, text: '未能读取本机窗口，请检查电脑操作设置。' }
      }
      if (section === 'computer' && helper) {
        const status = await runDeviceHelper(helper, deviceHome, ['status', '--check-session-storage'], signal)
        return { ok: status.ok, text: status.ok ? '原生组件可用，请在设置中启用电脑操作' : '无法检测电脑操作组件' }
      }
      if (section === 'mcp' && settings.mcp) {
        const client = await connectRemoteMcp(settings.mcp, signal)
        try {
          const { tools } = await client.listTools({}, { signal, timeout: 15_000 })
          return { ok: true, text: `已读取 ${tools.length} 个工具` }
        } finally { await client.close().catch(() => {}) }
      }
      if (section === 'open-environment' && settings.environment) {
        await browser.showEnvironment(settings.environment.url)
        return { ok: true, text: '已在查询窗口打开环境。首次使用请在该窗口登录。' }
      }
      if (section === 'environment' && settings.environment) {
        const response = await fetch(settings.environment.url, { method: 'HEAD', redirect: 'manual', signal })
        return { ok: response.status < 500, text: `环境地址返回 HTTP ${response.status}，业务权限以登录后为准` }
      }
      if (section === 'mini-program' && defaults?.miniProgramApiUrl) {
        const response = await fetch(defaults.miniProgramApiUrl, { method: 'HEAD', redirect: 'manual', signal })
          .catch(() => { throw new ClientInputError('无法连接小程序接口地址，请检查网络。') })
        return { ok: response.status < 500, text: `小程序接口地址返回 HTTP ${response.status}。此处仅检测地址连通性。` }
      }
      if (section === 'model' && scenes.includes(scene as Scene)) {
        const model = chosenModel(scene as Scene)
        if (model) {
          const response = await fetch(`${model.baseUrl}/models`, {
            headers: { Authorization: 'Bearer ' + model.key }, redirect: 'error', signal,
          })
          await response.body?.cancel()
          return { ok: response.ok, text: response.ok ? '模型接口响应正常' : `模型列表接口返回 HTTP ${response.status}` }
        }
      }
      throw new ClientInputError('请先保存连接配置')
    },
    model(scene: Scene) {
      const model = chosenModel(scene)
      return {
        ...(model ? { baseUrl: model.baseUrl, model: model.name, apiKey: model.key, modelVision: model.imageInput === true } : {}),
        ...(settings.workspace ? { reposDir: settings.workspace } : {}),
      }
    },
    openTools(signal: AbortSignal, prompt: string) {
      const tools = openClientTools({
        helper: settings.computerUse ? helper : undefined, home: deviceHome,
        computerEnabled: () => settings.computerUse, mcp: settings.mcp, owner, signal,
      })
      const context = contextConnection(signal)
      return { ...tools, browser: browser.forTurn(settings.environment?.url, prompt, signal), ...(context && { context }) }
    },
  }
}
