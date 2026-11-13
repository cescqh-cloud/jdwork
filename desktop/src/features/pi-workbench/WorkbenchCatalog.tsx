import { ArrowUpRight, BookOpen, Bot, Box, CircleArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { usePiTranslation, type PiKey } from './usePiTranslation'
import { errorText, type Agent, type Category, type PiApi } from './api'
import { usePiResource } from './usePiResource'

const categoryLabels: Record<Category, PiKey> = { office: 'pi.office', analysis: 'pi.analysis', development: 'pi.development' }

export function AgentCatalog({ agents, onChoose }: { agents: Agent[], onChoose: (agent: Agent) => void }) {
  const t = usePiTranslation()
  return (
    <section className="pi-page">
      <header className="pi-page-heading">
        <p className="pi-kicker">{t('pi.workspaceKicker')}</p>
        <h1>{t('pi.agents')}</h1>
        <p className="pi-description">{t('pi.agentsHint')}</p>
      </header>
      {agents.length ? <div className="pi-cards">
        {agents.map((agent) => <Card as="article" radius="lg" className="pi-catalog-card" key={agent.id}>
          <div className="pi-card-heading">
            <span className="pi-card-icon"><Bot size={21} strokeWidth={1.75} aria-hidden="true" /></span>
            <Badge size="sm">{t(categoryLabels[agent.category])}</Badge>
          </div>
          <h2>{agent.label}</h2>
          <p>{agent.summary}</p>
          <Button size="sm" variant="secondary" icon={<CircleArrowRight size={15} strokeWidth={1.75} />}
            onClick={() => onChoose(agent)}>{t('pi.useAgent')}</Button>
        </Card>)}
      </div> : <EmptyState variant="plain" title={t('pi.noAgents')} icon={<Bot size={22} strokeWidth={1.75} />} />}
    </section>
  )
}

type Template = { id: string, name: string, hint: string }

export function SkillCatalog({ api }: { api: PiApi }) {
  const t = usePiTranslation()
  const resources = usePiResource<{ templates: Template[] }>(api, '/api/status')
  return (
    <section className="pi-page">
      <header className="pi-page-heading">
        <p className="pi-kicker">{t('pi.workspaceKicker')}</p>
        <h1>{t('pi.skills')}</h1>
        <p className="pi-description">{t('pi.skillsHint')}</p>
      </header>
      {Boolean(resources.error) && <ErrorState title={errorText(resources.error, t('pi.loadError'))}
        onRetry={resources.refresh} retryLabel={t('pi.retry')} />}
      {!resources.value && !resources.error && <LoadingState label={t('pi.loadingSkills')} />}
      {resources.value && <div className="pi-cards">
        {resources.value.templates.map((template) => <Card as="article" radius="lg" className="pi-catalog-card" key={template.id}>
          <span className="pi-card-icon"><Box size={21} strokeWidth={1.75} aria-hidden="true" /></span>
          <h2>{template.name}</h2>
          <p>{template.hint}</p>
        </Card>)}
      </div>}
      <a className="pi-action-link" href="/?view=knowledge">
        <BookOpen size={16} strokeWidth={1.75} aria-hidden="true" />
        {t('pi.openKnowledge')}
        <ArrowUpRight size={15} strokeWidth={1.75} aria-hidden="true" />
      </a>
    </section>
  )
}
