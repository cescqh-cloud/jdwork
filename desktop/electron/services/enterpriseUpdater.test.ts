// @vitest-environment node

import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseEnterpriseReleaseTrust, releaseDigest, verifyEnterpriseManifest, verifyEnterpriseRelease } from './enterpriseReleaseProof'
import { EnterpriseUpdater } from './enterpriseUpdater'
import type { EnterpriseUpdateTransport } from './enterpriseUpdateRouting'
import { ElectronUpdaterService, type ElectronUpdaterLike } from './updater'

const reportsPath = '/api/v1/client/update-reports'
const oldVersion = '2.0.0'
const nextVersion = '2.1.0'
const certificateFingerprint = 'a'.repeat(64)
const installedContent = Buffer.from('Fixture bytes. This file is never executed.')
const name = 'Liyuan Workbench Setup.exe'
const hash512 = createHash('sha512').update(installedContent).digest('base64')
const artifact = { name, size: installedContent.length, sha256: releaseDigest(installedContent), sha512: hash512 }
const manifest = Buffer.from(`version: ${nextVersion}\nfiles:\n  - url: ${name}\n    sha512: ${hash512}\n    size: ${installedContent.length}\npath: ${name}\nsha512: ${hash512}\nreleaseDate: '2026-11-10T00:00:00Z'\n`)

function signedOffer(manifestBytes = manifest, version = nextVersion, publisher = certificateFingerprint) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  const publicEncoded = der.toString('base64url')
  const releaseId = randomUUID()
  const { signer, schema, ...exposed } = { schema: 1, releaseId, version, platform: 'win32', arch: 'x64', channel: 'canary',
    artifact, manifestSha256: releaseDigest(manifestBytes), signer: { kind: 'authenticode', publisher: 'Fixture publisher', fingerprint: publisher },
    publishedAt: '2026-11-10T00:00:00.000Z' }
  const signed = Buffer.from(JSON.stringify({ schema, signer, ...exposed }))
  const proof = { keyId: releaseDigest(der), publicKey: publicEncoded, payload: signed.toString('base64url'), signature: sign(null, signed, privateKey).toString('base64url') }
  const trust = parseEnterpriseReleaseTrust({ publicKey: publicEncoded, publisherSha256: certificateFingerprint, channel: 'canary' })
  const candidate = { ...exposed, proof, feedPath: `/api/v1/updates/feed/${releaseId}/` }
  return { trust, candidate, reply: { currentVersion: oldVersion, channel: 'canary', minClientVersion: nextVersion, compatibility: 'UPDATE_REQUIRED', candidate } }
}

const fixtures: string[] = []
const guards: EnterpriseUpdater[] = []
afterEach(async () => {
  for (const guard of guards.splice(0)) guard.closeFeed()
  for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function setup() {
  const offer = signedOffer()
  const directory = await mkdtemp(join(tmpdir(), 'liyuan-update-fixture-'))
  fixtures.push(directory)
  const receiptPath = join(directory, 'receipt.json')
  const filePath = join(directory, name)
  const stages: Array<Record<string, unknown>> = []
  const ranges: Array<string | undefined> = []
  let visible = true
  let binding = 'fixture-device-A'
  let failHealth = false
  let feed = ''
  const verifySigner = vi.fn(async (_path: string, _certificate: string) => {})
  const request: EnterpriseUpdateTransport['request'] = async (path, init) => {
    if (path.startsWith('/api/v1/updates/check?')) return Response.json({ ...offer.reply, candidate: visible ? offer.candidate : null })
    if (path === `${offer.candidate.feedPath}latest.yml`) return new Response(new Uint8Array(manifest))
    if (path === `${offer.candidate.feedPath}${encodeURIComponent(name)}`) {
      ranges.push(init?.range)
      if (init?.range === 'bytes=0-5') return new Response(new Uint8Array(installedContent.subarray(0, 6)), { status: 206,
        headers: { 'Content-Range': `bytes 0-5/${artifact.size}`, 'Content-Length': '6', 'Set-Cookie': 'not-forwarded' } })
      return new Response(init?.method === 'HEAD' ? null : new Uint8Array(installedContent), { headers: { 'Content-Length': String(artifact.size) } })
    }
    if (path === reportsPath && init?.body) {
      stages.push(init.body)
      return Response.json({}, { status: failHealth && init.body.stage === 'healthy' ? 503 : 200 })
    }
    return new Response(null, { status: 404 })
  }
  const opts = { trust: offer.trust, currentVersion: oldVersion, arch: 'x64', receiptPath,
    transport: async () => ({ binding, request }), applyFeed: (url: string) => { feed = url }, verifySigner }
  const guard = new EnterpriseUpdater(opts)
  guards.push(guard)
  return { ...offer, guard, opts, stages, ranges, receiptPath, filePath, verifySigner, feed: () => feed,
    pause() { visible = false }, switchDevice(value: string) { binding = value }, failHealth(value: boolean) { failHealth = value } }
}

describe('enterprise release proof', () => {
  it('pins the Ed25519 key, actual artifact metadata and publisher certificate', () => {
    const valid = signedOffer()
    const verified = verifyEnterpriseRelease(valid.reply, valid.trust, oldVersion, 'x64')
    expect(verified?.releaseId).toBe(valid.candidate.releaseId)
    expect(verified?.required).toBe(true)
    expect(() => verifyEnterpriseRelease(signedOffer().reply, valid.trust, oldVersion, 'x64')).toThrow()
    expect(() => verifyEnterpriseRelease({ ...valid.reply, candidate: { ...valid.candidate, artifact: { ...artifact, size: 3 } } }, valid.trust, oldVersion, 'x64')).toThrow()
    expect(() => verifyEnterpriseRelease({ ...valid.reply, candidate: { ...valid.candidate, feedPath: 'https://unrelated.example/' } }, valid.trust, oldVersion, 'x64')).toThrow()
    expect(() => verifyEnterpriseRelease(valid.reply, valid.trust, oldVersion, 'arm64')).toThrow()
    const old = signedOffer(manifest, '1.9.9')
    expect(() => verifyEnterpriseRelease(old.reply, old.trust, oldVersion, 'x64')).toThrow()
    const publisher = signedOffer(manifest, nextVersion, 'b'.repeat(64))
    expect(() => verifyEnterpriseRelease(publisher.reply, publisher.trust, oldVersion, 'x64')).toThrow()
  })

  it('uses the original signed bytes and rejects absolute YAML downloads even if signed', () => {
    const valid = signedOffer()
    const release = verifyEnterpriseRelease(valid.reply, valid.trust, oldVersion, 'x64')!
    expect(() => verifyEnterpriseManifest(manifest, release)).not.toThrow()
    expect(() => verifyEnterpriseManifest(Buffer.concat([manifest, Buffer.from('\n')]), release)).toThrow()
    const remote = Buffer.from(manifest.toString().replaceAll(name, 'https://unrelated.example/setup.exe'))
    const signed = signedOffer(remote)
    expect(() => verifyEnterpriseManifest(remote, verifyEnterpriseRelease(signed.reply, signed.trust, oldVersion, 'x64')!)).toThrow()
  })
})

describe('enterprise native updater guard', () => {
  it('provides a private fixed feed, validates downloaded bytes and reports the matching restart', async () => {
    const fixture = await setup()
    const fake: ElectronUpdaterLike = {
      autoDownload: true, autoInstallOnAppQuit: true,
      async checkForUpdates() {
        expect(await (await fetch(new URL('latest.yml', fixture.feed()))).text()).toBe(manifest.toString())
        expect((await fetch(new URL('other.exe', fixture.feed()))).status).toBe(404)
        return { isUpdateAvailable: true, updateInfo: { version: nextVersion, releaseNotes: 'Fixture notes' } }
      },
      async downloadUpdate() {
        const reply = await fetch(new URL(encodeURIComponent(name), fixture.feed()), { headers: { Range: 'bytes=0-5' } })
        expect(reply.status).toBe(206)
        expect(reply.headers.get('Set-Cookie')).toBeNull()
        expect(await reply.text()).toBe(installedContent.subarray(0, 6).toString())
        const full = await fetch(new URL(encodeURIComponent(name), fixture.feed()))
        await writeFile(fixture.filePath, Buffer.from(await full.arrayBuffer()))
        return [fixture.filePath]
      },
      quitAndInstall: vi.fn(), on() { return fake }, off() { return fake },
    }
    const service = new ElectronUpdaterService(fake, undefined, { enterprise: fixture.guard })
    const available = await service.checkForUpdates()
    expect(available?.body).toContain('企业版本策略要求更新')
    const emit = vi.fn()
    await service.downloadUpdate(emit)
    expect(fixture.ranges).toEqual(['bytes=0-5', undefined])
    expect(fixture.verifySigner).toHaveBeenCalledWith(fixture.filePath, certificateFingerprint)
    expect(emit).toHaveBeenLastCalledWith({ event: 'Finished' })
    await service.authorizeEnterpriseInstall()
    service.stageDownloadedUpdate()
    await service.prepareEnterpriseRelaunch()
    const receipt = JSON.parse(await readFile(fixture.receiptPath, 'utf8'))
    expect(receipt).toMatchObject({ releaseId: fixture.candidate.releaseId, version: nextVersion, binding: 'fixture-device-A' })
    expect(JSON.stringify(receipt)).not.toContain(fixture.trust.publicKey)

    const updated = new EnterpriseUpdater({ ...fixture.opts, currentVersion: nextVersion })
    fixture.switchDevice('fixture-device-B')
    await updated.reportStartup(true)
    expect(fixture.stages.map(stage => stage.stage)).toEqual(['downloaded'])
    fixture.switchDevice('fixture-device-A')
    fixture.failHealth(true)
    await expect(updated.reportStartup(true)).rejects.toThrow()
    fixture.failHealth(false)
    await updated.reportStartup(true)
    expect(fixture.stages.map(stage => stage.stage)).toEqual(['downloaded', 'installed', 'healthy', 'installed', 'healthy'])
    expect(fixture.stages[1]?.eventId).toBe(fixture.stages[3]?.eventId)
    expect(fixture.stages[2]?.eventId).toBe(fixture.stages[4]?.eventId)
    await expect(readFile(fixture.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a tampered cache and a paused or revoked candidate before installation', async () => {
    const fixture = await setup()
    await fixture.guard.prepare()
    await writeFile(fixture.filePath, Buffer.alloc(artifact.size))
    await expect(fixture.guard.validateDownload([fixture.filePath])).rejects.toThrow()
    expect(fixture.verifySigner).not.toHaveBeenCalled()
    await writeFile(fixture.filePath, installedContent)
    await fixture.guard.validateDownload([fixture.filePath])
    await writeFile(fixture.filePath, Buffer.alloc(artifact.size))
    await expect(fixture.guard.prepareInstall()).rejects.toThrow()
    await writeFile(fixture.filePath, installedContent)
    fixture.switchDevice('fixture-device-B')
    await expect(fixture.guard.prepareInstall()).rejects.toThrow()
    fixture.switchDevice('fixture-device-A')
    fixture.pause()
    await expect(fixture.guard.prepareInstall()).rejects.toThrow()
    await expect(readFile(fixture.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
