import { BarChart3, KeyRound, RefreshCw, Server, Trash2 } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { SelectField } from '@/components/ui/SelectField'
import {
  PiApiError, type ClientKind, type DesktopModel, type DesktopModelUpdate, type DesktopUsage, type Identity,
  type ModelSource, type PiApi, type UsageCounts, type UsageDays, type UsageRow,
} from './api'
import { usePiResource } from './usePiResource'
import { usePiTranslation, type PiKey } from './usePiTranslation'

const modelPath = '/api/desktop/model'
const sourceLabels = { server: 'pi.modelServer', personal: 'pi.modelPersonal' } as const
const kindLabels: Record<ClientKind, PiKey> = {
  desktop: 'pi.desktopRelease', web: 'pi.webClient', unknown: 'pi.usageUnknownClient',
}

function ModelPreferences({ api, initial }: { api: PiApi, initial: DesktopModel }) {
  const t = usePiTranslation()
  const [settings, setSettings] = useState(initial)
  const [source, setSource] = useState<ModelSource>(initial.source)
  const [profileId, setProfileId] = useState(initial.profileId || initial.profiles[0]?.id || '')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'clear' | 'reload'>()
  const [confirmClear, setConfirmClear] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>()
  const profile = settings.profiles.find((item) => item.id === profileId)
  const keepsKey = settings.configured && profile?.id === settings.profileId
  const dirty = source !== settings.source || (source === 'personal' && (profileId !== settings.profileId || !!key.trim()))
  const canSave = dirty && (source === 'server' || !!profile && (keepsKey || !!key.trim()))
  const conflict = error instanceof PiApiError && error.status === 409

  function apply(next: DesktopModel) {
    setSettings(next)
    setSource(next.source)
    setProfileId(next.profileId || next.profiles[0]?.id || '')
    setKey('')
  }

  async function update(data: DesktopModelUpdate, operation: 'save' | 'clear') {
    if (busy) return
    setBusy(operation)
    setSaved(false)
    setError(undefined)
    try {
      apply(await api.write<DesktopModel>(modelPath, 'PUT', data))
      setSaved(true)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(undefined)
      setConfirmClear(false)
    }
  }

  async function reload() {
    setBusy('reload')
    try {
      apply(await api.get<DesktopModel>(modelPath))
      setError(undefined)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(undefined)
    }
  }

  function save(event: FormEvent) {
    event.preventDefault()
    if (!canSave || busy) return
    const data: DesktopModelUpdate = { revision: settings.revision, source }
    if (source === 'personal' && profile) {
      data.profileId = profile.id
      const apiKey = key.trim()
      if (apiKey) {
        data.apiKey = apiKey
        data.target = profile.target
      }
    }
    void update(data, 'save')
  }

  return (
    <Card as="section" padding="lg" radius="lg" className="pi-stack" aria-label={t('pi.modelPreferences')}>
      <div className="pi-between">
        <h2 className="pi-inline"><KeyRound size={17} strokeWidth={1.75} aria-hidden="true" />{t('pi.modelPreferences')}</h2>
        {settings.source === 'personal' && <Badge tone={settings.configured ? 'success' : 'warning'}>
          {t(settings.configured ? 'pi.modelReady' : 'pi.modelNeedsSetup')}
        </Badge>}
      </div>
      <form className="pi-stack" onSubmit={save}>
        <div className="pi-wrap">
          <SegmentedControl<ModelSource> label={t('pi.modelSource')} appearance="raised" value={source}
            items={[
              { value: 'server', label: t(sourceLabels.server), icon: <Server size={15} strokeWidth={1.75} />, disabled: !!busy },
              { value: 'personal', label: t(sourceLabels.personal), icon: <KeyRound size={15} strokeWidth={1.75} />, disabled: !!busy },
            ]}
            onChange={(value) => {
              if (value === source) return
              setSource(value)
              setKey('')
              setSaved(false)
            }} />
          {settings.hasApiKey && <Badge>{t('pi.personalKeySaved')}</Badge>}
        </div>
        <p className="pi-subtle">{t(source === 'server' ? 'pi.modelServerHint' : 'pi.modelPersonalHint')}</p>
        {source === 'personal' && !settings.profiles.length && <EmptyState size="sm" variant="dashed"
          title={t('pi.noPersonalConnections')} description={t('pi.noPersonalConnectionsHint')} />}
        {source === 'personal' && !!settings.profiles.length && <>
          <SelectField label={t('pi.personalConnection')} value={profileId} disabled={!!busy}
            options={[
              ...(!profile ? [{ value: profileId, label: t('pi.selectPersonalConnection'), disabled: true }] : []),
              ...settings.profiles.map((item) => ({ value: item.id, label: item.name })),
            ]}
            onChange={(value) => { setProfileId(value); setKey(''); setSaved(false) }} />
          {profile && <>
            <dl className="pi-release-facts">
              <dt>{t('pi.modelDestination')}</dt><dd><code>{profile.baseUrl}</code></dd>
              <dt>{t('pi.modelName')}</dt><dd>{profile.model}</dd>
            </dl>
            <Input label={t('pi.personalApiKey')} type="password" value={key} autoComplete="off" maxLength={4096}
              autoCapitalize="none" spellCheck={false} disabled={!!busy} required={!keepsKey}
              hint={t(keepsKey ? 'pi.personalKeyRetain' : 'pi.personalKeyInputHint')}
              onChange={(event) => { setKey(event.target.value); setSaved(false) }} />
          </>}
        </>}
        {Boolean(error) && <ErrorState size="sm" title={t(conflict ? 'pi.modelSettingsConflict' : 'pi.modelSaveError')}
          retryLabel={t('pi.reloadSettings')} onRetry={conflict && !busy ? () => void reload() : undefined} />}
        <div className="pi-wrap">
          <Button type="submit" variant="primary" size="base" disabled={!canSave || !!busy} loading={busy === 'save'}>{t('pi.save')}</Button>
          {settings.hasApiKey && <Button variant="danger-ghost" size="base" disabled={!!busy}
            icon={<Trash2 size={15} strokeWidth={1.75} />} onClick={() => setConfirmClear(true)}>{t('pi.clearPersonalKey')}</Button>}
          {saved && <span role="status" className="pi-subtle">{t('pi.saved')}</span>}
        </div>
      </form>
      {confirmClear && <ConfirmDialog open onClose={() => setConfirmClear(false)} loading={busy === 'clear'}
        title={t('pi.clearPersonalKey')} body={t('pi.clearPersonalKeyHint')} confirmLabel={t('pi.clearPersonalKey')}
        cancelLabel={t('pi.cancel')} onConfirm={() => update({ revision: settings.revision, source: 'server', clearApiKey: true }, 'clear')} />}
    </Card>
  )
}

const metricFields = [
  { field: 'input', label: 'pi.usageInput' },
  { field: 'output', label: 'pi.usageOutput' },
  { field: 'cacheRead', label: 'pi.usageCacheRead' },
  { field: 'cacheWrite', label: 'pi.usageCacheWrite' },
  { field: 'totalTokens', label: 'pi.usageTotalTokens' },
] as const
const countFields = [...metricFields.map(({ field }) => field), 'reportedCalls', 'unreportedCalls'] as const
const tableColumns = 'grid grid-cols-[minmax(152px,1.8fr)_minmax(106px,1fr)_repeat(4,minmax(90px,1fr))] items-center gap-3 px-3 py-2.5'
const countFormat = new Intl.NumberFormat()
const formatCount = (count: number) => countFormat.format(count)

function groupUsage(rows: UsageRow[]) {
  const grouped = new Map<string, UsageRow>()
  for (const row of rows) {
    const key = JSON.stringify([row.actorId, row.clientId, row.credentials])
    const existing = grouped.get(key)
    if (existing) {
      for (const field of countFields) existing[field] += row[field]
    } else grouped.set(key, { ...row })
  }
  return [...grouped.values()].sort((first, second) => (
    first.actorName.localeCompare(second.actorName) || first.actorId.localeCompare(second.actorId)
    || first.clientId.localeCompare(second.clientId) || first.credentials.localeCompare(second.credentials)
  ))
}

function UsageSummary({ source, counts }: { source: ModelSource, counts: UsageCounts }) {
  const t = usePiTranslation()
  const allUnreported = !counts.reportedCalls && !!counts.unreportedCalls
  return (
    <Card as="article" radius="lg" className="pi-stack">
      <h3>{t(sourceLabels[source])}</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        {metricFields.map(({ field, label }) => <div key={field}>
          <dt className="pi-subtle">{t(label)}</dt>
          <dd className="m-0 font-medium tabular-nums">{allUnreported ? t('pi.usageNotReported') : formatCount(counts[field])}</dd>
        </div>)}
        <div>
          <dt className="pi-subtle">{t('pi.usageUnreportedCalls')}</dt>
          <dd className="m-0 font-medium tabular-nums">{formatCount(counts.unreportedCalls)}</dd>
        </div>
      </dl>
    </Card>
  )
}

function UsageTable({ usage, actorId }: { usage: DesktopUsage, actorId: string }) {
  const t = usePiTranslation()
  const rows = useMemo(() => groupUsage(usage.rows), [usage.rows])
  const clientNumbers = new Map<string, number>()

  if (!rows.length) return <EmptyState title={t('pi.usageNoRows')} size="sm" variant="dashed" />

  return (
    <div role="region" aria-label={t('pi.usageByClient')} tabIndex={0}
      className="overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] focus-visible:outline-2 focus-visible:outline-[var(--color-border-focus)]">
      <div role="table" aria-label={t('pi.usageByClient')} className="min-w-[680px]">
        <div role="row" className={`${tableColumns} bg-[var(--color-surface-container-low)] text-xs font-medium text-[var(--color-text-secondary)]`}>
          <span role="columnheader">{t('pi.usageAccountClient')}</span>
          <span role="columnheader">{t('pi.modelSource')}</span>
          <span role="columnheader">{t('pi.usageInput')}</span>
          <span role="columnheader">{t('pi.usageOutput')}</span>
          <span role="columnheader">{t('pi.usageTotalTokens')}</span>
          <span role="columnheader">{t('pi.usageUnreportedCalls')}</span>
        </div>
        {rows.map((row) => {
          const accountClient = JSON.stringify([row.actorId, row.clientId])
          const number = clientNumbers.get(accountClient) ?? clientNumbers.size + 1
          clientNumbers.set(accountClient, number)
          const kind = t(kindLabels[row.clientKind] ?? kindLabels.unknown)
          const current = row.actorId === actorId && row.clientId === usage.client.id
          const allUnreported = !row.reportedCalls && !!row.unreportedCalls
          return (
            <div role="row" key={JSON.stringify([row.actorId, row.clientId, row.credentials])}
              className={`${tableColumns} border-t border-[var(--color-border)] text-xs tabular-nums`}>
              <div role="rowheader">
                <strong className="block break-words font-medium">{row.actorName}</strong>
                <span className="pi-subtle">{current ? t('pi.usageCurrentKind', { kind }) : t('pi.usageClientNumber', { kind, number })}</span>
              </div>
              <span role="cell">{t(sourceLabels[row.credentials])}</span>
              <span role="cell">{allUnreported ? t('pi.usageNotReported') : formatCount(row.input)}</span>
              <span role="cell">{allUnreported ? t('pi.usageNotReported') : formatCount(row.output)}</span>
              <span role="cell">{allUnreported ? t('pi.usageNotReported') : formatCount(row.totalTokens)}</span>
              <span role="cell">{formatCount(row.unreportedCalls)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ModelUsagePanel({ api, identity, localClient }: { api: PiApi, identity: Identity, localClient?: boolean }) {
  const t = usePiTranslation()
  const [days, setDays] = useState<UsageDays>(7)
  const model = usePiResource<DesktopModel>(api, localClient ? null : modelPath)
  const usage = usePiResource<DesktopUsage>(api, `/api/desktop/usage?days=${days}`)
  return (
    <section className="pi-page">
      <header className="pi-page-heading">
        <p className="pi-kicker">{t('pi.manage')}</p>
        <h1>{t('pi.modelUsage')}</h1>
        <p className="pi-description">{t('pi.modelUsageHint')}</p>
      </header>
      {Boolean(model.error) && <ErrorState size="sm" title={t('pi.modelLoadError')}
        retryLabel={t('pi.retry')} onRetry={model.refresh} />}
      {!localClient && !model.value && !model.error && <LoadingState label={t('pi.loadingWorkspace')} size="sm" />}
      {model.value && <ModelPreferences api={api} initial={model.value} />}
      <section aria-label={t('pi.usageHeading')} className="pi-stack">
        <div className="pi-between">
          <h2 className="pi-inline"><BarChart3 size={17} strokeWidth={1.75} aria-hidden="true" />{t('pi.usageHeading')}</h2>
          <div className="pi-wrap">
            <SegmentedControl<'7' | '30'> label={t('pi.usageWindow')} appearance="raised" size="sm"
              value={days === 7 ? '7' : '30'} onChange={(value) => setDays(value === '7' ? 7 : 30)}
              items={[{ value: '7', label: t('pi.usageDays', { days: 7 }) }, { value: '30', label: t('pi.usageDays', { days: 30 }) }]} />
            <Button size="sm" variant="secondary" onClick={usage.refresh} icon={<RefreshCw size={15} strokeWidth={1.75} />}>{t('pi.usageRefresh')}</Button>
          </div>
        </div>
        <p className="pi-subtle">{t(identity.admin ? 'pi.usageAdminScope' : 'pi.usageMemberScope')}</p>
        {Boolean(usage.error) && <ErrorState size="sm" title={t('pi.usageLoadError')} retryLabel={t('pi.retry')} onRetry={usage.refresh} />}
        {!usage.value && !usage.error && <LoadingState label={t('pi.usageLoading')} size="sm" />}
        {usage.value && <>
          <p className="pi-subtle">{t('pi.usageRange', { from: usage.value.from, through: usage.value.through, timezone: usage.value.timezone })}</p>
          <div className="pi-cards">
            <UsageSummary source="server" counts={usage.value.totals.server} />
            <UsageSummary source="personal" counts={usage.value.totals.personal} />
          </div>
          {identity.admin && <UsageTable usage={usage.value} actorId={identity.id} />}
        </>}
      </section>
    </section>
  )
}
