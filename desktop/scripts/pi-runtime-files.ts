import { cp } from 'node:fs/promises'
import { relative, sep } from 'node:path'

const typescriptLocales = ['cs', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'zh-cn', 'zh-tw']
const excluded = new Set([
  // The staging build compiles TypeScript before copying runtime dependencies.
  ...typescriptLocales.map(locale => `typescript/lib/${locale}`),
  'typescript/bin/tsserver',
  'typescript/lib/_tsserver.js',
  'typescript/lib/tsserver.js',
  'typescript/lib/tsserverlibrary.js',
  // Import workers use the Node entry, which does not load these browser bundles.
  'officeparser/dist/officeparser.browser.mjs',
  'officeparser/dist/officeparser.browser.iife.js',
  'officeparser/dist/officeparser.browser.slim.mjs',
  'officeparser/dist/officeparser.browser.slim.iife.js',
  'officeparser/dist/officeparser.browser.native-pdf.mjs',
  // OfficeParser loads PDF.js legacy code and its worker. Keep their executable files and assets.
  'pdfjs-dist/types',
  ...['build', 'legacy/build'].flatMap(directory =>
    ['pdf', 'pdf.worker', 'pdf.sandbox'].map(name => `pdfjs-dist/${directory}/${name}.mjs.map`),
  ),
])

export async function copyPiRuntimeDependencies(source: string, destination: string) {
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: entry => !excluded.has(relative(source, entry).split(sep).join('/')),
  })
}
