import { BarChart3, Bot, Box, Braces, BriefcaseBusiness, Building2, CirclePlus, ClipboardCheck, Clock3, Folder, Layers3, LogOut, PanelLeftClose, Settings2, SquareTerminal, LibraryBig, Package, Search } from 'lucide-react'
import { useState } from 'react'
import { IconButton } from '@/components/ui/IconButton'
import { SearchField } from '@/components/ui/SearchField'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { usePiTranslation } from './usePiTranslation'
import { type Identity, type TaskSummary, type Workbench } from './api'
import { StatusBadge } from './presentation'

export type Page = 'new' | 'task' | 'query' | 'agents' | 'skills' | 'settings' | 'memory' | 'releases' | 'develop' | 'model' | 'connections'
type Area = 'work' | 'manage' | 'develop'

type Props = {
  workbench: Workbench
  page: Page
  tasks: TaskSummary[]
  taskId: string
  identity: Identity
  busy: boolean
  localClient?: boolean
  signOut: () => void
  close: () => void
  navigate: (page: Page) => void
  openTask: (id: string) => void
}

export function WorkbenchSidebar({ workbench, page, tasks, taskId, identity, busy, localClient, signOut, close, navigate, openTask }: Props) {
  const t = usePiTranslation()
  const product = t('pi.product')
  const [query, setQuery] = useState('')
  const area: Area = page === 'develop' ? 'develop' : ['settings', 'memory', 'releases', 'model', 'connections'].includes(page) ? 'manage' : 'work'
  const visibleTasks = tasks.filter((task) => task.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const knownGroups = new Set(workbench.groups.map((group) => group.id))
  const groups = [
    ...workbench.groups.map((group) => ({ ...group, tasks: visibleTasks.filter((task) => task.groupId === group.id) })),
    { id: '', label: t('pi.ungrouped'), tasks: visibleTasks.filter((task) => !task.groupId || !knownGroups.has(task.groupId)) },
  ]

  const mainLinks = area === 'work' ? [
    { page: 'new', label: t('pi.newTask'), icon: CirclePlus },
    ...(!localClient ? [{ page: 'query', label: t('pi.toolBrowser'), icon: Search }] as const : []),
    { page: 'agents', label: t('pi.agents'), icon: Bot },
    { page: 'skills', label: t('pi.skills'), icon: Box },
  ] as const : area === 'manage' && localClient ? [
    { page: 'connections', label: t('pi.clientConnections'), icon: Settings2 },
    { page: 'model', label: t('pi.usageHeading'), icon: BarChart3 },
    { page: 'memory', label: t('pi.memory'), icon: LibraryBig },
  ] as const : area === 'manage' ? [
    ...(identity.admin ? [{ page: 'settings', label: t('pi.workbenchSettings'), icon: Settings2 }] as const : []),
    { page: 'model', label: t('pi.modelUsage'), icon: BarChart3 },
    { page: 'memory', label: t('pi.memory'), icon: LibraryBig },
    { page: 'releases', label: t('pi.desktopRelease'), icon: Package },
  ] as const : [
    { page: 'develop', label: t('pi.developmentHome'), icon: SquareTerminal },
  ] as const

  return (
    <aside className="pi-sidebar" aria-label={t('pi.sidebar')}>
      <div className="pi-sidebar-top">
        <div className="pi-wordmark">
          <span className="pi-brand-mark"><Layers3 size={18} strokeWidth={1.75} aria-hidden="true" /></span>
          <div className="pi-wordmark-name">
            <strong>{product}</strong>
            {workbench.name !== product && <small title={workbench.name}>{workbench.name}</small>}
          </div>
        </div>
        <IconButton size="sm" className="pi-mobile-close" label={t('pi.hideSidebar')} icon={<PanelLeftClose size={17} strokeWidth={1.75} />}
          onClick={close} />
      </div>
      <div className="pi-sidebar-nav">
        <SegmentedControl<Area> label={t('pi.workspaceAreas')} size="sm" layout="fill" appearance="raised" value={area} className="pi-areas"
          items={[
            { value: 'work', label: t('pi.work'), icon: <BriefcaseBusiness size={14} strokeWidth={1.75} /> },
            { value: 'manage', label: t(localClient ? 'pi.clientSettings' : 'pi.manage'), icon: <Building2 size={14} strokeWidth={1.75} /> },
            { value: 'develop', label: t('pi.develop'), icon: <Braces size={14} strokeWidth={1.75} /> },
          ]}
          onChange={(value) => {
            if (value !== area) navigate(value === 'work' ? 'new' : value === 'develop' ? 'develop' : localClient ? 'connections' : identity.admin ? 'settings' : 'memory')
          }} />
        <nav aria-label={t('pi.sidebar')}>
          {mainLinks.map(({ page: target, label, icon: Icon }) => <button type="button" className="pi-nav-item" key={target}
            aria-current={page === target ? 'page' : undefined} onClick={() => navigate(target)} disabled={busy}>
            <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
            <span>{label}</span>
          </button>)}
          {!localClient && area !== 'develop' && <a className="pi-nav-item" href="/desktop/?view=approvals">
            <ClipboardCheck size={17} strokeWidth={1.75} aria-hidden="true" /><span>{t('pi.approvalCenter')}</span>
          </a>}
        </nav>
      </div>
      {area === 'work' && <section className="pi-history" aria-label={t('pi.history')}>
        <div className="pi-history-head">
          <h2 className="pi-inline"><Clock3 size={15} strokeWidth={1.75} aria-hidden="true" />{t('pi.history')}</h2>
          <SearchField label={t('pi.searchHistory')} clearLabel={t('pi.clearSearch')} size="sm"
            placeholder={t('pi.searchHistory')} value={query} onChange={setQuery} />
        </div>
        <div className="pi-history-list">
          {groups.map((group) => group.tasks.length > 0 && <details key={group.id} open className="pi-history-group">
            <summary><Folder size={15} strokeWidth={1.75} aria-hidden="true" /><span>{group.label}</span><small>{group.tasks.length}</small></summary>
            <ul>
              {group.tasks.map((task) => <li key={task.id}>
                <button type="button" className="pi-history-item" title={task.title} disabled={busy}
                  aria-current={page === 'task' && taskId === task.id ? 'page' : undefined}
                  onClick={() => openTask(task.id)}>
                  <span>{task.title}</span><StatusBadge status={task.status} />
                </button>
              </li>)}
            </ul>
          </details>)}
          {!visibleTasks.length && <p className="pi-history-empty">{t(query.trim() ? 'pi.noHistoryMatch' : 'pi.noHistory')}</p>}
        </div>
      </section>}
      <div className="pi-profile">
        <span className="pi-profile-avatar" aria-hidden="true">{Array.from(identity.name.trim())[0] ?? '·'}</span>
        <div className="pi-wordmark-name">
          <strong title={identity.name}>{identity.name}</strong>
          <small>{t(identity.admin && !localClient ? 'pi.admin' : 'pi.member')}</small>
        </div>
        {!localClient && <IconButton label={t('pi.signOut')} size="sm" icon={<LogOut size={17} strokeWidth={1.75} />} onClick={signOut} disabled={busy} />}
      </div>
    </aside>
  )
}
