import { useCallback, useEffect, useRef, useState } from 'react'
import { ClipboardCheck, FileCheck2, GitBranch, RotateCw, SquareArrowOutUpRight } from 'lucide-react'
import { SettingsPageHeader } from '@/components/settings/SettingsSection'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { SelectField } from '@/components/ui/SelectField'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import type { DesktopEnterpriseHost } from '@/lib/desktopHost/enterprise'
import {
  deliveryStates, type EnterpriseDeliveryHost, type EnterpriseDeliveryIssue, type EnterpriseDeliveryRun,
  type EnterpriseDeliverySession, type EnterpriseDeliveryTask,
} from '@/lib/desktopHost/enterpriseDelivery'
import { useChatStore } from '@/stores/chatStore'
import { useSessionStore } from '@/stores/sessionStore'
import { SETTINGS_TAB_ID, useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import { DeliveryActionDialog, type DeliveryChange, type DeliveryDialog } from './enterpriseDelivery/DeliveryActionDialog'
import { DeliveryReview } from './enterpriseDelivery/DeliveryReview'

const stageTones: Record<EnterpriseDeliveryTask['state'], Tone> = {
  ASSIGNED: 'neutral', DEVELOPING: 'brand', TESTING: 'info', ACCEPTANCE: 'warning', DELIVERED: 'success',
}
const historyLabels = {
  'delivery.assigned': 'enterpriseDelivery.history.assigned',
  'delivery.binding.changed': 'enterpriseDelivery.history.bound',
  'delivery.development.started': 'enterpriseDelivery.history.developing',
  'delivery.check.completed': 'enterpriseDelivery.history.checked',
  'delivery.materials.changed': 'enterpriseDelivery.history.materialsChanged',
  'delivery.review.accepted': 'enterpriseDelivery.decision.ACCEPT',
  'delivery.review.rework': 'enterpriseDelivery.decision.REWORK',
  'delivery.testing.started': 'enterpriseDelivery.history.testing',
  'delivery.test.recorded': 'enterpriseDelivery.history.tested',
  'delivery.rework.requested': 'enterpriseDelivery.history.rework',
  'delivery.delivered': 'enterpriseDelivery.state.DELIVERED',
} as const
type Current = () => boolean

function openLocalSession(result: EnterpriseDeliverySession, title: string) {
  const sessions = useSessionStore.getState()
  const now = new Date().toISOString()
  const existing = sessions.sessions.find(session => session.id === result.sessionId)
  const chat = useChatStore.getState()
  const draft = chat.sessions[result.sessionId]?.composerDraft
  if (result.draftText && !draft?.input.trim() && !draft?.attachments.length) {
    chat.setComposerDraft(result.sessionId, { input: result.draftText, attachments: [] })
  }
  sessions.openHistoricalSession(existing ?? {
    id: result.sessionId, title, createdAt: now, modifiedAt: now, messageCount: 0, projectPath: '',
    workDir: result.workDir, projectRoot: result.workDir, workDirExists: true,
  })
  chat.connectToSession(result.sessionId)
}

function DeliveryPanel({ host, delivery, active }: { host: DesktopEnterpriseHost; delivery: EnterpriseDeliveryHost; active: boolean }) {
  const t = useTranslation()
  const [tasks, setTasks] = useState<EnterpriseDeliveryTask[]>([])
  const [selected, setSelected] = useState<EnterpriseDeliveryTask | null>(null)
  const [report, setReport] = useState<EnterpriseDeliveryRun | null>(null)
  const [project, setProject] = useState('')
  const [device, setDevice] = useState<{ id: string; userId: string; expiresAt: number } | null>(null)
  const [issue, setIssue] = useState<EnterpriseDeliveryIssue | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<DeliveryDialog | null>(null)
  const operation = useRef(0)
  const working = useRef(false)
  const identity = useRef('')
  const lastSelection = useRef<{ identity: string; id: string } | null>(null)
  const retry = useRef<{ fingerprint: string; key: string } | null>(null)

  const clearDetail = useCallback(() => {
    setSelected(null)
    setReport(null)
    setDialog(null)
    retry.current = null
  }, [])
  const clearConnection = useCallback((retainSelection = false) => {
    identity.current = ''
    if (!retainSelection) lastSelection.current = null
    clearDetail()
    setDevice(null)
    setTasks([])
    setProject('')
  }, [clearDetail])
  const handleIssue = useCallback((problem: EnterpriseDeliveryIssue, id?: string) => {
    if (problem === 'cancelled') return
    if (problem === 'unbound') clearConnection()
    if (id && (problem === 'notFound' || problem === 'forbidden')) {
      lastSelection.current = null
      clearDetail()
      setTasks(previous => previous.filter(task => task.id !== id))
    }
    setIssue(problem)
  }, [clearConnection, clearDetail])
  const run = useCallback(async (work: (current: Current) => Promise<void>, replace = false) => {
    if (working.current && !replace) return
    const epoch = ++operation.current
    const current = () => epoch === operation.current
    working.current = true
    setBusy(true)
    setIssue(null)
    try { await work(current) } catch {
      if (current()) handleIssue('unavailable')
    } finally {
      if (current()) {
        working.current = false
        setBusy(false)
      }
    }
  }, [handleIssue])
  const updateTask = useCallback((task: EnterpriseDeliveryTask) => {
    lastSelection.current = { identity: identity.current, id: task.id }
    setSelected(task)
    setTasks(previous => previous.map(item => item.id === task.id ? task : item))
  }, [])
  const refreshReport = useCallback(async (task: EnterpriseDeliveryTask, current: Current) => {
    setReport(null)
    if (!task.latestRunId) return
    const result = await delivery({ action: 'getCheck', id: task.id, runId: task.latestRunId })
    if (!current()) return
    if (result.ok) setReport(result.data)
    else if (result.issue !== 'forbidden' && result.issue !== 'notFound') handleIssue(result.issue)
  }, [delivery, handleIssue])
  const loadTask = useCallback(async (id: string, current: Current) => {
    const result = await delivery({ action: 'get', id })
    if (!current()) return
    if (!result.ok) { handleIssue(result.issue, id); return }
    updateTask(result.data)
    await refreshReport(result.data, current)
  }, [delivery, handleIssue, refreshReport, updateTask])
  const refresh = useCallback((selectedId?: string, replace = false) => run(async current => {
    const connection = await host.sync().catch(() => null)
    if (!current()) return
    const bootstrap = connection?.bootstrap
    const expiry = Date.parse(bootstrap?.policy.expiresAt ?? '')
    if (connection?.state !== 'connected' || !bootstrap || !bootstrap.policy.features.demands || !(expiry > Date.now())) {
      clearConnection()
      handleIssue(!connection || connection.state === 'unavailable' ? 'unavailable' : 'unbound')
      return
    }
    const key = JSON.stringify([connection.origin, bootstrap.device.id, bootstrap.user.id])
    const same = identity.current === key
    const restore = lastSelection.current?.identity === key ? lastSelection.current.id : undefined
    if (!same) clearConnection(Boolean(restore))
    identity.current = key
    setDevice({ id: bootstrap.device.id, userId: bootstrap.user.id, expiresAt: expiry })
    const result = await delivery({ action: 'list' })
    if (!current()) return
    if (!result.ok) {
      clearDetail()
      setTasks([])
      handleIssue(result.issue)
      return
    }
    setTasks(result.data.items)
    setProject(value => value && !result.data.items.some(item => item.projectId === value) ? '' : value)
    const target = same ? selectedId ?? restore : restore
    if (target && result.data.items.some(item => item.id === target)) await loadTask(target, current)
    else { lastSelection.current = null; clearDetail() }
  }, replace), [clearConnection, clearDetail, delivery, handleIssue, host, loadTask, run])

  useEffect(() => {
    if (active) void refresh(undefined, true)
    else clearConnection(true)
    return () => { operation.current += 1; working.current = false }
  }, [active, clearConnection, refresh])
  useEffect(() => {
    if (!active || !device) return
    const timer = window.setTimeout(() => {
      operation.current += 1
      working.current = false
      setBusy(false)
      clearConnection()
      setIssue('unbound')
    }, Math.max(0, device.expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [active, clearConnection, device])

  const selectedId = selected?.id
  const shownRunId = report?.id ?? null
  const shownReportStale = report?.stale
  const materialExpiry = selected?.materials?.expiresAt
  useEffect(() => {
    if (!active || !selectedId || !materialExpiry) return
    const timer = window.setTimeout(() => setSelected(current =>
      current?.id === selectedId && current.materials?.expiresAt === materialExpiry
        ? { ...current, materials: { state: 'unverified', expiresAt: null } }
        : current), Math.max(0, Date.parse(materialExpiry) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [active, selectedId, materialExpiry])
  useEffect(() => {
    if (!active || !selectedId || dialog) return
    let stopped = false
    let pending = false
    const timer = window.setInterval(() => {
      if (working.current || pending || document.visibilityState === 'hidden') return
      const epoch = operation.current
      const current = () => !stopped && epoch === operation.current
      pending = true
      void delivery({ action: 'get', id: selectedId }).then(async result => {
        if (!current()) return
        if (!result.ok) { if (result.issue !== 'unavailable') handleIssue(result.issue, selectedId); return }
        const latest = result.data
        if (latest.latestRunId !== shownRunId || (latest.materials?.state === 'changed' && !shownReportStale)) {
          const updated = latest.latestRunId ? await delivery({ action: 'getCheck', id: latest.id, runId: latest.latestRunId }) : null
          if (!current()) return
          if (updated && !updated.ok && updated.issue === 'unbound') { handleIssue(updated.issue, latest.id); return }
          setReport(updated?.ok ? updated.data : null)
        }
        updateTask(latest)
      }).catch(() => {}).finally(() => { pending = false })
    }, 4000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [active, delivery, dialog, handleIssue, shownRunId, shownReportStale, selectedId, updateTask])

  const change = (request: DeliveryChange) => void run(async current => {
    const result = await delivery(request)
    if (!current()) return
    if (!result.ok) {
      handleIssue(result.issue, request.id)
      if (result.issue === 'materialsChanged' || result.issue === 'materialsUnverified') await loadTask(request.id, current)
      return
    }
    setDialog(null)
    updateTask(result.data)
    await refreshReport(result.data, current)
  })
  const local = (action: 'bind' | 'open' | 'fix', ruleId?: string) => {
    if (!selected || (action === 'fix' && (!report || report.stale || report.id !== selected.latestRunId))) return
    const { id, revision } = selected
    void run(async current => {
      const result = await (action === 'fix' && report
        ? delivery({ action, id, revision, runId: report.id, ...(ruleId ? { ruleId } : {}) })
        : delivery({ action: action as 'bind' | 'open', id, revision }))
      if (!current()) return
      if (!result.ok) { handleIssue(result.issue, id); return }
      updateTask(result.data.task)
      if (action === 'bind') {
        retry.current = null
        await refreshReport(result.data.task, current)
      } else if (action === 'fix' && !result.data.draftText) handleIssue('session')
      else openLocalSession(result.data, t(action === 'fix' ? 'enterpriseDelivery.fix' : 'enterpriseDelivery.open'))
    })
  }
  const check = () => {
    if (!selected?.binding || !device || selected.binding.deviceId !== device.id) return
    const { id, revision } = selected
    const fingerprint = [id, revision, selected.binding.id].join('/')
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: crypto.randomUUID() }
    const idempotencyKey = retry.current.key
    void run(async current => {
      const result = await delivery({ action: 'check', id, revision, idempotencyKey })
      if (!current()) return
      if (!result.ok) { handleIssue(result.issue, id); return }
      retry.current = null
      updateTask(result.data.task)
      setReport(result.data.run)
    })
  }
  const materials = (action: 'verify' | 'recheck' | 'watch') => {
    if (!selected) return
    const { id, revision } = selected
    void run(async current => {
      const result = await (action === 'watch'
        ? delivery({ action, id, revision, enabled: !selected.automaticRecheck })
        : delivery({ action, id, revision }))
      if (!current()) return
      if (!result.ok) {
        handleIssue(result.issue, id)
        if (['materialsChanged', 'materialConflict', 'worktreeChanged', 'invalidMaterial'].includes(result.issue)) {
          await loadTask(id, current)
        }
        return
      }
      updateTask(result.data.task)
      if (result.data.run) setReport(result.data.run)
    })
  }

  const options = [{ value: '', label: t('enterpriseDelivery.allProjects') },
    ...[...new Map(tasks.map(task => [task.projectId, task.projectName])).entries()].map(([value, label]) => ({ value, label }))]
  const visible = project ? tasks.filter(task => task.projectId === project) : tasks
  const stage = selected ? deliveryStates.indexOf(selected.state) : -1
  const boundHere = Boolean(selected?.binding && selected.binding.deviceId === device?.id && selected.assigneeId === device?.userId)
  const reusable = Boolean(boundHere && selected?.canAdvance && report?.canReuseMaterials && report.id === selected.latestRunId)
  const materialsCurrent = !selected?.materials || selected.materials.state === 'current'
  const issueMessage = issue ? t(`enterpriseDelivery.issue.${issue}`) : null

  return (
    <main className="h-full overflow-y-auto" aria-busy={busy}>
      <div className="mx-auto max-w-[1160px] space-y-5 px-5 py-6 sm:px-10 sm:py-9">
        <SettingsPageHeader title={t('enterpriseDelivery.title')} description={t('enterpriseDelivery.description')} action={
          <Button variant="secondary" disabled={busy} icon={<RotateCw size={14} />}
            onClick={() => void refresh(selected?.id)}>{t('settings.enterprise.refresh')}</Button>
        } />
        {issueMessage && !dialog && <p role="alert" className="rounded-[var(--radius-md)] bg-[var(--color-error-container)] px-3 py-2 text-sm text-[var(--color-on-error-container)]">{issueMessage}</p>}
        {!device && issue === 'unbound' && <Button variant="secondary" onClick={() => {
          useUIStore.getState().setPendingSettingsTab('general')
          useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
        }}>{t('settings.enterprise.title')}</Button>}
        {device && <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <Card as="section" padding="none" className="min-w-0 self-start">
            <div className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold"><ClipboardCheck size={16} />{t('enterpriseDelivery.tasks')}</h2>
                <Badge mono>{visible.length}</Badge>
              </div>
              <SelectField size="sm" label={t('enterpriseDelivery.project')} value={project} options={options} onChange={value => {
                setProject(value)
                if (value && selected?.projectId !== value) {
                  lastSelection.current = null
                  clearDetail()
                }
              }} disabled={busy} />
            </div>
            {visible.length ? <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
              {visible.map(task => <li key={task.id}>
                <button type="button" disabled={busy} aria-pressed={selected?.id === task.id}
                  className="block w-full px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-container-low)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] aria-pressed:bg-[var(--color-brand-soft)] aria-pressed:text-[var(--color-on-brand-soft)]"
                  onClick={() => { clearDetail(); void run(current => loadTask(task.id, current)) }}>
                  <span className="block break-words text-sm font-medium">{task.title || task.demandNo}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="break-all">{task.demandNo}</span>
                    <Badge tone={stageTones[task.state]}>{t(`enterpriseDelivery.state.${task.state}`)}</Badge>
                  </span>
                </button>
              </li>)}
            </ul> : <p className="px-4 pb-4 text-sm text-[var(--color-text-secondary)]">{t('enterpriseDelivery.empty')}</p>}
          </Card>

          <Card as="article" className="min-w-0 space-y-5">
            {selected ? <>
              <header className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge mono>{selected.demandNo}</Badge>
                  <Badge tone={stageTones[selected.state]}>{t(`enterpriseDelivery.state.${selected.state}`)}</Badge>
                  <span className="text-xs text-[var(--color-text-secondary)]">{t('enterpriseDelivery.revision', { value: selected.revision })}</span>
                </div>
                <h2 className="break-words text-xl font-semibold">{selected.title || selected.demandNo}</h2>
                <p className="break-words text-sm text-[var(--color-text-secondary)]">{selected.projectName} · {selected.assigneeName}</p>
              </header>
              <ol aria-label={t('enterpriseDelivery.progress')} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {deliveryStates.map((state, index) => <li key={state} aria-current={index === stage ? 'step' : undefined}
                  className="rounded-[var(--radius-sm)] border-t-2 border-[var(--color-border)] px-1.5 py-2 text-xs text-[var(--color-text-secondary)] aria-[current=step]:border-[var(--color-brand)] aria-[current=step]:font-semibold aria-[current=step]:text-[var(--color-text-primary)]">
                  {t(`enterpriseDelivery.state.${state}`)}
                </li>)}
              </ol>
              {!selected.canAdvance && selected.state !== 'DELIVERED' && <p className="text-sm text-[var(--color-text-secondary)]">{t('enterpriseDelivery.paused')}</p>}
              <details className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2.5 text-sm">
                <summary className="cursor-pointer font-medium">{t('enterpriseDelivery.approved')}</summary>
                <code className="mt-2 block break-all text-xs">{selected.approvedVersionId}</code>
                <code className="mt-1 block break-all text-xs">{selected.snapshotHash}</code>
                {selected.binding && <p className="mt-2 flex items-start gap-1.5 text-xs"><GitBranch size={13} className="mt-0.5 shrink-0" />
                  <code className="break-all">{selected.binding.gitRevision}</code>
                </p>}
              </details>
              <div className="flex flex-wrap gap-2">
                {selected.permissions.bind && <Button variant="secondary" size="sm" disabled={busy} icon={<GitBranch size={14} />}
                  onClick={() => local('bind')}>{t('enterpriseDelivery.bind')}</Button>}
                {boundHere && <Button variant="secondary" size="sm" disabled={busy} icon={<SquareArrowOutUpRight size={14} />}
                  onClick={() => local('open')}>{t('enterpriseDelivery.open')}</Button>}
                {selected.permissions.start && <Button size="sm" disabled={busy} onClick={() => change({ action: 'transition',
                  id: selected.id, revision: selected.revision, transition: { action: 'start' } })}>{t('enterpriseDelivery.start')}</Button>}
                {selected.permissions.submitChecks && <Button size="sm" disabled={busy || !boundHere} icon={<FileCheck2 size={14} />}
                  onClick={check}>{t('enterpriseDelivery.check')}</Button>}
                {selected.permissions.startTesting && <Button size="sm" disabled={busy || !materialsCurrent} onClick={() => change({ action: 'transition',
                  id: selected.id, revision: selected.revision, transition: { action: 'start_testing' } })}>{t('enterpriseDelivery.startTesting')}</Button>}
                {selected.permissions.recordTest && <Button size="sm" disabled={busy} onClick={() => setDialog('test')}>{t('enterpriseDelivery.test')}</Button>}
                {selected.permissions.returnForRework && <Button size="sm" variant="secondary" disabled={busy}
                  onClick={() => setDialog('rework')}>{t('enterpriseDelivery.rework')}</Button>}
                {selected.permissions.accept && <Button size="sm" disabled={busy || !materialsCurrent} onClick={() => setDialog('accept')}>{t('enterpriseDelivery.accept')}</Button>}
              </div>
              {selected.permissions.submitChecks && !boundHere && <p className="text-xs text-[var(--color-text-secondary)]">{t('enterpriseDelivery.bindHint')}</p>}
              {selected.latestTestOutcome && <Badge tone={selected.latestTestOutcome === 'passed' ? 'success' : 'warning'}>
                {t('enterpriseDelivery.testOutcome')} · {t(`enterpriseDelivery.outcome.${selected.latestTestOutcome}`)}
              </Badge>}
              {selected.deliveryRef && <p className="break-words text-sm">{t('enterpriseDelivery.handover')} · {selected.deliveryRef}</p>}
              {selected.latestRunId && selected.materials && <section className="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-3 text-sm">
                <p role="status">{t(`enterpriseDelivery.materials.${selected.materials.state}`)}</p>
                {(reusable || selected.automaticRecheck) && <>
                  <div className="flex flex-wrap gap-2">
                    {reusable && <Button size="sm" variant="secondary" disabled={busy} onClick={() => materials('verify')}>
                      {t('enterpriseDelivery.verifyMaterials')}</Button>}
                    {reusable && <Button size="sm" variant="secondary" disabled={busy} onClick={() => materials('recheck')}>
                      {t('enterpriseDelivery.recheckMaterials')}</Button>}
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => materials('watch')}>
                      {t(selected.automaticRecheck ? 'enterpriseDelivery.stopWatching' : 'enterpriseDelivery.startWatching')}</Button>
                  </div>
                  <p className="text-xs text-[var(--color-text-secondary)]">{t('enterpriseDelivery.watchHint')}</p>
                </>}
              </section>}
              {report && <DeliveryReview run={report} busy={busy}
                canFix={boundHere && selected.permissions.submitChecks} canReview={selected.permissions.review && materialsCurrent}
                onFix={ruleId => local('fix', ruleId)} onReview={() => setDialog('review')} />}
              {selected.history.length > 0 && <details className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2.5 text-sm">
                <summary className="cursor-pointer font-medium">{t('enterpriseDelivery.history')}</summary>
                <ol className="mt-2 divide-y divide-[var(--color-border)]">
                  {selected.history.map(event => <li key={event.revision} className="py-2">
                    <div className="flex flex-wrap justify-between gap-1">
                      <span>{t(historyLabels[event.action as keyof typeof historyLabels] ?? 'enterpriseDelivery.history')}</span>
                      <time className="text-xs text-[var(--color-text-secondary)]" dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time>
                    </div>
                    {event.details.note && <p className="mt-1 whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">{event.details.note}</p>}
                  </li>)}
                </ol>
              </details>}
            </> : <p className="text-sm text-[var(--color-text-secondary)]">{t('enterpriseDelivery.choose')}</p>}
          </Card>
        </div>}
        {dialog && selected && <DeliveryActionDialog key={`${selected.id}:${selected.revision}:${dialog}`} intent={dialog} task={selected}
          report={report} busy={busy} issue={issueMessage} onClose={() => { setDialog(null); setIssue(null) }} onSubmit={change} />}
      </div>
    </main>
  )
}

export function EnterpriseDeliveryPage({ active = true }: { active?: boolean }) {
  const t = useTranslation()
  const host = getDesktopHost().enterprise
  if (host?.delivery) return <DeliveryPanel host={host} delivery={host.delivery} active={active} />
  return <main className="h-full overflow-y-auto"><div className="mx-auto max-w-[1160px] space-y-4 px-5 py-6 sm:px-10 sm:py-9">
    <SettingsPageHeader title={t('enterpriseDelivery.title')} description={t('enterpriseDelivery.description')} />
    <p role="status" className="text-sm text-[var(--color-text-secondary)]">{t('enterpriseDelivery.issue.unbound')}</p>
  </div></main>
}
