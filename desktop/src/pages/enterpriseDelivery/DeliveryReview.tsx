import { FileCheck2, FileText, Wrench } from 'lucide-react'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import type { EnterpriseDeliveryRun } from '@/lib/desktopHost/enterpriseDelivery'

const tones: Record<EnterpriseDeliveryRun['verdict'], Tone> = { PASS: 'success', WARN: 'warning', BLOCK: 'danger' }
const rank = { BLOCK: 0, WARN: 1, PASS: 2 }

export function DeliveryReview({ run, busy, canFix, canReview, onFix, onReview }: {
  run: EnterpriseDeliveryRun
  busy: boolean
  canFix: boolean
  canReview: boolean
  onFix: (ruleId?: string) => void
  onReview: () => void
}) {
  const t = useTranslation()
  const findings = [...run.findings].sort((left, right) => rank[left.status] - rank[right.status])
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{t('enterpriseDelivery.report')}</h3>
          <Badge tone={tones[run.verdict]}>{t(`enterpriseDelivery.verdict.${run.verdict}`)}</Badge>
          {run.stale && <Badge tone="warning">{t('enterpriseDelivery.stale')}</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          {canReview && !run.stale && !run.review && <Button size="sm" variant="secondary" disabled={busy}
            icon={<FileCheck2 size={14} />} onClick={onReview}>{t('enterpriseDelivery.review')}</Button>}
          {canFix && !run.stale && run.verdict !== 'PASS' && <Button size="sm" disabled={busy}
            icon={<Wrench size={14} />} onClick={() => onFix()}>{t('enterpriseDelivery.fix')}</Button>}
        </div>
      </div>
      {run.review && <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2 text-sm">
        <Badge tone={run.review.decision === 'ACCEPT' ? 'success' : 'warning'}>{t(`enterpriseDelivery.decision.${run.review.decision}`)}</Badge>
        <p className="mt-2 whitespace-pre-wrap break-words">{run.review.note}</p>
      </div>}
      <ul className="space-y-2">
        {findings.map(finding => (
          <li key={finding.ruleId} className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={tones[finding.status]}>{t(`enterpriseDelivery.verdict.${finding.status}`)}</Badge>
              <p className="min-w-0 break-words text-sm font-medium">{finding.message}</p>
            </div>
            {finding.status !== 'PASS' && <p className="mt-1.5 break-words text-sm text-[var(--color-text-secondary)]">{finding.guidance}</p>}
            {finding.evidence.length > 0 && <ul className="mt-2 space-y-1 text-xs text-[var(--color-text-secondary)]">
              {finding.evidence.map((item, index) => <li key={`${item.path}:${item.line ?? 0}:${index}`} className="flex items-start gap-1.5">
                <FileText size={12} className="mt-0.5 shrink-0" />
                <code className="break-all">{item.path}{item.line ? `:${item.line}` : ''}</code>
              </li>)}
            </ul>}
            {canFix && !run.stale && finding.status !== 'PASS' && <Button size="sm" variant="ghost" disabled={busy}
              onClick={() => onFix(finding.ruleId)}>{t('enterpriseDelivery.fixFinding')}</Button>}
          </li>
        ))}
      </ul>
      <details className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2.5 text-sm">
        <summary className="cursor-pointer font-medium">{t('enterpriseDelivery.evidence')}</summary>
        <p className="mt-2 text-xs text-[var(--color-text-secondary)]">{run.ruleVersion} · {t('enterpriseDelivery.revision', { value: run.taskRevision })}</p>
        <code className="break-all text-xs">{run.inputHash}</code>
        <ul className="mt-2 space-y-1 text-xs">
          {run.files.map(file => <li key={`${file.path}:${file.sha256}`} className="break-all"><code>{file.path}</code> · <code>{file.sha256}</code></li>)}
        </ul>
      </details>
    </section>
  )
}
