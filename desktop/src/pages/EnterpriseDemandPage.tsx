import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Plus, RotateCw } from 'lucide-react'
import { SettingsGroup, SettingsPageHeader } from '@/components/settings/SettingsSection'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { TextArea } from '@/components/ui/TextArea'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import type { DesktopEnterpriseHost, EnterpriseBootstrap } from '@/lib/desktopHost/enterprise'
import {
  blankDemandDraft, demandDraftFields, type EnterpriseDemandDetail, type EnterpriseDemandDraft, type EnterpriseDemandIssue,
  type EnterpriseDemandResult, type EnterpriseDemandStatus, type EnterpriseDemandSummary, type EnterpriseDemandTemplate,
} from '@/lib/desktopHost/enterpriseDemand'
import type { EnterpriseDemandDraftConflict, EnterpriseDemandLocalRecord, EnterpriseDemandLocalSummary } from '@/lib/desktopHost/enterpriseDemandLocal'
import { SETTINGS_TAB_ID, useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import { EnterpriseDemandMergePanel } from './EnterpriseDemandMergePanel'

const draftRoles = ['requester', 'developer', 'project_owner', 'it_lead', 'platform_admin']
const pendingStates = ['SUBMITTING', 'PENDING'] as const
const pending = (detail: EnterpriseDemandDetail | null) =>
  pendingStates.some(state => detail?.state === state) || detail?.submission?.state === 'UNCONFIRMED'

function dateLabel(timestamp: string) {
  return new Date(timestamp).toLocaleString()
}

function formFor(detail: EnterpriseDemandDetail | null) {
  return detail?.draft ?? detail?.activeVersion?.snapshot.draft ?? blankDemandDraft
}

type DraftMerge = {
  local: EnterpriseDemandDraft
  cloud: EnterpriseDemandDraft
  base: EnterpriseDemandDraft | null
  baseRevision: number
  cloudRevision: number
} & ({ target: 'local'; record: EnterpriseDemandLocalRecord; deviceId: string }
  | { target: 'cloud'; detail: EnterpriseDemandDetail })

function DemandPanel({ host, active }: { host: DesktopEnterpriseHost; active: boolean }) {
  const t = useTranslation()
  const [user, setUser] = useState<EnterpriseBootstrap['user'] | null>(null)
  const [status, setStatus] = useState<EnterpriseDemandStatus | null>(null)
  const [templates, setTemplates] = useState<EnterpriseDemandTemplate[]>([])
  const [list, setList] = useState<EnterpriseDemandSummary[]>([])
  const [selected, setSelected] = useState<EnterpriseDemandDetail | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [form, setForm] = useState<EnterpriseDemandDraft>(blankDemandDraft)
  const [cloudOnline, setCloudOnline] = useState(false)
  const [localDevice, setLocalDevice] = useState<string | null>(null)
  const [localList, setLocalList] = useState<EnterpriseDemandLocalSummary[]>([])
  const [localSelected, setLocalSelected] = useState<EnterpriseDemandLocalRecord | null>(null)
  const [localNotice, setLocalNotice] = useState<'saved' | 'exported' | 'synced' | 'newer' | 'merged' | null>(null)
  const [merge, setMerge] = useState<DraftMerge | null>(null)
  const [unreadable, setUnreadable] = useState(0)
  const [processCode, setProcessCode] = useState('')
  const [approvers, setApprovers] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<EnterpriseDemandIssue | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const busyRef = useRef(false)
  const retry = useRef<{ fingerprint: string; key: string } | null>(null)
  const boundDevice = useRef<string | null>(null)
  const localId = useRef<string | null>(null)

  const canDraft = user?.roles.some(role => draftRoles.includes(role)) === true
  const isLead = user?.roles.includes('it_lead') === true
  const isOwner = Boolean(user && selected?.ownerId === user.id)
  const baseForm = localSelected?.draft ?? formFor(selected)
  const editable = Boolean(localSelected || isNew || (selected?.draft && ((isOwner && canDraft) || (isLead && selected.state === 'IMPORT_REVIEW'))))
  const dirty = editable && JSON.stringify(form) !== JSON.stringify(baseForm)
  const localReady = Boolean(localDevice && host.demandLocal)
  const currentTemplate = templates.find(template => template.processCode === processCode)
  const hasApprovers = currentTemplate?.approverOptions.every(option => approvers[option.actionerKey]?.some(id => option.allowedUserIds.includes(id))) === true
  const isPrechecked = selected?.precheck?.draftRevision === selected?.draftRevision && Boolean(selected?.precheck)
  const needsNewRevision = Boolean(selected && ['BACKLOG', 'REJECTED', 'CANCELLED'].includes(selected.state)
    && selected.activeVersion?.snapshot.draftRevision === selected.draftRevision)
  const canSubmit = Boolean(cloudOnline && selected && !merge && !localSelected && !dirty && isOwner && canDraft && isPrechecked && !pending(selected)
    && selected.state !== 'IMPORT_REVIEW' && !needsNewRevision && status?.oaConfigured && hasApprovers)
  const canReconcile = Boolean(cloudOnline && selected && status?.oaConfigured && (isOwner || isLead) && pending(selected))

  const accept = useCallback(<T,>(result: { ok: true; data: T } | Extract<EnterpriseDemandResult, { ok: false }>): T | null => {
    if (result.ok) return result.data
    setIssue(result.issue)
    return null
  }, [])

  const run = useCallback(async (operation: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setIssue(null)
    try { await operation() } catch { setIssue('unavailable') } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  const loadPage = useCallback(async (offset = 0) => {
    const result = accept(await host.demand({ action: 'list', offset }))
    if (!result) return
    setList(previous => offset ? [...new Map([...previous, ...result.demands].map(item => [item.id, item])).values()] : result.demands)
    setHasMore(result.demands.length === 30)
  }, [host, accept])

  const updateDetail = useCallback((detail: EnterpriseDemandDetail) => {
    setMerge(null)
    setSelected(detail)
    setForm(formFor(detail))
    setIsNew(false)
    setLocalSelected(null)
    localId.current = null
    setList(previous => previous.map(item => item.id === detail.id
      ? { ...item, title: detail.title, state: detail.state, updatedAt: detail.updatedAt, revision: detail.revision, draftRevision: detail.draftRevision }
      : item))
  }, [])

  const setBinding = useCallback((deviceId: string | null) => {
    if (boundDevice.current === deviceId) return
    boundDevice.current = deviceId
    setCloudOnline(false)
    setUser(null)
    setStatus(null)
    setTemplates([])
    setList([])
    setHasMore(false)
    setLocalDevice(null)
    setLocalList([])
    setUnreadable(0)
    setSelected(null)
    setForm(blankDemandDraft)
    setIsNew(false)
    setLocalSelected(null)
    setLocalNotice(null)
    setMerge(null)
    setApprovers({})
    retry.current = null
    localId.current = null
  }, [])

  const loadLocal = useCallback(async () => {
    if (!host.demandLocal) return null
    const result = await host.demandLocal({ action: 'list' })
    if (!result.ok) {
      setLocalDevice(null)
      setLocalList([])
      setUnreadable(0)
      if (result.issue === 'unbound') setBinding(null)
      else setIssue(result.issue)
      return null
    }
    setBinding(result.data.deviceId)
    setLocalDevice(result.data.deviceId)
    setLocalList(result.data.drafts)
    setUnreadable(result.data.unreadable)
    return result.data.deviceId
  }, [host, setBinding])

  const loadOverview = useCallback(async () => {
    const local = await loadLocal()
    const connection = await host.sync()
    if (connection.state !== 'connected' || !connection.bootstrap) {
      setCloudOnline(false)
      setStatus(null)
      setTemplates([])
      if (!local) setBinding(null)
      setIssue(connection.state === 'unavailable' ? 'unavailable' : 'unbound')
      return false
    }
    const deviceId = connection.bootstrap.device.id
    if (local && local !== deviceId) await loadLocal()
    setBinding(deviceId)
    setCloudOnline(true)
    setUser(connection.bootstrap.user)
    const [state, configurations] = await Promise.all([
      host.demand({ action: 'status' }), host.demand({ action: 'templates' }), loadPage(),
    ])
    setStatus(accept(state))
    const available = accept(configurations)?.templates ?? []
    setTemplates(available)
    setProcessCode(previous => available.some(template => template.processCode === previous) ? previous : available[0]?.processCode ?? '')
    return true
  }, [host, loadPage, loadLocal, setBinding, accept])

  useEffect(() => {
    if (!active) return
    if (host.demandLocal) void loadOverview().catch(() => setIssue('unavailable'))
    else void run(async () => { await loadOverview() })
  }, [active, host, run, loadOverview])

  const open = (id: string) => void run(async () => {
    setLocalNotice(null)
    const result = accept(await host.demand({ action: 'get', id }))
    if (result) updateDetail(result)
  })

  const openLocal = (id: string) => void run(async () => {
    if (!host.demandLocal || !localDevice) return
    const record = accept(await host.demandLocal({ action: 'get', deviceId: localDevice, id }))
    if (!record) return
    setMerge(null)
    setLocalNotice(null)
    setSelected(null)
    setLocalSelected(record)
    setForm(record.draft)
    setIsNew(false)
    localId.current = record.id
  })

  useEffect(() => {
    if (!active || !cloudOnline || !selected || !pending(selected) || dirty || busy || merge) return
    const timer = window.setInterval(() => {
      if (busyRef.current || document.visibilityState === 'hidden') return
      void host.demand({ action: 'get', id: selected.id }).then(result => {
        if (result.ok && !busyRef.current) setSelected(current => current?.id === result.data.id && current.draftRevision === result.data.draftRevision ? result.data : current)
      }).catch(() => {})
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [active, busy, cloudOnline, dirty, host, merge, selected])

  const showLocal = (record: EnterpriseDemandLocalRecord) => {
    setLocalSelected(record)
    setForm(record.draft)
    setIsNew(false)
    const { draft, ...summary } = record
    setLocalList(previous => [{ ...summary, title: draft.title }, ...previous.filter(item => item.id !== record.id)])
  }

  const saveLocalSnapshot = async () => {
    if (!host.demandLocal || !localDevice) return null
    if (localSelected && !dirty) return localSelected
    const id = localSelected?.id ?? (localId.current ??= crypto.randomUUID())
    const cloud = localSelected ? localSelected.cloud
      : selected ? { id: selected.id, demandNo: selected.demandNo, draftRevision: selected.draftRevision } : null
    const record = accept(await host.demandLocal({
      action: 'save', id, deviceId: localDevice, expectedLocalRevision: localSelected?.revision ?? null, cloud, draft: form,
      ...(!localSelected && cloud && selected?.draft ? { baseDraft: selected.draft } : {}),
    }))
    if (record) showLocal(record)
    return record
  }

  const saveLocal = () => void run(async () => {
    setLocalNotice(null)
    if (await saveLocalSnapshot()) setLocalNotice('saved')
  })

  const exportLocal = () => void run(async () => {
    setLocalNotice(null)
    if (!host.demandLocal || !localDevice) return
    const record = await saveLocalSnapshot()
    if (!record) return
    const result = accept(await host.demandLocal({
      action: 'export', deviceId: localDevice, id: record.id, expectedLocalRevision: record.revision,
    }))
    if (result?.saved) setLocalNotice('exported')
  })

  const compareLocal = (conflict: EnterpriseDemandDraftConflict | undefined, record: EnterpriseDemandLocalRecord, deviceId: string) => {
    if (!conflict || boundDevice.current !== deviceId || conflict.local.id !== record.id ||
      !conflict.local.cloud || conflict.local.cloud.id !== record.cloud?.id || conflict.latest.cloud.id !== conflict.local.cloud.id ||
      conflict.latest.cloud.draftRevision <= conflict.local.cloud.draftRevision) return
    setIssue(null)
    showLocal(conflict.local)
    setMerge({ target: 'local', deviceId, record: conflict.local, local: conflict.local.draft, base: conflict.baseDraft,
      cloud: conflict.latest.draft, baseRevision: conflict.local.cloud.draftRevision, cloudRevision: conflict.latest.cloud.draftRevision })
  }

  const applyMerge = (draft: EnterpriseDemandDraft) => {
    if (!merge) return
    if (merge.target === 'cloud') {
      setIssue(null)
      updateDetail(merge.detail)
      setForm(draft)
      return
    }
    void run(async () => {
      if (!host.demandLocal || boundDevice.current !== merge.deviceId) return
      const reply = await host.demandLocal({ action: 'merge', deviceId: merge.deviceId, id: merge.record.id,
        expectedLocalRevision: merge.record.revision, expectedCloudRevision: merge.cloudRevision, draft })
      if (boundDevice.current !== merge.deviceId) return
      if (!reply.ok) {
        setIssue(reply.issue)
        compareLocal(reply.conflict, merge.record, merge.deviceId)
        if (reply.issue === 'forbidden' || reply.issue === 'unbound' || reply.issue === 'notFound') setMerge(null)
        return
      }
      showLocal(reply.data)
      setMerge(null)
      setLocalNotice('merged')
    })
  }

  const save = () => void run(async () => {
    setLocalNotice(null)
    if (host.demandLocal && localDevice) {
      const record = await saveLocalSnapshot()
      if (!record) return
      const reply = await host.demandLocal({
        action: 'sync', id: record.id, deviceId: localDevice, expectedLocalRevision: record.revision,
      })
      if (boundDevice.current !== localDevice) return
      if (!reply.ok) {
        setIssue(reply.issue)
        compareLocal(reply.conflict, record, localDevice)
        return
      }
      const result = reply.data
      setLocalList(previous => previous.filter(item => item.id !== record.id))
      updateDetail(result.demand)
      if (result.draft) showLocal(result.draft)
      setLocalNotice(result.draft ? 'newer' : 'synced')
      if (cloudOnline) await loadPage()
      else await loadOverview()
      return
    }
    const device = boundDevice.current
    const reply = await (selected
      ? host.demand({ action: 'edit', id: selected.id, expectedDraftRevision: selected.draftRevision, draft: form })
      : host.demand({ action: 'create', draft: form }))
    if (boundDevice.current !== device) return
    if (reply.ok) {
      updateDetail(reply.data)
      await loadPage()
    } else {
      setIssue(reply.issue)
      if (reply.issue !== 'conflict' || !selected?.draft) return
      const latest = await host.demand({ action: 'get', id: selected.id })
      if (!latest.ok || boundDevice.current !== device) return
      const detail = latest.data
      const canEdit = (detail.ownerId === user?.id && canDraft) || (isLead && detail.state === 'IMPORT_REVIEW')
      if (canEdit && detail.draft && detail.id === selected.id && detail.draftRevision > selected.draftRevision) {
        setIssue(null)
        setMerge({ target: 'cloud', detail, local: form, cloud: detail.draft, base: selected.draft,
          baseRevision: selected.draftRevision, cloudRevision: detail.draftRevision })
      }
    }
  })

  const submit = () => {
    if (!selected || !currentTemplate || !canSubmit) return
    const approval = currentTemplate.approverOptions.map(option => ({
      actionerKey: option.actionerKey, actionerUserIds: (approvers[option.actionerKey] ?? []).filter(id => option.allowedUserIds.includes(id)).sort(),
    }))
    const fingerprint = JSON.stringify([selected.id, selected.draftRevision, processCode, approval])
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: crypto.randomUUID() }
    const idempotencyKey = retry.current.key
    void run(async () => {
      const result = accept(await host.demand({
        action: 'submit', id: selected.id, expectedDraftRevision: selected.draftRevision,
        processCode, idempotencyKey, approverSelections: approval,
      }))
      if (result) {
        retry.current = null
        updateDetail(result.demand)
      }
    })
  }

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1120px] space-y-5 px-5 py-6 sm:px-10 sm:py-9">
        <SettingsPageHeader title={t('enterpriseDemand.title')} description={t('enterpriseDemand.description')} action={
          <>
            <Button variant="secondary" disabled={busy || dirty || Boolean(merge)} icon={<RotateCw size={14} />} onClick={() => void run(async () => {
              const device = boundDevice.current
              const connected = await loadOverview()
              if (connected && selected && !localSelected && device === boundDevice.current) {
                const result = accept(await host.demand({ action: 'get', id: selected.id }))
                if (result) updateDetail(result)
              }
            })}>{t('settings.enterprise.refresh')}</Button>
            {(canDraft || (localReady && !cloudOnline)) && <Button disabled={busy || dirty || Boolean(merge)} icon={<Plus size={14} />} onClick={() => {
              setSelected(null)
              setLocalSelected(null)
              setForm(blankDemandDraft)
              setIsNew(true)
              setIssue(null)
              setLocalNotice(null)
              localId.current = null
            }}>{t('enterpriseDemand.new')}</Button>}
          </>
        } />
        {issue && <p role="alert" className="rounded-[var(--radius-md)] bg-[var(--color-error-container)] px-3 py-2 text-sm text-[var(--color-on-error-container)]">
          {t(`enterpriseDemand.issue.${issue}`)} {issue === 'conflict' && localSelected && t('enterpriseDemand.localConflictHint')}
        </p>}
        {localNotice && <p role="status" className="px-1 text-sm text-[var(--color-text-secondary)]">{t(`enterpriseDemand.localNotice.${localNotice}`)}</p>}
        {!user && !localReady && issue === 'unbound' && <Button variant="secondary" onClick={() => {
          useUIStore.getState().setPendingSettingsTab('general')
          useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
        }}>{t('settings.enterprise.title')}</Button>}
        {(user || localReady) && <div className="grid items-start gap-4 lg:grid-cols-[minmax(190px,1fr)_minmax(0,2.5fr)]">
          <SettingsGroup className="min-w-0">
            {localReady && <section>
              <h3 className="px-4 py-3 text-sm font-semibold">{t('enterpriseDemand.localList')}</h3>
              {unreadable > 0 && <p className="px-4 pb-2 text-xs text-[var(--color-text-secondary)]">
                {t('enterpriseDemand.localUnreadable', { count: unreadable })}
              </p>}
              {localList.length === 0 && <p className="px-4 pb-3 text-xs text-[var(--color-text-secondary)]">{t('enterpriseDemand.localEmpty')}</p>}
              {localList.map(item => <button key={item.id} type="button" aria-current={item.id === localSelected?.id ? 'true' : undefined}
                disabled={busy || dirty || Boolean(merge)}
                className="block w-full min-w-0 px-4 py-3 text-left hover:bg-[var(--color-surface-hover)] aria-[current=true]:bg-[var(--color-brand-soft)] disabled:opacity-60"
                onClick={() => openLocal(item.id)}>
                <span className="block break-words text-sm font-medium">{item.title || t('enterpriseDemand.untitled')}</span>
                <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                  <Badge>{t('enterpriseDemand.localUnsynced')}</Badge>{item.cloud?.demandNo}
                </span>
              </button>)}
            </section>}
            {cloudOnline && user && <section>
              <h3 className="px-4 py-3 text-sm font-semibold">{t('enterpriseDemand.list')}</h3>
              {list.length === 0 && <p className="px-4 py-3 text-sm text-[var(--color-text-secondary)]">{t('enterpriseDemand.empty')}</p>}
              {list.map(item => <button key={item.id} type="button" aria-current={!localSelected && item.id === selected?.id ? 'true' : undefined}
                disabled={busy || dirty || Boolean(merge)}
                className="block w-full min-w-0 px-4 py-3 text-left hover:bg-[var(--color-surface-hover)] aria-[current=true]:bg-[var(--color-brand-soft)] disabled:opacity-60"
                onClick={() => open(item.id)}>
                <span className="block break-words text-sm font-medium">{item.title || t('enterpriseDemand.untitled')}</span>
                <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                  {item.demandNo}<Badge>{t(`enterpriseDemand.state.${item.state}`)}</Badge>
                </span>
              </button>)}
              {hasMore && <div className="p-3"><Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => loadPage(list.length))}>{t('enterpriseDemand.more')}</Button></div>}
            </section>}
          </SettingsGroup>

          {(selected || isNew || localSelected) && <SettingsGroup className="min-w-0">
            <header className="space-y-2 px-4 py-4">
              <h3 className="break-words font-semibold">{localSelected?.draft.title || selected?.title || t(isNew ? 'enterpriseDemand.new' : 'enterpriseDemand.untitled')}</h3>
              {localSelected && <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge>{t('enterpriseDemand.localUnsynced')}</Badge>{localSelected.cloud?.demandNo}
                <time dateTime={localSelected.updatedAt}>{dateLabel(localSelected.updatedAt)}</time>
              </div>}
              {selected && <div className="flex flex-wrap items-center gap-2 text-xs">
                {selected.demandNo}<Badge tone={selected.state === 'BACKLOG' ? 'success' : 'neutral'}>{t(`enterpriseDemand.state.${selected.state}`)}</Badge>
                <time dateTime={selected.updatedAt}>{dateLabel(selected.updatedAt)}</time>
                {selected.activeVersion && <Badge>{t('enterpriseDemand.version', { version: selected.activeVersion.versionNo })}</Badge>}
              </div>}
              {pending(selected) && editable && <p className="text-xs text-[var(--color-text-secondary)]">{t('enterpriseDemand.nextDraftHint')}</p>}
            </header>
            {merge && <EnterpriseDemandMergePanel key={JSON.stringify([merge.target, merge.target === 'local' ? merge.record.revision : merge.detail.id, merge.cloudRevision])}
              local={merge.local} cloud={merge.cloud} base={merge.base} baseRevision={merge.baseRevision} cloudRevision={merge.cloudRevision}
              busy={busy} onApply={applyMerge} onClose={() => { setMerge(null); setIssue(null) }} />}
            {!merge && (selected?.draft || selected?.activeVersion || isNew || localSelected) && <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
              {demandDraftFields.map(field => {
                const props = {
                  label: t(`enterpriseDemand.field.${field.key}`), value: form[field.key], maxLength: field.limit,
                  readOnly: !editable, disabled: busy,
                  onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                    const value = event.target.value
                    setForm(previous => ({ ...previous, [field.key]: value }))
                  },
                }
                return 'multiline' in field
                  ? <TextArea key={field.key} {...props} rows={3} containerClassName="sm:col-span-2" />
                  : <Input key={field.key} {...props} />
              })}
              {form.attachmentRefs.length > 0 && <p className="text-xs sm:col-span-2">{form.attachmentRefs.map(file => file.name).join(' · ')}</p>}
              {editable && <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                <Button size="sm" disabled={busy || (!cloudOnline && !localReady) || (!dirty && !isNew && !localSelected)} onClick={save}>
                  {t(localReady ? 'enterpriseDemand.saveCloud' : 'enterpriseDemand.save')}
                </Button>
                {localReady && <Button size="sm" variant="secondary" disabled={busy || (!dirty && !isNew)} onClick={saveLocal}>{t('enterpriseDemand.saveLocal')}</Button>}
                {localReady && <Button size="sm" variant="ghost" disabled={busy || (!dirty && !isNew && !localSelected)} onClick={exportLocal}>{t('enterpriseDemand.exportLocal')}</Button>}
                {dirty && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(baseForm)}>{t('enterpriseDemand.discard')}</Button>}
                {selected && cloudOnline && <Button size="sm" variant="secondary" disabled={busy || dirty || Boolean(localSelected) || !status?.aiPrecheckConfigured || !!selected.validation?.missing.length}
                  onClick={() => void run(async () => {
                    const result = accept(await host.demand({ action: 'precheck', id: selected.id, expectedDraftRevision: selected.draftRevision }))
                    if (result) updateDetail(result)
                  })}>{t('enterpriseDemand.precheck')}</Button>}
              </div>}
              {editable && <p className="text-xs text-[var(--color-text-secondary)] sm:col-span-2">{t('enterpriseDemand.required')}</p>}
            </div>}
            {selected?.activeVersion && <details className="px-4 py-3 text-sm">
              <summary className="cursor-pointer font-semibold">{t('enterpriseDemand.frozenVersion', { version: selected.activeVersion.versionNo })}</summary>
              <dl className="mt-2 space-y-2">
                {demandDraftFields.filter(field => selected.activeVersion?.snapshot.draft[field.key]).map(field => <div key={field.key}>
                  <dt className="font-medium">{t(`enterpriseDemand.field.${field.key}`)}</dt>
                  <dd className="whitespace-pre-wrap break-words">{selected.activeVersion?.snapshot.draft[field.key]}</dd>
                </div>)}
              </dl>
              {selected.activeVersion.snapshot.draft.attachmentRefs.length > 0 && <p className="mt-2 break-words text-xs">
                {selected.activeVersion.snapshot.draft.attachmentRefs.map(file => file.name).join(' · ')}
              </p>}
            </details>}
            {!localSelected && selected?.precheck && <section className="space-y-2 px-4 py-4 text-sm">
              <h4 className="font-semibold">{t('enterpriseDemand.precheck')}</h4>
              <p className="whitespace-pre-wrap break-words">{selected.precheck.summary}</p>
              {[...selected.precheck.questions, ...selected.precheck.risks].map((item, index) => <p key={index} className="break-words">• {item}</p>)}
            </section>}
            {selected && (selected.submission || selected.approval || selected.approvedVersion) && <section className="space-y-2 px-4 py-4 text-sm">
              <h4 className="font-semibold">{t('enterpriseDemand.progress')}</h4>
              {selected.submission && <Badge>{t(`enterpriseDemand.submission.${selected.submission.state}`)}</Badge>}
              {selected.approval && <p className="break-all">{t('enterpriseDemand.instance', { id: selected.approval.instanceId })} · {t(`enterpriseDemand.approval.${selected.approval.state}`)}</p>}
              {selected.approval?.verifiedAt && <p>{t('enterpriseDemand.verified', { time: dateLabel(selected.approval.verifiedAt) })}</p>}
              {selected.approvedVersion && <p>{t('enterpriseDemand.approvedVersion', { version: selected.approvedVersion.versionNo })}</p>}
              {selected.unsubmittedChanges && <p>{t('enterpriseDemand.unsubmitted')}</p>}
              {canReconcile && <Button variant="secondary" size="sm" disabled={busy || dirty || Boolean(localSelected)} onClick={() => void run(async () => {
                const result = accept(await host.demand({ action: 'reconcile', id: selected.id }))
                if (result) updateDetail(result)
              })}>{t('enterpriseDemand.reconcile')}</Button>}
            </section>}
            {selected && cloudOnline && isOwner && canDraft && <section className="space-y-3 px-4 py-4">
              <h4 className="font-semibold">{t('enterpriseDemand.submit')}</h4>
              {status && !status.oaConfigured && <p className="text-xs">{t('enterpriseDemand.issue.dingtalk')}</p>}
              {status && !status.aiPrecheckConfigured && <p className="text-xs">{t('enterpriseDemand.issue.precheck')}</p>}
              {templates.length > 0 && <label className="block text-sm">
                {t('enterpriseDemand.template')}
                <select className="mt-1 block w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
                  disabled={busy || pending(selected)} value={processCode}
                  onChange={event => { setProcessCode(event.target.value); setApprovers({}) }}>
                  {templates.map(template => <option key={template.processCode} value={template.processCode}>{template.label}</option>)}
                </select>
              </label>}
              {currentTemplate?.approverOptions.map(option => <fieldset key={option.actionerKey} disabled={busy || pending(selected)}>
                <legend className="text-sm font-medium">{option.label}</legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {option.allowedUserIds.map(id => <label key={id} className="flex items-center gap-1.5 break-all text-xs">
                    <input type="checkbox" checked={approvers[option.actionerKey]?.includes(id) === true}
                      disabled={(approvers[option.actionerKey]?.length ?? 0) >= 20 && !approvers[option.actionerKey]?.includes(id)}
                      onChange={event => {
                        const checked = event.target.checked
                        setApprovers(previous => {
                          const current = previous[option.actionerKey] ?? []
                          return { ...previous, [option.actionerKey]: checked ? [...current, id] : current.filter(item => item !== id) }
                        })
                      }} />{id}
                  </label>)}
                </div>
              </fieldset>)}
              <Button size="sm" disabled={busy || !canSubmit} onClick={submit}>{t('enterpriseDemand.submit')}</Button>
              <p className="text-xs text-[var(--color-text-secondary)]">{t('enterpriseDemand.submitHint')}</p>
            </section>}
          </SettingsGroup>}
        </div>}
      </div>
    </main>
  )
}

export function EnterpriseDemandPage({ active = true }: { active?: boolean }) {
  const host = getDesktopHost().enterprise
  return host?.demand ? <DemandPanel host={host} active={active} /> : null
}
