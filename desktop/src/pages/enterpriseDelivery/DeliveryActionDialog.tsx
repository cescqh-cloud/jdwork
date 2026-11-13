import { useState } from 'react'
import { ActionDialog } from '@/components/ui/ActionDialog'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { SelectField } from '@/components/ui/SelectField'
import { TextArea } from '@/components/ui/TextArea'
import { useTranslation } from '@/i18n'
import { deliveryOutcomes, type EnterpriseDeliveryRequest, type EnterpriseDeliveryRun, type EnterpriseDeliveryTask } from '@/lib/desktopHost/enterpriseDelivery'

export type DeliveryDialog = 'review' | 'test' | 'accept' | 'rework'
export type DeliveryChange = Extract<EnterpriseDeliveryRequest, { action: 'review' | 'transition' }>

export function DeliveryActionDialog({ intent, task, report, busy, issue, onClose, onSubmit }: {
  intent: DeliveryDialog
  task: EnterpriseDeliveryTask
  report: EnterpriseDeliveryRun | null
  busy: boolean
  issue: string | null
  onClose: () => void
  onSubmit: (request: DeliveryChange) => void
}) {
  const t = useTranslation()
  const [note, setNote] = useState('')
  const [acknowledge, setAcknowledge] = useState(false)
  const [outcome, setOutcome] = useState<typeof deliveryOutcomes[number]>('not_run')
  const [evidenceLabel, setEvidenceLabel] = useState('')
  const [evidenceHash, setEvidenceHash] = useState('')
  const [handover, setHandover] = useState('')
  const validTest = outcome !== 'passed' || Boolean(evidenceLabel.trim() && /^[a-f0-9]{64}$/u.test(evidenceHash.trim()))
  const base = { id: task.id, revision: task.revision }
  const submitReview = (decision: 'ACCEPT' | 'REWORK') => {
    if (!report || report.stale || report.review) return
    onSubmit({ ...base, action: 'review', runId: report.id, decision,
      ...(report.verdict === 'WARN' ? { acknowledgeWarnings: acknowledge } : {}), note: note.trim() })
  }
  const save = () => {
    if (intent === 'test') {
      onSubmit({ ...base, action: 'transition', transition: { action: 'record_test', outcome, note: note.trim(),
        ...(outcome === 'passed' ? { evidence: [{ label: evidenceLabel.trim(), sha256: evidenceHash.trim() }] } : {}) } })
    } else if (intent === 'accept') {
      onSubmit({ ...base, action: 'transition', transition: { action: 'accept', deliveryRef: handover.trim(), note: note.trim() } })
    } else if (intent === 'rework') {
      onSubmit({ ...base, action: 'transition', transition: { action: 'return_for_rework', note: note.trim() } })
    }
  }
  const disabled = !note.trim() || (intent === 'test' && !validTest) || (intent === 'accept' && !handover.trim())
  const outcomes = task.materials && task.materials.state !== 'current' ? deliveryOutcomes.filter(value => value !== 'passed') : deliveryOutcomes
  const hasEdits = Boolean(note || acknowledge || outcome !== 'not_run' || evidenceLabel || evidenceHash || handover)
  const cancel = { label: t('common.cancel'), onClick: onClose }
  const title = t(`enterpriseDelivery.${intent}`)
  return (
    <ActionDialog
      open title={title} onClose={() => { if (!hasEdits) onClose() }} loading={busy}
      body={<div className="space-y-3">
        {intent === 'test' && <SelectField label={t('enterpriseDelivery.testOutcome')} value={outcome} onChange={setOutcome}
          options={outcomes.map(value => ({ value, label: t(`enterpriseDelivery.outcome.${value}`) }))} />}
        {intent === 'test' && outcome === 'passed' && <>
          <Input aria-label={t('enterpriseDelivery.evidenceLabel')} placeholder={t('enterpriseDelivery.evidenceLabel')}
            maxLength={160} value={evidenceLabel} onChange={event => setEvidenceLabel(event.target.value)} />
          <Input aria-label={t('enterpriseDelivery.evidenceHash')} placeholder={t('enterpriseDelivery.evidenceHash')}
            maxLength={64} value={evidenceHash} onChange={event => setEvidenceHash(event.target.value.toLowerCase())} />
        </>}
        {intent === 'accept' && <Input aria-label={t('enterpriseDelivery.handover')} placeholder={t('enterpriseDelivery.handover')}
          maxLength={240} value={handover} onChange={event => setHandover(event.target.value)} />}
        <TextArea aria-label={t('enterpriseDelivery.note')} placeholder={t('enterpriseDelivery.note')}
          value={note} onChange={event => setNote(event.target.value)} rows={4} maxLength={1000} />
        {intent === 'review' && report?.verdict === 'WARN' && <Checkbox checked={acknowledge} onChange={event => setAcknowledge(event.target.checked)}
          label={t('enterpriseDelivery.ackWarnings')} />}
        {issue && <p role="alert" className="text-sm text-[var(--color-error)]">{issue}</p>}
      </div>}
      actions={intent === 'review' ? [
        cancel,
        { label: t('enterpriseDelivery.decision.REWORK'), onClick: () => submitReview('REWORK'), disabled },
        ...(report?.verdict !== 'BLOCK' ? [{ label: t('enterpriseDelivery.decision.ACCEPT'), onClick: () => submitReview('ACCEPT'),
          variant: 'primary' as const, disabled: disabled || (report?.verdict === 'WARN' && !acknowledge) }] : []),
      ] : [cancel, { label: intent === 'accept' ? t('enterpriseDelivery.accept') : t('common.save'), onClick: save, variant: 'primary', disabled }]}
    />
  )
}
