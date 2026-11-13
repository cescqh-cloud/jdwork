import { expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { artifactName, clientVersion, compareVersions, createReleaseInput, rolloutBucket, type ReleaseProofPayload } from '../src/releases/contract'
import { validateBuilderManifest } from '../src/releases/manifest'
import { createReleaseSigner, loadReleaseConfig, validateTrustedSigner, verifyReleaseProof } from '../src/releases/signatures'
import { installerResponse } from '../src/releases/storage'
import { fixtureFingerprint, fixturePublisher, sha256, sha512, testExe } from './releases-fixtures'

const bytes = testExe()
const filename = 'Fixture Workbench Setup 0.7.8.exe'
const manifest = `version: 0.7.8\nfiles:\n  - url: ${filename}\n    sha512: ${sha512(bytes)}\n    size: ${bytes.length}\npath: ${filename}\nsha512: ${sha512(bytes)}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`

test('accepts only a strict one-installer builder manifest and preserves original bytes', () => {
  const value = Buffer.from(manifest)
  const parsed = validateBuilderManifest(value, '0.7.8', 2048)
  expect(parsed).toMatchObject({ bytes: value, name: filename, size: bytes.length, sha512: sha512(bytes), manifestSha256: sha256(value) })
  for (const bad of [manifest.replaceAll(filename, '../unsafe.exe'), manifest.replaceAll(filename, 'https://other.example/x.exe'),
    manifest.replaceAll(filename, 'CON.exe'), manifest.replaceAll(filename, 'file%2fsecret.exe'), `${manifest}version: 0.7.9\n`,
    `${manifest}---\nversion: 0.7.9\n`, `${manifest}stagingPercentage: 50\n`, `${manifest}packages: {x64: {path: helper.7z}}\n`,
    manifest.replace('files:', 'files: &files').replace(`path: ${filename}`, 'path: *files'), manifest.replace(`size: ${bytes.length}`, 'size: 0')]) {
    expect(() => validateBuilderManifest(Buffer.from(bad), '0.7.8', 2048)).toThrow('original electron-builder')
  }
  expect(() => validateBuilderManifest(value, '0.7.9', 2048)).toThrow()
  expect(() => validateBuilderManifest(value, '0.7.8', 100)).toThrow()
  expect(artifactName.safeParse('dot..exe').success).toBe(false)
})

test('compares semantic versions without trusting lexical order, and gives each device a stable cohort', () => {
  expect(compareVersions('0.7.10', '0.7.9')).toBeGreaterThan(0)
  expect(compareVersions('0.7.9-rc.10', '0.7.9-rc.2')).toBeGreaterThan(0)
  expect(compareVersions('0.7.9-rc.1', '0.7.9')).toBeLessThan(0)
  expect(compareVersions('0.7.9+metadata', '0.7.9')).toBe(0)
  expect(clientVersion.safeParse('0.7.9-rc.01').success).toBe(false)
  expect(clientVersion.safeParse('0.07.9').success).toBe(false)
  expect(createReleaseInput.safeParse({ platform: 'win32', arch: 'x64', channel: 'dev', version: '1.0.0', rolloutPercent: 100 }).success).toBe(false)
  const bucket = rolloutBucket('tenant', 'win32', 'x64', 'canary', 'device-01')
  expect(bucket).toBe(rolloutBucket('tenant', 'win32', 'x64', 'canary', 'device-01'))
  expect(bucket).toBeGreaterThanOrEqual(0)
  expect(bucket).toBeLessThan(10_000)
})

test('requires the pinned release key and a trusted package signature independently', () => {
  const trusted = createReleaseSigner(generateKeyPairSync('ed25519').privateKey)
  const other = createReleaseSigner(generateKeyPairSync('ed25519').privateKey)
  const payload: ReleaseProofPayload = { schema: 1, releaseId: '545eaf48-986a-46e5-94eb-7c5d482401ab', version: '0.7.8', platform: 'win32', arch: 'x64', channel: 'canary',
    artifact: { name: filename, size: bytes.length, sha256: sha256(bytes), sha512: sha512(bytes) }, manifestSha256: sha256(Buffer.from(manifest)),
    signer: { kind: 'authenticode', fingerprint: fixtureFingerprint, publisher: fixturePublisher }, publishedAt: '2026-01-01T00:00:00.000Z' }
  const proof = trusted.sign(payload)
  expect(verifyReleaseProof(proof, trusted.publicKey)).toEqual(payload)
  expect(verifyReleaseProof(other.sign(payload), trusted.publicKey)).toBeUndefined()
  expect(verifyReleaseProof({ ...proof, publicKey: other.publicKey, keyId: other.keyId }, other.publicKey)).toBeUndefined()
  const tampered = Buffer.from(JSON.stringify({ ...payload, version: '0.7.9' })).toString('base64url')
  expect(verifyReleaseProof({ ...proof, payload: tampered }, trusted.publicKey)).toBeUndefined()
  expect(loadReleaseConfig({ ENTERPRISE_UPDATE_TEST_SIGNATURE: 'true' })).toBeUndefined()
  const config = { directory: 'unused', maxBytes: 4096, signer: trusted, async verifier() { return payload.signer },
    trustedFingerprints: new Set([fixtureFingerprint]) }
  expect(() => validateTrustedSigner({ ...payload.signer, kind: 'test-fixture' }, config)).toThrow('valid Windows Authenticode')
  expect(() => validateTrustedSigner({ ...payload.signer, fingerprint: 'b'.repeat(64) }, config)).toThrow('trusted publisher')
})

test('returns exact single byte ranges and refuses multipart or out-of-bounds ranges', async () => {
  const blob = new Blob([bytes])
  const meta = { name: filename, size: bytes.length, sha256: sha256(bytes), sha512: sha512(bytes) }
  const request = (range: string, method = 'GET', other?: Record<string, string>) => new Request('http://127.0.0.1/', {
    method, headers: { Range: range, ...other },
  })
  const partial = installerResponse(blob, meta, request('bytes=10-19'))
  expect(partial.status).toBe(206)
  expect(partial.headers.get('Content-Range')).toBe('bytes 10-19/1024')
  expect(Buffer.from(await partial.arrayBuffer())).toEqual(bytes.subarray(10, 20))
  const suffix = installerResponse(blob, meta, request('bytes=-2', 'HEAD'))
  expect(suffix.status).toBe(206)
  expect(suffix.headers.get('Content-Length')).toBe('2')
  expect(await suffix.text()).toBe('')
  for (const invalid of ['bytes=1024-', 'bytes=5-3', 'bytes=-0', 'bytes=0-1,2-3']) {
    expect(installerResponse(blob, meta, request(invalid)).status).toBe(416)
  }
  expect(installerResponse(blob, meta, request('bytes=0-1', 'GET', { 'If-Range': 'obsolete' })).status).toBe(200)
})
