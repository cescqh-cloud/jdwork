/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { approvedDocumentUrl, isPublicDocumentAddress, projectAnonymousHtml } from './lightpandaDocument'
import { LightpandaDocumentReader, loadLightpandaConfiguration, readIsolatedSnapshot } from './lightpandaReader'

const URL = 'https://docs.example.com/manual'
const HTML = '<html><head><title>模拟文档</title></head><body><article><h1>采购收货帮助</h1><p>只读测试内容</p></article></body></html>'
const config = loadLightpandaConfiguration({
  LIYUAN_LIGHTPANDA_BINARY: '/opt/bin/lightpanda',
  LIYUAN_LIGHTPANDA_WSL_DISTRO: 'Ubuntu-24.04',
  LIYUAN_LIGHTPANDA_DOCUMENTS: JSON.stringify([URL]),
}, 'win32')

function source(url = URL, hasSession = false) {
  return {
    url, title: 'Chromium document',
    hasSession: vi.fn(async () => hasSession),
    readChromium: vi.fn(async () => 'Visible text already loaded in Chromium'),
  }
}

describe('Lightpanda document routing', () => {
  it('validates local engine configuration and only takes exact approved document addresses', () => {
    expect(config.settings).toMatchObject({
      command: 'C:\\Windows\\System32\\wsl.exe',
      args: ['-d', 'Ubuntu-24.04', '--exec', '/usr/bin/env', '-i', 'LIGHTPANDA_DISABLE_TELEMETRY=true',
        'LIGHTPANDA_DISABLE_CORE_DUMP=1', '/opt/bin/lightpanda', 'mcp', '--block-private-networks'],
      approvedUrls: new Set([URL]),
    })
    expect(loadLightpandaConfiguration({}, 'win32')).toEqual({ reason: 'engine-not-configured' })
    expect(loadLightpandaConfiguration({ LIYUAN_LIGHTPANDA_BINARY: '/opt/bin/lightpanda' }, 'win32')).toEqual({ reason: 'invalid-configuration' })
    expect(approvedDocumentUrl(URL)).toBe(URL)
    for (const url of [
      'http://docs.example.com/manual', 'https://localhost/manual', 'https://127.0.0.1/manual',
      'https://[::1]/manual', 'https://docs.company.internal/manual', 'https://docs.example.com:444/manual',
      'https://docs.example.com/manual?view=all', 'https://docs.example.com/manual#main', 'https://docs.example.com/manual?',
      'https://docs.example.com/ierp/guide', 'https://docs.example.com/login.html',
      'https://docs.example.com/%69erp/guide',
    ]) expect(approvedDocumentUrl(url)).toBeUndefined()
    for (const address of ['127.0.0.1', '10.0.0.15', '100.64.1.1', '169.254.2.1', '172.16.0.1',
      '192.168.1.1', '192.0.2.2', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2001:db8::1', 'ff02::1']) {
      expect(isPublicDocumentAddress(address)).toBe(false)
    }
    for (const address of ['1.1.1.1', '2606:4700:4700::1111']) expect(isPublicDocumentAddress(address)).toBe(true)
  })

  it('builds inert HTML from document structure without subresources, form controls or original attributes', () => {
    const result = projectAnonymousHtml(
      '<title>公开文档 &amp; 示例</title><base href="https://assets.example.invalid/">' +
      '<main class="document"><h1>业务说明</h1><script>sampleScript()</script><style>.sample{color:red}</style>' +
      '<p><a href="https://links.example.invalid/">链接标题</a> &lt;文本&gt;</p>' +
      '<p hidden>隐藏段落</p><img src="/sample.png"><form><input value="测试字段"></form>' +
      '<iframe src="/other"></iframe><table><tr><th>单号</th><td>模拟001</td></tr></table></main>',
    )
    expect(result.title).toBe('公开文档 & 示例')
    expect(result.html).toContain('<h1>业务说明</h1>')
    expect(result.html).toContain('<p>链接标题 &lt;文本&gt;</p>')
    expect(result.html).toContain('<td>模拟001</td>')
    for (const hidden of ['example.invalid', '<script', '<style', 'class=', '隐藏段落', '<img', '<form', '测试字段', '<iframe']) {
      expect(result.html).not.toContain(hidden)
    }
    expect(() => projectAnonymousHtml('<body><form><input type="password"></form><p>Sign in</p></body>')).toThrow('interactive session')
    expect(() => projectAnonymousHtml('<body><script>buildPage()</script></body>')).toThrow('static document')
    expect(() => projectAnonymousHtml('<p>' + '文'.repeat(40_000) + '</p>')).toThrow('static document')
  })

  it('passes only the anonymous document snapshot to the selected engine', async () => {
    const fetch = vi.fn(async () => HTML.replace('<p>', '<p onclick="sample()">'))
    const mcp = vi.fn(async () => '# 采购收货帮助\n\n只读测试内容')
    const selected = source()
    const result = await new LightpandaDocumentReader(config, fetch, mcp).read(selected)
    expect(fetch).toHaveBeenCalledWith(URL, expect.any(AbortSignal))
    expect(mcp).toHaveBeenCalledWith(config.settings, expect.stringContaining('<h1>采购收货帮助</h1>'), expect.any(AbortSignal))
    expect(JSON.stringify(mcp.mock.calls)).not.toContain('onclick')
    expect(selected.readChromium).not.toHaveBeenCalled()
    expect(result).toEqual({
      engine: 'lightpanda', fallbackReason: null, sourceUrl: URL, title: '模拟文档',
      text: '# 采购收货帮助\n\n只读测试内容', format: 'markdown', truncated: false,
    })
  })

  it('keeps unapproved addresses, login sessions and an unavailable configuration in Chromium', async () => {
    const fetch = vi.fn(async () => HTML)
    const mcp = vi.fn(async () => 'Simulated document')
    const reader = new LightpandaDocumentReader(config, fetch, mcp)
    const fallback = new LightpandaDocumentReader({ reason: 'engine-not-configured' }, fetch, mcp)
    await expect(fallback.read(source())).resolves.toMatchObject({ engine: 'chromium', fallbackReason: 'engine-not-configured' })
    await expect(reader.read(source(URL, true))).resolves.toMatchObject({ engine: 'chromium', fallbackReason: 'active-page-session' })
    const unavailableSessionCheck = source()
    unavailableSessionCheck.hasSession.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(reader.read(unavailableSessionCheck)).resolves.toMatchObject({ engine: 'chromium', fallbackReason: 'active-page-session' })
    await expect(reader.read(source('https://docs.example.com/other'))).resolves.toMatchObject({ fallbackReason: 'address-not-approved' })
    await expect(reader.read(source('http://127.0.0.1/ierp/index?view=fixture#list'))).resolves.toMatchObject({
      fallbackReason: 'address-not-approved', sourceUrl: 'http://127.0.0.1/ierp/index',
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(mcp).not.toHaveBeenCalled()
  })

  it('returns the real Chromium text when the anonymous fetch or MCP is unavailable and caps text without splitting UTF-8', async () => {
    const fetch = vi.fn(async () => HTML).mockRejectedValueOnce(new Error('public page unavailable'))
    const mcp = vi.fn(async () => { throw new Error('engine did not respond') })
    const reader = new LightpandaDocumentReader(config, fetch, mcp)
    const selected = source()
    selected.readChromium.mockResolvedValue('A' + '文'.repeat(5000))
    await expect(reader.read(selected)).resolves.toMatchObject({ engine: 'chromium', fallbackReason: 'anonymous-document-unavailable' })
    const result = await reader.read(selected)
    expect(result).toMatchObject({ engine: 'chromium', fallbackReason: 'lightpanda-unavailable', truncated: true })
    expect(result.text).toBe('A' + '文'.repeat(3999))
    expect(mcp).toHaveBeenCalledTimes(1)
  })

  it('does not fall back to a different page after the selected tab was cancelled', async () => {
    const control = new AbortController()
    const fetch = vi.fn(async () => { control.abort(); throw control.signal.reason })
    const selected = source()
    const mcp = vi.fn()
    await expect(new LightpandaDocumentReader(config, fetch, mcp).read(selected, control.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(selected.readChromium).not.toHaveBeenCalled()
    expect(mcp).not.toHaveBeenCalled()
  })
})

const localBinary = process.env.LIYUAN_TEST_LIGHTPANDA_BINARY
it.skipIf(!localBinary)('runs the official local Lightpanda MCP against an inert synthetic document', async () => {
  const { settings } = loadLightpandaConfiguration({
    LIYUAN_LIGHTPANDA_BINARY: localBinary,
    LIYUAN_LIGHTPANDA_WSL_DISTRO: process.env.LIYUAN_TEST_LIGHTPANDA_WSL_DISTRO,
    LIYUAN_LIGHTPANDA_DOCUMENTS: JSON.stringify([URL]),
  })
  expect(settings).toBeDefined()
  const text = await readIsolatedSnapshot(settings!, projectAnonymousHtml(HTML).html, AbortSignal.timeout(10_000))
  expect(text).toContain('# 采购收货帮助')
  expect(text).toContain('只读测试内容')
}, 12_000)
