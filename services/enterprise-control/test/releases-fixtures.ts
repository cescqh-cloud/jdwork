import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export const requireDesktop = createRequire(new URL('../../../desktop/package.json', import.meta.url))
export const fixtureFingerprint = 'a'.repeat(64)
export const fixturePublisher = 'Local test-only signer'

export function testExe(marker = 0x43) {
  const bytes = Buffer.alloc(1024, marker)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(128, 60)
  bytes.writeUInt32LE(0x00004550, 128)
  bytes.writeUInt16LE(0xe0, 148)
  bytes.writeUInt16LE(0x0002, 150)
  bytes.writeUInt16LE(0x010b, 152)
  return bytes
}

export function sha256(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex') }
export function sha512(bytes: Uint8Array) { return createHash('sha512').update(bytes).digest('base64') }

export async function builderOutput(directory: string, version: string, marker = 0x43) {
  await mkdir(directory, { recursive: true })
  const bytes = testExe(marker)
  const name = `Fixture Workbench Setup ${version}.exe`
  const file = join(directory, name)
  await writeFile(file, bytes)
  const builder = requireDesktop('app-builder-lib/out/publish/updateInfoBuilder') as {
    createUpdateInfoTasks(input: unknown, publish: unknown[]): Promise<unknown[]>
    writeUpdateInfoFiles(tasks: unknown[], packager: unknown): Promise<void>
  }
  const { Platform } = requireDesktop('app-builder-lib/out/core') as { Platform: { WINDOWS: unknown } }
  const packager = { platform: Platform.WINDOWS, appInfo: { version }, platformSpecificBuildOptions: {}, config: {}, info: {},
    async getResource() { return null }, async emitArtifactCreated() {} }
  const tasks = await builder.createUpdateInfoTasks({ file, target: { outDir: directory }, packager,
    updateInfo: { size: bytes.length, sha512: sha512(bytes) } }, [{ provider: 'generic', url: 'http://127.0.0.1/' }])
  await builder.writeUpdateInfoFiles(tasks, packager)
  const manifest = Buffer.from(await Bun.file(join(directory, 'latest.yml')).arrayBuffer())
  return { bytes, name, manifest }
}
