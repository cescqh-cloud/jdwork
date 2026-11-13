// @vitest-environment node
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientSettings } from './pi-client-settings'

const { runDeviceHelper, showEnvironment } = vi.hoisted(() => ({ runDeviceHelper: vi.fn(), showEnvironment: vi.fn() }))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.2.6' }, dialog: {}, shell: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (text: Buffer) => text.toString(),
  },
}))
vi.mock('./pi-client-tools', () => ({ openClientTools: () => ({ close: async () => {} }), runDeviceHelper }))
vi.mock('./pi-query-browser', () => ({ createQueryBrowser: () => ({ forTurn: () => vi.fn(), close: vi.fn(), showEnvironment }) }))

const origin = 'http://192.168.44.10:8080'
const token = 'y'.repeat(43)
const baseOptions = { defaultManagement: origin, intranetOrigin: origin, owner: () => undefined }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

it('opens 0.2.4 settings without rewriting them and keeps the resource token scoped to its saved server', async () => {
  const dataDir = await mkdtemp(join(process.cwd(), '.liyuan-workbench-settings-'))
  const file = join(dataDir, 'connections.dpapi')
  const options = { ...baseOptions, dataDir, engine: 'cc-haha' as const }
  const oldSettings = {
    models: { default: { baseUrl: 'https://model.example.invalid/v1', name: 'Fixture model', key: 'old-model-key' } },
    workspace: 'C:/fixture/project', computerUse: false, management: origin,
  }
  const signal = new AbortController().signal
  try {
    await writeFile(file, JSON.stringify(oldSettings))
    const settings = await createClientSettings(options)
    expect(settings.view()).toMatchObject({ revision: 0, hasContextKey: false, workspace: oldSettings.workspace,
      management: origin, models: { default: { name: 'Fixture model', hasKey: true } },
      runtime: { version: '0.2.6', engine: 'cc-haha', engineVersion: '0.7.7' } })
    expect(settings.openTools(signal, 'existing task')).not.toHaveProperty('context')
    expect(await readFile(file, 'utf8')).toBe(JSON.stringify(oldSettings))

    await settings.save({ revision: 0, section: 'context', value: { key: token } })
    expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('runtime')
    const connected = await createClientSettings({ ...options, engine: 'pi' })
    expect(connected.view().hasContextKey).toBe(true)
    expect(connected.view().runtime).toEqual({ version: '0.2.6', engine: 'pi', engineVersion: '1.4.0' })
    expect(JSON.stringify(connected.view())).not.toContain(token)
    expect(connected.openTools(signal, 'existing task')).toHaveProperty('context')
    expect(connected.model('review')).toMatchObject({ apiKey: 'old-model-key', reposDir: oldSettings.workspace })

    await connected.save({ revision: 0, section: 'management', value: { url: origin + '/' } })
    expect(connected.view().hasContextKey).toBe(true)
    await connected.save({ revision: 1, section: 'management', value: { url: 'https://other.example.invalid' } })
    expect(connected.view().hasContextKey).toBe(false)
    expect(connected.openTools(signal, 'existing task')).not.toHaveProperty('context')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...oldSettings, management: 'https://other.example.invalid' })
  } finally {
    await rm(file, { force: true })
    await rmdir(dataDir)
  }
})

async function withFixture<T>(run: (settings: Awaited<ReturnType<typeof createClientSettings>>, dataDir: string) => Promise<T>) {
  const dataDir = await mkdtemp(join(process.cwd(), '.liyuan-workbench-settings-'))
  try {
    const settings = await createClientSettings({ ...baseOptions, dataDir, engine: 'cc-haha', helper: 'fixture-helper.exe',
      defaults: { environment: { name: 'UAT', url: 'http://uat.example.invalid/', dataCenter: '' } } })
    return await run(settings, dataDir)
  } finally {
    await rm(join(dataDir, 'connections.dpapi'), { force: true })
    await rmdir(dataDir)
  }
}

it('lists bounded window IDs and titles only after computer use is enabled', async () => {
  await withFixture(async (settings, dataDir) => {
    expect(await settings.testConnection({ section: 'computer-windows' })).toMatchObject({ ok: false })
    expect(runDeviceHelper).not.toHaveBeenCalled()
    await settings.save({ revision: 0, section: 'computer', value: { enabled: true } })
    runDeviceHelper.mockResolvedValue({ ok: true, data: [null, { id: 'invalid\n', title: 'skip' },
      { id: 'w-103', title: ' 采购\u0007台 ', pid: 25, app_name: 'fixture' },
      ...Array.from({ length: 38 }, (_, index) => ({ id: `w-${index + 200}`, title: 'x'.repeat(300) }))] })
    const result = await settings.testConnection({ section: 'computer-windows' })
    expect(runDeviceHelper).toHaveBeenCalledExactlyOnceWith('fixture-helper.exe', join(dataDir, 'computer-use'), ['list-windows'], expect.any(AbortSignal))
    expect(result).toMatchObject({ ok: true, windows: expect.arrayContaining([{ id: 'w-103', title: '采购 台' }]) })
    if (!('windows' in result) || !result.windows) throw new Error('missing window list')
    expect(result.windows).toHaveLength(30)
    expect(result.windows[1]?.title).toHaveLength(180)
    expect(result.windows[0]).toEqual({ id: 'w-103', title: '采购 台' })
    runDeviceHelper.mockRejectedValue(new Error('private fixture error'))
    const failed = await settings.testConnection({ section: 'computer-windows' })
    expect(failed).toMatchObject({ ok: false })
    expect(JSON.stringify(failed)).not.toContain('private fixture error')
  })
})

it('reuses the exact server context lookup and exposes only safe, bounded source lines', async () => {
  await withFixture(async settings => {
    let searchResult: unknown = { status: 'matched', sources: [
      { path: '../secret.md', lines: [{ line: 1, text: 'private path fixture' }] },
      { path: 'docs/%2e%2e/secret.md', lines: [{ line: 1, text: 'private encoded fixture' }] },
      { path: 'C:/secret.md', lines: [{ line: 1, text: 'private absolute fixture' }] },
      { path: '项目资料/采购.md', lines: [{ line: -1, text: 'invalid line' }, { line: 18, text: '采购查询原文' },
        ...Array.from({ length: 30 }, (_, index) => ({ line: 19 + index, text: '原'.repeat(650), privateField: 'private field fixture' }))] },
    ] }
    const fetchFixture = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.href).toBe(`${origin}/api/desktop/context/mcp`)
      expect(init.redirect).toBe('error')
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`)
      const { id, method, params } = JSON.parse(String(init.body))
      expect({ method, params }).toEqual({ method: 'tools/call', params: { name: 'search_knowledge', arguments: { query: '采购查询' } } })
      return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(searchResult) }] } })
    })
    vi.stubGlobal('fetch', fetchFixture)
    const request = { section: 'context-search', query: ' 采购查询 ' }
    expect(await settings.testConnection(request)).toMatchObject({ ok: false })
    await settings.save({ revision: 0, section: 'context', value: { key: token } })
    expect(await settings.testConnection({ ...request, query: '采购\n查询' })).toMatchObject({ ok: false })
    expect(await settings.testConnection({ ...request, query: '采'.repeat(201) })).toMatchObject({ ok: false })
    expect(fetchFixture).not.toHaveBeenCalled()
    const result = await settings.testConnection(request)
    expect(result).toMatchObject({ ok: true })
    if (!('matches' in result) || !result.matches) throw new Error('missing source lines')
    expect(result.matches).toHaveLength(20)
    expect(result.matches[0]).toEqual({ path: '项目资料/采购.md', line: 18, text: '采购查询原文' })
    expect(result.matches[1]?.text).toHaveLength(600)
    expect(JSON.stringify(result)).not.toMatch(/private|secret|invalid line/)

    searchResult = { status: 'no_match', sources: [] }
    expect(await settings.testConnection(request)).toMatchObject({ ok: true, matches: [] })
    searchResult = { status: 'unavailable', sources: [], notice: 'private fixture error' }
    const failed = await settings.testConnection(request)
    expect(failed).toMatchObject({ ok: false })
    expect(JSON.stringify(failed)).not.toContain('private fixture error')
  })
})

it('opens the existing business query window through the unchanged test route', async () => {
  await withFixture(async settings => {
    expect(await settings.testConnection({ section: 'open-environment' })).toMatchObject({ ok: true })
    expect(showEnvironment).toHaveBeenCalledExactlyOnceWith('http://uat.example.invalid/')
  })
})
