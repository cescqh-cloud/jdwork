import { join } from 'node:path'
import {
  enterpriseDeliveryResponses, type EnterpriseDeliveryRequest, type EnterpriseDeliveryResult,
  type EnterpriseDeliveryRun, type EnterpriseDeliveryTask,
} from '../../src/lib/desktopHost/enterpriseDelivery'
import { deliveryBindRoute, deliveryCheckRoute, deliveryFixDraft, deliveryMaterialsRoute, deliveryRoute } from './enterpriseDeliveryRouting'
import {
  confirmDeliveryWorktree, deliveryBindingRef, deliveryCheckKey, deliveryMaterialChecksum, deliverySelectionPayload, DeliveryWorkspaceError,
  inspectDeliveryWorktree, readStableDeliveryMaterials, trustedDeliveryBinding, watchDeliveryMaterials, type DeliveryWorkspace,
} from './enterpriseDeliveryWorkspace'

type Identity = { origin: string; deviceId: string; privateKey: string }
type Route = ReturnType<typeof deliveryRoute>
type Request = (route: Route) => Promise<unknown>
type Local = Extract<EnterpriseDeliveryRequest, { action: 'bind' | 'open' | 'check' | 'fix' | 'verify' | 'recheck' | 'watch' }>
type Snapshot = Awaited<ReturnType<typeof readStableDeliveryMaterials>>
type Session = Awaited<ReturnType<DeliveryWorkspace['createSession']>>
type Monitor = { id: string; deviceId: string; bindingId: string; controller: AbortController; close: () => void }
type Dependencies = {
  identity(): Promise<Identity | null>
  userId(): string | undefined
  request(route: Route, deviceId?: string): Promise<unknown>
  sign(privateKey: string, payload: string[]): string
}
type LocalContext = { request: Request; identity: Identity; workspace: DeliveryWorkspace }

function parseTask(value: unknown, id: string) {
  const result = enterpriseDeliveryResponses.get.safeParse(value)
  if (!result.success || result.data.id !== id) throw new DeliveryWorkspaceError('unavailable')
  return result.data
}

function rendererReport(run: EnterpriseDeliveryRun) {
  const { selectionReceipt, ...view } = run
  return { ...view, canReuseMaterials: Boolean(selectionReceipt) }
}

export class EnterpriseDeliveryCoordinator {
  private monitor: Monitor | null = null
  private repairs = new Map<string, { scope: string; session: Promise<Session> }>()

  constructor(private readonly dependencies: Dependencies) {}

  stop(id?: string) {
    if (!id) this.repairs.clear()
    if (!this.monitor || (id && this.monitor.id !== id)) return
    const monitor = this.monitor
    this.monitor = null
    monitor.controller.abort()
    monitor.close()
  }

  private taskView(task: EnterpriseDeliveryTask) {
    const monitor = this.monitor
    return { ...task, automaticRecheck: Boolean(monitor && monitor.id === task.id && monitor.bindingId === task.binding?.id &&
      monitor.deviceId === task.binding.deviceId) }
  }

  async execute(input: EnterpriseDeliveryRequest, workspace: DeliveryWorkspace): Promise<EnterpriseDeliveryResult> {
    switch (input.action) {
      case 'bind': case 'open': case 'check': case 'fix': case 'verify': case 'recheck': case 'watch':
        return this.local(input, workspace)
      case 'transition':
        if (input.transition.action === 'start_testing') {
          const context = await this.context(workspace)
          const task = await this.currentTask(context, input.id, input.revision)
          const result = await this.verify(context, task, false)
          if (result.task.materials?.state === 'changed') throw new DeliveryWorkspaceError('materialsChanged')
          if (result.task.materials?.state !== 'current') throw new DeliveryWorkspaceError('materialsUnverified')
          const current = parseTask(await context.request(deliveryRoute(input)), input.id)
          return { ok: true, data: this.taskView(current) }
        }
        break
    }
    const response = enterpriseDeliveryResponses[input.action].safeParse(await this.dependencies.request(deliveryRoute(input)))
    if (!response.success) throw new DeliveryWorkspaceError('unavailable')
    if (input.action === 'getCheck') {
      return { ok: true, data: rendererReport(enterpriseDeliveryResponses.getCheck.parse(response.data)) }
    }
    if (input.action === 'get') return { ok: true, data: this.taskView(parseTask(response.data, input.id)) }
    return { ok: true, data: response.data }
  }

  private async context(workspace: DeliveryWorkspace): Promise<LocalContext> {
    const identity = await this.dependencies.identity()
    if (!identity) throw new DeliveryWorkspaceError('unbound')
    return { identity, request: route => this.dependencies.request(route, identity.deviceId), workspace }
  }

  private async currentTask(context: LocalContext, id: string, revision?: number) {
    const task = parseTask(await context.request(deliveryRoute({ action: 'get', id })), id)
    if (revision !== undefined && task.revision !== revision) throw new DeliveryWorkspaceError('conflict')
    if (task.assigneeId !== this.dependencies.userId()) throw new DeliveryWorkspaceError('forbidden')
    return task
  }

  private async readRun(context: LocalContext, task: EnterpriseDeliveryTask, id: string) {
    const run = enterpriseDeliveryResponses.getCheck.safeParse(await context.request(deliveryRoute({ action: 'getCheck', id: task.id, runId: id })))
    if (!run.success || run.data.id !== id || run.data.bindingId !== task.binding?.id ||
      run.data.approvedVersionId !== task.approvedVersionId || run.data.snapshotHash !== task.snapshotHash) throw new DeliveryWorkspaceError('conflict')
    return run.data
  }

  private async local(input: Local, workspace: DeliveryWorkspace): Promise<EnterpriseDeliveryResult> {
    if (input.action === 'watch' && !input.enabled) this.stop(input.id)
    const context = await this.context(workspace)
    const task = await this.currentTask(context, input.id, input.action === 'watch' && !input.enabled ? undefined : input.revision)
    if (input.action === 'watch' && !input.enabled) return { ok: true, data: { task: this.taskView(task), run: null } }
    if (!task.canAdvance && input.action !== 'open') throw new DeliveryWorkspaceError('forbidden')
    if (input.action === 'bind') {
      if (!task.permissions.bind) throw new DeliveryWorkspaceError('forbidden')
      const selected = await workspace.pickDirectory()
      if (!selected) return { ok: false, issue: 'cancelled' }
      this.stop(task.id)
      const tree = await inspectDeliveryWorktree(selected)
      await this.currentTask(context, task.id, task.revision)
      const session = await workspace.createSession(tree.workDir)
      const refs = { sessionId: session.sessionId, gitRevision: tree.gitRevision,
        worktreeId: deliveryBindingRef(task, context.identity, session, tree.gitRevision) }
      const bound = parseTask(await context.request(deliveryBindRoute(task.id, task.revision, refs)), task.id)
      if (bound.binding?.sessionId !== refs.sessionId || bound.binding.worktreeId !== refs.worktreeId ||
        bound.binding.gitRevision !== refs.gitRevision || bound.binding.deviceId !== context.identity.deviceId) throw new DeliveryWorkspaceError('unavailable')
      return { ok: true, data: { task: this.taskView(bound), ...session } }
    }
    if (input.action === 'verify' || input.action === 'recheck' || input.action === 'watch') {
      const result = await this.verify(context, task, input.action === 'recheck')
      if (input.action === 'watch') this.startMonitor(context, result.task, result.paths)
      return { ok: true, data: { task: this.taskView(result.task), run: rendererReport(result.run) } }
    }
    const { binding } = trustedDeliveryBinding(task, context.identity)
    const tree = await workspace.worktreeForSession(binding.sessionId)
    confirmDeliveryWorktree(task, context.identity, tree)
    if (input.action === 'open') {
      await this.currentTask(context, task.id, task.revision)
      return { ok: true, data: { task: this.taskView(task), sessionId: binding.sessionId, workDir: tree.workDir } }
    }
    if (!task.permissions.submitChecks) throw new DeliveryWorkspaceError('forbidden')
    if (input.action === 'check') {
      const selected = await workspace.pickFiles(tree.workDir)
      if (!selected) return { ok: false, issue: 'cancelled' }
      this.stop(task.id)
      await this.currentTask(context, task.id, task.revision)
      const snapshot = await readStableDeliveryMaterials(tree.workDir, selected)
      const result = await this.submit(context, task, tree.workDir, selected, snapshot, input.idempotencyKey)
      return { ok: true, data: { task: this.taskView(result.task), run: rendererReport(result.run) } }
    }
    if (task.latestRunId !== input.runId) throw new DeliveryWorkspaceError('conflict')
    const run = await this.readRun(context, task, input.runId)
    if (run.selectionReceipt) {
      const current = await this.verify(context, task, false)
      if (current.run.stale) throw new DeliveryWorkspaceError('materialsChanged')
    }
    const draftText = deliveryFixDraft(run, input.ruleId)
    if (!draftText) throw new DeliveryWorkspaceError('conflict')
    await this.currentTask(context, task.id, task.revision)
    confirmDeliveryWorktree(task, context.identity, await inspectDeliveryWorktree(tree.workDir))
    const session = await this.repairSession(context, task, tree.workDir)
    return { ok: true, data: { task: this.taskView(task), ...session, draftText } }
  }

  private async repairSession(context: LocalContext, task: EnterpriseDeliveryTask, workDir: string) {
    const path = process.platform === 'win32' ? workDir.toLowerCase() : workDir
    const scope = `${context.identity.deviceId}|${task.id}`
    const existing = this.repairs.get(path)
    if (existing) {
      if (existing.scope !== scope) throw new DeliveryWorkspaceError('materialConflict')
      return existing.session
    }
    const session = context.workspace.createSession(workDir)
    this.repairs.set(path, { scope, session })
    try { return await session } catch (error) { this.repairs.delete(path); throw error }
  }

  private async sample(context: LocalContext, task: EnterpriseDeliveryTask, root: string, paths: string[], signal?: AbortSignal) {
    confirmDeliveryWorktree(task, context.identity, await inspectDeliveryWorktree(root))
    const snapshot = await readStableDeliveryMaterials(root, paths, signal)
    confirmDeliveryWorktree(task, context.identity, await inspectDeliveryWorktree(root))
    return snapshot
  }

  private async observe(context: LocalContext, task: EnterpriseDeliveryTask, run: EnterpriseDeliveryRun, checksum: string | null, signal?: AbortSignal) {
    signal?.throwIfAborted()
    return parseTask(await context.request(deliveryMaterialsRoute(task.id, task.revision, run.id, checksum)), task.id)
  }

  private async submit(context: LocalContext, task: EnterpriseDeliveryTask, root: string, paths: string[], snapshot: Snapshot,
    requestId?: string, signal?: AbortSignal) {
    confirmDeliveryWorktree(task, context.identity, await inspectDeliveryWorktree(root))
    const receipt = this.dependencies.sign(context.identity.privateKey, deliverySelectionPayload(task, snapshot.checksum))
    signal?.throwIfAborted()
    const route = deliveryCheckRoute(task.id, task.revision, snapshot.files, receipt, requestId ?? deliveryCheckKey(task, snapshot.checksum))
    const result = enterpriseDeliveryResponses.check.safeParse(await context.request(route))
    if (!result.success || result.data.task.id !== task.id || result.data.run.bindingId !== task.binding?.id ||
      result.data.run.id !== result.data.task.latestRunId || result.data.run.selectionReceipt !== receipt) throw new DeliveryWorkspaceError('unavailable')
    const { task: submitted, run } = result.data
    let current: Snapshot | undefined
    try { current = await this.sample(context, submitted, root, paths, signal) } catch (error) {
      if (signal?.aborted || !(error instanceof DeliveryWorkspaceError)) throw error
    }
    const observed = await this.observe(context, submitted, run, current?.checksum ?? null, signal)
    return { task: observed, run: { ...run, stale: run.stale || observed.materials?.state === 'changed' } }
  }

  private async verify(context: LocalContext, task: EnterpriseDeliveryTask, recheck: boolean, signal?: AbortSignal) {
    if (!task.canAdvance) throw new DeliveryWorkspaceError('forbidden')
    if (!task.latestRunId) throw new DeliveryWorkspaceError('materialsUnverified')
    const { binding } = trustedDeliveryBinding(task, context.identity)
    const run = await this.readRun(context, task, task.latestRunId)
    const checksum = deliveryMaterialChecksum(run.files)
    const signature = this.dependencies.sign(context.identity.privateKey, deliverySelectionPayload(task, checksum))
    if (!run.selectionReceipt || run.selectionReceipt !== signature || !run.files.length) throw new DeliveryWorkspaceError('materialsUnverified')
    if (run.stale && task.materials?.state !== 'changed') throw new DeliveryWorkspaceError('materialsChanged')
    const tree = await context.workspace.worktreeForSession(binding.sessionId)
    const paths = run.files.map(file => join(tree.workDir, ...file.path.split('/')))
    let snapshot: Snapshot | undefined
    let problem: DeliveryWorkspaceError | undefined
    try { snapshot = await this.sample(context, task, tree.workDir, paths, signal) } catch (error) {
      if (signal?.aborted || !(error instanceof DeliveryWorkspaceError)) throw error
      problem = error
    }
    const observed = await this.observe(context, task, run, snapshot?.checksum ?? null, signal)
    if (problem) throw problem
    if (snapshot && recheck && observed.materials?.state === 'changed' && observed.permissions.submitChecks) {
      return { ...await this.submit(context, observed, tree.workDir, paths, snapshot, undefined, signal), paths }
    }
    return { task: observed, run: { ...run, stale: run.stale || observed.materials?.state === 'changed' }, paths }
  }

  private startMonitor(context: LocalContext, task: EnterpriseDeliveryTask, paths: string[]) {
    const bindingId = task.binding?.id
    if (!bindingId) throw new DeliveryWorkspaceError('missingLocalWorkspace')
    if (this.monitor) this.stop(this.monitor.id)
    const controller = new AbortController()
    const refresh = async () => {
      try {
        const current = await this.currentTask(context, task.id)
        controller.signal.throwIfAborted()
        if (current.binding?.id !== bindingId) throw new DeliveryWorkspaceError('missingLocalWorkspace')
        await this.verify(context, current, true, controller.signal)
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof DeliveryWorkspaceError &&
          ['forbidden', 'notFound', 'unbound', 'missingLocalWorkspace', 'worktreeChanged', 'materialsUnverified', 'materialsChanged'].includes(error.issue)) this.stop(task.id)
      }
    }
    this.monitor = { id: task.id, deviceId: context.identity.deviceId, bindingId, controller, close: watchDeliveryMaterials(paths, refresh) }
  }
}
