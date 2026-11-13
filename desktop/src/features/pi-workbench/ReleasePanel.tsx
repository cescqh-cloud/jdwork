import { Download, Package, ShieldCheck, Upload } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { usePiTranslation, type PiKey } from './usePiTranslation'
import { formatBytes } from '@/lib/formatBytes'
import { errorText, type PiApi, type Release } from './api'
import { usePiResource } from './usePiResource'

const releaseStates: Record<Release['state'], [PiKey, Tone]> = {
  draft: ['pi.draft', 'warning'],
  published: ['pi.published', 'success'],
  withdrawn: ['pi.withdrawn', 'neutral'],
}
type ReleaseAction = 'submit' | 'approve' | 'reject' | 'publish' | 'withdraw'
type Confirmation = { release: Release, action: ReleaseAction }
const labels: Record<ReleaseAction, PiKey> = {
  submit: 'pi.releaseSubmit', approve: 'pi.releaseApprove', reject: 'pi.releaseReject', publish: 'pi.publish', withdraw: 'pi.withdraw',
}
const reviewLabels: Record<NonNullable<Release['review']>['state'], [PiKey, Tone]> = {
  pending: ['pi.releasePending', 'warning'], approved: ['pi.releaseApproved', 'success'], rejected: ['pi.releaseRejected', 'warning'],
}
const path = '/api/desktop/releases'

function compareVersions(left: string, right: string) {
  const format = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/
  const a = format.exec(left)
  const b = format.exec(right)
  if (!a || !b) return undefined
  const numberOrder = (x: string, y: string) => x.length - y.length || (x === y ? 0 : x < y ? -1 : 1)
  for (const index of [1, 2, 3]) {
    const order = numberOrder(a[index]!, b[index]!)
    if (order) return order
  }
  if (!a[4] || !b[4]) return Number(!a[4]) - Number(!b[4])
  const x = a[4].split('.')
  const y = b[4].split('.')
  for (let index = 0; index < Math.min(x.length, y.length); index++) {
    const first = x[index]!
    const second = y[index]!
    if (first === second) continue
    const firstNumeric = /^\d+$/.test(first)
    const secondNumeric = /^\d+$/.test(second)
    if (firstNumeric && secondNumeric) return numberOrder(first, second)
    if (firstNumeric !== secondNumeric) return firstNumeric ? -1 : 1
    return first < second ? -1 : 1
  }
  return x.length - y.length
}

export function ReleasePanel({ api, admin }: { api: PiApi, admin: boolean }) {
  const t = usePiTranslation()
  const latest = usePiResource<{ release: Release | null }>(api, `${path}/latest`)
  const records = usePiResource<{ releases: Release[], configured: boolean, requiresReview?: boolean }>(api, admin ? path : null)
  const [manifest, setManifest] = useState<File>()
  const [installer, setInstaller] = useState<File>()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const release = latest.value?.release
  const installed = /(?:^|\s)PiWorkbenchDesktop\/([^\s]+)/.exec(navigator.userAgent)?.[1]
  const order = installed && release ? compareVersions(release.version, installed) : undefined

  async function download(item: Release) {
    if (busy) return
    setBusy('download')
    setError('')
    try {
      await api.download(`${path}/${encodeURIComponent(item.id)}/download`, item.filename)
    } catch (cause) {
      setError(errorText(cause, t('pi.downloadError')))
    } finally {
      setBusy('')
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!records.value?.configured || !manifest || !installer || busy) return
    const formElement = event.currentTarget
    setBusy('upload')
    setError('')
    try {
      const form = new FormData()
      form.append('manifest', await manifest.text())
      form.append('installer', installer)
      await api.write(path, 'POST', form)
      setManifest(undefined)
      setInstaller(undefined)
      formElement.reset()
      records.refresh()
    } catch (cause) {
      setError(errorText(cause, t('pi.uploadError')))
    } finally {
      setBusy('')
    }
  }

  async function changeState() {
    if (!confirmation || busy) return
    const { release: item, action } = confirmation
    setBusy(item.id)
    setError('')
    try {
      await api.write(`${path}/${encodeURIComponent(item.id)}`, 'PATCH', { action })
      latest.refresh()
      records.refresh()
    } catch (cause) {
      setError(errorText(cause, t('pi.releaseError')))
    } finally {
      setBusy('')
      setConfirmation(undefined)
    }
  }

  return (
    <section className="pi-page">
      <header className="pi-page-heading">
        <p className="pi-kicker">{t('pi.manage')}</p>
        <h1>{t('pi.desktopRelease')}</h1>
        <p className="pi-description">{t('pi.releaseHint')}</p>
      </header>
      <div className="pi-wrap">
        <Badge tone="neutral">{installed ? t('pi.installedVersion', { version: installed }) : t('pi.webClient')}</Badge>
        {order !== undefined && <Badge tone={order > 0 ? 'info' : 'success'}>
          {t(order > 0 ? 'pi.newVersionAvailable' : order < 0 ? 'pi.newerThanPublished' : 'pi.upToDate')}
        </Badge>}
      </div>
      {error && <ErrorState title={error} size="sm" />}
      {Boolean(latest.error) && <ErrorState title={errorText(latest.error, t('pi.loadError'))} size="sm"
        onRetry={latest.refresh} retryLabel={t('pi.retry')} />}
      {!latest.value && !latest.error && <LoadingState label={t('pi.loadingReleases')} />}
      {latest.value && !release && <EmptyState variant="dashed" size="sm" title={t('pi.noRelease')} icon={<Package size={22} strokeWidth={1.75} />} />}
      {release && <Card as="article" padding="lg" radius="xl" shadow="card" className="pi-stack">
        <div className="pi-between">
          <div className="pi-inline">
            <span className="pi-card-icon"><Package size={21} strokeWidth={1.75} aria-hidden="true" /></span>
            <div>
              <h2>{t('pi.releaseVersion', { version: release.version })}</h2>
              <p className="pi-subtle">{t('pi.windowsInstaller', { size: formatBytes(release.bytes) })}</p>
            </div>
          </div>
          <Badge tone="success" icon={<ShieldCheck size={14} strokeWidth={1.75} />}>{t('pi.published')}</Badge>
        </div>
        {release.notes && <p className="pi-release-notes">{release.notes}</p>}
        <dl className="pi-release-facts">
          <dt>{t('pi.checksum')}</dt><dd><code>{release.sha256}</code></dd>
          {release.publishedAt && <><dt>{t('pi.publishedAt')}</dt><dd><time dateTime={release.publishedAt}>{new Date(release.publishedAt).toLocaleString()}</time></dd></>}
        </dl>
        <Button variant="primary" size="base" className="pi-fit" loading={busy === 'download'} disabled={!!busy}
          icon={<Download size={16} strokeWidth={1.75} />} onClick={() => void download(release)}>{t('pi.downloadInstaller')}</Button>
      </Card>}
      {admin && <>
        <h2 className="pi-panel-heading">{t('pi.manageReleases')}</h2>
        {Boolean(records.error) && <ErrorState title={errorText(records.error, t('pi.loadError'))} size="sm"
          onRetry={records.refresh} retryLabel={t('pi.retry')} />}
        {!records.value && !records.error && <LoadingState label={t('pi.loadingReleases')} />}
        {records.value && !records.value.configured && <EmptyState size="sm" variant="dashed" title={t('pi.releaseKeyRequired')}
          description={t('pi.releaseKeyHint')} icon={<ShieldCheck size={21} strokeWidth={1.75} />} />}
        {records.value?.configured && <Card radius="lg" padding="lg">
          <form onSubmit={(event) => void upload(event)} className="pi-stack">
            <Input label={t('pi.releaseManifest')} type="file" accept=".json,application/json" required
              onChange={(event) => setManifest(event.target.files?.[0])} disabled={!!busy} />
            <Input label={t('pi.releaseInstaller')} type="file" accept=".exe" required
              onChange={(event) => setInstaller(event.target.files?.[0])} disabled={!!busy} />
            <Button type="submit" size="base" variant="secondary" className="pi-fit" icon={<Upload size={16} strokeWidth={1.75} />}
              loading={busy === 'upload'} disabled={!manifest || !installer || !!busy}>{t('pi.uploadRelease')}</Button>
          </form>
        </Card>}
        {records.value?.releases.map((item) => {
          const [label, tone] = item.state === 'draft' && item.review ? reviewLabels[item.review.state] : releaseStates[item.state]
          let actions: ReleaseAction[] = []
          if (item.state === 'published') actions = ['withdraw']
          if (item.state === 'draft') {
            if (item.review?.state === 'pending') actions = ['approve', 'reject']
            else if (item.review?.state === 'approved' || (!records.value?.requiresReview && !item.review)) actions = ['publish']
            else actions = ['submit']
          }
          return <Card as="article" padding="sm" radius="md" className="pi-between" key={item.id}>
            <div>
              <h3>{t('pi.releaseVersion', { version: item.version })}</h3>
              <p className="pi-subtle">{item.filename}</p>
            </div>
            <div className="pi-wrap">
              <Badge tone={tone} size="sm">{t(label)}</Badge>
              {records.value?.configured && actions.map(action => <Button key={action} size="sm"
                variant={action === 'withdraw' || action === 'reject' ? 'danger-outline' : 'secondary'}
                disabled={!!busy} onClick={() => setConfirmation({ release: item, action })}>
                {t(labels[action])}
              </Button>)}
            </div>
          </Card>
        })}
      </>}
      {confirmation && <ConfirmDialog open onClose={() => setConfirmation(undefined)} loading={!!busy}
        title={t(labels[confirmation.action])}
        body={t(confirmation.action === 'publish' ? 'pi.confirmPublish' : confirmation.action === 'withdraw' ? 'pi.confirmWithdraw' : 'pi.releaseConfirmReview',
          { version: confirmation.release.version, action: t(labels[confirmation.action]) })}
        confirmVariant={confirmation.action === 'withdraw' || confirmation.action === 'reject' ? 'danger' : 'primary'}
        confirmLabel={t(labels[confirmation.action])} cancelLabel={t('pi.cancel')}
        onConfirm={changeState} />}
    </section>
  )
}
