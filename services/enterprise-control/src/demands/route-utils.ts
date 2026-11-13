import type { Context } from 'hono'
import type { z } from 'zod'
import { ControlError } from '../contract'
import type { Actor } from '../store'
import type { DemandService } from './service'

export interface DemandRoutesOptions {
  service: DemandService
  actor(context: Context, deviceAllowed?: boolean): Promise<Actor>
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    const paths = [...new Set(result.error.issues.map(issue => issue.path.join('.')).filter(Boolean))].slice(0, 6)
    throw new ControlError(400, 'DEMAND_INPUT_INVALID', paths.length ? `请检查以下字段 ${paths.join('、')}` : '请检查需求表单中的字段。')
  }
  return result.data
}

export async function body<T>(context: Context, schema: z.ZodType<T>) {
  if (context.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ControlError(400, 'DEMAND_JSON_REQUIRED', 'Send application/json for this endpoint.')
  }
  return parse(schema, await context.req.json().catch(() => undefined))
}
