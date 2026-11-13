import type { Context } from 'hono'
import type { z } from 'zod'
import { ControlError } from '../contract'
import type { Actor } from '../store'
import type { ReleaseService } from './service'

export interface ReleaseRoutesOptions { service: ReleaseService, actor(context: Context, deviceAllowed?: boolean): Promise<Actor> }

export function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value)
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map(issue => issue.path.join('.')).filter(Boolean))].slice(0, 5)
    throw new ControlError(400, 'UPDATE_INPUT_INVALID', fields.length ? `请检查发布参数 ${fields.join('、')}` : '请检查客户端版本或发布参数。')
  }
  return result.data
}

export function contentType(context: Context, allowed: readonly string[]) {
  const kind = context.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase()
  const encoding = context.req.header('Content-Encoding')?.trim().toLowerCase()
  if (!kind || !allowed.includes(kind) || (encoding && encoding !== 'identity')) {
    throw new ControlError(400, 'UPDATE_CONTENT_TYPE', 'Send the file in the requested format without multipart or content compression.')
  }
}

export async function json<T>(context: Context, schema: z.ZodType<T>) {
  contentType(context, ['application/json'])
  return parse(schema, await context.req.json().catch(() => undefined))
}
