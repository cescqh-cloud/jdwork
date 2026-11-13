import { FileDown, FileText, History, Pencil, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { SelectField } from '@/components/ui/SelectField'
import { TextArea } from '@/components/ui/TextArea'
import { usePiTranslation } from './usePiTranslation'
import { errorText, PiApiError, taskPath, type PiApi, type RequirementDocument, type RequirementResponse, type Task, type Workbench } from './api'
import { noInlineImages } from './presentation'
import { usePiResource } from './usePiResource'

type Props = {
  api: PiApi
  task: Task
  sections: Workbench['requirementSections']
  canEdit: boolean
  working: boolean
  onClose: () => void
  onGenerate: (revision?: number) => void
  onRefine: (section: string, revision: number) => void
}

export function RequirementsPanel({ api, task, sections, canEdit, working, onClose, onGenerate, onRefine }: Props) {
  const t = usePiTranslation()
  const [version, setVersion] = useState('latest')
  const [draft, setDraft] = useState<RequirementDocument>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState<'draft' | 'confirmed' | 'md' | 'docx'>()
  const path = `${taskPath(task.id)}/requirements`
  const latest = usePiResource<RequirementResponse>(api, path, task.messages.length + Number(task.status !== 'running'))
  const historical = usePiResource<RequirementResponse>(api, version === 'latest' ? null : `${path}?revision=${encodeURIComponent(version)}`)
  const selected = version === 'latest' ? latest : historical
  const current = selected.value?.document
  const editable = canEdit && !working && version === 'latest' && !selected.error
  const versions = latest.value?.revisions ?? []
  const conflict = error instanceof PiApiError && error.status === 409

  async function save(status: 'draft' | 'confirmed', event?: FormEvent) {
    event?.preventDefault()
    if (!draft || !draft.title.trim() || !editable || busy) return
    setError(undefined)
    setBusy(status)
    try {
      await api.write(path, 'PUT', { title: draft.title.trim(), sections: draft.sections, revision: draft.revision, status })
      setDraft(undefined)
      latest.refresh()
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(undefined)
    }
  }

  async function download(format: 'md' | 'docx') {
    if (!current || busy) return
    setError(undefined)
    setBusy(format)
    try {
      const params = new URLSearchParams({ format, revision: String(current.revision) })
      await api.download(`${path}/export?${params}`, `requirements-v${current.revision}.${format}`)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <aside className="pi-document" aria-label={t('pi.requirements')}>
      <header className="pi-document-head">
        <h2 className="pi-inline"><FileText size={18} strokeWidth={1.75} aria-hidden="true" />{t('pi.requirements')}</h2>
        <IconButton size="sm" label={t('pi.close')} icon={<X size={17} strokeWidth={1.75} />} onClick={onClose} disabled={Boolean(busy)} />
      </header>
      <div className="pi-document-body pi-stack">
        {versions.length > 0 && <div className="pi-document-toolbar">
          <span className="pi-inline">
            <History size={16} strokeWidth={1.75} aria-hidden="true" />
            <SelectField label={t('pi.documentVersion')} labelHidden size="sm" value={version}
              options={[
                { value: 'latest', label: t('pi.latestVersion', { revision: latest.value?.document?.revision ?? versions[0]!.revision }) },
                ...versions.map((item) => ({ value: String(item.revision), label: t('pi.versionNumber', { revision: item.revision }) })),
              ]}
              onChange={(value) => { setError(undefined); setVersion(value) }}
              disabled={Boolean(draft || busy)} />
          </span>
          {current && <Badge tone={current.status === 'confirmed' ? 'success' : 'warning'}>
            {t(current.status === 'confirmed' ? 'pi.confirmed' : 'pi.draft')}
          </Badge>}
        </div>}
        {Boolean(selected.error) && <ErrorState size="sm" title={errorText(selected.error, t('pi.loadError'))}
          onRetry={selected.refresh} retryLabel={t('pi.retry')} />}
        {!selected.value && !selected.error && <LoadingState label={t('pi.loadingDocument')} size="sm" />}
        {selected.value && !current && <EmptyState variant="plain" size="sm"
          title={t('pi.noDocument')} description={canEdit ? t(working ? 'pi.documentRunning' : 'pi.documentEmpty') : undefined}
          icon={<FileText size={19} strokeWidth={1.75} />}
          action={editable ? { label: t('pi.generateDraft'), onClick: () => onGenerate(0), variant: 'primary' } : undefined} />}
        {Boolean(error) && <ErrorState size="sm"
          title={errorText(error, t('pi.documentError'))}
          detail={conflict ? t('pi.documentConflict') : undefined}
          retryLabel={t('pi.reloadDocument')}
          onRetry={conflict ? () => { setDraft(undefined); setError(undefined); latest.refresh() } : undefined} />}
        {current && draft && <form className="pi-stack pi-document-form" onSubmit={(event) => void save('draft', event)}>
          <Input label={t('pi.documentTitle')} value={draft.title} maxLength={160} disabled={!!busy}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })} required />
          {sections.map((section) => <TextArea key={section.id} label={section.label} rows={5} maxLength={12000}
            value={draft.sections[section.id] ?? ''} disabled={!!busy}
            onChange={(event) => setDraft({ ...draft, sections: { ...draft.sections, [section.id]: event.target.value } })} />)}
          <div className="pi-wrap">
            <Button type="submit" variant="secondary" size="base" disabled={!editable || !draft.title.trim() || Boolean(busy)}
              loading={busy === 'draft'}>{t('pi.saveDraft')}</Button>
            <Button variant="primary" size="base" disabled={!editable || !draft.title.trim() || Boolean(busy)}
              loading={busy === 'confirmed'} onClick={() => void save('confirmed')}>{t('pi.confirmDocument')}</Button>
            <Button size="base" variant="ghost" disabled={!!busy}
              onClick={() => { setDraft(undefined); setError(undefined) }}>{t('pi.cancel')}</Button>
          </div>
        </form>}
        {current && !draft && <>
          <div>
            <h3 className="pi-document-title">{current.title}</h3>
            <p className="pi-subtle">
              {t(current.source === 'agent' ? 'pi.agentRevision' : 'pi.manualRevision')} ·{' '}
              <time dateTime={current.updatedAt}>{new Date(current.updatedAt).toLocaleString()}</time>
            </p>
          </div>
          {version !== 'latest' && <p className="pi-subtle">{t('pi.historicalVersion')}</p>}
          <div className="pi-wrap">
            {editable && <Button size="base" variant="primary" icon={<Pencil size={15} strokeWidth={1.75} />}
              onClick={() => { setDraft(current); setError(undefined) }} disabled={!!busy}>{t('pi.editDocument')}</Button>}
            <Button size="base" variant="secondary" icon={<FileDown size={15} strokeWidth={1.75} />}
              loading={busy === 'md'} disabled={!!busy} onClick={() => void download('md')}>{t('pi.exportMarkdown')}</Button>
            <Button size="base" variant="secondary" icon={<FileDown size={15} strokeWidth={1.75} />}
              loading={busy === 'docx'} disabled={!!busy} onClick={() => void download('docx')}>{t('pi.exportWord')}</Button>
          </div>
          {sections.map((section) => <section className="pi-document-section" key={section.id}>
            <div className="pi-document-section-title">
              <h4>{section.label}</h4>
              {editable && <Button size="xs" variant="ghost" disabled={!!busy}
                aria-label={t('pi.refineNamed', { name: section.label })}
                onClick={() => onRefine(section.id, current.revision)}>{t('pi.refineSection')}</Button>}
            </div>
            {current.sections[section.id]
              ? <MarkdownRenderer content={current.sections[section.id]!} resolveImageSrc={noInlineImages} />
              : <p className="pi-subtle">{t('pi.pendingSection')}</p>}
          </section>)}
        </>}
      </div>
    </aside>
  )
}
