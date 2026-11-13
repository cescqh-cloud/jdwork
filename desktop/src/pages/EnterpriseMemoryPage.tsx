import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Plus, RotateCw, Search } from 'lucide-react'
import { SettingsPageHeader } from '@/components/settings/SettingsSection'
import { ActionDialog } from '@/components/ui/ActionDialog'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { TextArea } from '@/components/ui/TextArea'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import type { DesktopEnterpriseHost } from '@/lib/desktopHost/enterprise'
import { memoryScopes, type EnterpriseKnowledgeDetail, type EnterpriseMemory, type EnterpriseMemoryHost,
  type EnterpriseMemoryIssue, type EnterpriseMemoryRequest, type EnterpriseMemoryResult, type EnterpriseMemoryScope } from '@/lib/desktopHost/enterpriseMemory'
import { memoryEntryKey } from '@/lib/desktopHost/enterpriseMemoryCache'
import { useEnterpriseMemory } from '@/lib/desktopHost/useEnterpriseMemory'
import { SETTINGS_TAB_ID, useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import { MemoryConflictPanel, type MemoryConflict, type MemoryVersionChoice } from './enterpriseMemory/MemoryConflictPanel'

const sections = [...memoryScopes, 'knowledge', 'candidates'] as const
type Section = typeof sections[number]
type Item = { id: string; revision: number; label: string; source: string; type: 'memory' | 'knowledge' }
type EditState = { record: EnterpriseMemory; body: string }

function MemoryPanel({ host, memory }: { host: DesktopEnterpriseHost; memory: EnterpriseMemoryHost }) {
  const t = useTranslation()
  const hub = useEnterpriseMemory(host, memory)
  const [section, setSection] = useState<Section>('user_private')
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Map<string, number> | null>(null)
  const [selected, setSelected] = useState<Item | null>(null)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [conflict, setConflict] = useState<MemoryConflict | null>(null)
  const [document, setDocument] = useState<EnterpriseKnowledgeDetail | null>(null)
  const [draft, setDraft] = useState<{ scope: EnterpriseMemoryScope; scopeId: string; body: string } | null>(null)
  const [issue, setIssue] = useState<EnterpriseMemoryIssue | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const submitting = useRef(false)
  const selectionEpoch = useRef(0)
  const retry = useRef<{ fingerprint: string; key: string } | null>(null)

  const visible = Boolean(hub.cache && hub.cache.expiresAt > Date.now())
  const online = visible && !hub.issue
  const items: Item[] = []
  if (visible && section === 'candidates') {
    for (const item of hub.candidates) items.push({ id: item.id, revision: item.revision, label: item.excerpt,
      source: t(`enterpriseMemory.scope.${item.scope}`), type: 'memory' })
  } else if (visible && hub.cache) {
    for (const entry of hub.cache.entries.values()) {
      if (section === 'knowledge' && entry.resourceType === 'knowledge') {
        items.push({ id: entry.id, revision: entry.revision, label: entry.record.title, source: entry.record.source.label, type: 'knowledge' })
      } else if (entry.resourceType === 'memory' && entry.record.scope === section &&
        (!entry.record.expiresAt || Date.parse(entry.record.expiresAt) > Date.now())) {
        items.push({ id: entry.id, revision: entry.revision, label: entry.record.excerpt, source: t(`enterpriseMemory.scope.${entry.record.scope}`), type: 'memory' })
      }
    }
  }
  const selectedCurrent = selected && items.find(item => item.id === selected.id && item.type === selected.type)
  const hasSelectedAccess = Boolean(online && selectedCurrent)
  const canSeeDetail = hasSelectedAccess && selectedCurrent?.revision === selected?.revision
  const record = edit?.record
  const canEdit = Boolean(record && (record.ownerId === hub.user?.id || hub.user?.roles.some(role => role === 'platform_admin' || role === 'it_lead'
    || (record.scope === 'project_private' && role === 'project_owner')) && record.scope !== 'user_private'))
  const canPublish = record?.status === 'candidate' && (record.scope === 'user_private' ? record.ownerId === hub.user?.id
    : hub.user?.roles.some(role => role === 'platform_admin' || role === 'it_lead' || (record.scope === 'project_private' && role === 'project_owner')))
  const canCompare = record?.scope === 'user_private' && record.ownerId === hub.user?.id
  const cloudCurrent = Boolean(conflict?.cloud && selectedCurrent && selectedCurrent.revision <= conflict.cloud.revision &&
    (!conflict.cloud.expiresAt || Date.parse(conflict.cloud.expiresAt) > Date.now()))

  const clearDetail = useCallback(() => {
    selectionEpoch.current++
    setSelected(null)
    setEdit(null)
    setConflict(null)
    setDocument(null)
    setConfirmDelete(false)
  }, [])

  useEffect(() => {
    clearDetail()
    setDraft(null)
    setMatches(null)
    setQuery('')
    setIssue(null)
    retry.current = null
  }, [clearDetail, hub.generation])

  useEffect(() => {
    if (selected && !hasSelectedAccess) clearDetail()
  }, [clearDetail, selected, hasSelectedAccess])

  const cloudExpiry = conflict?.cloud?.expiresAt
  useEffect(() => {
    if (!cloudExpiry) return
    const epoch = selectionEpoch.current
    const delay = Math.max(0, Math.min(Date.parse(cloudExpiry) - Date.now(), 2_147_483_647))
    const timer = window.setTimeout(() => {
      if (selectionEpoch.current === epoch && Date.parse(cloudExpiry) <= Date.now()) clearDetail()
    }, delay)
    return () => window.clearTimeout(timer)
  }, [clearDetail, cloudExpiry])

  async function request<R extends EnterpriseMemoryRequest>(input: R): Promise<EnterpriseMemoryResult<R['action']> | null> {
    if (submitting.current || !online || !hub.cache || hub.cache.expiresAt <= Date.now()) return null
    submitting.current = true
    setBusy(true)
    setIssue(null)
    const epoch = hub.epoch.current
    try {
      const result = await memory(input)
      if (!hub.live.current || hub.epoch.current !== epoch) return null
      if (!result.ok) {
        if (result.issue === 'unbound') hub.clear()
        if (result.issue === 'notFound' || result.issue === 'forbidden') {
          clearDetail()
          void hub.refresh()
        }
        setIssue(result.issue)
      }
      return result
    } catch {
      if (hub.live.current && hub.epoch.current === epoch) setIssue('unavailable')
      return null
    } finally {
      submitting.current = false
      if (hub.live.current) setBusy(false)
    }
  }

  function switchSection(next: Section) {
    setSection(next)
    clearDetail()
    setDraft(null)
    setQuery('')
    setMatches(null)
    setIssue(null)
  }

  async function search(event: FormEvent) {
    event.preventDefault()
    if (!query.trim() || section === 'candidates') { setMatches(null); return }
    const result = section === 'knowledge'
      ? await request({ action: 'searchKnowledge', query }) : await request({ action: 'searchMemory', query, scope: section })
    if (result?.ok) setMatches(new Map(result.data.items.map(item => [item.id, item.revision])))
  }

  async function readConflict(base: EditState) {
    if (!hasSelectedAccess || base.record.scope !== 'user_private' || base.record.ownerId !== hub.user?.id) return
    const { id, revision } = base.record
    const epoch = selectionEpoch.current
    setConflict(previous => previous?.id === id
      ? { ...previous, cloud: null, basedOn: null }
      : { id, originalBody: base.body, originalRevision: revision, cloud: null, draft: null, basedOn: null })
    const result = await request({ action: 'getMemory', id })
    if (!result?.ok || selectionEpoch.current !== epoch) return
    const latest = result.data
    if (latest.id !== id || latest.ownerId !== base.record.ownerId || latest.scope !== 'user_private' || latest.status === 'deleted' ||
      (latest.expiresAt && Date.parse(latest.expiresAt) <= Date.now())) {
      clearDetail()
      setIssue('forbidden')
      return
    }
    setConflict(previous => previous?.id === id ? { ...previous, cloud: latest } : previous)
  }

  async function open(item: Item) {
    if (item.type === 'memory' && edit && canCompare && item.id === selected?.id &&
      (conflict || (item.revision > edit.record.revision && edit.body !== edit.record.body))) {
      if (!conflict || !cloudCurrent) await readConflict(edit)
      return
    }
    clearDetail()
    const epoch = selectionEpoch.current
    setDraft(null)
    if (item.type === 'knowledge') {
      const result = await request({ action: 'getKnowledge', id: item.id, revision: item.revision })
      if (selectionEpoch.current !== epoch) return
      if (result?.ok && result.data.id === item.id && result.data.revision === item.revision &&
        result.data.citation.documentId === item.id && result.data.citation.revision === item.revision) {
        setSelected(item)
        setDocument(result.data)
      }
    } else {
      const result = await request({ action: 'getMemory', id: item.id })
      if (selectionEpoch.current !== epoch) return
      if (result?.ok && result.data.id === item.id && result.data.revision === item.revision) {
        setSelected(item)
        setEdit({ record: result.data, body: result.data.body })
      } else if (result?.ok) {
        setIssue('conflict')
        void hub.refresh()
      }
    }
  }

  async function saveDraft(event: FormEvent) {
    event.preventDefault()
    if (!draft || !draft.body.trim() || (draft.scope !== 'user_private' && !draft.scopeId)) return
    const fingerprint = JSON.stringify(draft)
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: crypto.randomUUID() }
    const result = await request({ action: 'create', scope: draft.scope, body: draft.body,
      ...(draft.scope === 'project_private' ? { projectId: draft.scopeId } : {}),
      ...(draft.scope === 'team_shared' ? { departmentId: draft.scopeId } : {}), idempotencyKey: retry.current.key })
    if (result?.ok) {
      retry.current = null
      switchSection('candidates')
      await hub.refreshAfterMutation()
    }
  }

  async function mutate(action: 'edit' | 'publish' | 'delete') {
    if (!edit) return
    const base = { id: edit.record.id, revision: edit.record.revision }
    const result = action === 'edit' ? await request({ ...base, action, body: edit.body }) : await request({ ...base, action })
    if (result?.ok) {
      setConfirmDelete(false)
      switchSection(result.data.status === 'candidate' ? 'candidates' : result.data.scope)
      await hub.refreshAfterMutation()
    } else if (result) {
      setConfirmDelete(false)
      if (action === 'edit' && result.issue === 'conflict' && canCompare) await readConflict(edit)
      else void hub.refresh()
    }
  }

  function chooseVersion(choice: MemoryVersionChoice) {
    if (!cloudCurrent) return
    setConflict(current => current?.cloud ? { ...current, basedOn: current.cloud.revision,
      draft: choice === 'cloud' ? current.cloud.body : choice === 'local' ? current.originalBody : current.draft } : current)
  }

  async function saveResolution() {
    if (!edit || !hasSelectedAccess || !cloudCurrent || !conflict?.cloud || !conflict.draft?.trim() ||
      conflict.basedOn !== conflict.cloud.revision) return
    const result = await request({ action: 'edit', id: conflict.id, revision: conflict.cloud.revision, body: conflict.draft })
    if (result?.ok) {
      switchSection(result.data.status === 'candidate' ? 'candidates' : result.data.scope)
      await hub.refreshAfterMutation()
    } else if (result?.issue === 'conflict') {
      await readConflict(edit)
    }
  }

  function connectionSettings() {
    useUIStore.getState().setPendingSettingsTab('general')
    useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
  }

  const activeIssue = (issue === 'conflict' && conflict ? null : issue) ?? hub.issue
  const shown = matches ? items.filter(item => matches.get(item.id) === item.revision) : items
  const revisionChanged = Boolean(online && selectedCurrent && selected?.revision !== selectedCurrent.revision)

  return (
    <div className="h-full overflow-auto bg-[var(--color-bg-primary)] p-5 md:p-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <SettingsPageHeader title={t('enterpriseMemory.title')} description={t('enterpriseMemory.description')} action={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={hub.syncing || busy} onClick={() => void hub.refresh()}><RotateCw size={14} />{t('settings.enterprise.refresh')}</Button>
            {online && <Button disabled={busy} onClick={() => {
              clearDetail()
              const scope = section === 'knowledge' || section === 'candidates' ? 'user_private' : section
              setDraft({ scope, scopeId: scope === 'team_shared' ? hub.scopes?.department?.id ?? '' : '', body: '' })
            }}><Plus size={14} />{t('enterpriseMemory.new')}</Button>}
          </div>
        } />
        {activeIssue && <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
          {t(`enterpriseMemory.issue.${activeIssue}`)}
          {activeIssue === 'unbound' && <Button size="sm" variant="secondary" onClick={connectionSettings}>{t('settings.enterprise.title')}</Button>}
        </div>}
        {!visible && hub.syncing && <p role="status" className="text-sm text-[var(--color-text-secondary)]">{t('enterpriseMemory.syncing')}</p>}
        {visible && <>
          <nav aria-label={t('enterpriseMemory.title')} className="flex flex-wrap gap-2">
            {sections.map(value => <Button key={value} variant={value === section ? 'primary' : 'secondary'} aria-pressed={value === section}
              size="sm" disabled={busy} onClick={() => switchSection(value)}>{t(`enterpriseMemory.scope.${value}`)}</Button>)}
          </nav>
          {section !== 'candidates' && <form onSubmit={search} className="flex max-w-xl items-center gap-2">
            <Input value={query} maxLength={160} aria-label={t('enterpriseMemory.search')} placeholder={t('enterpriseMemory.search')}
              disabled={!online || busy} onChange={event => { setQuery(event.target.value); if (!event.target.value) setMatches(null) }} />
            <Button type="submit" variant="secondary" disabled={!online || busy || !query.trim()}><Search size={14} />{t('enterpriseMemory.search')}</Button>
          </form>}
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(16rem,1fr)_minmax(0,1.55fr)]">
            <div className="min-w-0 max-h-[65vh] overflow-auto rounded-xl border border-[var(--color-border)]">
              {shown.length === 0 && <p className="p-4 text-sm text-[var(--color-text-secondary)]">{t('enterpriseMemory.empty')}</p>}
              {shown.map(item => <button type="button" key={memoryEntryKey(item.type, item.id)} aria-pressed={item.id === selected?.id}
                disabled={!online || busy} onClick={() => void open(item)}
                className="block w-full min-w-0 border-b border-[var(--color-border)] p-4 text-left hover:bg-[var(--color-bg-hover)] aria-pressed:bg-[var(--color-bg-hover)] disabled:opacity-75">
                <span className="block break-words text-sm leading-5">{item.label}</span>
                <span className="mt-2 block break-words text-xs text-[var(--color-text-secondary)]">{item.source} · {t('enterpriseMemory.version', { revision: String(item.revision) })}</span>
              </button>)}
            </div>
            <div className="min-w-0 space-y-4 rounded-xl border border-[var(--color-border)] p-5">
              {draft && (online || draft.scope === 'user_private') ? <form onSubmit={saveDraft} className="space-y-3">
                <h3 className="font-semibold">{t('enterpriseMemory.new')}</h3>
                <label className="block text-sm">{t('enterpriseMemory.audience')}
                  <select value={draft.scope} disabled={!online || busy} className="mt-1 block w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2"
                    onChange={event => {
                      const scope = event.target.value as EnterpriseMemoryScope
                      setDraft({ ...draft, scope, scopeId: scope === 'team_shared' ? hub.scopes?.department?.id ?? '' : '' })
                    }}>
                    {memoryScopes.map(scope => <option key={scope} value={scope}>{t(`enterpriseMemory.scope.${scope}`)}</option>)}
                  </select>
                </label>
                {draft.scope === 'project_private' && <select value={draft.scopeId} aria-label={t('enterpriseMemory.project')}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2 text-sm"
                  onChange={event => setDraft({ ...draft, scopeId: event.target.value })}>
                  <option value="">{t('enterpriseMemory.project')}</option>
                  {hub.scopes?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>}
                {draft.scope === 'team_shared' && <p className="text-sm text-[var(--color-text-secondary)]">{hub.scopes?.department?.name ?? t('enterpriseMemory.noDepartment')}</p>}
                <TextArea aria-label={t('enterpriseMemory.body')} value={draft.body} rows={6} maxLength={2000} disabled={busy}
                  onChange={event => setDraft({ ...draft, body: event.target.value })} />
                <p className="text-xs text-[var(--color-text-secondary)]">{t('enterpriseMemory.candidateHint')}</p>
                <Button type="submit" disabled={!online || busy || !draft.body.trim() || (draft.scope !== 'user_private' && !draft.scopeId)}>{t('enterpriseMemory.saveCandidate')}</Button>
              </form> : canSeeDetail && document ? <>
                <h3 className="break-words font-semibold">{document.title}</h3>
                <p className="break-words text-xs text-[var(--color-text-secondary)]">{document.source.label} · {t('enterpriseMemory.version', { revision: String(document.revision) })}</p>
                <p className="whitespace-pre-wrap break-words text-sm leading-6">{document.body}</p>
                <p className="break-all text-xs text-[var(--color-text-secondary)]" title={document.citation.checksum}>{document.citation.documentId}</p>
              </> : hasSelectedAccess && canCompare && edit && conflict?.id === edit.record.id ? <MemoryConflictPanel
                conflict={conflict} cloudCurrent={cloudCurrent} busy={busy} onChoose={chooseVersion}
                onEdit={body => setConflict(previous => previous ? { ...previous, draft: body } : previous)}
                onReload={() => void readConflict(edit)} onSave={() => void saveResolution()} />
              : (canSeeDetail || revisionChanged) && edit ? <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{t(`enterpriseMemory.scope.${edit.record.scope}`)}</Badge>
                  <Badge>{t(`enterpriseMemory.status.${edit.record.status}`)}</Badge>
                </div>
                {revisionChanged && <div className="space-y-2">
                  <p role="status" className="text-sm text-[var(--color-text-secondary)]">{t('enterpriseMemory.issue.conflict')}</p>
                  {canCompare && edit.body !== edit.record.body && <Button size="sm" variant="secondary" disabled={busy}
                    onClick={() => void readConflict(edit)}>{t('enterpriseMemory.compareVersions')}</Button>}
                </div>}
                {canEdit ? <TextArea aria-label={t('enterpriseMemory.body')} value={edit.body} rows={7} maxLength={2000} disabled={busy}
                  onChange={event => setEdit({ ...edit, body: event.target.value })} />
                  : <p className="whitespace-pre-wrap break-words text-sm leading-6">{edit.record.body}</p>}
                {edit.record.lastVerifiedAt && <p className="text-xs text-[var(--color-text-secondary)]">{t('enterpriseMemory.verified', { date: new Date(edit.record.lastVerifiedAt).toLocaleString() })}</p>}
                <div className="flex flex-wrap gap-2">
                  {canEdit && <Button variant="secondary" disabled={busy || !canSeeDetail || !edit.body.trim() || edit.body === edit.record.body} onClick={() => void mutate('edit')}>{t('enterpriseMemory.save')}</Button>}
                  {canPublish && <Button disabled={busy || !canSeeDetail || edit.body !== edit.record.body} onClick={() => void mutate('publish')}>{t('enterpriseMemory.publish')}</Button>}
                  {canEdit && <Button variant="ghost" disabled={busy || !canSeeDetail} onClick={() => setConfirmDelete(true)}>{t('enterpriseMemory.delete')}</Button>}
                </div>
              </> : <p className="text-sm text-[var(--color-text-secondary)]">{t('enterpriseMemory.select')}</p>}
            </div>
          </div>
        </>}
        <ActionDialog open={confirmDelete && Boolean(canSeeDetail)} onClose={() => setConfirmDelete(false)} title={t('enterpriseMemory.delete')}
          body={t('enterpriseMemory.deleteHint')} loading={busy} actions={[
            { label: t('common.cancel'), onClick: () => setConfirmDelete(false) },
            { label: t('enterpriseMemory.delete'), variant: 'danger', onClick: () => mutate('delete') },
          ]} />
      </div>
    </div>
  )
}

export function EnterpriseMemoryPage() {
  const host = getDesktopHost().enterprise
  return host?.memory ? <MemoryPanel host={host} memory={host.memory} /> : null
}
