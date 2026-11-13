import { posix, win32 } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { BrowserDocumentFallbackReason, BrowserDocumentResult } from '../../src/lib/desktopHost/browserDocument'
import { approvedDocumentUrl, fetchAnonymousDocument, projectAnonymousHtml } from './lightpandaDocument'

const MAX_OUTPUT_BYTES = 12_000
const MAX_INPUT_BYTES = 96 * 1024

export interface LightpandaSettings {
  command: string
  args: string[]
  approvedUrls: ReadonlySet<string>
}

export type LightpandaConfiguration = { settings: LightpandaSettings } |
  { settings?: undefined, reason: 'engine-not-configured' | 'invalid-configuration' }

export function loadLightpandaConfiguration(env: NodeJS.ProcessEnv, platform = process.platform): LightpandaConfiguration {
  const binary = env.LIYUAN_LIGHTPANDA_BINARY
  const documents = env.LIYUAN_LIGHTPANDA_DOCUMENTS
  const distro = env.LIYUAN_LIGHTPANDA_WSL_DISTRO
  if (!binary && !documents && !distro) return { reason: 'engine-not-configured' }
  const invalid = { reason: 'invalid-configuration' as const }
  if (!binary || binary.length > 4096 || /[\u0000-\u001f\u007f\\]/u.test(binary) || !posix.isAbsolute(binary) ||
      binary.split('/').includes('..') || posix.basename(binary) !== 'lightpanda' || !documents || documents.length > 24_576 ||
      (platform === 'win32' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(distro ?? ''))) return invalid
  let values: unknown
  try { values = JSON.parse(documents) } catch { return invalid }
  if (!Array.isArray(values) || !values.length || values.length > 64) return invalid
  const approvedUrls = new Set<string>()
  for (const value of values) {
    const url = typeof value === 'string' ? approvedDocumentUrl(value) : undefined
    if (!url) return invalid
    approvedUrls.add(url)
  }
  const isolated = ['-i', 'LIGHTPANDA_DISABLE_TELEMETRY=true', 'LIGHTPANDA_DISABLE_CORE_DUMP=1', binary, 'mcp', '--block-private-networks']
  if (platform === 'win32') {
    const root = env.SystemRoot || 'C:\\Windows'
    if (!win32.isAbsolute(root)) return invalid
    return { settings: { command: win32.join(root, 'System32', 'wsl.exe'), args: ['-d', distro!, '--exec', '/usr/bin/env', ...isolated], approvedUrls } }
  }
  if (platform !== 'linux' && platform !== 'darwin') return invalid
  return { settings: { command: '/usr/bin/env', args: isolated, approvedUrls } }
}

export async function readIsolatedSnapshot(settings: LightpandaSettings, html: string, signal: AbortSignal) {
  if (Buffer.byteLength(html, 'utf8') > MAX_INPUT_BYTES) throw new Error('Document snapshot exceeds the reader limit')
  signal.throwIfAborted()
  const client = new Client({ name: 'liyuan-document-reader', version: '1.0.0' })
  const transport = new StdioClientTransport({ command: settings.command, args: settings.args, stderr: 'ignore' })
  try {
    await client.connect(transport, { signal, timeout: 4500 })
    if (client.getServerVersion()?.name !== 'lightpanda') throw new Error('The configured reader is not Lightpanda MCP')
    // Only a host-generated inert document is ever sent to this private subprocess.
    const url = `data:text/html;base64,${Buffer.from(html, 'utf8').toString('base64')}`
    const result = await client.callTool({ name: 'markdown', arguments: { url, maxBytes: MAX_OUTPUT_BYTES, timeout: 2500 } },
      undefined, { signal, timeout: 3500 })
    if (result.isError || !Array.isArray(result.content)) throw new Error('Lightpanda could not read the static document')
    const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n').trim()
    if (!text) throw new Error('Lightpanda returned no text')
    return text
  } finally { await client.close().catch(() => {}) }
}

export interface BrowserDocumentSource {
  url: string
  title: string
  hasSession(): Promise<boolean>
  readChromium(): Promise<string>
}

function capText(text: string) {
  const value = text.trim()
  const bytes = Buffer.from(value, 'utf8')
  return { text: new TextDecoder().decode(bytes.subarray(0, MAX_OUTPUT_BYTES), { stream: true }),
    truncated: bytes.length > MAX_OUTPUT_BYTES || value.endsWith('[truncated]') }
}

function publicSource(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('This page has no web document address')
  return url.origin + url.pathname
}

export class LightpandaDocumentReader {
  private reading = false

  constructor(private readonly configuration: LightpandaConfiguration,
    private readonly fetchDocument = fetchAnonymousDocument, private readonly readSnapshot = readIsolatedSnapshot) {}

  async read(source: BrowserDocumentSource, signal?: AbortSignal): Promise<BrowserDocumentResult> {
    signal?.throwIfAborted()
    const sourceUrl = publicSource(source.url)
    const chromium = async (fallbackReason: BrowserDocumentFallbackReason): Promise<BrowserDocumentResult> => {
      signal?.throwIfAborted()
      const text = await source.readChromium()
      signal?.throwIfAborted()
      return { engine: 'chromium', fallbackReason, sourceUrl, title: source.title.slice(0, 240), format: 'text', ...capText(text) }
    }
    const { settings } = this.configuration
    if (!settings) return chromium(this.configuration.reason)
    const selected = approvedDocumentUrl(source.url)
    if (!selected || !settings.approvedUrls.has(selected)) return chromium('address-not-approved')
    if (await source.hasSession().catch(() => true)) return chromium('active-page-session')
    signal?.throwIfAborted()
    if (this.reading) return chromium('lightpanda-busy')

    this.reading = true
    let fallbackReason: BrowserDocumentFallbackReason = 'anonymous-document-unavailable'
    try {
      const fetchDeadline = AbortSignal.timeout(4500)
      const raw = await this.fetchDocument(selected, signal ? AbortSignal.any([signal, fetchDeadline]) : fetchDeadline)
      const snapshot = projectAnonymousHtml(raw)
      fallbackReason = 'lightpanda-unavailable'
      const deadline = AbortSignal.timeout(8000)
      const text = await this.readSnapshot(settings, snapshot.html, signal ? AbortSignal.any([signal, deadline]) : deadline)
      signal?.throwIfAborted()
      return { engine: 'lightpanda', fallbackReason: null, sourceUrl, title: snapshot.title || source.title.slice(0, 240),
        format: 'markdown', ...capText(text) }
    } catch { signal?.throwIfAborted() }
    finally { this.reading = false }
    return chromium(fallbackReason)
  }
}
