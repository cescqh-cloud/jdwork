import { createHash, createPublicKey } from 'node:crypto'
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { normalizeEnvironmentDefaults, normalizeWorkbenchOrigin, WORKBENCH_APP_ID, WORKBENCH_NAME } from '../electron/pi-workbench-policy'
import { copyPiRuntimeDependencies } from './pi-runtime-files'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(desktop, '..')
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: 'string', default: 'renderer' },
    version: { type: 'string', default: '0.1.0' },
    server: { type: 'string' },
    'intranet-http': { type: 'boolean', default: false },
    'device-runtime': { type: 'string' },
    'client-runtime': { type: 'string' },
    'release-key': { type: 'string' },
    'environment-name': { type: 'string' },
    'environment-url': { type: 'string' },
    'mini-program-api': { type: 'string' },
    'ui-dir': { type: 'string' },
    unsigned: { type: 'boolean', default: false },
  },
})
const licenses = ['LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES.md']
// Extracted from the hash-verified cc-haha 0.7.7 Windows x64 release.
const deviceRuntimeFiles = [
  ['agent-desktop.exe', 3525632, '2ff9c1fa525e492553e975ff27405d7aa4c0482967cc1edaea8a0787dac7e5ce'],
  ['agent-desktop-manifest.json', 194, '3a83a3bc08b98db7d2f0457db6ae201c7741e48d1f2a8c06abb1dc436255fbaf'],
  ['agent-desktop-licenses/LICENSE', 11560, '3ddf9be5c28fe27dad143a5dc76eea25222ad1dd68934a047064e56ed2fa40c5'],
  ['agent-desktop-licenses/NOTICE', 991, 'b0ce0dc57d8c1884bdbc3364a54ec2b5d5ad74ebdbaad38ae4a9b77a819bbf45'],
  ['agent-desktop-licenses/PATCHES.md', 4717, 'c63e252107c0bc3568b66d222bb68980b515ecf0144164eebcf6f6527e24328d'],
  ['agent-desktop-licenses/THIRD-PARTY-NOTICES', 1686836, '52d2f701205313c5e2a9da8449b61722643b9e56f32eb9032bff996371825646'],
  ['agent-desktop-licenses/UPSTREAM.json', 371070, 'eedf53802098e17e65c15c01d391b9d23c67a80f71d55b53b78cd61c86cde331'],
] as const
const target = values.target
const version = values.version
if (!['renderer', 'dir', 'installer'].includes(target)) throw new Error('选择 renderer、dir 或 installer。')
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本必须采用 x.y.z 格式。')
const server = values.server?.trim()
const intranetOrigin = values['intranet-http'] && server ? new URL(server).origin : undefined
const origin = server ? normalizeWorkbenchOrigin(server, intranetOrigin) : undefined
if (values['intranet-http'] && (target === 'renderer' || !origin?.startsWith('http://'))) {
  throw new Error('--intranet-http 需要 Windows 构建和内网 HTTP 服务器地址。')
}
const deviceRuntime = values['device-runtime']
if (deviceRuntime !== undefined && (target === 'renderer' || !deviceRuntime.trim())) {
  throw new Error('--device-runtime 需要 Windows 构建和原生资源目录。')
}
const clientRuntime = values['client-runtime']
if (clientRuntime !== undefined && (target === 'renderer' || !clientRuntime.trim())) {
  throw new Error('--client-runtime 需要 Windows 构建和 Pi 工作台源码目录。')
}
const environmentUrl = values['environment-url']
const environmentName = values['environment-name']
const miniProgramApiUrl = values['mini-program-api']
if (Boolean(environmentUrl) !== Boolean(environmentName)
  || ((environmentUrl !== undefined || environmentName !== undefined || miniProgramApiUrl !== undefined) && !clientRuntime)) {
  throw new Error('预设环境需要 Windows 用户端，网页环境名称和地址需要一并提供。')
}
const environmentDefaults = normalizeEnvironmentDefaults({
  environment: environmentUrl === undefined ? undefined : { name: environmentName, url: environmentUrl },
  miniProgramApiUrl,
})
const releaseKey = values['release-key']?.trim()
if (releaseKey !== undefined) {
  const der = Buffer.from(releaseKey, 'base64')
  if (!clientRuntime || der.toString('base64') !== releaseKey
    || createPublicKey({ key: der, format: 'der', type: 'spki' }).asymmetricKeyType !== 'ed25519') {
    throw new Error('--release-key 需要 Windows 用户端与 Base64 Ed25519 发布公钥。')
  }
}

async function stageDeviceRuntime(source: string, destination: string) {
  for (const [relativePath, size, expectedHash] of deviceRuntimeFiles) {
    const input = join(source, relativePath)
    const info = await lstat(input)
    if (!info.isFile() || info.size !== size) throw new Error(`原生资源文件大小不符合官方 Windows x64 发布：${relativePath}`)
    const data = await readFile(input)
    if (createHash('sha256').update(data).digest('hex') !== expectedHash) {
      throw new Error(`原生资源 SHA-256 校验失败：${relativePath}`)
    }
    if (relativePath === 'agent-desktop.exe') {
      const peOffset = data.readUInt32LE(0x3c)
      if (data.readUInt16LE(0) !== 0x5a4d || peOffset > data.length - 6
        || data.readUInt32LE(peOffset) !== 0x00004550 || data.readUInt16LE(peOffset + 4) !== 0x8664) {
        throw new Error('Computer Use 运行时必须是 Windows x64 可执行文件。')
      }
    }
    const output = join(destination, relativePath)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, data)
  }
}

async function run(args: string[], cwd = desktop) {
  const child = Bun.spawn(args, { cwd, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' })
  const code = await child.exited
  if (code !== 0) throw new Error(`构建命令失败（${code}）`)
}

async function buildRenderer(destination: string) {
  await run(['node', join(desktop, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.pi-workbench.config.ts'])
  const source = join(desktop, 'dist-pi-workbench')
  await mkdir(destination, { recursive: true })
  await cp(join(source, 'assets'), join(destination, 'assets'), { recursive: true })
  for (const license of licenses) await copyFile(join(repository, license), join(destination, license))
  await copyFile(join(source, 'pi-workbench.html'), join(destination, 'pi-workbench.html'))
}

async function stageClientRuntime(source: string, destination: string) {
  await run(['node', join(source, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], source)
  await mkdir(join(destination, 'config'), { recursive: true })
  await mkdir(join(destination, 'workspace'), { recursive: true })
  await mkdir(join(destination, 'public'), { recursive: true })
  for (const directory of ['dist', 'skills']) {
    await cp(join(source, directory), join(destination, directory), { recursive: true, verbatimSymlinks: true })
  }
  await copyPiRuntimeDependencies(join(source, 'node_modules'), join(destination, 'node_modules'))
  for (const file of ['package.json', 'config/project.json', 'workspace/AGENTS.md']) {
    await copyFile(join(source, file), join(destination, file))
  }
  for (const entry of await readdir(join(source, 'public'), { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:html|css|js)$/.test(entry.name)) {
      await copyFile(join(source, 'public', entry.name), join(destination, 'public', entry.name))
    }
  }
  await buildRenderer(join(destination, 'public', 'desktop'))
}

if (target === 'renderer') {
  const destination = resolve(values['ui-dir'] ?? join(repository, '../pi-agent-workbench/public/desktop'))
  await buildRenderer(destination)
  console.log(`PI_WORKBENCH_UI=${destination}`)
} else {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 构建桌面包。')
  const buildRoot = join(desktop, 'build-artifacts', 'pi-workbench')
  await mkdir(buildRoot, { recursive: true })
  const work = await mkdtemp(join(buildRoot, `${version}-`))
  const staging = join(work, 'app')
  const output = join(work, 'output')
  const nativeResources = deviceRuntime ? join(work, 'computer-use') : undefined
  if (nativeResources && deviceRuntime) await stageDeviceRuntime(resolve(deviceRuntime), nativeResources)
  const runtimeResources = clientRuntime ? join(work, 'pi-client-runtime') : undefined
  if (runtimeResources && clientRuntime) await stageClientRuntime(resolve(clientRuntime), runtimeResources)
  await mkdir(staging)
  if (releaseKey) await writeFile(join(staging, 'pi-release-key.txt'), releaseKey)
  if (Object.keys(environmentDefaults).length) {
    await writeFile(join(staging, 'pi-environments-default.json'), JSON.stringify(environmentDefaults))
  }
  const bundle = await Bun.build({
    entrypoints: ['pi-workbench-main.ts', 'pi-workbench-preload.ts'].map(name => join(desktop, 'electron', name)),
    outdir: staging,
    naming: '[name].cjs',
    format: 'cjs',
    target: 'node',
    external: ['electron'],
  })
  if (!bundle.success) throw new Error(bundle.logs.map(log => log.message).join('\n'))
  for (const name of ['html', 'css', 'js']) {
    const file = `pi-workbench-connect.${name}`
    await copyFile(join(desktop, 'build', file), join(staging, file))
  }
  for (const license of licenses) await copyFile(join(repository, license), join(staging, license))
  const nativeNotice = nativeResources ? '包含从 cc-haha 0.7.7 提取的 agent-desktop Windows x64 电脑操作组件。\n' : ''
  await writeFile(join(staging, 'ABOUT.txt'), `${WORKBENCH_NAME}\n包含研发助手、需求文档、记忆和内部版本分发。\n${nativeNotice}\nBased on cc-haha: https://github.com/NanmiCoder/cc-haha\nCopyright (c) 2026 cc-haha\n`)
  if (origin) {
    await writeFile(join(staging, 'pi-server-default.json'), JSON.stringify({
      origin, ...(values['intranet-http'] ? { intranetHttp: true } : {}),
    }))
  }
  await writeFile(join(staging, 'package.json'), JSON.stringify({
    name: 'liyuan-pi-workbench', version, description: WORKBENCH_NAME,
    author: WORKBENCH_NAME, private: true, main: 'pi-workbench-main.cjs',
  }, null, 2))
  const electron = join(desktop, 'node_modules', 'electron')
  const { version: electronVersion } = JSON.parse(await readFile(join(electron, 'package.json'), 'utf8')) as { version: string }
  const builderConfig = join(work, 'electron-builder.json')
  await writeFile(builderConfig, JSON.stringify({
    appId: WORKBENCH_APP_ID,
    productName: WORKBENCH_NAME,
    electronVersion,
    electronDist: join(electron, 'dist'),
    directories: { output },
    files: ['**/*'],
    extraResources: [
      ...(nativeResources ? [{ from: nativeResources, to: 'computer-use' }] : []),
      ...(runtimeResources ? [
        { from: runtimeResources, to: 'pi-client-runtime' },
        // electron-builder skips a file set's root node_modules directory.
        { from: join(runtimeResources, 'node_modules'), to: 'pi-client-runtime/node_modules' },
      ] : []),
    ],
    asar: true,
    npmRebuild: false,
    forceCodeSigning: !values.unsigned,
    win: { target: ['nsis'], signAndEditExecutable: !values.unsigned, executableName: 'PiWorkbench' },
    nsis: {
      artifactName: 'Liyuan-Workbench-${version}-Windows-x64-Setup.exe',
      shortcutName: WORKBENCH_NAME,
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
    },
  }, null, 2))
  await run([
    'node', join(desktop, 'node_modules/electron-builder/out/cli/cli.js'),
    '--projectDir', staging, '--config', builderConfig, '--win', '--x64', '--publish', 'never',
    ...(target === 'dir' ? ['--dir'] : []),
  ])
  console.log(`PI_WORKBENCH_WINDOWS=${output}`)
}
