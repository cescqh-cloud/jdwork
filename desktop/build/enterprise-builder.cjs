const { execFile } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')

const base = require('../package.json').build
const brand = require('./enterprise-brand.json')
const version = process.env.LIYUAN_DESKTOP_RELEASE_VERSION
const publisherName = process.env.LIYUAN_DESKTOP_SIGNER_PUBLISHER
const trustPath = process.env.LIYUAN_DESKTOP_BUILD_UPDATE_TRUST_FILE
const versionParts = version && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(version)
if (!versionParts || version.length > 96 || versionParts[4]?.split('.').some(part => /^0\d+$/u.test(part)) || !publisherName?.trim() || !trustPath) {
  throw new Error('Set the enterprise release version, signing publisher and build trust file before packaging')
}
const trust = JSON.parse(readFileSync(trustPath, 'utf8'))
if (!/^[a-f0-9]{64}$/u.test(trust?.publisherSha256 ?? '') || !/^[A-Za-z0-9_-]{59}$/u.test(trust?.publicKey ?? '') ||
    !['stable', 'canary', 'dev'].includes(trust?.channel)) throw new Error('Invalid enterprise build trust file')

const windowsVerify = String.raw`
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $env:LIYUAN_PACKAGE_TO_VERIFY
if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or $null -eq $signature.SignerCertificate) { exit 32 }
$hash = [System.Security.Cryptography.SHA256]::Create()
try { [System.BitConverter]::ToString($hash.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() }
finally { $hash.Dispose() }
`

module.exports = {
  ...base,
  appId: brand.appId,
  productName: brand.productName,
  copyright: 'Copyright (c) 2026 cc-haha',
  extraMetadata: { name: brand.name, productName: brand.productName, version },
  extraResources: [
    { from: '../LICENSE', to: 'LICENSE-CC-HAHA.txt' },
    { from: '../NOTICE', to: 'NOTICE-CC-HAHA.txt' },
    { from: '../THIRD_PARTY_LICENSES.md', to: 'THIRD-PARTY-LICENSES.md' },
    { from: 'build/enterprise-notice.txt', to: 'ENTERPRISE-MODIFICATIONS.txt' },
  ],
  forceCodeSigning: true,
  detectUpdateChannel: false,
  win: { ...base.win, executableName: brand.executableName, signtoolOptions: { publisherName } },
  nsis: { ...base.nsis, perMachine: false, packElevateHelper: false, artifactName: 'Liyuan-Workbench-${version}-Windows-${arch}-Setup.${ext}' },
  // The native runtime supplies an authenticated feed for the selected device.
  // This generic origin only tells electron-builder to emit its own latest.yml.
  publish: [{ provider: 'generic', url: 'https://127.0.0.1:1/enterprise-release' }],
  beforePack({ packager }) {
    const { appDir } = packager.info
    const main = readFileSync(path.join(appDir, 'electron-dist', 'main.cjs'), 'utf8')
    const renderer = readFileSync(path.join(appDir, 'dist', 'index.html'), 'utf8')
    const pinned = JSON.stringify({ publicKey: trust.publicKey, publisherSha256: trust.publisherSha256, channel: trust.channel })
    if (!(main.includes(pinned) || main.includes(JSON.stringify(pinned))) ||
        !renderer.includes(`<title>${brand.productName}</title>`)) throw new Error('Build the renderer and Electron main for this enterprise release before packaging')
  },
  async afterAllArtifactBuild(result) {
    const installers = result.artifactPaths.filter(file => /-Setup\.exe$/iu.test(file))
    if (process.platform !== 'win32' || !installers.length) throw new Error('A signed Windows NSIS installer is required')
    const { SystemRoot, TEMP, TMP } = process.env
    const shell = path.join(SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    for (const file of installers) {
      const { stdout } = await promisify(execFile)(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsVerify, 'utf16le').toString('base64')], {
        env: { SystemRoot, TEMP, TMP, LIYUAN_PACKAGE_TO_VERIFY: file }, windowsHide: true, timeout: 90_000, maxBuffer: 4096,
      })
      if (stdout.trim() !== trust.publisherSha256) throw new Error('Installer publisher does not match the enterprise build trust')
    }
    return []
  },
}
