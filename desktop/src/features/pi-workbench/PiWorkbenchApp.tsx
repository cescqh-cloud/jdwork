import { KeyRound, Layers3, ShieldCheck } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ErrorState } from '@/components/ui/ErrorState'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { usePiTranslation } from './usePiTranslation'
import { createPiApi, errorText, PiApiError, type LoginConfig, type Session } from './api'
import { Workspace } from './Workspace'

const ReleasePanel = lazy(() => import('./ReleasePanel').then((module) => ({ default: module.ReleasePanel })))
const ApprovalPanel = lazy(() => import('./ApprovalPanel').then((module) => ({ default: module.ApprovalPanel })))

// Also used by the same-origin Pi admin pages opened by the workbench.
const tokenKey = 'pi-access-token'

function readToken() {
  try {
    return sessionStorage.getItem(tokenKey) ?? ''
  } catch {
    return ''
  }
}

function storeToken(token: string) {
  try {
    if (token) sessionStorage.setItem(tokenKey, token)
    else sessionStorage.removeItem(tokenKey)
  } catch {
    // Restricted storage can prevent same-tab handoff to the legacy pages.
  }
}

type Access = { session: Session, token: string }

export function PiWorkbenchApp() {
  const t = usePiTranslation()
  const approvalView = new URLSearchParams(window.location.search).get('view') === 'approvals'
  const [config, setConfig] = useState<LoginConfig>()
  const [access, setAccess] = useState<Access>()
  const [checked, setChecked] = useState(false)
  const [bootId, setBootId] = useState(0)
  const [bootError, setBootError] = useState<unknown>()
  const [authError, setAuthError] = useState<unknown>()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    setChecked(false)
    setBootError(undefined)

    async function boot() {
      const anonymous = createPiApi()
      const options = await anonymous.get<LoginConfig>('/auth/config', signal)
      if (signal.aborted) return
      setConfig(options)
      const stored = options.tokenLogin ? readToken() : ''
      if (stored) {
        try {
          const session = await createPiApi(stored).get<Session>('/api/me', signal)
          if (!signal.aborted) setAccess({ session, token: stored })
          return
        } catch (error) {
          if (signal.aborted) return
          if (!(error instanceof PiApiError) || error.status !== 401) throw error
        }
      }
      storeToken('')
      try {
        const session = await anonymous.get<Session>('/api/me', signal)
        if (!signal.aborted) setAccess({ session, token: '' })
      } catch (error) {
        if (!(error instanceof PiApiError) || error.status !== 401) throw error
      }
    }

    void boot().catch((error: unknown) => {
      if (!signal.aborted) setBootError(error)
    }).finally(() => {
      if (!signal.aborted) setChecked(true)
    })
    return () => controller.abort()
  }, [bootId])

  const expire = useCallback(() => {
    storeToken('')
    setAccess(undefined)
  }, [])
  const api = useMemo(() => createPiApi(access?.token, access?.session.csrfToken, expire), [access, expire])

  async function signIn(event: FormEvent) {
    event.preventDefault()
    const token = input.trim()
    if (!token || busy || !config?.tokenLogin) return
    setBusy(true)
    setAuthError(undefined)
    try {
      const session = await createPiApi(token).get<Session>('/api/me')
      storeToken(token)
      setAccess({ session, token })
      setInput('')
    } catch (error) {
      setAuthError(error)
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    await api.write('/api/logout', 'POST')
    expire()
  }

  if (access && !config?.localClient && (config?.managementOnly || approvalView)) return <main className="pi-page">
    <header className="pi-between"><strong>{t('pi.releaseGovernance')}</strong>
      <nav className="pi-wrap" aria-label={t('pi.releaseGovernance')}>
        {approvalView ? <>
          {!config?.managementOnly && <a className="pi-action-link" href="/desktop/">{t('pi.openWorkspace')}</a>}
          <a className="pi-action-link" href="/desktop/?view=updates">{t('pi.desktopRelease')}</a>
        </> : <a className="pi-action-link" href="/desktop/?view=approvals">{t('pi.approvalCenter')}</a>}
        <Button size="sm" variant="secondary" onClick={() => void signOut()}>{t('pi.signOut')}</Button>
      </nav>
    </header>
    <Suspense fallback={<LoadingState label={t('pi.connecting')} />}>
      {approvalView ? <ApprovalPanel api={api} identity={access.session.identity} />
        : <ReleasePanel api={api} admin={access.session.identity.admin} />}
    </Suspense>
  </main>
  if (access) return <Workspace api={api} session={access.session} onSignOut={signOut} localClient={config?.localClient} />

  const product = t('pi.product')
  const projectName = config?.project.name || product
  return (
    <main className="pi-login">
      <Card padding="lg" radius="xl" shadow="card" className="pi-login-card">
        <span className="pi-brand-mark" aria-hidden="true"><Layers3 size={22} strokeWidth={1.75} /></span>
        {projectName !== product && <p className="pi-kicker">{product}</p>}
        <h1>{projectName}</h1>
        {config?.project.description && <p className="pi-description">{config.project.description}</p>}
        {!checked && <LoadingState label={t('pi.connecting')} />}
        {Boolean(bootError) && <ErrorState
          title={t('pi.loadError')}
          detail={errorText(bootError, t('pi.connectError'))}
          retryLabel={t('pi.retry')}
          onRetry={() => setBootId((id) => id + 1)}
        />}
        {checked && config && !bootError && <div className="pi-login-options">
          {config.dingTalkLogin && <a className="pi-action-link pi-login-link"
            href={approvalView ? '/auth/dingtalk/start?next=%2Fdesktop%2F%3Fview%3Dapprovals' : '/auth/dingtalk/start?next=/desktop/'}
            onClick={() => storeToken('')}>
            <ShieldCheck size={17} strokeWidth={1.75} />
            {t('pi.dingTalkLogin')}
          </a>}
          {config.tokenLogin && <form onSubmit={(event) => void signIn(event)} className="pi-stack">
            <Input
              label={t('pi.token')}
              value={input}
              type="password"
              autoComplete="current-password"
              onChange={(event) => setInput(event.target.value)}
              error={authError ? errorText(authError, t('pi.loginError')) : undefined}
            />
            <Button type="submit" variant={config.dingTalkLogin ? 'secondary' : 'primary'} block loading={busy}
              disabled={!input.trim()} icon={<KeyRound size={16} strokeWidth={1.75} />}>
              {t('pi.tokenLogin')}
            </Button>
          </form>}
          {!config.dingTalkLogin && !config.tokenLogin && <p className="pi-description">{t('pi.noLogin')}</p>}
        </div>}
      </Card>
    </main>
  )
}
