import { ArrowRight, BookOpen, Bot, FileText, FolderOpen, KeyRound, PanelLeftOpen, Square } from 'lucide-react'
import { lazy, useEffect, useReducer, useRef, useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { LoadingState } from '@/components/ui/LoadingState'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { usePiTranslation, type PiKey } from './usePiTranslation'
import { defaultGroup, errorText, isRequirementTask, PiApiError, taskPath, type Agent, type Category, type ClientConnections, type DesktopModel, type PiApi, type RequirementAction, type Session, type Task, type TaskInput, type TaskSummary, type Workbench } from './api'
import { StatusBadge } from './presentation'
import { TaskComposer, type TaskComposerHandle } from './TaskComposer'
import { usePiResource } from './usePiResource'
import { WorkbenchSidebar, type Page } from './WorkbenchSidebar'
import { AgentCatalog, SkillCatalog } from './WorkbenchCatalog'
import { WorkbenchPane } from './WorkbenchPane'
import { WorkbenchTools, type ToolSettingsSection } from './WorkbenchTools'

const TaskThread = lazy(() => import('./TaskThread').then((module) => ({ default: module.TaskThread })))
const RequirementsPanel = lazy(() => import('./RequirementsPanel').then((module) => ({ default: module.RequirementsPanel })))
const Management = lazy(() => import('./Management').then((module) => ({ default: module.Management })))
const ConnectionsPanel = lazy(() => import('./ConnectionsPanel').then((module) => ({ default: module.ConnectionsPanel })))
const ModelUsagePanel = lazy(() => import('./ModelUsagePanel').then((module) => ({ default: module.ModelUsagePanel })))
const WebQueryPanel = lazy(() => import('./WebQueryPanel').then((module) => ({ default: module.WebQueryPanel })))

const categories: ReadonlyArray<{ value: Category, label: PiKey }> = [
  { value: 'office', label: 'pi.office' },
  { value: 'analysis', label: 'pi.analysis' },
  { value: 'development', label: 'pi.development' },
]

function useTask(api: PiApi, id: string) {
  const [generation, refresh] = useReducer((value: number) => value + 1, 0)
  const [result, setResult] = useState<{ id: string, generation: number, task?: Task, error?: unknown }>()
  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    let timer: number | undefined
    async function poll() {
      let retry = false
      try {
        const task = await api.get<Task>(taskPath(id), controller.signal)
        if (controller.signal.aborted) return
        setResult({ id, generation, task })
        retry = task.status === 'running'
      } catch (error) {
        if (controller.signal.aborted) return
        const noAccess = error instanceof PiApiError && [401, 403, 404].includes(error.status)
        setResult((previous) => ({
          id, generation, task: !noAccess && previous?.id === id ? previous.task : undefined, error,
        }))
        retry = !noAccess
      }
      if (retry) timer = window.setTimeout(() => void poll(), 1500)
    }
    void poll()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [api, id, generation])
  const current = result?.id === id ? result : undefined
  return { task: current?.task, error: current?.error, updating: current?.generation !== generation, refresh }
}

function selectUrlTask(taskId: string, view?: 'updates' | 'model' | 'connections' | 'query', section?: ToolSettingsSection) {
  const url = new URL(window.location.href)
  if (taskId) url.searchParams.set('task', taskId)
  else url.searchParams.delete('task')
  if (view) url.searchParams.set('view', view)
  else url.searchParams.delete('view')
  if (view === 'connections' && section) url.searchParams.set('section', section)
  else if (view !== 'connections') url.searchParams.delete('section')
  window.history.replaceState(null, '', url)
}

type Props = { api: PiApi, session: Session, onSignOut: () => Promise<void>, localClient?: boolean }

export function Workspace({ api, session, onSignOut, localClient }: Props) {
  const t = usePiTranslation()
  const product = t('pi.product')
  const catalog = usePiResource<Workbench>(api, '/api/desktop/workbench')
  const workbench = catalog.value
  const workbenchName = workbench?.name || session.project.name
  const history = usePiResource<TaskSummary[]>(api, '/api/tasks')
  const { refresh: refreshHistory } = history
  const [taskId, setTaskId] = useState(() => new URLSearchParams(window.location.search).get('task') ?? '')
  const [page, setPage] = useState<Page>(() => {
    const view = new URLSearchParams(window.location.search).get('view')
    if (localClient && (view === 'connections' || view === 'updates')) return 'connections'
    if (!localClient && view === 'query') return 'query'
    return view === 'updates' ? 'releases' : view === 'model' ? 'model' : taskId ? 'task' : 'new'
  })
  const model = usePiResource<DesktopModel>(api, page === 'new' && !localClient ? '/api/desktop/model' : null).value
  const connections = usePiResource<ClientConnections>(api, localClient ? '/api/client/settings' : null)
  const [category, setCategory] = useState<Category>('office')
  const [agentId, setAgentId] = useState('')
  const [requirementMode, setRequirementMode] = useState<'clarify' | 'draft'>('clarify')
  const [chosenGroup, setChosenGroup] = useState('')
  const [prompt, setPrompt] = useState('')
  const [focusRequest, focusComposer] = useReducer((value: number) => value + 1, 0)
  const [documentOpen, setDocumentOpen] = useState<boolean>()
  const [intent, setIntent] = useState<RequirementAction>()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [newTaskId, resetComposer] = useReducer((value: number) => value + 1, 0)
  const [busy, setBusy] = useState<'send' | 'cancel' | 'logout'>()
  const [stoppingId, setStoppingId] = useState('')
  const [error, setError] = useState('')
  const actionLock = useRef(false)
  const followUpComposer = useRef<TaskComposerHandle>(null)
  const details = useTask(api, taskId)
  const task = details.task
  const { refresh: refreshTask } = details
  const status = task?.status
  const agents = workbench?.agents.map((agent) => localClient && agent.id === 'knowledge'
    ? { ...agent, label: t('pi.clientAssistant'), summary: t('pi.clientAssistantHint') }
    : agent) ?? []
  const enabledAgents = agents.filter((agent) => workbench?.enabledAgentIds.includes(agent.id))
  const activeCategory = enabledAgents.some((agent) => agent.category === category)
    ? category : enabledAgents[0]?.category ?? category
  const categoryAgents = enabledAgents.filter((agent) => agent.category === activeCategory)
  const selectedAgent = categoryAgents.find((agent) => agent.id === agentId)
    ?? categoryAgents.find((agent) => agent.id === (localClient ? 'knowledge' : 'requirements')) ?? categoryAgents[0]
  const taskAgent = agents.find((agent) => task?.agentId === agent.id)
  const groupId = workbench?.groups.find((group) => group.id === chosenGroup)?.id
    ?? (workbench ? defaultGroup(workbench, selectedAgent) : '')
  const ownTask = task?.ownerId === session.identity.id
  const showDocument = documentOpen ?? isRequirementTask(task)
  const canSend = status !== 'running' && !details.updating && !details.error && ownTask

  useEffect(() => {
    if (status) refreshHistory()
  }, [taskId, status, refreshHistory])

  useEffect(() => {
    document.title = localClient || workbenchName === product ? product : `${workbenchName} · ${product}`
  }, [localClient, product, workbenchName])

  function clearComposer() {
    setPrompt('')
    setIntent(undefined)
    setError('')
    resetComposer()
  }

  function navigate(target: Page, section?: ToolSettingsSection) {
    if (actionLock.current) return
    setSidebarOpen(false)
    setError('')
    if (target === 'new') {
      setTaskId('')
      setDocumentOpen(undefined)
      setRequirementMode('clarify')
      clearComposer()
    }
    selectUrlTask(target === 'task' ? taskId : '', target === 'releases' ? 'updates'
      : target === 'model' || target === 'connections' || target === 'query' ? target : undefined, section)
    setPage(target)
  }

  function openTask(id: string) {
    if (actionLock.current) return
    setSidebarOpen(false)
    if (id !== taskId || page === 'new') {
      clearComposer()
      setDocumentOpen(undefined)
      setTaskId(id)
    }
    setPage('task')
    selectUrlTask(id)
  }

  function chooseAgent(agent: Agent, starter = false) {
    setCategory(agent.category)
    setAgentId(agent.id)
    if (page !== 'new') navigate('new')
    if (page !== 'new' || (starter && !prompt.trim())) setPrompt(agent.starter)
    focusComposer()
  }

  function draftTool(promptText: string) {
    const assistant = enabledAgents.find((agent) => agent.id === 'knowledge') ?? selectedAgent
    if (!assistant) return
    setCategory(assistant.category)
    setAgentId(assistant.id)
    setRequirementMode('clarify')
    setPrompt((previous) => previous.trim() ? `${previous.trimEnd()}\n\n${promptText}` : promptText)
    focusComposer()
  }

  async function submit(text: string, attachmentIds: string[], actionOverride?: RequirementAction) {
    if (actionLock.current || (page === 'task' ? !task || !canSend : !selectedAgent)) return false
    const kind = page === 'task' ? task?.kind : selectedAgent?.kind
    if (!kind) return false
    const continuing = page === 'task' && task
    const requirementAction = actionOverride ?? intent
      ?? (!continuing && selectedAgent?.id === 'requirements' && requirementMode === 'draft' ? { type: 'draft' } : undefined)
    const input: TaskInput = {
      kind, prompt: text,
      ...(continuing ? { taskId: continuing.id } : { agentId: selectedAgent?.id, ...(groupId && { groupId }) }),
      ...(attachmentIds.length && { attachmentIds }),
      ...(requirementAction && { requirementAction }),
    }
    actionLock.current = true
    setBusy('send')
    setError('')
    try {
      const result = await api.write<{ id: string }>('/api/tasks', 'POST', input)
      setPrompt('')
      setIntent(undefined)
      setStoppingId('')
      setTaskId(result.id)
      setPage('task')
      selectUrlTask(result.id)
      if (requirementAction) setDocumentOpen(true)
      refreshTask()
      refreshHistory()
      return true
    } catch (cause) {
      setError(errorText(cause, t('pi.sendError')))
      return false
    } finally {
      actionLock.current = false
      setBusy(undefined)
    }
  }

  async function cancel() {
    if (!task || !ownTask || actionLock.current || stoppingId === task.id) return
    actionLock.current = true
    setBusy('cancel')
    setError('')
    try {
      await api.write(`${taskPath(task.id)}/cancel`, 'POST')
      setStoppingId(task.id)
      refreshTask()
    } catch (cause) {
      setError(errorText(cause, t('pi.cancelError')))
    } finally {
      actionLock.current = false
      setBusy(undefined)
    }
  }

  async function signOut() {
    if (actionLock.current) return
    actionLock.current = true
    setBusy('logout')
    setError('')
    try {
      await onSignOut()
    } catch (cause) {
      setError(errorText(cause, t('pi.signOutError')))
    } finally {
      actionLock.current = false
      setBusy(undefined)
    }
  }

  async function pickWorkspace() {
    if (actionLock.current) return
    actionLock.current = true
    setBusy('send')
    setError('')
    try { await api.write('/api/client/folder', 'POST', {}); connections.refresh() }
    catch (cause) { setError(errorText(cause, t('pi.saveError'))) }
    finally { actionLock.current = false; setBusy(undefined) }
  }

  function refine(section: string, revision: number) {
    setIntent({ type: 'section', section, revision })
    focusComposer()
  }

  if (!workbench) return <main className="pi-login">
    {catalog.error ? <ErrorState title={errorText(catalog.error, t('pi.loadError'))}
      retryLabel={t('pi.retry')} onRetry={catalog.refresh} /> : <LoadingState label={t('pi.loadingWorkspace')} />}
  </main>

  const sectionName = intent?.type === 'section' ? workbench.requirementSections.find((section) => section.id === intent.section)?.label : undefined
  const pageTitle = page === 'task' ? task?.title || t('pi.conversation') : page === 'new' ? t('pi.newTask')
    : page === 'agents' ? t('pi.agents') : page === 'skills' ? t('pi.skills') : page === 'settings' ? t('pi.workbenchSettings')
      : page === 'memory' ? t('pi.memory') : page === 'releases' ? t('pi.desktopRelease') : page === 'model' ? t('pi.modelUsage')
        : page === 'connections' ? t('pi.clientConnections') : page === 'query' ? t('pi.toolBrowser') : t('pi.developmentHome')
  const workspace = connections.value?.workspace
  const runtime = connections.value?.runtime
  const folderButton = localClient ? <Button type="button" variant="secondary" size="sm" className="pi-fit"
    icon={<FolderOpen size={15} strokeWidth={1.75} />} title={workspace || t('pi.clientFolder')}
    disabled={!!busy || status === 'running'} onClick={() => void pickWorkspace()}>
    {workspace?.split(/[\\/]/).pop() || t('pi.clientFolder')}
  </Button> : undefined

  return (
    <div className="pi-workbench" data-sidebar-open={sidebarOpen}>
      <WorkbenchSidebar workbench={workbench} page={page} taskId={taskId} tasks={history.value ?? []} identity={session.identity}
        close={() => setSidebarOpen(false)} busy={!!busy} localClient={localClient}
        navigate={navigate} openTask={openTask} signOut={() => void signOut()} />
      <main className="pi-main">
        <header className="pi-topbar" data-home={page === 'new'}>
          <div className="pi-topbar-title">
            <IconButton size="sm" className="pi-mobile-menu" label={t('pi.showSidebar')} onClick={() => setSidebarOpen(true)}
              icon={<PanelLeftOpen size={17} strokeWidth={1.75} />} />
            {page === 'task' ? <h1 title={pageTitle}>{pageTitle}</h1> : page !== 'new' && <span>{pageTitle}</span>}
            {page === 'task' && task && <StatusBadge status={task.status} />}
          </div>
          <div className="pi-wrap">
            {page === 'new' && <Button size="sm" variant="secondary" className="pi-client-link" onClick={() => navigate(localClient ? 'connections' : 'model')}
              title={t(localClient ? 'pi.clientConnections' : 'pi.modelUsage')} aria-label={t(localClient ? 'pi.clientConnections' : 'pi.modelUsage')}
              disabled={!!busy} icon={<KeyRound size={14} strokeWidth={1.75} />}>
              {t(localClient ? 'pi.clientConnections' : model?.source === 'personal' ? 'pi.modelPersonal' : model?.source === 'server' ? 'pi.modelServer' : 'pi.modelUsage')}
            </Button>}
            {page === 'task' && task && ownTask && task.status === 'running' && <Button size="sm" variant="danger-outline"
              icon={<Square size={13} strokeWidth={1.75} />} loading={busy === 'cancel'}
              disabled={!!busy || stoppingId === task.id} onClick={() => void cancel()}>
              {t(stoppingId === task.id ? 'pi.stopping' : 'pi.stop')}
            </Button>}
            {page === 'task' && task && <Button size="sm" variant={showDocument ? 'tonal' : 'secondary'} aria-pressed={showDocument}
              icon={<FileText size={15} strokeWidth={1.75} />} onClick={() => setDocumentOpen(!showDocument)}>{t('pi.requirements')}</Button>}
            {!localClient && page !== 'releases' && page !== 'task' && <Button size="sm" variant="secondary" className="pi-client-link" onClick={() => navigate('releases')} disabled={!!busy}
              icon={<ArrowRight size={14} strokeWidth={1.75} />} iconPosition="end">{t('pi.desktopRelease')}</Button>}
          </div>
        </header>
        {Boolean(catalog.error) && <ErrorState size="sm" className="pi-banner" title={errorText(catalog.error, t('pi.loadError'))}
          onRetry={catalog.refresh} retryLabel={t('pi.retry')} />}
        {Boolean(history.error) && <ErrorState size="sm" className="pi-banner" title={errorText(history.error, t('pi.historyError'))}
          onRetry={refreshHistory} retryLabel={t('pi.retry')} />}
        {error && <ErrorState size="sm" className="pi-banner" title={error} />}
        {page === 'new' && <section className="pi-home">
          <div className="pi-home-content">
            <div className="pi-home-heading">
              {runtime && <Badge className="pi-runtime-badge">{t('pi.toolsRuntime', {
                version: runtime.version, engine: runtime.engine === 'cc-haha' ? 'cc-haha' : 'Pi', engineVersion: runtime.engineVersion,
              })}</Badge>}
              <h1>{localClient ? product : workbench.name}</h1>
              <p className="pi-description">{localClient ? t('pi.clientHomeHint') : workbench.description || t('pi.homeHint')}</p>
            </div>
            {localClient && connections.value && <WorkbenchTools api={api} value={connections.value} disabled={!!busy}
              canDraft={!!selectedAgent} onDraft={draftTool} onSettings={(section) => navigate('connections', section)} />}
            {localClient && Boolean(connections.error) && <ErrorState size="sm" title={errorText(connections.error, t('pi.loadError'))}
              onRetry={connections.refresh} retryLabel={t('pi.retry')} />}
            <SegmentedControl<Category> label={t('pi.scenes')} value={activeCategory} appearance="raised" className="pi-scenes"
              items={categories.map((item) => ({ ...item, label: t(item.label), disabled: !enabledAgents.some((agent) => agent.category === item.value) }))}
              onChange={setCategory} />
            <TaskComposer key={`new-${newTaskId}`} api={api} prompt={prompt} setPrompt={setPrompt}
              agents={categoryAgents} agent={selectedAgent} onAgent={setAgentId}
              groups={workbench.groups} groupId={groupId} onGroup={setChosenGroup}
              disabled={!selectedAgent} sending={busy === 'send'} focusRequest={focusRequest} localClient={localClient}
              footerContent={<>{folderButton}{selectedAgent?.id === 'requirements' && <SegmentedControl<'clarify' | 'draft'>
                label={t('pi.requirementMode')} size="sm" value={requirementMode} className="pi-requirement-mode"
                appearance="raised" onChange={setRequirementMode}
                items={[
                  { value: 'clarify', label: t('pi.clarifyMode'), disabled: !!busy },
                  { value: 'draft', label: t('pi.draftMode'), disabled: !!busy },
                ]} />}</>}
              clearAction={() => setIntent(undefined)} onSubmit={submit} />
            <div className="pi-quick-starts">
              <span className="sr-only">{t('pi.quickStart')}</span>
              {categoryAgents.map((agent) => {
                const Icon = agent.id === 'requirements' ? FileText : agent.id === 'knowledge' ? BookOpen : Bot
                return <Button key={agent.id} size="base" variant="secondary" title={agent.summary} className="pi-shortcut-chip"
                  icon={<Icon size={15} strokeWidth={1.75} />} onClick={() => chooseAgent(agent, true)} disabled={!!busy}>{agent.label}</Button>
              })}
              {!categoryAgents.length && <p className="pi-subtle">{t('pi.noAgents')}</p>}
            </div>
          </div>
          <footer className="pi-home-footer">{t('pi.reviewOutput')}</footer>
        </section>}
        {page === 'task' && <>
          {Boolean(details.error) && <ErrorState className="pi-banner" title={errorText(details.error, t('pi.loadError'))}
            onRetry={refreshTask} retryLabel={t('pi.retry')} />}
          {!task && !details.error && <LoadingState label={t('pi.loadingTask')} />}
          {task && <div className="pi-task-layout" data-document-open={showDocument}>
            <section className="pi-conversation" aria-label={t('pi.conversation')}>
              <WorkbenchPane key={task.id} loadingLabel={t('pi.loadingTask')}>
                <TaskThread task={task} api={api} />
              </WorkbenchPane>
              <div className="pi-follow-up">
                {ownTask
                  ? <TaskComposer key={task.id} ref={followUpComposer} api={api} prompt={prompt} setPrompt={setPrompt}
                    agent={taskAgent} disabled={!canSend} sending={busy === 'send'} focusRequest={focusRequest} localClient={localClient}
                    footerContent={folderButton}
                    actionLabel={sectionName ? t('pi.refineNamed', { name: sectionName }) : undefined}
                    clearAction={() => setIntent(undefined)} onSubmit={submit} />
                  : <Badge>{t('pi.readOnlyTask')}</Badge>}
              </div>
            </section>
            {showDocument && <WorkbenchPane key={task.id} loadingLabel={t('pi.loadingDocument')}>
              <RequirementsPanel api={api} task={task} sections={workbench.requirementSections}
                canEdit={ownTask && !details.error} working={task.status === 'running' || details.updating || !!busy}
                onClose={() => setDocumentOpen(false)}
                onGenerate={(revision) => followUpComposer.current?.generateDraft(t('pi.draftPrompt'), revision)}
                onRefine={refine} />
            </WorkbenchPane>}
          </div>}
        </>}
        {page === 'agents' && <AgentCatalog agents={enabledAgents} onChoose={chooseAgent} />}
        {page === 'skills' && <SkillCatalog api={api} />}
        {page !== 'new' && page !== 'task' && page !== 'agents' && page !== 'skills' && <WorkbenchPane key={page} loadingLabel={t('pi.loadingWorkspace')}>
          {page === 'query' ? <WebQueryPanel api={api} />
            : page === 'connections' ? <ConnectionsPanel api={api} resource={connections} />
            : page === 'model' && localClient ? <ModelUsagePanel api={api} identity={{ ...session.identity, admin: false }} localClient />
              : <Management page={page} api={api} identity={session.identity} workbench={workbench} refreshWorkbench={catalog.refresh} />}
        </WorkbenchPane>}
      </main>
    </div>
  )
}
