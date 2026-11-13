import { ArrowUpRight, BookOpen, CodeXml, GitBranch, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { lazy, useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { ErrorState } from '@/components/ui/ErrorState'
import { Input } from '@/components/ui/Input'
import { TextArea } from '@/components/ui/TextArea'
import { usePiTranslation } from './usePiTranslation'
import { errorText, PiApiError, type Identity, type PiApi, type Workbench } from './api'

const MemoryPanel = lazy(() => import('./MemoryPanel').then((module) => ({ default: module.MemoryPanel })))
const ReleasePanel = lazy(() => import('./ReleasePanel').then((module) => ({ default: module.ReleasePanel })))
const ModelUsagePanel = lazy(() => import('./ModelUsagePanel').then((module) => ({ default: module.ModelUsagePanel })))

type Props = { api: PiApi, identity: Identity, workbench: Workbench, refreshWorkbench: () => void }

function PortalLink({ href, icon, children }: { href: string, icon?: ReactNode, children: ReactNode }) {
  return <a className="pi-action-link" href={href}>
    {icon}{children}<ArrowUpRight size={15} strokeWidth={1.75} aria-hidden="true" />
  </a>
}

function WorkspaceSettings({ api, workbench, refreshWorkbench }: Props) {
  const t = usePiTranslation()
  const [draft, setDraft] = useState(workbench)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>()
  const path = '/api/desktop/workbench'

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || !draft.name.trim() || !draft.description.trim()) return
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      const { revision, name, description, enabledAgentIds } = draft
      const result = await api.write<Workbench>(path, 'PUT', { revision, name, description, enabledAgentIds })
      setDraft(result)
      refreshWorkbench()
      setSaved(true)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  async function reload() {
    setBusy(true)
    try {
      setDraft(await api.get<Workbench>(path))
      setError(undefined)
      refreshWorkbench()
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  function change(update: Partial<Workbench>) {
    setSaved(false)
    setDraft((current) => ({ ...current, ...update }))
  }

  return (
    <section className="pi-page">
      <header className="pi-page-heading">
        <p className="pi-kicker">{t('pi.manage')}</p>
        <h1>{t('pi.workbenchSettings')}</h1>
        <p className="pi-description">{t('pi.settingsHint')}</p>
      </header>
      <Card padding="lg" radius="lg">
        <form className="pi-stack" onSubmit={(event) => void save(event)}>
          <Input label={t('pi.workspaceName')} value={draft.name} maxLength={80} required disabled={busy}
            onChange={(event) => change({ name: event.target.value })} />
          <TextArea label={t('pi.workspaceDescription')} value={draft.description} maxLength={1000} required disabled={busy}
            onChange={(event) => change({ description: event.target.value })} />
          <fieldset className="pi-stack pi-settings-agents">
            <legend>{t('pi.enabledAgents')}</legend>
            {draft.agents.map((agent) => <Checkbox key={agent.id} label={agent.label} description={agent.summary}
              checked={draft.enabledAgentIds.includes(agent.id)} disabled={busy}
              onChange={(event) => change({
                enabledAgentIds: event.target.checked
                  ? [...draft.enabledAgentIds, agent.id]
                  : draft.enabledAgentIds.filter((id) => id !== agent.id),
              })} />)}
          </fieldset>
          {Boolean(error) && <ErrorState size="sm" title={errorText(error, t('pi.saveError'))}
            retryLabel={t('pi.reloadSettings')} onRetry={error instanceof PiApiError && error.status === 409 && !busy ? () => void reload() : undefined} />}
          <div className="pi-inline">
            <Button type="submit" variant="primary" size="base" loading={busy}
              disabled={!draft.name.trim() || !draft.description.trim()}>{t('pi.save')}</Button>
            {saved && <span className="pi-subtle" role="status">{t('pi.saved')}</span>}
          </div>
        </form>
      </Card>
      <div className="pi-wrap">
        <PortalLink href="/?view=settings" icon={<SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />}>{t('pi.modelSettings')}</PortalLink>
        <PortalLink href="/?view=audit" icon={<ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" />}>{t('pi.auditLog')}</PortalLink>
      </div>
    </section>
  )
}

export function Management({ page, ...props }: Props & { page: 'settings' | 'memory' | 'releases' | 'develop' | 'model' }) {
  const t = usePiTranslation()
  if (page === 'settings' && props.identity.admin) return <WorkspaceSettings {...props} />
  if (page === 'memory') return <MemoryPanel api={props.api} admin={props.identity.admin} />
  if (page === 'releases') return <ReleasePanel api={props.api} admin={props.identity.admin} />
  if (page === 'model') return <ModelUsagePanel api={props.api} identity={props.identity} />

  return (
    <section className="pi-page">
      <header className="pi-page-heading">
        <p className="pi-kicker">{t('pi.develop')}</p>
        <h1>{t('pi.developmentHome')}</h1>
        <p className="pi-description">{t(props.identity.admin ? 'pi.developmentHint' : 'pi.memberDevelopmentHint')}</p>
      </header>
      <div className="pi-cards">
        {props.identity.admin && <>
          <Card as="article" radius="lg" className="pi-catalog-card">
            <span className="pi-card-icon"><CodeXml size={21} strokeWidth={1.75} aria-hidden="true" /></span>
            <h2>{t('pi.kingdee')}</h2>
            <p>{t('pi.kingdeeHint')}</p>
            <PortalLink href="/?view=kingdee">{t('pi.openWorkspace')}</PortalLink>
          </Card>
          <Card as="article" radius="lg" className="pi-catalog-card">
            <span className="pi-card-icon"><GitBranch size={21} strokeWidth={1.75} aria-hidden="true" /></span>
            <h2>{t('pi.codeVersions')}</h2>
            <p>{t('pi.codeVersionsHint')}</p>
            <PortalLink href="/?view=versions">{t('pi.openWorkspace')}</PortalLink>
          </Card>
        </>}
        <Card as="article" radius="lg" className="pi-catalog-card">
          <span className="pi-card-icon"><BookOpen size={21} strokeWidth={1.75} aria-hidden="true" /></span>
          <h2>{t('pi.knowledge')}</h2>
          <p>{t('pi.knowledgeHint')}</p>
          <PortalLink href="/?view=knowledge">{t('pi.openKnowledge')}</PortalLink>
        </Card>
      </div>
    </section>
  )
}
