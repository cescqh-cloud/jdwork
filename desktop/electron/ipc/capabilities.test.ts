import { describe, expect, it } from 'vitest'
import { PUBLIC_ACCESS_CONSENT_VERSION } from '../../src/lib/desktopHost/types'
import { ELECTRON_IPC_CHANNELS } from './channels'
import { blankDemandDraft } from '../../src/lib/desktopHost/enterpriseDemand'
import {
  ELECTRON_IPC_VALIDATORS,
  isElectronIpcChannel,
  isElectronIpcChannelAllowedForPetWindow,
  validateElectronIpcPayload,
} from './capabilities'

describe('Electron IPC capabilities', () => {
  it('limits local memory to explicit private drafts and typed session references', () => {
    const channel = 'desktop:enterprise:memory-local'
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    const deviceId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
    const sourceRef = { sessionId: 'local-session:7', messageRefs: ['message.1'] }
    const save = { action: 'save', id, deviceId, expectedLocalRevision: null, body: '采购报表经验', sourceRef, cloud: null }
    const create = { action: 'create', scope: 'user_private', body: save.body, sourceRef, idempotencyKey: id }
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.enterpriseMemory, create)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.enterpriseMemory, { ...create, sourceRef: { ...sourceRef, extra: 'discard' } })).toBe(false)
    if (!isElectronIpcChannel(channel)) throw new Error('Missing dedicated local memory channel')
    expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
    expect(validateElectronIpcPayload(channel, save)).toBe(true)
    expect(validateElectronIpcPayload(channel, { ...save, scope: 'team_shared' })).toBe(false)
    expect(validateElectronIpcPayload(channel, { ...save, sourceRef: { sessionId: 'https://example.test' } })).toBe(false)
    expect(validateElectronIpcPayload(channel, { action: 'discard', id, deviceId, expectedLocalRevision: 1 })).toBe(true)
    const merge = { action: 'merge', id, deviceId, expectedLocalRevision: 1, expectedCloudRevision: 2, body: save.body }
    expect(validateElectronIpcPayload(channel, merge)).toBe(true)
    expect(validateElectronIpcPayload(channel, { ...merge, cloud: { id, revision: 2 } })).toBe(false)
  })

  it('limits offline demand operations to draft and device identities, and keeps paths out of renderer input', () => {
    const channel = ELECTRON_IPC_CHANNELS.enterpriseDemandLocal
    const input = { action: 'export', id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      deviceId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', expectedLocalRevision: 1 }
    expect(validateElectronIpcPayload(channel, input)).toBe(true)
    expect(validateElectronIpcPayload(channel, { ...input, path: 'user-selected.md' })).toBe(false)
    expect(validateElectronIpcPayload(channel, { ...input, id: '../draft' })).toBe(false)
    expect(validateElectronIpcPayload(channel, { ...input, action: 'submit' })).toBe(false)
    expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
  })

  it('limits the base draft to new cloud copies and the merge request to current revisions and manual content', () => {
    const channel = ELECTRON_IPC_CHANNELS.enterpriseDemandLocal
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    const deviceId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
    const cloud = { id: 'cccccccc-cccc-4ccc-accc-cccccccccccc', demandNo: 'REQ-1', draftRevision: 1 }
    const save = { action: 'save', id, deviceId, expectedLocalRevision: null, cloud, draft: blankDemandDraft, baseDraft: blankDemandDraft }
    expect(validateElectronIpcPayload(channel, save)).toBe(true)
    expect(validateElectronIpcPayload(channel, { ...save, cloud: null })).toBe(false)
    expect(validateElectronIpcPayload(channel, { ...save, expectedLocalRevision: 1 })).toBe(false)
    const merge = { action: 'merge', id, deviceId, expectedLocalRevision: 2, expectedCloudRevision: 3, draft: blankDemandDraft }
    expect(validateElectronIpcPayload(channel, merge)).toBe(true)
    expect(validateElectronIpcPayload(channel, { ...merge, expectedCloudRevision: 0 })).toBe(false)
    expect(validateElectronIpcPayload(channel, { ...merge, cloud })).toBe(false)
    expect(validateElectronIpcPayload(channel, { ...merge, baseDraft: blankDemandDraft })).toBe(false)
  })
  it('allows a document read only for the declared workspace browser tab and address', () => {
    const channel = ELECTRON_IPC_CHANNELS.workspaceBrowserReadDocument
    const input = { tabId: 'wb-1', expectedUrl: 'https://docs.example.com/manual' }
    expect(validateElectronIpcPayload(channel, input)).toBe(true)
    for (const value of [undefined, { ...input, expectedUrl: 'file:///notes' }, { ...input, tabId: '../other' },
      { ...input, expectedUrl: 'https://docs.example.com/' + 'x'.repeat(8192) }, { ...input, engine: 'lightpanda' },
    ]) expect(validateElectronIpcPayload(channel, value)).toBe(false)
    expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
  })
  it('limits enterprise IPC to the native binding payloads and excludes the pet window', () => {
    const { enterpriseEnroll, enterpriseSync, enterpriseDisconnect } = ELECTRON_IPC_CHANNELS
    const input = { origin: 'https://control.example.test', challenge: 'a'.repeat(43) }
    expect(validateElectronIpcPayload(enterpriseEnroll, input)).toBe(true)
    expect(validateElectronIpcPayload(enterpriseEnroll, { ...input, officeHttp: true })).toBe(true)
    expect(validateElectronIpcPayload(enterpriseEnroll, { ...input, officeHttp: false })).toBe(true)
    for (const payload of [undefined, {}, { ...input, refreshToken: 'secret' }, { ...input, officeHttp: 'true' }, { ...input, challenge: 'a'.repeat(65) }]) {
      expect(validateElectronIpcPayload(enterpriseEnroll, payload)).toBe(false)
    }
    expect(validateElectronIpcPayload(enterpriseSync, true)).toBe(true)
    expect(validateElectronIpcPayload(enterpriseSync, undefined)).toBe(true)
    expect(validateElectronIpcPayload(enterpriseSync, {})).toBe(false)
    expect(validateElectronIpcPayload(enterpriseDisconnect, undefined)).toBe(true)
    expect(validateElectronIpcPayload(enterpriseDisconnect, 'secret')).toBe(false)
    for (const channel of [enterpriseEnroll, enterpriseSync, enterpriseDisconnect]) {
      expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
    }
  })

  it('accepts only structured enterprise demand actions in the main desktop host', () => {
    const channel = ELECTRON_IPC_CHANNELS.enterpriseDemand
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    const input = { action: 'precheck', id, expectedDraftRevision: 1 }
    expect(validateElectronIpcPayload(channel, input)).toBe(true)
    for (const value of [
      { ...input, route: '/external' }, { ...input, id: '../private' }, { ...input, expectedDraftRevision: 0 },
      { ...input, modelId: 'undeclared' }, { action: 'approve', id },
    ]) expect(validateElectronIpcPayload(channel, value)).toBe(false)
    expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
  })

  it('accepts only boolean power preferences and denies the pet renderer access', () => {
    const channel = ELECTRON_IPC_CHANNELS.powerSetPreventSleepWhileRunning
    expect(validateElectronIpcPayload(channel, true)).toBe(true)
    expect(validateElectronIpcPayload(channel, false)).toBe(true)
    for (const payload of [undefined, null, 'true', 1, {}, { enabled: true }]) {
      expect(validateElectronIpcPayload(channel, payload)).toBe(false)
    }
    expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
  })
  it('validates migration paths and identities and keeps migration IPC unavailable to pet windows', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.migrationPrepare, { targetDir: 'D:\\cc-haha-data' })).toBe(true)
    for (const payload of [undefined, {}, { targetDir: '' }, { targetDir: '   ' }, { targetDir: 2 }, { targetDir: 'bad\u0000path' }, { targetDir: 'D:\\data', sourceDir: 'C:\\data' }]) {
      expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.migrationPrepare, payload)).toBe(false)
    }
    for (const channel of [ELECTRON_IPC_CHANNELS.migrationStart, ELECTRON_IPC_CHANNELS.migrationCancel]) {
      expect(validateElectronIpcPayload(channel, { id: 'migration-1' })).toBe(true)
      for (const payload of [undefined, {}, { id: '' }, { id: '../other' }, { id: 'x'.repeat(201) }, { id: 'migration-1', targetDir: 'D:\\data' }]) {
        expect(validateElectronIpcPayload(channel, payload)).toBe(false)
      }
    }
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.migrationStatus, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.migrationStatus, {})).toBe(false)
    for (const channel of [ELECTRON_IPC_CHANNELS.migrationPrepare, ELECTRON_IPC_CHANNELS.migrationStart, ELECTRON_IPC_CHANNELS.migrationStatus, ELECTRON_IPC_CHANNELS.migrationCancel]) {
      expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
    }
  })

  it('restricts public tunnel consent to validated desktop IPC and retires credential channels', () => {
    for (const channel of ['desktop:public-access:save-credential', 'desktop:public-access:delete-credential']) {
      expect(isElectronIpcChannel(channel)).toBe(false)
    }
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.publicAccessStart, PUBLIC_ACCESS_CONSENT_VERSION)).toBe(true)
    for (const value of [0, PUBLIC_ACCESS_CONSENT_VERSION - 1, PUBLIC_ACCESS_CONSENT_VERSION + 1, '3', null]) {
      expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.publicAccessStart, value)).toBe(false)
    }
    for (const channel of Object.values(ELECTRON_IPC_CHANNELS).filter(value => value.startsWith('desktop:public-access:'))) {
      expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
    }
  })

  it('accepts only typed Cloudflare configuration and a fixed local port', () => {
    const channel = ELECTRON_IPC_CHANNELS.publicAccessConfigure
    const configuration = { mode: 'named', customUrl: 'https://phone.example.test', localPort: 17463 }
    expect(validateElectronIpcPayload(channel, configuration)).toBe(true)
    expect(validateElectronIpcPayload(channel, { mode: 'quick', customUrl: '', localPort: 17463 })).toBe(true)
    for (const value of [undefined, {}, { ...configuration, customUrl: 'http://phone.example.test' }, { ...configuration, customUrl: 'https://phone.example.test/remote' }, { ...configuration, customUrl: 'https://user:password@phone.example.test' }, { ...configuration, localPort: 80 }, { ...configuration, localPort: '17463' }, { ...configuration, mode: 'ngrok' }, { ...configuration, mode: 'tailscale' }, { ...configuration, localHost: '0.0.0.0' }, { ...configuration, command: 'cloudflared tunnel run' }]) {
      expect(validateElectronIpcPayload(channel, value)).toBe(false)
    }
    expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
  })

  it('accepts only the typed browser-menu fields and keeps the channel unavailable to pets', () => {
    const channel = ELECTRON_IPC_CHANNELS.workspaceBrowserShowMenu
    const labels = Object.fromEntries(['find', 'print', 'zoom', 'zoomIn', 'zoomOut', 'zoomReset', 'capture', 'pickElement', 'downloads', 'history', 'openExternal'].map(key => [key, key]))
    const payload = { tabId: 'wb-1', x: 20, y: 44, labels, zoomFactor: 1, hasPage: true, canOpenExternal: true }
    expect(validateElectronIpcPayload(channel, payload)).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(channel)).toBe(false)
    for (const patch of [
      { tabId: '' }, { tabId: '../bad' }, { x: NaN }, { y: Infinity }, { x: '20' },
      { zoomFactor: 0 }, { zoomFactor: NaN }, { canOpenExternal: 'true' }, { hasPage: undefined }, { hasPage: 'true' },
      { action: 'quit' }, { labels: { ...labels, role: 'quit' } },
      { labels: { ...labels, find: undefined } }, { labels: { ...labels, find: '' } },
      { labels: { ...labels, find: 'x'.repeat(201) } }, { labels: { ...labels, find: 'bad\nlabel' } },
    ]) expect(validateElectronIpcPayload(channel, { ...payload, ...patch })).toBe(false)
  })

  it('requires the renderer guest id on create and accepts no geometry', () => {
    const channel = ELECTRON_IPC_CHANNELS.workspaceBrowserCreate
    const identity = { tabId: 'wb-1', storageId: 'store-1', webContentsId: 7 }
    expect(validateElectronIpcPayload(channel, identity)).toBe(true)
    expect(validateElectronIpcPayload(channel, { ...identity, url: 'https://example.com/' })).toBe(true)
    for (const webContentsId of [undefined, 0, -1, 1.5, '7', Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(validateElectronIpcPayload(channel, { ...identity, webContentsId })).toBe(false)
    }
    // Pages are drawn by the renderer now; the old native-view options are gone.
    expect(validateElectronIpcPayload(channel, { ...identity, visible: false })).toBe(false)
    expect(validateElectronIpcPayload(channel, { ...identity, bounds: { x: 0, y: 0, width: 1, height: 1 } })).toBe(false)
  })

  it('has a validator for every exposed invoke channel', () => {
    expect(Object.keys(ELECTRON_IPC_VALIDATORS).sort()).toEqual(
      Object.values(ELECTRON_IPC_CHANNELS).sort(),
    )
  })

  it('rejects channels outside the desktop host contract', () => {
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appGetVersion)).toBe(true)
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appGetLocalePreference)).toBe(true)
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appSetLocalePreference)).toBe(true)
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appGetPreferredSystemLanguages)).toBe(true)
    expect(isElectronIpcChannel('ipcRenderer:send-anything')).toBe(false)
  })

  it('validates structured payloads before they reach ipcRenderer.invoke', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.shellOpen, 'https://example.com')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.shellOpen, { url: 'https://example.com' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.clipboardReadText, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.clipboardWriteText, 'paste me')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.clipboardWriteText, { text: 'paste me' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusSession, '4673a448-9e2c-475e-898d-9aa0ee2d1ab7')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusSession, '../escape')).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowClose, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowClose, {})).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowStartDragging, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowStartDragging, { deltaX: 4, deltaY: -2 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: 1, data: 'pwd\n' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: '1', data: 'pwd\n' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: 24, cwd: '/tmp' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: 24, requestId: 'start' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { requestId: '' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { requestId: 'x'.repeat(129) })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: '80', rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: 24, shell: '/bin/sh' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: Number.NaN, rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80.5, rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 1_001, rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: Number.POSITIVE_INFINITY })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: 24, cwd: 'x'.repeat(4_097) })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: 0, data: 'pwd\n' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: 1.5, data: 'pwd\n' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, {
      sessionId: Number.MAX_SAFE_INTEGER + 1,
      data: 'pwd\n',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, {
      sessionId: 1,
      data: 'x'.repeat(1_048_577),
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, {
      sessionId: 1,
      data: 'pwd\n',
      extra: true,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalResize, {
      sessionId: 1,
      cols: 80,
      rows: 24,
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalResize, {
      sessionId: 1,
      cols: Number.NaN,
      rows: 24,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalKill, { sessionId: -1 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalKill, {
      sessionId: 1,
      extra: true,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: 'http://127.0.0.1:7890' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: '' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: 'http://127.0.0.1:7890', extra: true })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.appSetLocalePreference, 'zh-TW')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.appSetLocalePreference, 'fr')).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsList, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsList, {})).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromImage, {
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
      dialogTitle: '选择透明背景的宠物图片',
      dialogFilterName: '宠物图片',
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromImage, {
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
      dialogTitle: 'Bad\nTitle',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromAtlas, {
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromAtlas, {
      slug: '../escape',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromAtlas, {
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
      atlasPath: '/tmp/private.png',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsOpenFolder, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShow, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsHide, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: '关闭宠物',
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: '   ',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: 'x'.repeat(81),
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: 'Close\nPet',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: 'Close pet',
      extra: true,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsDragWindow, {
      phase: 'move',
      x: -1_240.5,
      y: 480,
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsDragWindow, {
      phase: 'move',
      x: Number.NaN,
      y: 480,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsDragWindow, {
      phase: 'teleport',
      x: 120,
      y: 480,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsDragWindow, {
      phase: 'end',
      x: 120,
      y: 480,
      windowId: 2,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions, [
      { x: 100, y: 220, width: 144, height: 160 },
    ])).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions, [
      { x: -1, y: 0, width: 20, height: 20 },
    ])).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusMainWindow, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusMainWindow, {})).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusSession, 'session-123')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusSession, '../escape')).toBe(false)
  })

  it('pins the reported appearance colors to literal 6-digit hex', () => {
    // Both values reach BrowserWindow.setBackgroundColor, which also accepts
    // #AARRGGBB — an 8-digit value would let a compromised renderer make the
    // window translucent (click-through, overlay spoofing). So the boundary
    // takes exactly #RRGGBB and nothing else.
    const valid = {
      isDark: true,
      background: '#0E0E0E',
      lightBackground: '#FFFFFF',
      followSystem: false,
    }
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.appearanceSetApplied, valid)).toBe(true)

    for (const invalid of [
      undefined,
      'dark',
      { isDark: true, background: '#0E0E0E', lightBackground: '#FFFFFF' },
      { isDark: true, background: '#0E0E0E', followSystem: false },
      { isDark: 'true', background: '#0E0E0E', lightBackground: '#FFFFFF', followSystem: false },
      { ...valid, background: '#0E0' },
      { ...valid, background: 'black' },
      { ...valid, background: 'rgb(0 0 0)' },
      { ...valid, background: '#800E0E0E' },
      { ...valid, lightBackground: '#80FFFFFF' },
      { ...valid, lightBackground: 'white' },
      { ...valid, extra: 1 },
    ]) {
      expect(
        validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.appearanceSetApplied, invalid),
        JSON.stringify(invalid),
      ).toBe(false)
    }
  })

  it('keeps the appearance channel away from the pet window', () => {
    // The pet window is transparent and must not repaint the main window.
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.appearanceSetApplied,
    )).toBe(false)
  })

  it('gives the pet renderer only runtime bootstrap and companion controls', () => {
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.appGetLocalePreference,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.appSetLocalePreference,
    )).toBe(false)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.appGetPreferredSystemLanguages,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.runtimeGetServerUrl,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.runtimeGetPetAccessToken,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.runtimeGetLocalAccessToken,
    )).toBe(false)
    expect(isElectronIpcChannelAllowedForPetWindow(ELECTRON_IPC_CHANNELS.petsList)).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(ELECTRON_IPC_CHANNELS.petsHide)).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.petsShowContextMenu,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.petsDragWindow,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(ELECTRON_IPC_CHANNELS.petsFocusSession)).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.petsFocusMainWindow,
    )).toBe(true)

    for (const forbidden of [
      ELECTRON_IPC_CHANNELS.commandInvoke,
      ELECTRON_IPC_CHANNELS.runtimeGetLocalAccessToken,
      ELECTRON_IPC_CHANNELS.shellOpen,
      ELECTRON_IPC_CHANNELS.shellOpenPath,
      ELECTRON_IPC_CHANNELS.dialogOpen,
      ELECTRON_IPC_CHANNELS.petsCreateFromImage,
      ELECTRON_IPC_CHANNELS.petsCreateFromAtlas,
      ELECTRON_IPC_CHANNELS.updateRelaunch,
      ELECTRON_IPC_CHANNELS.terminalSpawn,
      ELECTRON_IPC_CHANNELS.previewOpen,
      ELECTRON_IPC_CHANNELS.appModeSet,
      ELECTRON_IPC_CHANNELS.adaptersRestartSidecar,
    ]) {
      expect(isElectronIpcChannelAllowedForPetWindow(forbidden)).toBe(false)
    }
  })
})
