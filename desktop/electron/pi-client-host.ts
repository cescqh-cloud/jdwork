import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { createClientSettings } from './pi-client-settings'
import { WORKBENCH_NAME, type EnvironmentDefaults } from './pi-workbench-policy'

type StartOptions = { runtime: string, defaultManagement: string, intranetOrigin?: string, releaseKey?: string, defaults?: EnvironmentDefaults }

export async function startPiClient({ runtime, defaultManagement, intranetOrigin, releaseKey, defaults }: StartOptions) {
  const dataDir = join(app.getPath('userData'), 'client-data')
  await mkdir(dataDir, { recursive: true })
  const identityFile = join(dataDir, 'client-id')
  let clientId = await readFile(identityFile, 'utf8').catch(() => '')
  if (!/^[a-f0-9]{64}$/.test(clientId)) {
    clientId = randomBytes(32).toString('hex')
    await writeFile(identityFile, clientId, { mode: 0o600 })
  }
  const helperPath = join(process.resourcesPath, 'computer-use', 'agent-desktop.exe')
  const helper = await access(helperPath).then(() => helperPath, () => undefined)
  let win: BrowserWindow | undefined
  const token = randomBytes(32).toString('hex')
  const url = pathToFileURL(join(runtime, 'dist', 'server.js')).href
  const { createApp } = await import(url) as typeof import('../../../pi-agent-workbench/src/server')
  const agentUrl = pathToFileURL(join(runtime, 'dist', 'agent.js')).href
  const { runAgent } = await import(agentUrl) as typeof import('../../../pi-agent-workbench/src/agent')
  const dialogueUrl = pathToFileURL(join(runtime, 'dist', 'pi-dialogue.js')).href
  const { createPiDialogue } = await import(dialogueUrl) as typeof import('../../../pi-agent-workbench/src/pi-dialogue')
  const dialogue = createPiDialogue()
  const runner = (input: Parameters<typeof runAgent>[0]) => runAgent(input, dialogue)
  const service = await createClientSettings({ dataDir, defaultManagement, intranetOrigin, releaseKey, defaults, helper,
    engine: 'pi', owner: () => win })
  const local = await createApp({
    host: '127.0.0.1', port: 0, authMode: 'token', accessToken: token, dataDir,
    knowledgeDir: join(dataDir, 'knowledge'), reposDir: join(dataDir, 'workspace'),
    publicDir: join(runtime, 'public'), desktopUiDir: join(runtime, 'public', 'desktop'),
    workspaceInstructions: join(runtime, 'workspace', 'AGENTS.md'),
    projectFile: join(runtime, 'config', 'project.json'), skillsDir: join(runtime, 'skills'),
    contextWindow: 64_000, maxTokens: 4096, timeoutMs: 600_000, apiKey: '', baseUrl: '', model: '',
  }, runner, { localClient: service })
  try {
    await new Promise<void>((done, reject) => {
      local.server.once('error', reject)
      local.server.listen(0, '127.0.0.1', () => {
        local.server.removeListener('error', reject)
        done()
      })
    })
    const address = local.server.address()
    if (!address || typeof address === 'string') throw new Error('本机工作台连接失败')
    const origin = `http://127.0.0.1:${address.port}`
    win = new BrowserWindow({
      title: WORKBENCH_NAME, width: 1240, height: 845, minWidth: 680, minHeight: 560,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true,
        partition: 'pi-client-' + randomUUID() },
    })
    const view = win.webContents
    win.on('page-title-updated', event => event.preventDefault())
    view.setUserAgent(`${view.getUserAgent()} PiWorkbenchDesktop/${app.getVersion()}`)
    view.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    view.session.setPermissionCheckHandler(() => false)
    const sameOrigin = (value: string) => {
      try { return new URL(value).origin === origin }
      catch { return false }
    }
    view.session.webRequest.onBeforeSendHeaders({ urls: [origin + '/*'] }, (details, reply) => {
      if (details.webContentsId !== view.id || !sameOrigin(details.url)) { reply({ cancel: true }); return }
      if (!new URL(details.url).pathname.startsWith('/api/')) { reply({ requestHeaders: details.requestHeaders }); return }
      const requestHeaders = Object.fromEntries(Object.entries(details.requestHeaders)
        .filter(([key]) => !['authorization', 'x-pi-client'].includes(key.toLowerCase())))
      reply({ requestHeaders: { ...requestHeaders, Authorization: 'Bearer ' + token, 'X-Pi-Client': clientId } })
    })
    view.on('will-navigate', (event, target) => { if (!sameOrigin(target)) event.preventDefault() })
    view.on('will-redirect', (event, target) => { if (!sameOrigin(target)) event.preventDefault() })
    view.setWindowOpenHandler(() => ({ action: 'deny' }))
    await win.loadURL(origin + '/desktop/')
    return { window: win, origin, managementOrigin: () => service.view().management,
      close: () => { service.closeBrowser(); return local.close() } }
  } catch (error) {
    if (win && !win.isDestroyed()) win.destroy()
    service.closeBrowser()
    await local.close().catch(() => {})
    throw error
  }
}
