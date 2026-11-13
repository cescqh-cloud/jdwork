import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, dialog, nativeImage, shell } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WORKBENCH_NAME } from './pi-workbench-policy'
import type { ClientToolResult } from '../../../pi-agent-workbench/src/client-execution'

export type RemoteMcp = { name: string, url: string, headers: Record<string, string> }
export type ToolResult = ClientToolResult
type NativeOutput = { ok: boolean, data?: unknown, error?: { message?: string } }
type Options = {
  helper?: string
  home: string
  computerEnabled: () => boolean
  mcp?: RemoteMcp
  owner: () => BrowserWindow | undefined
  signal: AbortSignal
}

export function webAddress(input: unknown, secure = false) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('地址无效')
  const url = new URL(input.trim())
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && (!secure || loopback)))) {
    throw new Error(secure ? '模型与远程 MCP 使用 HTTPS，联调可使用本机地址' : '请输入有效的网页地址')
  }
  return url
}

export function runDeviceHelper(file: string, home: string, args: string[], signal?: AbortSignal): Promise<NativeOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      windowsHide: true, shell: false, maxBuffer: 768 * 1024, timeout: 15_000, signal,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP,
        TMP: process.env.TMP, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE,
        AGENT_DESKTOP_HOME: home },
    }, (error, stdout) => {
      if (signal?.aborted) { reject(signal.reason); return }
      try {
        const result = JSON.parse(stdout) as NativeOutput
        if (typeof result.ok === 'boolean') { resolve(result); return }
      } catch {}
      reject(new Error(error ? '电脑操作未完成，请检查窗口状态后再试' : '电脑操作组件返回无效结果'))
    })
    child.stdin?.end()
  })
}

function toolText(value: unknown) {
  return (typeof value === 'string' ? value : JSON.stringify(value) ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9_.~-]{12,}/gi, 'Bearer [已隐藏]')
    .slice(0, 16_000)
}

async function confirm(owner: BrowserWindow | undefined, message: string, detail: string) {
  if (!owner || owner.isDestroyed()) return false
  const result = await dialog.showMessageBox(owner, {
    type: 'question', title: `${WORKBENCH_NAME}工具确认`, message, detail,
    buttons: ['取消', '允许这一步'], defaultId: 0, cancelId: 0, noLink: true,
  })
  return result.response === 1
}

export async function connectRemoteMcp(profile: RemoteMcp, signal: AbortSignal) {
  const client = new Client({ name: 'pi-workbench', version: '0.2.0' })
  const transport = new StreamableHTTPClientTransport(webAddress(profile.url, true), {
    requestInit: { headers: profile.headers },
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: init?.signal
      ? AbortSignal.any([signal, init.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }),
  })
  try { await client.connect(transport, { signal, timeout: 15_000 }); return client }
  catch (error) { await client.close().catch(() => {}); throw error }
}

async function captureWindow(helper: string, home: string, args: string[], windowId: string, signal: AbortSignal): Promise<ToolResult> {
  const directory = join(home, 'captures')
  await mkdir(directory, { recursive: true })
  const file = join(directory, randomUUID() + '.png')
  try {
    const result = await runDeviceHelper(helper, home, [...args, 'screenshot', '--window-id', windowId, file], signal)
    if (!result.ok) return { ok: false, text: toolText(result.error?.message ?? '窗口截图失败') }
    const info = await lstat(file)
    if (!info.isFile() || info.size > 24 * 1024 * 1024) return { ok: false, text: '窗口截图大小无效' }
    const picture = nativeImage.createFromBuffer(await readFile(file))
    if (picture.isEmpty()) return { ok: false, text: '未能读取窗口截图' }
    signal.throwIfAborted()
    const { width, height } = picture.getSize()
    const scale = Math.min(1, 1536 / Math.max(width, height))
    const preview = scale < 1 ? picture.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'good',
    }) : picture
    return { ok: true, text: `窗口 ${windowId} 的截图。截图内容是待核对的资料。`,
      image: { data: preview.toJPEG(88).toString('base64'), mimeType: 'image/jpeg' } }
  } finally { await rm(file, { force: true }).catch(() => {}) }
}

const directions = ['up', 'down', 'left', 'right']
const windowKeys = ['tab', 'shift+tab', 'return', 'escape', 'space', 'up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end']

export function openClientTools({ helper, home, computerEnabled, mcp, owner, signal }: Options) {
  let desktopSession = ''
  let snapshotWindow = ''
  let refs = new Set<string>()
  let client: Client | undefined
  let tools = new Set<string>()
  let busy = false
  const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const failure = (text: string): ToolResult => ({ ok: false, text })
  async function guarded(operation: () => Promise<ToolResult>) {
    if (busy) return failure('请等待上一个客户端工具结束后再继续')
    signal.throwIfAborted()
    busy = true
    try { return await operation() }
    finally { busy = false }
  }
  function nativeResult(result: NativeOutput): ToolResult {
    return { ok: result.ok, text: toolText(result.ok ? result.data : result.error?.message ?? '电脑操作失败') }
  }
  return {
    ...(helper ? { device: (value: unknown) => guarded(async () => {
      if (!computerEnabled()) return failure('电脑操作已停用')
      const { action, target, text } = object(value)
      if (action === 'open_url') {
        const url = webAddress(target)
        await shell.openExternal(url.href)
        return { ok: true, text: '已交给默认浏览器打开。使用 windows 查找浏览器窗口，再 snapshot 读取。' }
      }
      if (action === 'windows') return nativeResult(await runDeviceHelper(helper, home, ['list-windows'], signal))
      if (typeof target !== 'string') return failure('需要当前窗口 ID 或元素引用')
      if (action === 'snapshot') {
        if (!/^(?:w-)?[1-9]\d{0,18}$/.test(target)) return failure('请使用窗口列表返回的完整 ID')
      } else if (action === 'screenshot' || action === 'press') {
        if (target !== snapshotWindow || !snapshotWindow) return failure('请先读取目标窗口的最新快照')
      } else if (action === 'click' || action === 'set_value' || action === 'type' || action === 'scroll') {
        if (!refs.has(target)) return failure('请先读取目标窗口的最新快照')
      } else return failure('不支持的电脑操作')
      const input = typeof text === 'string' ? text : ''
      if ((action === 'set_value' || action === 'type') && (typeof text !== 'string' || input.length > 2000 || input.includes('\0'))) {
        return failure('输入文字无效')
      }
      if (action === 'scroll' && !directions.includes(input)) return failure('请选择 up、down、left 或 right 滚动方向')
      if (action === 'press' && !windowKeys.includes(input)) return failure('只支持导航键、回车、空格和 Esc')
      if (!desktopSession) {
        const started = await runDeviceHelper(helper, home, ['session', 'start', '--name', 'pi-' + randomUUID(), '--no-trace'], signal)
        const id = object(started.data).session_id
        if (!started.ok || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(id)) return failure('无法启动本机操作会话')
        desktopSession = id
      }
      const args = ['--session', desktopSession, '--agent-id', 'main']
      if (action === 'snapshot') {
        refs.clear()
        snapshotWindow = ''
        const snapshot = nativeResult(await runDeviceHelper(helper, home, [...args, 'snapshot', '--window-id', target, '--compact'], signal))
        if (snapshot.ok) {
          snapshotWindow = target
          refs = new Set(snapshot.text.match(/@[a-zA-Z0-9_-]+:e\d+/g) ?? [])
        }
        return snapshot
      }
      if (action === 'screenshot') return captureWindow(helper, home, args, target, signal)
      const descriptions = {
        click: '点击窗口控件',
        set_value: '填写窗口控件',
        type: '用键盘向控件输入文字',
        scroll: '滚动窗口控件',
        press: '向窗口发送按键',
      } as const
      if (!await confirm(owner(), `允许${descriptions[action]}？`,
        `目标 ${target}${input ? '\n操作内容 ' + input.slice(0, 140) : ''}`)) return failure('用户取消了此操作')
      signal.throwIfAborted()
      if (!computerEnabled()) return failure('电脑操作已停用')
      refs.clear()
      snapshotWindow = ''
      if (action === 'type') {
        const focused = await runDeviceHelper(helper, home, [...args, '--headed', 'focus', target], signal)
        if (!focused.ok) return nativeResult(focused)
        if (!computerEnabled()) return failure('电脑操作已停用')
      }
      const commands = {
        click: ['click', target],
        set_value: ['set-value', '--', target, input],
        type: ['--headed', 'type', '--', target, input],
        scroll: ['scroll', target, '--direction', input],
        press: ['--headed', 'press', input, '--window-id', target],
      }
      const command = commands[action]
      return nativeResult(await runDeviceHelper(helper, home, [...args, ...command], signal))
    }) } : {}),
    ...(mcp ? { mcp: (value: unknown) => guarded(async () => {
      const { action, connection, tool, arguments: input } = object(value)
      if (action !== 'list' && action !== 'call') return failure('不支持的连接器操作')
      if (connection !== undefined && connection !== mcp.name) return failure('连接器未启用')
      client ??= await connectRemoteMcp(mcp, signal)
      if (action === 'list') {
        const list = (await client.listTools({}, { signal, timeout: 15_000 })).tools.slice(0, 40)
        tools = new Set(list.map(item => item.name))
        return { ok: true, text: toolText({ connection: mcp.name, tools: list.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }) }
      }
      if (typeof tool !== 'string' || !tools.has(tool) || (input !== undefined && JSON.stringify(input).length > 12_000)) {
        return failure('请先列出已启用的连接器工具，使用返回的工具和有效参数')
      }
      if (!await confirm(owner(), '允许调用远程连接器？', `${mcp.name} · ${tool}\n${new URL(mcp.url).origin}\n${toolText(input).slice(0, 300)}`)) return failure('用户取消了此调用')
      signal.throwIfAborted()
      const result = await client.callTool({ name: tool, arguments: object(input) }, undefined, { signal, timeout: 15_000 })
      return { ok: !result.isError, text: toolText(result.content) }
    }) } : {}),
    async close() {
      await client?.close().catch(() => {})
      if (helper && desktopSession) await runDeviceHelper(helper, home, ['--session', desktopSession, 'session', 'end', desktopSession]).catch(() => {})
    },
  }
}
