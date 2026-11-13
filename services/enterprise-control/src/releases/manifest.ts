import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { ControlError } from '../contract'
import { artifactName, maxArtifactBytes, releaseVersion, sha512 } from './contract'

export const manifestLimit = 65_536
const file = z.strictObject({ url: artifactName, sha512, size: z.number().int().min(1).max(maxArtifactBytes),
  blockMapSize: z.number().int().positive().optional(), isAdminRightsRequired: z.boolean().optional() })
const manifest = z.strictObject({ version: releaseVersion, files: z.array(file).length(1), path: artifactName.optional(), sha512: sha512.optional(),
  releaseName: z.string().max(200).nullable().optional(), releaseNotes: z.union([z.string().max(28_000),
    z.array(z.strictObject({ version: releaseVersion, note: z.string().max(4000).nullable() })).max(30), z.null()]).optional(),
  releaseDate: z.iso.datetime({ offset: true }), minimumSystemVersion: z.string().regex(/^\d{1,5}(?:\.\d{1,6}){1,3}$/u).optional(),
  sha2: z.string().regex(/^[a-f0-9]{64}$/iu).optional(), packages: z.null().optional(),
})

export interface BuilderManifest { bytes: Uint8Array, manifestSha256: string, version: string, name: string, size: number, sha512: string, legacySha256?: string }

function invalid() {
  return new ControlError(400, 'UPDATE_MANIFEST_INVALID', 'Upload the original electron-builder 26 Windows NSIS latest.yml for one complete installer.')
}

export function validateBuilderManifest(bytes: Uint8Array, expectedVersion: string, limit: number): BuilderManifest {
  if (!bytes.byteLength || bytes.byteLength > manifestLimit) throw invalid()
  let parsed: z.infer<typeof manifest>
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const doc = parseDocument(text, { schema: 'core', strict: true, uniqueKeys: true, merge: false })
    if (doc.errors.length || doc.warnings.length) throw invalid()
    parsed = manifest.parse(doc.toJS({ maxAliasCount: 0 }))
  } catch { throw invalid() }
  const installer = parsed.files[0]!
  if (parsed.version !== expectedVersion || (parsed.path && parsed.path !== installer.url) ||
      (parsed.sha512 && parsed.sha512 !== installer.sha512) || installer.size > limit) throw invalid()
  return { bytes, manifestSha256: createHash('sha256').update(bytes).digest('hex'), version: parsed.version,
    name: installer.url, size: installer.size, sha512: installer.sha512, legacySha256: parsed.sha2?.toLowerCase() }
}

export async function readManifestBody(body: ReadableStream<Uint8Array> | null) {
  if (!body) throw invalid()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > manifestLimit) throw new ControlError(413, 'UPDATE_MANIFEST_TOO_LARGE', 'The update manifest exceeds 64 KiB.')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}
