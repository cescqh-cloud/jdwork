import { Badge, type Tone } from '@/components/ui/Badge'
import type { TaskStatus } from './api'
import { usePiTranslation, type PiKey } from './usePiTranslation'

const statusMap: Record<TaskStatus, [PiKey, Tone]> = {
  running: ['pi.running', 'info'],
  completed: ['pi.completed', 'success'],
  failed: ['pi.failed', 'danger'],
  cancelled: ['pi.cancelled', 'neutral'],
  interrupted: ['pi.interrupted', 'warning'],
}

export const noInlineImages = () => null

export function StatusBadge({ status }: { status: TaskStatus }) {
  const t = usePiTranslation()
  const [key, tone] = statusMap[status] ?? ['pi.unknownStatus', 'neutral']
  return <Badge tone={tone} size="sm">{t(key)}</Badge>
}
