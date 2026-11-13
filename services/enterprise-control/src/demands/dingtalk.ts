import { z } from 'zod'
import { dingTalkId, processCode, type FieldRef, type VerifiedState } from './contract'

const origin = 'https://api.dingtalk.com'
const workflow = '/v1.0/workflow/processInstances'
export const instanceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:+/=@-]{0,191}$/u)
const formValue = z.object({ id: dingTalkId.optional().nullable(), name: z.string().max(120), value: z.string().max(16_384).nullable() })

export interface DingTalkCreateRequest {
  RequestId: string
  processCode: string
  originatorUserId: string
  deptId: number
  formComponentValues: Array<{ name: string, value: string }>
  targetSelectActioners?: Array<{ actionerKey: string, actionerUserIds: string[] }>
}

export interface DingTalkInstance {
  instanceId: string
  processCode: string | null
  originatorUserId: string
  title: string
  state: VerifiedState
  finishedAt: string | null
  approverUserIds: string[]
  form: Array<z.infer<typeof formValue>>
}

export interface DingTalkTransport {
  create(request: DingTalkCreateRequest): Promise<{ instanceId: string }>
  get(instance: string): Promise<DingTalkInstance>
  list(input: { processCode: string, startTime: number, endTime: number, nextToken: number, userIds?: string[] }):
    Promise<{ ids: string[], nextToken: number | null }>
}

export class DingTalkDispatchError extends Error {
  constructor(readonly disposition: 'NOT_SENT' | 'DECLINED' | 'UNCONFIRMED') { super(disposition) }
}

export function authoritativeState(status: string, result: string | undefined): VerifiedState {
  switch (status.trim().toUpperCase()) {
    case 'NEW':
    case 'RUNNING': return 'RUNNING'
    case 'TERMINATED': return 'TERMINATED'
    case 'COMPLETED': {
      const decision = result?.trim().toUpperCase()
      if (decision === 'AGREE' || decision === 'REFUSE') return decision
    }
  }
  return 'UNKNOWN'
}

export function formText(form: DingTalkInstance['form'], field: FieldRef): string | undefined {
  const matches = form.filter(value => field.id ? value.id === field.id : value.name === field.name)
  return matches.length === 1 && typeof matches[0]?.value === 'string' ? matches[0].value : undefined
}

const tokenReply = z.object({ accessToken: z.string().min(1).max(4096), expireIn: z.number().int().positive() })
const createReply = z.object({ instanceId })
const instanceReply = z.object({ result: z.object({
  instanceId: instanceId.optional(), processInstanceId: instanceId.optional(), processCode: processCode.optional().nullable(),
  originatorUserId: dingTalkId, title: z.string().max(300).default(''), status: z.string().min(1).max(64),
  result: z.string().max(64).nullable().optional(), finishTime: z.string().max(80).nullable().optional(),
  approverUserIds: z.array(dingTalkId).max(1000).nullable().optional(),
  formComponentValues: z.array(formValue).max(500).nullable().optional(),
}) })
const listReply = z.object({ success: z.literal(true).optional(), result: z.object({
  list: z.array(instanceId).max(20).nullable().optional(),
  nextToken: z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d{1,16}$/u)]).nullable().optional(),
}) })

const definiteCreateErrors = new Set([
  'targetSelectApproverScopeError', 'targetSelectApproverMissing', 'invalidParameter', 'processInstanceInvalidParameter',
  'needAuth', 'invalidAgentId', 'processCodeError', 'processSetupNoPermission', 'formConverterError', 'illegalComponent',
])

function parseFinishTime(value: string | null | undefined): string | null {
  if (!value || !/(?:Z|[+-]\d\d:\d\d)$/iu.test(value)) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

async function readReply(response: Response): Promise<unknown> {
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let reply = ''
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.length
      if (bytes > 1_048_576) { await reader.cancel(); return undefined }
      reply += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(reply + decoder.decode())
  } catch {
    return undefined
  } finally {
    reader.releaseLock()
  }
}

/** All provider operations go to DingTalk's documented origin. Tests inject an in-memory transport. */
export function createDingTalkTransport(credentials: { appKey: string, appSecret: string }, fetcher = fetch): DingTalkTransport {
  let token: { value: string, until: number } | undefined
  let refresh: Promise<string> | undefined

  function request(path: string, method: 'GET' | 'POST', body?: unknown, accessToken?: string) {
    const headers = new Headers({ Accept: 'application/json' })
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    if (accessToken) headers.set('x-acs-dingtalk-access-token', accessToken)
    return fetcher(new URL(path, origin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(7500) })
  }

  async function accessToken(): Promise<string> {
    if (token && token.until > Date.now()) return token.value
    if (refresh) return refresh
    refresh = (async () => {
      const response = await request('/v1.0/oauth2/accessToken', 'POST', credentials)
      const reply = tokenReply.safeParse(await readReply(response))
      if (!response.ok || !reply.success) throw new Error('DINGTALK_CREDENTIALS_UNAVAILABLE')
      token = { value: reply.data.accessToken, until: Date.now() + Math.max(1, Math.min(reply.data.expireIn, 7200) - 60) * 1000 }
      return token.value
    })().finally(() => { refresh = undefined })
    return refresh
  }

  async function read(path: string, method: 'GET' | 'POST', body?: unknown) {
    const credential = await accessToken()
    let response = await request(path, method, body, credential)
    if (response.status === 401) {
      if (token?.value === credential) token = undefined
      await response.body?.cancel()
      response = await request(path, method, body, await accessToken())
    }
    const reply = await readReply(response)
    if (!response.ok) throw new Error('DINGTALK_READ_UNAVAILABLE')
    return reply
  }

  return {
    async create(input) {
      const credential = await accessToken().catch(() => { throw new DingTalkDispatchError('NOT_SENT') })
      const response = await request(workflow, 'POST', input, credential).catch(() => { throw new DingTalkDispatchError('UNCONFIRMED') })
      const raw = await readReply(response)
      if (response.ok) {
        const reply = createReply.safeParse(raw)
        if (reply.success) return reply.data
      }
      if (response.status === 401) {
        if (token?.value === credential) token = undefined
        throw new DingTalkDispatchError('DECLINED')
      }
      const code = z.object({ code: z.string() }).safeParse(raw)
      if (response.status === 400 && code.success && definiteCreateErrors.has(code.data.code)) throw new DingTalkDispatchError('DECLINED')
      throw new DingTalkDispatchError('UNCONFIRMED')
    },
    async get(id) {
      const path = `${workflow}?${new URLSearchParams({ processInstanceId: instanceId.parse(id) })}`
      const { result } = instanceReply.parse(await read(path, 'GET'))
      if ((result.instanceId && result.instanceId !== id) || (result.processInstanceId && result.processInstanceId !== id)) {
        throw new Error('DINGTALK_INSTANCE_MISMATCH')
      }
      return { instanceId: id, processCode: result.processCode ?? null, originatorUserId: result.originatorUserId,
        title: result.title, state: authoritativeState(result.status, result.result ?? undefined), finishedAt: parseFinishTime(result.finishTime),
        approverUserIds: [...new Set(result.approverUserIds ?? [])], form: result.formComponentValues ?? [] }
    },
    async list(input) {
      const { result } = listReply.parse(await read('/v1.0/workflow/processes/instanceIds/query', 'POST', { ...input, maxResults: 20 }))
      const cursor = result.nextToken === null || result.nextToken === undefined ? null : Number(result.nextToken)
      if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new Error('DINGTALK_PAGING_INVALID')
      return { ids: [...new Set(result.list ?? [])], nextToken: cursor === 0 ? null : cursor }
    },
  }
}
