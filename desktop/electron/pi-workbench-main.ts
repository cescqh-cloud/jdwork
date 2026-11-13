import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { isWorkbenchNavigation, normalizeEnvironmentDefaults, normalizeWorkbenchOrigin, WORKBENCH_APP_ID, WORKBENCH_NAME, workbenchEntry } from './pi-workbench-policy'
import { startPiClient } from './pi-client-host'

const productName = WORKBENCH_NAME
const appPath = app.getAppPath()
const setupPath = join(appPath, 'pi-workbench-connect.html')
const setupUrl = pathToFileURL(setupPath).href
const nativePreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
let setupWindow: BrowserWindow | undefined
let workbenchWindow: BrowserWindow | undefined
let managementWindow: { window: BrowserWindow, origin: string } | undefined
let managementOrigin: (() => string) | undefined
let serverOrigin: string | undefined
let intranetOrigin: string | undefined

function savePath() { return join(app.getPath('userData'), 'pi-server.json') }

async function originFromFile(file: string, packaged = false): Promise<string | undefined> {
  try {
    const stored = JSON.parse(await readFile(file, 'utf8')) as { origin: unknown, intranetHttp?: unknown }
    if (packaged && stored.intranetHttp === true && typeof stored.origin === 'string') {
      const origin = normalizeWorkbenchOrigin(stored.origin, stored.origin)
      if (origin.startsWith('http:')) intranetOrigin = origin
      return origin
    }
    return normalizeWorkbenchOrigin(stored.origin, intranetOrigin)
  } catch { return undefined }
}

function openSetup() {
  if (setupWindow) { setupWindow.focus(); return }
  const win = new BrowserWindow({
    title: productName,
    width: 535,
    height: 400,
    resizable: false,
    webPreferences: { ...nativePreferences, preload: join(appPath, 'pi-workbench-preload.cjs') },
  })
  setupWindow = win
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => { if (url !== setupUrl) event.preventDefault() })
  win.on('closed', () => { setupWindow = undefined })
  void win.loadFile(setupPath)
}

type WorkbenchView = 'home' | 'updates' | 'approvals'

async function goToWorkbench(win: BrowserWindow, origin: string, view: WorkbenchView = 'home', changeAddress = openSetup) {
  const entry = view === 'approvals' ? new URL('/desktop/?view=approvals', origin).href : workbenchEntry(origin, view === 'updates')
  try { await win.loadURL(entry) }
  catch (error) {
    if (win.isDestroyed() || (error as { code?: string }).code === 'ERR_ABORTED') return
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '工作台暂不可用',
      message: '无法打开服务器工作台。',
      detail: '请检查地址和办公网络，或连接 VPN 后重试。',
      buttons: ['重试', '修改地址', '关闭'],
      cancelId: 2,
    })
    if (result.response === 0 && !win.isDestroyed()) void goToWorkbench(win, origin, view, changeAddress)
    if (result.response === 1) changeAddress()
  }
}

function createServerWindow(origin: string, title = productName) {
  const win = new BrowserWindow({
    title,
    width: 1240, height: 845, minWidth: 680, minHeight: 560,
    webPreferences: { ...nativePreferences, partition: 'persist:pi-workbench' },
  })
  const view = win.webContents
  view.setUserAgent(`${view.getUserAgent()} PiWorkbenchDesktop/${app.getVersion()}`)
  view.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  view.session.setPermissionCheckHandler(() => false)
  view.on('will-navigate', (event, url) => { if (!isWorkbenchNavigation(url, origin)) event.preventDefault() })
  view.on('will-redirect', (event, url) => { if (!isWorkbenchNavigation(url, origin)) event.preventDefault() })
  view.setWindowOpenHandler(({ url }) => {
    if (isWorkbenchNavigation(url, origin)) void win.loadURL(url).catch(() => {})
    return { action: 'deny' }
  })
  view.on('page-title-updated', event => event.preventDefault())
  return win
}

function openWorkbench(origin: string) {
  const previous = workbenchWindow
  const win = createServerWindow(origin)
  workbenchWindow = win
  win.on('closed', () => { if (workbenchWindow === win) workbenchWindow = undefined })
  previous?.close()
  void goToWorkbench(win, origin)
}

function openManagementSettings() {
  if (!workbenchWindow || !serverOrigin) return
  workbenchWindow.focus()
  void workbenchWindow.loadURL(serverOrigin + '/desktop/?view=connections&section=management').catch(() => {})
}

function openManagement(view: 'updates' | 'approvals' = 'updates') {
  let origin: string
  try { origin = normalizeWorkbenchOrigin(managementOrigin?.(), intranetOrigin) }
  catch { openManagementSettings(); return }
  if (managementWindow?.origin === origin) {
    const { window } = managementWindow
    window.focus()
    if (view === 'approvals' && window.webContents.getURL() !== new URL('/desktop/?view=approvals', origin).href) {
      void goToWorkbench(window, origin, view, () => { window.close(); openManagementSettings() })
    }
    return
  }
  managementWindow?.window.close()
  const window = createServerWindow(origin, `${productName} · 服务器管理端`)
  managementWindow = { window, origin }
  window.on('closed', () => { if (managementWindow?.window === window) managementWindow = undefined })
  void goToWorkbench(window, origin, view, () => { window.close(); openManagementSettings() })
}

ipcMain.handle('pi-workbench:connect', async (event, value: unknown) => {
  if (!setupWindow || event.sender !== setupWindow.webContents || event.senderFrame?.url !== setupUrl) {
    return { ok: false, error: '连接设置来源无效。' }
  }
  let origin: string
  try { origin = normalizeWorkbenchOrigin(value, intranetOrigin) }
  catch (error) { return { ok: false, error: (error as Error).message } }
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    const temporary = `${savePath()}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ origin }), { flag: 'wx', mode: 0o600 })
    await rename(temporary, savePath())
    serverOrigin = origin
    openWorkbench(origin)
    const window = setupWindow
    setImmediate(() => window?.close())
    return { ok: true }
  } catch {
    return { ok: false, error: '保存服务器设置失败，请检查应用数据目录权限。' }
  }
})

function applicationMenu(standalone = false) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '工作台',
      submenu: [
        { label: '返回工作台', accelerator: 'Ctrl+Home', click: () => {
          if (standalone && managementWindow?.window.isFocused()) workbenchWindow?.focus()
          else if (workbenchWindow && serverOrigin) void goToWorkbench(workbenchWindow, serverOrigin)
          else openSetup()
        } },
        { label: '检查更新', click: () => {
          if (standalone) openManagementSettings()
          else if (workbenchWindow && serverOrigin) void goToWorkbench(workbenchWindow, serverOrigin, 'updates')
          else openSetup()
        } },
        { label: '审批中心', click: () => {
          if (standalone) openManagement('approvals')
          else if (workbenchWindow && serverOrigin) void goToWorkbench(workbenchWindow, serverOrigin, 'approvals')
          else openSetup()
        } },
        ...(standalone ? [
          { label: '服务器管理端', click: () => openManagement() },
          { label: '电脑操作', click: () => {
            if (workbenchWindow && serverOrigin) void workbenchWindow.loadURL(serverOrigin + '/desktop/?view=connections&section=computer').catch(() => {})
          } },
        ] : []),
        standalone
          ? { label: '连接设置', click: () => {
              if (workbenchWindow && serverOrigin) void workbenchWindow.loadURL(serverOrigin + '/desktop/?view=connections').catch(() => {})
            } }
          : { label: '服务器连接', click: openSetup },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: '帮助',
      submenu: [{ label: `关于${productName}`, click: () => {
        void dialog.showMessageBox({
          type: 'info',
          title: productName,
          message: `${productName} ${app.getVersion()}`,
          detail: '包含研发助手、电脑操作、需求文档和内部版本分发。\n\nBased on cc-haha: https://github.com/NanmiCoder/cc-haha\nCopyright (c) 2026 cc-haha\n完整许可及第三方声明随安装包提供。',
          buttons: ['关闭', '查看上游项目'],
          cancelId: 0,
        }).then(result => { if (result.response === 1) return shell.openExternal('https://github.com/NanmiCoder/cc-haha') })
      } }],
    },
  ]))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => (setupWindow ?? workbenchWindow)?.focus())
  app.on('window-all-closed', () => app.quit())
  void app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId(WORKBENCH_APP_ID)
    const defaultOrigin = await originFromFile(join(appPath, 'pi-server-default.json'), true)
    const runtime = join(process.resourcesPath, 'pi-client-runtime')
    if (existsSync(join(runtime, 'dist', 'server.js'))) {
      try {
        const releaseKey = await readFile(join(appPath, 'pi-release-key.txt'), 'utf8').then(value => value.trim(), () => undefined)
        const defaults = await readFile(join(appPath, 'pi-environments-default.json'), 'utf8')
          .then(value => normalizeEnvironmentDefaults(JSON.parse(value)), () => undefined)
        const client = await startPiClient({ runtime, defaultManagement: defaultOrigin ?? '', intranetOrigin, releaseKey, defaults })
        workbenchWindow = client.window
        serverOrigin = client.origin
        managementOrigin = client.managementOrigin
        applicationMenu(true)
        let closed = false
        let closing = false
        app.on('before-quit', event => {
          if (closed) return
          event.preventDefault()
          if (closing) return
          closing = true
          void client.close().catch(() => {}).finally(() => { closed = true; app.quit() })
        })
        workbenchWindow.once('closed', () => { if (!closing && !closed) app.quit() })
      } catch {
        dialog.showErrorBox(`${productName}无法启动`, '请检查当前 Windows 用户的应用数据目录权限，或重新安装客户端。')
        app.quit()
      }
      return
    }
    applicationMenu()
    serverOrigin = await originFromFile(savePath()) ?? defaultOrigin
    if (serverOrigin) openWorkbench(serverOrigin)
    else openSetup()
  })
}
