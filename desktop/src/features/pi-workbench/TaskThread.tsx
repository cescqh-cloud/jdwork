import { BookOpen, CircleCheck, CircleX, FileDown, FileText, FolderOpen, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { usePiTranslation, type PiKey } from './usePiTranslation'
import { errorText, taskPath, type PiApi, type Task, type ToolEvent } from './api'
import { noInlineImages } from './presentation'
import { usePiResource } from './usePiResource'

const toolLabels: Record<string, PiKey> = {
  list_files: 'pi.toolList',
  read_file: 'pi.toolRead',
  save_artifact: 'pi.toolSave',
  computer_use: 'pi.toolComputer',
  browser_query: 'pi.toolBrowser',
  mcp_connection: 'pi.toolMcp',
  search_knowledge: 'pi.toolSearch',
  search_server_knowledge: 'pi.toolsServerKnowledge',
  search_project_memory: 'pi.toolsSharedMemory',
  recall_memory: 'pi.toolRecall',
  remember: 'pi.toolRemember',
  subagent: 'pi.toolSubagent',
}

function currentTools(tools: ToolEvent[]) {
  const current = new Map<string, ToolEvent>()
  tools.forEach((event, index) => {
    const key = event.callId || `event-${index}`
    current.set(key, { ...current.get(key), ...event })
  })
  return [...current.entries()]
}

function Evidence({ task }: { task: Task }) {
  const t = usePiTranslation()
  const calls = currentTools(task.tools)
  const files = new Set(calls.flatMap(([, event]) => (
    event.name === 'read_file' && event.status === 'succeeded' && event.path && event.area && event.area !== 'artifacts'
      ? [`${event.area}/${event.path}`]
      : []
  )))
  if (task.svnSource) files.add(`SVN · ${task.svnSource.path} · r${task.svnSource.revision}`)
  if (task.svnVersion) files.add(`SVN · ${task.svnVersion.path} · r${task.svnVersion.uatRevision} / r${task.svnVersion.productionRevision}`)
  if (task.codeVersion) files.add(`${task.codeVersion.repositoryName} · ${task.codeVersion.base ? `${task.codeVersion.base.slice(0, 8)} → ` : ''}${task.codeVersion.head.slice(0, 8)}`)
  const attachmentNames = new Set(task.messages.flatMap((message) => message.attachments ?? []))
  const hasSources = !!files.size || !!attachmentNames.size

  return (
    <>
      {!!calls.length && <details className="pi-disclosure" open>
        <summary><Wrench size={15} strokeWidth={1.75} aria-hidden="true" />{t('pi.toolActivity')}<Badge size="xs">{calls.length}</Badge></summary>
        <ol className="pi-tool-list">
          {calls.map(([id, event]) => <li key={id}>
            {event.status === 'failed'
              ? <CircleX size={15} strokeWidth={1.75} aria-label={t('pi.failed')} />
              : event.status === 'succeeded'
                ? <CircleCheck size={15} strokeWidth={1.75} aria-label={t('pi.completed')} />
                : <span className="pi-activity-dot" role="img" aria-label={t('pi.toolStarted')} />}
            <span>{toolLabels[event.name] ? t(toolLabels[event.name]!) : event.name}</span>
            {event.path && <code>{[event.area, event.path].filter(Boolean).join('/')}</code>}
          </li>)}
        </ol>
      </details>}
      {hasSources && <details className="pi-disclosure" open>
        <summary><BookOpen size={15} strokeWidth={1.75} aria-hidden="true" />{t('pi.sources')}</summary>
        <ul className="pi-source-list">
          {[...files].map((file) => <li key={file}><code>{file}</code></li>)}
          {[...attachmentNames].map((name) => <li key={name}><FileText size={14} strokeWidth={1.75} aria-hidden="true" />{name}</li>)}
        </ul>
      </details>}
    </>
  )
}

export function TaskThread({ task, api }: { task: Task, api: PiApi }) {
  const t = usePiTranslation()
  const artifacts = usePiResource<string[]>(api, `${taskPath(task.id)}/artifacts`, task.messages.length + Number(task.status !== 'running'))
  const [downloading, setDownloading] = useState('')
  const [error, setError] = useState('')
  const scroll = useRef<HTMLDivElement>(null)
  const followOutput = useRef(true)
  const lastMessage = task.messages.at(-1)?.text

  useEffect(() => {
    if (followOutput.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [lastMessage, task.tools.length, task.status])

  async function download(path: string) {
    if (downloading) return
    setError('')
    setDownloading(path)
    try {
      await api.download(`${taskPath(task.id)}/download?${new URLSearchParams({ path })}`, path)
    } catch (cause) {
      setError(errorText(cause, t('pi.downloadError')))
    } finally {
      setDownloading('')
    }
  }

  return (
    <div className="pi-thread" ref={scroll} onScroll={(event) => {
      const element = event.currentTarget
      followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100
    }}>
      <ol className="pi-messages" aria-label={t('pi.conversation')}>
        {task.messages.map((message, index) => message.text && <li className={`pi-message pi-message-${message.role}`} key={index}>
          <div className="pi-message-meta">
            <span>{t(message.role === 'user' ? 'pi.you' : 'pi.assistant')}</span>
            <time dateTime={message.at}>{new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          </div>
          {message.role === 'assistant'
            ? <MarkdownRenderer content={message.text} resolveImageSrc={noInlineImages}
              streaming={task.status === 'running' && index === task.messages.length - 1} />
            : <div className="pi-user-message">{message.text}</div>}
        </li>)}
      </ol>
      {task.status === 'running' && <LoadingState label={t('pi.processing')} variant="inline" />}
      {task.error && <ErrorState size="sm" title={task.error} />}
      <Evidence task={task} />
      {Boolean(artifacts.error) && <ErrorState size="sm" title={errorText(artifacts.error, t('pi.loadError'))}
        onRetry={artifacts.refresh} retryLabel={t('pi.retry')} />}
      {!!artifacts.value?.length && <Card radius="lg" padding="sm" className="pi-stack">
        <h3 className="pi-inline"><FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />{t('pi.artifacts')}</h3>
        {artifacts.value.map((path) => <Button size="sm" variant="secondary" key={path} className="pi-artifact-button"
          loading={downloading === path} disabled={!!downloading && downloading !== path}
          onClick={() => void download(path)} icon={<FileDown size={15} strokeWidth={1.75} />}>{path}</Button>)}
        {error && <ErrorState size="sm" title={error} />}
      </Card>}
    </div>
  )
}
