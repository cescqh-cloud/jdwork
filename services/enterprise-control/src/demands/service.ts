import { z } from 'zod'
import { ControlError, tenantSlug } from '../contract'
import type { Actor } from '../store'
import { createDingTalkCallback, type DingTalkCallback, type DingTalkEvent } from './callback'
import { dingTalkId, draftInput, evidenceHash, precheckOutput, redactDemandText, validateDemand, type DemandDraft, type FieldMap,
  type IdentityInput, type PrecheckOutput, type SubmitInput } from './contract'
import { createDingTalkTransport, DingTalkDispatchError, formText, type DingTalkInstance, type DingTalkTransport } from './dingtalk'
import { DemandStore, type InboxRow, type InstanceRow, type SubmissionRow } from './store'

export interface DingTalkConnection { corpId: string, transport: DingTalkTransport, callback?: DingTalkCallback }
export type DemandPrechecker = (input: { actor: Actor, demandId: string, draft: DemandDraft, modelId?: string, signal: AbortSignal }) => Promise<unknown>
export interface DemandServiceOptions { connections: ReadonlyMap<string, DingTalkConnection>, precheck?: DemandPrechecker, now?: () => number }

const noDingTalk = () => new ControlError(503, 'DINGTALK_NOT_CONFIGURED', 'DingTalk OA is not configured for this tenant.')
const marker = /^wb1\.([0-9a-f-]{36})\.([0-9a-f]{64})$/iu
const msPerHour = 60 * 60_000
const isFinal = (state: DingTalkInstance['state']) => ['AGREE', 'REFUSE', 'TERMINATED'].includes(state)
const precheckUnavailable = () => new ControlError(503, 'DEMAND_PRECHECK_UNAVAILABLE', 'The configured AI precheck is unavailable. Retry when a model is available.')

export function loadDingTalkConnections(env: Record<string, string | undefined>): ReadonlyMap<string, DingTalkConnection> {
  const input = {
    tenant: env.ENTERPRISE_DINGTALK_TENANT, corpId: env.ENTERPRISE_DINGTALK_CORP_ID, appKey: env.ENTERPRISE_DINGTALK_APP_KEY,
    appSecret: env.ENTERPRISE_DINGTALK_APP_SECRET, token: env.ENTERPRISE_DINGTALK_CALLBACK_TOKEN,
    encodingAesKey: env.ENTERPRISE_DINGTALK_CALLBACK_AES_KEY, receiverId: env.ENTERPRISE_DINGTALK_CALLBACK_RECEIVER,
  }
  if (!Object.values(input).some(Boolean)) return new Map()
  const parsed = z.object({ tenant: tenantSlug, corpId: dingTalkId, appKey: dingTalkId,
    appSecret: z.string().min(1).max(1024), token: z.string().optional(), encodingAesKey: z.string().optional(),
    receiverId: dingTalkId.optional() }).safeParse(input)
  if (!parsed.success) throw new Error('DingTalk OA server configuration is incomplete or invalid')
  const { tenant, corpId, appKey, appSecret, token, encodingAesKey, receiverId } = parsed.data
  let callback: DingTalkCallback | undefined
  if (token || encodingAesKey || receiverId) {
    if (!token || !encodingAesKey) throw new Error('DingTalk HTTP callback requires both a signature token and an encoding AES key')
    callback = createDingTalkCallback({ token, encodingAesKey, receiverId: receiverId ?? appKey })
  }
  return new Map([[tenant, { corpId, transport: createDingTalkTransport({ appKey, appSecret }), callback }]])
}

function reviewedDraft(draft: DemandDraft): DemandDraft {
  return {
    title: redactDemandText(draft.title), systemKey: redactDemandText(draft.systemKey), category: redactDemandText(draft.category),
    businessContext: redactDemandText(draft.businessContext), expectedValue: redactDemandText(draft.expectedValue),
    acceptanceCriteria: redactDemandText(draft.acceptanceCriteria), priority: redactDemandText(draft.priority), businessOwner: '', attachmentRefs: [],
  }
}

function cleanReview(review: PrecheckOutput): PrecheckOutput {
  return { summary: redactDemandText(review.summary).slice(0, 2400), questions: review.questions.map(text => redactDemandText(text).slice(0, 500)),
    risks: review.risks.map(text => redactDemandText(text).slice(0, 500)) }
}

function mappedDraft(mapping: FieldMap, instance: DingTalkInstance) {
  const fields = {} as Record<string, unknown>
  let complete = true
  for (const key of Object.keys(draftInput.shape) as Array<keyof DemandDraft>) {
    const field = mapping[key]
    const raw = field ? formText(instance.form, field) : undefined
    if (raw === undefined) continue
    let value: unknown = raw
    if (key === 'attachmentRefs') {
      try { value = JSON.parse(raw) } catch { complete = false; continue }
    }
    const parsed = draftInput.shape[key].safeParse(value)
    if (parsed.success) fields[key] = parsed.data
    else complete = false
  }
  const mapped = draftInput.parse(fields)
  const missing = validateDemand(mapped).missing.length > 0
  return { draft: { ...mapped, title: mapped.title || instance.title.trim().slice(0, 160) }, complete: complete && !missing }
}

export class DemandService {
  private readonly now: () => number

  constructor(readonly store: DemandStore, private readonly options: DemandServiceOptions) {
    this.now = options.now ?? Date.now
  }

  get hasConnections() { return this.options.connections.size > 0 }

  async capabilities(actor: Actor) {
    const slug = await this.store.tenantSlug(actor.tenantId)
    const connection = slug ? this.options.connections.get(slug) : undefined
    return { oaConfigured: Boolean(connection), callbackConfigured: Boolean(connection?.callback), aiPrecheckConfigured: Boolean(this.options.precheck) }
  }

  private async connection(tenantId: string) {
    const slug = await this.store.tenantSlug(tenantId)
    const connection = slug ? this.options.connections.get(slug) : undefined
    if (!connection) throw noDingTalk()
    return connection
  }

  async precheck(actor: Actor, id: string, revision: number, modelId?: string, signal?: AbortSignal) {
    const { draft, previous } = await this.store.precheckDraft(actor, id, revision)
    if (previous?.draftRevision === revision) return this.store.get(actor, id)
    if (validateDemand(draft).missing.length) {
      throw new ControlError(409, 'DEMAND_FIELDS_INCOMPLETE', 'Complete the required fields before requesting AI precheck.')
    }
    if (!this.options.precheck) throw precheckUnavailable()
    const timeout = AbortSignal.timeout(30_000)
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    let result: unknown
    try { result = await this.options.precheck({ actor, demandId: id, draft: reviewedDraft(draft), modelId, signal: requestSignal }) }
    catch (error) { if (error instanceof ControlError) throw error; throw precheckUnavailable() }
    const parsed = precheckOutput.safeParse(result)
    if (requestSignal.aborted || !parsed.success) throw precheckUnavailable()
    await this.store.recordPrecheck(actor, id, { ...cleanReview(parsed.data), draftRevision: revision, checkedAt: new Date(this.now()).toISOString() })
    return this.store.get(actor, id)
  }

  async submit(actor: Actor, id: string, input: SubmitInput) {
    const { corpId } = await this.connection(actor.tenantId)
    const result = await this.store.reserve(actor, id, corpId, input)
    return { ...result, demand: await this.store.get(actor, id) }
  }

  async saveIdentity(actor: Actor, input: IdentityInput) {
    const { corpId } = await this.connection(actor.tenantId)
    return this.store.saveIdentity(actor, corpId, input)
  }

  async adminIdentities(actor: Actor, login: string) {
    const slug = await this.store.tenantSlug(actor.tenantId)
    const corpId = slug ? this.options.connections.get(slug)?.corpId : undefined
    return this.store.adminIdentities(actor, corpId, login, 50)
  }

  async callback(tenantSlug: string, query: unknown, body: unknown) {
    const config = this.options.connections.get(tenantSlug)
    if (!config?.callback) throw new ControlError(404, 'DINGTALK_CALLBACK_DISABLED', 'The DingTalk callback is unavailable.')
    const event = config.callback.receive(query, body)
    if (event) await this.ingest(tenantSlug, event)
    return config.callback.ack()
  }

  async ingest(slug: string, event: DingTalkEvent) {
    const config = this.options.connections.get(slug)
    if (!config || config.corpId !== event.corpId) throw new ControlError(403, 'DINGTALK_TENANT_MISMATCH', 'The event was received for an unconfigured organization.')
    const tenant = await this.store.tenantId(slug)
    if (!tenant) throw noDingTalk()
    const linked = await this.store.knownInstance(tenant, event.instanceId)
    const mapping = await this.store.getTemplate(tenant, event.processCode)
    if (linked ? linked.corp_id === config.corpId && linked.process_code === event.processCode : mapping?.importEnabled || mapping?.submitEnabled) {
      await this.store.enqueue(tenant, event)
    }
  }

  async scheduleReconcile(actor: Actor, id: string) {
    const demand = await this.store.requireManager(actor, id)
    await this.connection(actor.tenantId)
    await this.store.scheduleReconcile(demand)
    return this.store.get(actor, id)
  }

  async scan(actor: Actor, processCode: string, lookbackHours: number, cursor: number, until?: number) {
    await this.store.scanTemplate(actor, processCode)
    const { corpId, transport } = await this.connection(actor.tenantId)
    const now = this.now()
    const end = until ?? now
    if (end > now || end < now - msPerHour) throw new ControlError(400, 'DINGTALK_SCAN_TIME', 'Start a new scan when the page token is older than one hour.')
    let result: Awaited<ReturnType<DingTalkTransport['list']>>
    try { result = await transport.list({ processCode, startTime: end - lookbackHours * msPerHour, endTime: end, nextToken: cursor }) }
    catch { throw new ControlError(503, 'DINGTALK_SCAN_UNAVAILABLE', 'The OA template could not be scanned with its current permissions.') }
    const period = Math.floor(end / msPerHour)
    for (const instanceId of result.ids) {
      await this.store.enqueue(actor.tenantId, { eventId: `scan.${evidenceHash([processCode, instanceId, period])}`,
        corpId, processCode, instanceId, type: 'scan' })
    }
    return { queued: result.ids.length, nextToken: result.nextToken, until: end }
  }

  private async dispatch(tenant: string, connection: DingTalkConnection) {
    const attempt = await this.store.claimDispatch(tenant, connection.corpId)
    if (!attempt) return
    if (!await this.store.dispatchAllowed(attempt)) {
      await this.store.dispatchFailed(attempt, 'DECLINED', 'DINGTALK_SUBMISSION_PERMISSION_CHANGED')
      return
    }
    let result: Awaited<ReturnType<DingTalkTransport['create']>>
    try { result = await connection.transport.create(attempt.request) }
    catch (error) {
      const disposition = error instanceof DingTalkDispatchError ? error.disposition : 'UNCONFIRMED'
      const code = disposition === 'NOT_SENT' ? 'DINGTALK_CREDENTIALS_UNAVAILABLE' : disposition === 'DECLINED'
        ? 'DINGTALK_SUBMISSION_DECLINED' : 'DINGTALK_SUBMISSION_UNCONFIRMED'
      await this.store.dispatchFailed(attempt, disposition === 'UNCONFIRMED' ? 'UNCONFIRMED' : 'DECLINED', code)
      return
    }
    if (!await this.store.link(attempt, result.instanceId)) {
      await this.store.dispatchFailed(attempt, 'UNCONFIRMED', 'DINGTALK_SUBMISSION_UNCONFIRMED')
    }
  }

  private async readOnlyRecovery(attempt: SubmissionRow, transport: DingTalkTransport) {
    const endTime = this.now()
    const startTime = attempt.submitted_at.getTime() - 90_000
    if (endTime <= startTime || endTime - startTime > 119 * 24 * msPerHour) return
    const matches = new Map<string, DingTalkInstance>()
    const deadline = Date.now() + 20_000
    let nextToken: number | null = 0
    for (let page = 0; page < 3 && nextToken !== null; page++) {
      if (Date.now() >= deadline) return
      const result = await transport.list({ processCode: attempt.process_code, startTime, endTime, nextToken, userIds: [attempt.originator_user_id] })
      if (result.nextToken === nextToken) return
      nextToken = result.nextToken
      for (const id of result.ids) {
        if (Date.now() >= deadline) return
        const actual = await transport.get(id)
        if (this.store.matches(attempt, attempt.process_code, actual)) matches.set(id, actual)
        if (matches.size > 1) return
      }
    }
    if (nextToken !== null || matches.size !== 1) return
    const actual = matches.values().next().value
    if (!actual) return
    const linked = await this.store.link(attempt, actual.instanceId)
    if (linked) await this.store.recordVerified(linked, actual)
  }

  private async recover(tenant: string, connection: DingTalkConnection) {
    const attempt = await this.store.claimRecovery(tenant, connection.corpId)
    if (!attempt) return
    await this.store.dispatchFailed(attempt, 'UNCONFIRMED', 'DINGTALK_SUBMISSION_UNCONFIRMED', 'UNCONFIRMED')
    await this.readOnlyRecovery(attempt, connection.transport)
  }

  private async poll(tenant: string, connection: DingTalkConnection) {
    const linked = await this.store.claimPoll(tenant, connection.corpId)
    if (linked) await this.store.recordVerified(linked, await connection.transport.get(linked.instance_id))
  }

  private async readInbox(tenant: string, connection: DingTalkConnection, hint: InboxRow) {
    let linked: InstanceRow | undefined = await this.store.knownInstance(tenant, hint.instance_id)
    if (linked && (linked.process_code !== hint.process_code || linked.corp_id !== connection.corpId || isFinal(linked.state))) return true
    const mapping = await this.store.getTemplate(tenant, hint.process_code)
    if (!linked && !mapping?.importEnabled && !mapping?.submitEnabled) return true
    const actual = await connection.transport.get(hint.instance_id)
    if (actual.processCode && actual.processCode !== hint.process_code) return true
    if (!linked) {
      const markers = actual.form.flatMap(field => typeof field.value === 'string' ? [marker.exec(field.value)] : []).filter(Boolean)
      if (markers.length) {
        const version = z.uuid().safeParse(markers.length === 1 ? markers[0]?.[1] : undefined)
        const attempt = version.success ? await this.store.submissionByVersion(tenant, version.data) : undefined
        if (!attempt || attempt.corp_id !== connection.corpId || !this.store.matches(attempt, hint.process_code, actual)) return true
        linked = await this.store.link(attempt, actual.instanceId)
        if (!linked) return false
      } else {
        if (await this.store.openSubmissionForStaff(tenant, connection.corpId, hint.process_code, actual.originatorUserId)) return false
        if (!mapping?.importEnabled) return true
        const { draft, complete } = mappedDraft(mapping.fieldMap, actual)
        linked = await this.store.importExisting(tenant, connection.corpId, hint.process_code, actual, draft, complete, mapping.fieldMap)
      }
    }
    if (!linked || !await this.store.recordVerified(linked, actual)) return true
    return hint.event_type === 'start' || hint.event_type === 'scan' || isFinal(actual.state)
  }

  private async inbox(tenant: string, connection: DingTalkConnection) {
    const hint = await this.store.claimInbox(tenant, connection.corpId)
    if (hint && await this.readInbox(tenant, connection, hint)) await this.store.finishInbox(tenant, hint.event_id)
  }

  async runOnce() {
    let deferred = 0
    for (const [slug, connection] of this.options.connections) {
      const tenant = await this.store.tenantId(slug)
      if (!tenant) continue
      const results = await Promise.allSettled([
        this.dispatch(tenant, connection), this.inbox(tenant, connection), this.recover(tenant, connection), this.poll(tenant, connection),
      ])
      deferred += results.filter(result => result.status === 'rejected').length
    }
    return { deferred }
  }
}

export function startDemandWorker(service: DemandService, intervalMs = 5000) {
  if (!service.hasConnections) return async () => {}
  let active: Promise<unknown> | undefined
  const run = () => {
    if (!active) active = service.runOnce().catch(() => undefined).finally(() => { active = undefined })
  }
  const timer = setInterval(run, intervalMs)
  timer.unref()
  run()
  return async () => { clearInterval(timer); await active }
}
