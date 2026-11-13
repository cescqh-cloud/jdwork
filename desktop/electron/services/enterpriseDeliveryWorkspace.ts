import { execFile } from 'node:child_process'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { constants, watch, type FSWatcher } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { EnterpriseDeliveryIssue, EnterpriseDeliveryTask } from '../../src/lib/desktopHost/enterpriseDelivery'

const gitSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const sessionRef = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u
const filesLimit = 8
const textLimit = 8192
const payloadLimit = 12_288
export const deliveryMaterialExtensions = ['.md', '.txt', '.yaml', '.yml', '.json', '.sql', '.js', '.jsx', '.ts', '.tsx', '.java', '.py'] as const
const extensions = new Set<string>(deliveryMaterialExtensions)
const excluded = new Set(['.git', '.svn', '.env', '.ssh', '.aws', '.claude', '.codex', 'node_modules'])

export class DeliveryWorkspaceError extends Error {
  constructor(readonly issue: EnterpriseDeliveryIssue) { super(issue) }
}

type LocalAccess = { serverUrl: string; token: string }
export type DeliveryPickers = {
  directory: () => Promise<string | null>
  files: (root: string) => Promise<string[] | null>
}
export type DeliveryFile = { path: string; text: string }
type BindingIdentity = { origin: string; deviceId: string; privateKey: string }
type Worktree = { workDir: string; gitRevision: string }
type LocalSession = { sessionId: string; workDir: string }

const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
function inside(root: string, candidate: string) {
  const path = relative(canonical(root), canonical(candidate))
  return Boolean(path) && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
}

function git(workDir: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) {
    delete (env as NodeJS.ProcessEnv)[key]
  }
  return new Promise((resolveResult, reject) => {
    execFile('git', ['-C', workDir, '-c', 'core.fsmonitor=false', ...args], {
      env, encoding: 'utf8', maxBuffer: 16_384, timeout: 5000, windowsHide: true,
    }, (error, stdout) => error ? reject(new DeliveryWorkspaceError('repository')) : resolveResult(stdout.trim()))
  })
}

export async function inspectDeliveryWorktree(path: string): Promise<Worktree> {
  if (!isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path)) throw new DeliveryWorkspaceError('repository')
  try {
    const workDir = await realpath(path)
    if (!(await stat(workDir)).isDirectory()) throw new DeliveryWorkspaceError('repository')
    const lines = (await git(workDir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])).split(/\r?\n/u)
    if (lines.length !== 3) throw new DeliveryWorkspaceError('repository')
    const [root, gitDir, commonDir] = await Promise.all(lines.map(value => realpath(value)))
    if (!root || !gitDir || !commonDir || canonical(root) !== canonical(workDir) || !inside(join(commonDir, 'worktrees'), gitDir)) {
      throw new DeliveryWorkspaceError('repository')
    }
    const gitRevision = await git(workDir, ['rev-parse', '--verify', 'HEAD'])
    if (!gitSha.test(gitRevision)) throw new DeliveryWorkspaceError('repository')
    return { workDir, gitRevision }
  } catch (error) {
    throw error instanceof DeliveryWorkspaceError ? error : new DeliveryWorkspaceError('repository')
  }
}

function rootTag(workDir: string, identity: BindingIdentity) {
  return createHmac('sha256', identity.privateKey).update(JSON.stringify(['delivery-root-v1', canonical(workDir)])).digest('hex').slice(0, 32)
}

function attestation(task: EnterpriseDeliveryTask, identity: BindingIdentity, sessionId: string, gitRevision: string, tag: string) {
  return createHmac('sha256', identity.privateKey).update(JSON.stringify([
    'delivery-binding-v1', identity.origin, identity.deviceId, task.id, task.projectId, task.approvedVersionId, sessionId, gitRevision, tag,
  ])).digest('hex')
}

export function deliveryBindingRef(task: EnterpriseDeliveryTask, identity: BindingIdentity, session: LocalSession, gitRevision: string) {
  const tag = rootTag(session.workDir, identity)
  return `w-${tag}.${attestation(task, identity, session.sessionId, gitRevision, tag)}`
}

export function trustedDeliveryBinding(task: EnterpriseDeliveryTask, identity: BindingIdentity) {
  const binding = task.binding
  const match = /^w-([a-f0-9]{32})\.([a-f0-9]{64})$/u.exec(binding?.worktreeId ?? '')
  if (!binding || binding.deviceId !== identity.deviceId || !match) throw new DeliveryWorkspaceError('missingLocalWorkspace')
  const tag = match[1]!
  const expected = attestation(task, identity, binding.sessionId, binding.gitRevision, tag)
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(match[2]!, 'hex'))) throw new DeliveryWorkspaceError('missingLocalWorkspace')
  return { binding, tag }
}

export function confirmDeliveryWorktree(task: EnterpriseDeliveryTask, identity: BindingIdentity, actual: Worktree) {
  const { binding, tag } = trustedDeliveryBinding(task, identity)
  if (tag !== rootTag(actual.workDir, identity)) throw new DeliveryWorkspaceError('missingLocalWorkspace')
  if (binding.gitRevision !== actual.gitRevision) throw new DeliveryWorkspaceError('worktreeChanged')
}

export async function readDeliveryMaterials(root: string, paths: string[]): Promise<DeliveryFile[]> {
  if (!paths.length || paths.length > filesLimit) throw new DeliveryWorkspaceError('invalidMaterial')
  const result: DeliveryFile[] = []
  const seen = new Set<string>()
  try {
    for (const selected of paths) {
      if (!isAbsolute(selected) || !inside(root, selected)) throw new DeliveryWorkspaceError('invalidMaterial')
      const file = await realpath(selected)
      if (canonical(file) !== canonical(selected) || !inside(root, file) || !extensions.has(extname(file).toLowerCase())) {
        throw new DeliveryWorkspaceError('invalidMaterial')
      }
      const path = relative(root, file).split(sep).join('/')
      const parts = path.split('/')
      if (!/^[\p{L}\p{N}_. -]+(?:\/[\p{L}\p{N}_. -]+)*$/u.test(path) || path.length > 180 ||
        parts.some(part => part === '.' || part === '..' || part !== part.trim() || excluded.has(part.toLowerCase()) ||
          part.toLowerCase().startsWith('.env.')) ||
        seen.has(path.toLowerCase())) throw new DeliveryWorkspaceError('invalidMaterial')
      const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const handle = await open(file, flags)
      try {
        const before = await handle.stat()
        const resolved = await stat(file)
        if (!before.isFile() || before.size > payloadLimit || before.dev !== resolved.dev || before.ino !== resolved.ino ||
          await realpath(selected) !== file) throw new DeliveryWorkspaceError('invalidMaterial')
        const bytes = Buffer.alloc(payloadLimit + 1)
        const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0)
        const after = await handle.stat()
        if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || await realpath(selected) !== file) {
          throw new DeliveryWorkspaceError('materialConflict')
        }
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead))
        if (text.length > textLimit || text.includes('\u0000')) throw new DeliveryWorkspaceError('invalidMaterial')
        result.push({ path, text })
        seen.add(path.toLowerCase())
      } finally { await handle.close() }
    }
  } catch (error) {
    throw error instanceof DeliveryWorkspaceError ? error : new DeliveryWorkspaceError('invalidMaterial')
  }
  if (Buffer.byteLength(JSON.stringify({ files: result, selectionReceipt: 'x'.repeat(86) }), 'utf8') > payloadLimit) {
    throw new DeliveryWorkspaceError('invalidMaterial')
  }
  return result
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
export const deliveryManifest = (files: DeliveryFile[]) => files.map(file => ({ path: file.path, sha256: sha256(file.text) }))

export function deliveryMaterialChecksum(files: readonly { path: string, sha256: string }[]) {
  return sha256(JSON.stringify([...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map(file => [file.path, file.sha256])))
}

export function deliverySelectionPayload(task: EnterpriseDeliveryTask, checksum: string) {
  const binding = task.binding
  if (!binding) throw new DeliveryWorkspaceError('missingLocalWorkspace')
  return ['delivery-material-selection-v1', binding.deviceId, task.id, task.approvedVersionId, binding.id, binding.gitRevision, checksum]
}

export function deliveryCheckKey(task: EnterpriseDeliveryTask, checksum: string) {
  const chars = sha256(JSON.stringify([task.id, task.binding?.id, task.revision, checksum]))
  return `${chars.slice(0, 8)}-${chars.slice(8, 12)}-4${chars.slice(13, 16)}-8${chars.slice(17, 20)}-${chars.slice(20, 32)}`
}

export async function readStableDeliveryMaterials(root: string, paths: string[], signal?: AbortSignal) {
  signal?.throwIfAborted()
  const first = await readDeliveryMaterials(root, paths)
  await sleep(350, undefined, { signal })
  const files = await readDeliveryMaterials(root, paths)
  const checksum = deliveryMaterialChecksum(deliveryManifest(files))
  if (deliveryMaterialChecksum(deliveryManifest(first)) !== checksum ||
    await git(root, ['--literal-pathspecs', 'ls-files', '--unmerged', '--', ...files.map(file => file.path)])) {
    throw new DeliveryWorkspaceError('materialConflict')
  }
  signal?.throwIfAborted()
  return { files, checksum }
}

export function watchDeliveryMaterials(paths: string[], refresh: () => Promise<void>) {
  const directories = new Map<string, Set<string>>()
  for (const path of paths) {
    const parent = dirname(path)
    const names = directories.get(parent) ?? new Set<string>()
    names.add(basename(canonical(path)))
    directories.set(parent, names)
  }
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let pending = false
  function schedule() {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (stopped) return
      if (running) { pending = true; return }
      running = true
      void refresh().catch(() => {}).finally(() => {
        running = false
        if (pending) { pending = false; schedule() }
      })
    }, 350)
    timer.unref()
  }
  const watchers: FSWatcher[] = []
  for (const [parent, names] of directories) {
    try {
      const watcher = watch(parent, { persistent: false }, (_event, file) => {
        if (file === null || names.has(basename(canonical(file.toString())))) schedule()
      })
      watcher.on('error', schedule)
      watchers.push(watcher)
    } catch { /* The periodic check also covers a moved or recreated directory. */ }
  }
  const periodic = setInterval(schedule, 15_000)
  periodic.unref()
  schedule()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    clearInterval(periodic)
    for (const watcher of watchers) watcher.close()
  }
}

async function localJson(fetchLocal: typeof fetch, access: LocalAccess | null, path: string, body?: { workDir: string; permissionMode: 'default' }) {
  if (!access) throw new DeliveryWorkspaceError('session')
  try {
    const origin = new URL(access.serverUrl)
    if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) || origin.pathname !== '/' ||
      origin.username || origin.password || origin.search || origin.hash) throw new DeliveryWorkspaceError('session')
    const response = await fetchLocal(new URL(path, origin), {
      method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store',
      headers: { Authorization: `Bearer ${access.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new DeliveryWorkspaceError('session')
    }
    const reader = response.body.getReader()
    try {
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 131_072) {
          void reader.cancel().catch(() => {})
          throw new DeliveryWorkspaceError('session')
        }
        chunks.push(value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } finally { reader.releaseLock() }
  } catch { throw new DeliveryWorkspaceError('session') }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createDeliveryWorkspace(getAccess: () => LocalAccess | null, pickers: DeliveryPickers, fetchLocal = fetch) {
  return {
    pickDirectory: pickers.directory,
    pickFiles: pickers.files,
    async createSession(workDir: string): Promise<LocalSession> {
      const value = await localJson(fetchLocal, getAccess(), '/api/sessions', { workDir, permissionMode: 'default' })
      if (!isRecord(value) || typeof value.sessionId !== 'string' || !sessionRef.test(value.sessionId) ||
        typeof value.workDir !== 'string' || canonical(value.workDir) !== canonical(workDir)) throw new DeliveryWorkspaceError('session')
      return { sessionId: value.sessionId, workDir }
    },
    async worktreeForSession(sessionId: string): Promise<Worktree> {
      if (!sessionRef.test(sessionId)) throw new DeliveryWorkspaceError('session')
      const value = await localJson(fetchLocal, getAccess(), `/api/sessions/${encodeURIComponent(sessionId)}/inspection?statusOnly=1`)
      if (!isRecord(value) || !isRecord(value.status) || value.status.sessionId !== sessionId || typeof value.status.workDir !== 'string') {
        throw new DeliveryWorkspaceError('missingLocalWorkspace')
      }
      return inspectDeliveryWorktree(value.status.workDir)
    },
  }
}

export type DeliveryWorkspace = ReturnType<typeof createDeliveryWorkspace>
