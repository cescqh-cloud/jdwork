import { ControlError, tokenDigest } from '../contract'

const verificationLifetime = 60_000
type MaterialHead = {
  latest_run_id: string | null
  material_verified_at: Date | null
  material_invalidated_at: Date | null
  material_device_active: boolean
  state: string
}

export function materialState(task: MaterialHead, now = Date.now()) {
  if (!task.latest_run_id) return { state: 'unchecked', expiresAt: null } as const
  if (task.material_invalidated_at) return { state: 'changed', expiresAt: null } as const
  if (task.state === 'DELIVERED' && task.material_verified_at) return { state: 'current', expiresAt: null } as const
  const expires = task.material_verified_at ? task.material_verified_at.getTime() + verificationLifetime : 0
  if (!task.material_device_active || expires <= now) return { state: 'unverified', expiresAt: null } as const
  return { state: 'current', expiresAt: new Date(expires).toISOString() } as const
}

export function requireCurrentMaterials(task: MaterialHead) {
  if (materialState(task).state !== 'current') {
    throw new ControlError(409, 'DELIVERY_MATERIALS_UNVERIFIED', '请由绑定设备核验当前材料，再继续复审、测试或验收。')
  }
}

export function materialChecksum(files: readonly { path: string, sha256: string }[]) {
  return tokenDigest(JSON.stringify([...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map(file => [file.path, file.sha256])))
}

export function selectionPayload(deviceId: string, taskId: string, approvedVersionId: string, bindingId: string, gitRevision: string, checksum: string) {
  return ['delivery-material-selection-v1', deviceId, taskId, approvedVersionId, bindingId, gitRevision, checksum]
}
