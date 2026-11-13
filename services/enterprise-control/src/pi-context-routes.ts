import type { Context, Env, Hono } from 'hono'
import { ControlError } from './contract'
import { piContextInput, type PiContextInput } from './pi-context'

export interface ContextActor {
  tenantId: string
  id: string
  device: { id: string } | null
}

export interface PiContextRouteOptions<E extends Env> {
  actor(context: Context<E>): Promise<ContextActor>
  allowed(actor: ContextActor): Promise<boolean>
  context: { read(input: PiContextInput, signal?: AbortSignal): Promise<string> }
}

export function mountPiContextRoutes<E extends Env>(app: Hono<E>, options: PiContextRouteOptions<E>) {
  app.post('/api/v1/pi-context', async c => {
    const before = await options.actor(c)
    if (!before.device || !await options.allowed(before)) throw new ControlError(403, 'PI_CONTEXT_DENIED', '当前设备无权读取共享资料。')
    const body: unknown = await c.req.json().catch(() => null)
    const input = piContextInput.safeParse(body)
    if (!input.success) throw new ControlError(400, 'PI_CONTEXT_INVALID', '共享资料查询格式无效。')
    const text = await options.context.read(input.data, c.req.raw.signal)
    const after = await options.actor(c)
    if (after.tenantId !== before.tenantId || after.id !== before.id || after.device?.id !== before.device.id
      || !await options.allowed(after)) throw new ControlError(403, 'PI_CONTEXT_CHANGED', '共享资料权限发生变化，请重新连接。')
    return c.json({ kind: input.data.kind, text })
  })
}
