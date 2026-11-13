// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { copyPiRuntimeDependencies } from './pi-runtime-files'

function readBuildScript() {
  return readFileSync(path.resolve(import.meta.dirname, 'build-pi-workbench.ts'), 'utf8')
}

describe('pi workbench build script', () => {
  it('drops the cc-haha dialogue runtime entirely', () => {
    const script = readBuildScript()
    expect(script).not.toMatch(/cc-haha-runtime/)
    expect(script).not.toMatch(/CC_HAHA_EXECUTABLE/)
    expect(script).not.toMatch(/stageDialogueRuntime/)
    expect(script).not.toMatch(/132934656/)
  })

  it('keeps the computer-use device runtime', () => {
    const script = readBuildScript()
    expect(script).toMatch(/--device-runtime/)
    expect(script).toMatch(/stageDeviceRuntime/)
    expect(script).toMatch(/to: 'computer-use'/)
    expect(script).toMatch(/agent-desktop\.exe/)
  })

  it('copies runtime files while leaving excluded assets in the source only', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pi-runtime-files-'))
    const source = path.join(root, 'original', 'node_modules')
    const destination = path.join(root, 'staged', 'node_modules')
    const kept = [
      'officeparser/dist/index.mjs',
      'officeparser/dist/parsers/PdfParser.js',
      'officeparser/dist/utils/ocrUtils.js',
      'pdfjs-dist/legacy/build/pdf.mjs',
      'pdfjs-dist/legacy/build/pdf.worker.mjs',
      'pdfjs-dist/build/pdf.mjs',
      'pdfjs-dist/standard_fonts/FoxitFixed.pfb',
      'pdfjs-dist/cmaps/UniGB-UCS2-H.bcmap',
      'pdfjs-dist/wasm/openjpeg.wasm',
      'tesseract.js/src/worker-script/node/index.js',
      '@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node',
      'typescript/lib/typescript.js',
      '@earendil-works/pi-coding-agent/dist/index.js',
      '@earendil-works/pi-coding-agent/docs/models.md',
    ]
    const excluded = [
      'officeparser/dist/officeparser.browser.mjs',
      'officeparser/dist/officeparser.browser.iife.js',
      'officeparser/dist/officeparser.browser.slim.mjs',
      'officeparser/dist/officeparser.browser.slim.iife.js',
      'officeparser/dist/officeparser.browser.native-pdf.mjs',
      'pdfjs-dist/build/pdf.worker.mjs.map',
      'pdfjs-dist/legacy/build/pdf.worker.mjs.map',
      'pdfjs-dist/types/src/pdf.d.ts',
      'typescript/lib/zh-cn/diagnosticMessages.generated.json',
      'typescript/lib/tsserver.js',
    ]
    try {
      for (const entry of [...kept, ...excluded]) {
        const file = path.join(source, entry)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, entry)
      }
      await copyPiRuntimeDependencies(source, destination)
      for (const entry of kept) {
        await expect(readFile(path.join(destination, entry), 'utf8')).resolves.toBe(entry)
      }
      for (const entry of excluded) {
        await expect(readFile(path.join(destination, entry), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readFile(path.join(source, entry), 'utf8')).resolves.toBe(entry)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
