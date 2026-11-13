import { useId } from 'react'
import { Button } from '@/components/ui/Button'
import { TextArea } from '@/components/ui/TextArea'
import { useTranslation } from '@/i18n'
import type { EnterpriseMemory } from '@/lib/desktopHost/enterpriseMemory'

export type MemoryConflict = {
  id: string
  originalBody: string
  originalRevision: number
  cloud: EnterpriseMemory | null
  draft: string | null
  basedOn: number | null
}

export type MemoryVersionChoice = 'local' | 'cloud' | 'draft'

export function MemoryConflictPanel({ conflict, cloudCurrent, busy, onChoose, onEdit, onReload, onSave }: {
  conflict: MemoryConflict
  cloudCurrent: boolean
  busy: boolean
  onChoose: (choice: MemoryVersionChoice) => void
  onEdit: (body: string) => void
  onReload: () => void
  onSave: () => void
}) {
  const t = useTranslation()
  const heading = useId()
  const canResolve = !busy && cloudCurrent
  const selected = Boolean(conflict.cloud && conflict.basedOn === conflict.cloud.revision)
  return <section aria-labelledby={heading} className="min-w-0 space-y-3">
    <header className="space-y-1">
      <h3 id={heading} className="font-semibold">{t('enterpriseMemory.conflictTitle')}</h3>
      <p className="text-sm text-[var(--color-text-secondary)]">{t('enterpriseMemory.conflictHelp')}</p>
    </header>
    <div className="grid min-w-0 gap-3 md:grid-cols-2">
      <div className="min-w-0 space-y-2">
        <TextArea label={t('enterpriseMemory.localVersion')} value={conflict.originalBody} rows={5} readOnly
          hint={t('enterpriseMemory.localBase', { revision: String(conflict.originalRevision) })} />
        <Button size="sm" variant="secondary" disabled={!canResolve} onClick={() => onChoose('local')}>
          {t('enterpriseMemory.chooseLocal')}</Button>
      </div>
      <div className="min-w-0 space-y-2">
        {cloudCurrent && conflict.cloud
          ? <TextArea label={t('enterpriseMemory.cloudVersion')} value={conflict.cloud.body} rows={5} readOnly
            hint={t('enterpriseMemory.version', { revision: String(conflict.cloud.revision) })} />
          : <p role="status" className="text-sm text-[var(--color-text-secondary)]">
            {t(busy ? 'enterpriseMemory.loadingCloud' : conflict.cloud ? 'enterpriseMemory.cloudChanged' : 'enterpriseMemory.cloudUnavailable')}</p>}
        <Button size="sm" variant="secondary" disabled={!canResolve} onClick={() => onChoose('cloud')}>
          {t('enterpriseMemory.chooseCloud')}</Button>
      </div>
    </div>
    {!cloudCurrent && <Button size="sm" variant="secondary" disabled={busy} onClick={onReload}>{t('enterpriseMemory.reloadCloud')}</Button>}
    {conflict.draft !== null && <>
      <TextArea label={t('enterpriseMemory.resolutionDraft')} value={conflict.draft} maxLength={2000} rows={5}
        disabled={busy} readOnly={!selected || !cloudCurrent} onChange={event => onEdit(event.target.value)} />
      {!selected && <Button size="sm" variant="secondary" disabled={!canResolve} onClick={() => onChoose('draft')}>
        {t('enterpriseMemory.chooseDraft')}</Button>}
      <Button size="sm" disabled={!canResolve || !selected || !conflict.draft.trim()} onClick={onSave}>
        {t('enterpriseMemory.saveResolution')}</Button>
    </>}
  </section>
}
