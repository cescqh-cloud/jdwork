import { z } from 'zod'
import { ControlError } from '../contract'
import { revision } from '../demands/contract'

const uuid = z.uuid()
export const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const short = (maximum: number) => z.string().trim().min(1).max(maximum).refine(text => !text.includes('\u0000'))
const workRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u)
const gitRevision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)
const filePath = z.string().min(1).max(180)
  .regex(/^[\p{L}\p{N}_. -]+(?:\/[\p{L}\p{N}_. -]+)*$/u)
  .refine(path => path.split('/').every(part => part !== '.' && part !== '..' && part === part.trim()))
const fileInput = z.strictObject({ path: filePath, text: z.string().max(8192).refine(text => !text.includes('\u0000')) })
const knowledgeRef = z.strictObject({ documentId: uuid, revision, checksum: sha256 })
const evidence = z.strictObject({ label: short(160), sha256 })

export const assignInput = z.strictObject({ approvedVersionId: uuid, expectedDemandRevision: revision, projectId: uuid, assigneeId: uuid })
export const bindInput = z.strictObject({ worktreeId: workRef, sessionId: workRef, gitRevision })
export const checkInput = z.strictObject({ files: z.array(fileInput).min(1).max(8), knowledgeRefs: z.array(knowledgeRef).max(8).optional(),
  selectionReceipt: z.string().regex(/^[A-Za-z0-9_-]{86}$/u).optional() })
  .refine(input => Buffer.byteLength(JSON.stringify(input), 'utf8') <= 12_288)
export const materialVerificationInput = z.strictObject({ runId: uuid, checksum: sha256.nullable() })
export const reviewInput = z.strictObject({
  runId: uuid, decision: z.enum(['ACCEPT', 'REWORK']), acknowledgeWarnings: z.boolean().optional(), note: short(1000),
})
export const testOutcome = z.enum(['passed', 'failed', 'skipped', 'blocked', 'not_run'])
export const transitionInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({ action: z.literal('start_testing') }),
  z.strictObject({ action: z.literal('record_test'), outcome: testOutcome, evidence: z.array(evidence).max(8).optional(), note: short(1000) }),
  z.strictObject({ action: z.literal('return_for_rework'), note: short(1000) }),
  z.strictObject({ action: z.literal('accept'), deliveryRef: short(240), note: short(1000) }),
])

export type AssignInput = z.infer<typeof assignInput>
export type BindInput = z.infer<typeof bindInput>
export type CheckInput = z.infer<typeof checkInput>
export type MaterialVerificationInput = z.infer<typeof materialVerificationInput>
export type KnowledgeReference = z.infer<typeof knowledgeRef>
export type ReviewInput = z.infer<typeof reviewInput>
export type TransitionInput = z.infer<typeof transitionInput>
export type DeliveryState = 'ASSIGNED' | 'DEVELOPING' | 'TESTING' | 'ACCEPTANCE' | 'DELIVERED'

export function readDeliveryRevision(header: string | undefined) {
  const match = /^"([1-9]\d{0,9})"$/u.exec(header ?? '')
  const parsed = revision.safeParse(Number(match?.[1]))
  if (!parsed.success) throw new ControlError(400, 'DELIVERY_REVISION_REQUIRED', '请使用交付任务 ETag 作为 If-Match。')
  return parsed.data
}
