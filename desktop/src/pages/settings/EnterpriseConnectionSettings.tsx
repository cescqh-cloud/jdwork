import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import { SettingsGroup, SettingsRow, SettingsSection } from '@/components/settings/SettingsSection'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { enterpriseFeatures, type DesktopEnterpriseHost, type EnterpriseConnection } from '@/lib/desktopHost/enterprise'
import { useEnterpriseModelStore } from '@/stores/enterpriseModelStore'

const pollIntervalMs = 15_000
const statusTone: Record<EnterpriseConnection['state'], Tone> = {
  connected: 'success',
  disconnected: 'neutral',
  unavailable: 'warning',
  revoked: 'danger',
}

function EnterpriseConnectionPanel({ host }: { host: DesktopEnterpriseHost }) {
  const t = useTranslation()
  const [connection, setConnection] = useState<EnterpriseConnection | null>(null)
  const [enteredOrigin, setEnteredOrigin] = useState<string | null>(null)
  const [challenge, setChallenge] = useState('')
  const [officeHttp, setOfficeHttp] = useState(false)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const inFlight = useRef(false)

  const run = useCallback(async (operation: () => Promise<EnterpriseConnection>, background = false) => {
    if (background && inFlight.current) return
    const id = ++generation.current
    inFlight.current = true
    if (!background) setBusy(true)
    try {
      const result = await operation()
      if (id === generation.current) {
        setConnection(result)
        if (result.state !== 'connected') useEnterpriseModelStore.getState().clear()
        else if (!background) void useEnterpriseModelStore.getState().refresh()
      }
    } catch {
      if (id === generation.current) {
        setConnection(previous => ({
          origin: previous?.origin ?? null, state: 'unavailable', issue: 'network',
          ...(previous?.officeHttpOrigin ? { officeHttpOrigin: previous.officeHttpOrigin } : {}),
        }))
      }
    } finally {
      if (id === generation.current) {
        inFlight.current = false
        if (!background) setBusy(false)
      }
    }
  }, [])

  useEffect(() => {
    void run(() => host.sync())
    return () => {
      generation.current++
      inFlight.current = false
    }
  }, [host, run])

  const canPoll = Boolean(connection?.origin && (connection.state === 'connected' || connection.state === 'unavailable'))
  useEffect(() => {
    if (!canPoll) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void run(() => host.sync(true), true)
    }, pollIntervalMs)
    return () => window.clearInterval(timer)
  }, [canPoll, host, run])

  const origin = officeHttp ? connection?.officeHttpOrigin ?? '' : enteredOrigin ?? connection?.origin ?? ''
  const showForm = connection && (!connection.origin || connection.state === 'revoked')
  const showDisconnect = Boolean(connection?.origin || connection?.issue === 'secureStorage')
  const bootstrap = connection?.bootstrap

  function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !origin.trim()) return
    if (!officeHttp && !challenge.trim()) return
    const submittedChallenge = officeHttp ? undefined : challenge.trim()
    setChallenge('')
    void run(() => host.enroll({
      origin: origin.trim(),
      ...(submittedChallenge ? { challenge: submittedChallenge } : {}),
      ...(officeHttp ? { officeHttp: true } : {}),
    }))
  }

  return (
    <SettingsSection
      title={t('settings.enterprise.title')}
      description={t('settings.enterprise.description')}
    >
      <SettingsGroup>
        <SettingsRow title={t('settings.enterprise.status')} description={
          connection?.origin && <span className="break-all">{connection.origin}</span>
        }>
          <div className="flex flex-wrap items-center gap-2">
            <span role="status" aria-label={t('settings.enterprise.status')}>
              {connection
                ? <Badge tone={statusTone[connection.state]}>{t(`settings.enterprise.state.${connection.state}`)}</Badge>
                : <Badge>{t('settings.enterprise.loading')}</Badge>}
            </span>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => host.sync())}>
              {t('settings.enterprise.refresh')}
            </Button>
            {showDisconnect && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => {
              setOfficeHttp(false)
              setEnteredOrigin(null)
              void run(() => host.disconnect())
            }}>
                {t('settings.enterprise.disconnect')}
              </Button>
            )}
          </div>
        </SettingsRow>
        {bootstrap && (
          <SettingsRow title={t('settings.enterprise.details')} layout="stack">
            <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt>{t('settings.enterprise.user')}</dt>
              <dd className="break-words">{bootstrap.user.displayName}</dd>
              <dt>{t('settings.enterprise.roles')}</dt>
              <dd className="break-words">{bootstrap.user.roles.join(' · ') || '—'}</dd>
              <dt>{t('settings.enterprise.device')}</dt>
              <dd className="break-all">{bootstrap.device.id}</dd>
              <dt>{t('settings.enterprise.policy')}</dt>
              <dd>{bootstrap.policy.revision}</dd>
              <dt>{t('settings.enterprise.expiry')}</dt>
              <dd><time dateTime={bootstrap.policy.expiresAt}>{new Date(bootstrap.policy.expiresAt).toLocaleString()}</time></dd>
              <dt>{t('settings.enterprise.features')}</dt>
              <dd className="flex flex-wrap gap-2">
                {enterpriseFeatures.map(feature => (
                  <Badge key={feature} tone={bootstrap.policy.features[feature] ? 'success' : 'neutral'} wrap>
                    {t(`settings.enterprise.feature.${feature}`)} · {t(bootstrap.policy.features[feature]
                      ? 'settings.enterprise.featureEnabled' : 'settings.enterprise.featureDisabled')}
                  </Badge>
                ))}
              </dd>
            </dl>
          </SettingsRow>
        )}
        {showForm && (
          <form className="grid gap-3 px-4 py-4 sm:grid-cols-2" onSubmit={enroll}>
            {connection.officeHttpOrigin && (
              <Checkbox
                containerClassName="sm:col-span-2"
                label={t('settings.enterprise.officeHttp')}
                description={t('settings.enterprise.officeHttpDescription')}
                checked={officeHttp}
                disabled={busy}
                onChange={event => setOfficeHttp(event.target.checked)}
              />
            )}
            <Input
              label={t('settings.enterprise.origin')}
              type="url"
              placeholder={connection.officeHttpOrigin ?? 'https://control.example.com'}
              value={origin}
              onChange={event => setEnteredOrigin(event.target.value)}
              autoComplete="off"
              maxLength={2048}
              disabled={busy || officeHttp}
              required
            />
            {!officeHttp && (
              <Input
                label={t('settings.enterprise.challenge')}
                type="password"
                value={challenge}
                onChange={event => setChallenge(event.target.value)}
                autoComplete="off"
                maxLength={43}
                disabled={busy}
                required
              />
            )}
            <div className="sm:col-span-2">
              <Button type="submit" size="sm" disabled={busy || !origin.trim() || (!officeHttp && !challenge.trim())}>
                {officeHttp ? t('settings.enterprise.connectIntranet') : t('settings.enterprise.connect')}
              </Button>
            </div>
          </form>
        )}
        {connection?.issue && (
          <p role="alert" className="px-4 py-3 text-xs text-[var(--color-error)]">
            {t(`settings.enterprise.issue.${connection.issue}`)}
          </p>
        )}
      </SettingsGroup>
    </SettingsSection>
  )
}

export function EnterpriseConnectionSettings() {
  const host = getDesktopHost().enterprise
  return host ? <EnterpriseConnectionPanel host={host} /> : null
}
