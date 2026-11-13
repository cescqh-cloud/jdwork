import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { demandDraftFields, type EnterpriseDemandDraft } from '@/lib/desktopHost/enterpriseDemand'

const fields = [...demandDraftFields.map(field => field.key), 'attachmentRefs'] as const
const sides = ['local', 'cloud'] as const
type Field = typeof fields[number]
type Side = typeof sides[number]
type Value = EnterpriseDemandDraft[Field]

const equal = (left: Value, right: Value) => JSON.stringify(left) === JSON.stringify(right)
const display = (value: Value) => typeof value === 'string' ? value : value.map(file => file.name).join('\n')

export function EnterpriseDemandMergePanel({ local, cloud, base, baseRevision, cloudRevision, busy, onApply, onClose }: {
  local: EnterpriseDemandDraft
  cloud: EnterpriseDemandDraft
  base: EnterpriseDemandDraft | null
  baseRevision: number
  cloudRevision: number
  busy: boolean
  onApply(draft: EnterpriseDemandDraft): void
  onClose(): void
}) {
  const t = useTranslation()
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [choices, setChoices] = useState<Partial<Record<Field, Side>>>({})
  useEffect(() => { heading.current?.focus() }, [])

  const differences = fields.filter(field => !equal(local[field], cloud[field])).map(field => ({
    field,
    side: choices[field] ?? (base && equal(base[field], cloud[field]) ? 'local'
      : base && equal(base[field], local[field]) ? 'cloud' : undefined),
  }))
  const pending = differences.some(({ side }) => !side)

  return <section aria-labelledby={id} className="space-y-4 border-t border-[var(--color-border)] px-4 py-4">
    <header className="space-y-1">
      <h4 ref={heading} id={id} tabIndex={-1} className="font-semibold">{t('enterpriseDemand.merge.title')}</h4>
      <p className="text-sm text-[var(--color-text-secondary)]">{t('enterpriseDemand.merge.versions', { base: baseRevision, latest: cloudRevision })}</p>
      <p className="text-sm">{t(base ? 'enterpriseDemand.merge.instructions' : 'enterpriseDemand.merge.legacy')}</p>
    </header>
    {differences.length === 0 && <p className="text-sm">{t('enterpriseDemand.merge.same')}</p>}
    {differences.map(({ field, side }) => <fieldset key={field} disabled={busy} className="space-y-2">
      <legend className="text-sm font-medium">{t(`enterpriseDemand.field.${field}`)}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {sides.map(option => <div key={option} className="min-w-0 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="radio" name={`${id}-${field}`} checked={side === option} onChange={() => setChoices(previous => ({ ...previous, [field]: option }))} />
            {t(option === 'local' ? 'enterpriseDemand.merge.keepLocal' : 'enterpriseDemand.merge.keepCloud')}
          </label>
          <p className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">
            {display((option === 'local' ? local : cloud)[field]) || t('enterpriseDemand.merge.empty')}
          </p>
        </div>)}
      </div>
    </fieldset>)}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy || pending} onClick={() => onApply({ ...cloud, ...Object.fromEntries(
        differences.filter(({ side }) => side === 'local').map(({ field }) => [field, local[field]]),
      ) })}>{t('enterpriseDemand.merge.apply')}</Button>
      <Button size="sm" variant="secondary" disabled={busy} onClick={onClose}>{t('enterpriseDemand.merge.back')}</Button>
    </div>
  </section>
}
