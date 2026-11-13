import { ArrowUp, Bot, Cloud, Folder, Paperclip, X } from 'lucide-react'
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { SelectField } from '@/components/ui/SelectField'
import { TextArea } from '@/components/ui/TextArea'
import { usePiTranslation } from './usePiTranslation'
import { errorText, type Agent, type Attachment, type PiApi, type RequirementAction } from './api'

const extensions = ['.md', '.txt', '.csv', '.pdf', '.docx', '.xlsx', '.pptx']
const maxFiles = 4
const maxBytes = 10 * 1024 * 1024

type Props = {
  api: PiApi
  prompt: string
  setPrompt: (prompt: string) => void
  agent?: Agent
  agents?: Agent[]
  onAgent?: (id: string) => void
  groups?: { id: string, label: string }[]
  groupId?: string
  onGroup?: (id: string) => void
  disabled: boolean
  sending: boolean
  localClient?: boolean
  focusRequest: number
  actionLabel?: string
  footerContent?: ReactNode
  clearAction: () => void
  onSubmit: (prompt: string, attachmentIds: string[], action?: RequirementAction) => Promise<boolean>
}

export type TaskComposerHandle = {
  generateDraft: (fallbackPrompt: string, revision?: number) => void
}

export const TaskComposer = forwardRef<TaskComposerHandle, Props>(function TaskComposer({
  api, prompt, setPrompt, agent, agents, onAgent, groups, groupId, onGroup,
  disabled, sending, localClient, focusRequest, actionLabel, footerContent, clearAction, onSubmit,
}, ref) {
  const t = usePiTranslation()
  const fileInput = useRef<HTMLInputElement>(null)
  const textInput = useRef<HTMLTextAreaElement>(null)
  const upload = useRef<AbortController>()
  const uploadHintId = useId()
  const [uploading, setUploading] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [error, setError] = useState('')

  useEffect(() => () => upload.current?.abort(), [])
  useEffect(() => {
    if (focusRequest) textInput.current?.focus()
  }, [focusRequest])

  async function addAttachments(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length || disabled || sending || upload.current) return
    setError('')
    if (attachments.length + files.length > maxFiles) {
      setError(t('pi.attachmentCount', { count: maxFiles }))
      return
    }
    if (files.some((file) => file.size > maxBytes || !extensions.some((extension) => file.name.toLowerCase().endsWith(extension)))) {
      setError(t('pi.attachmentTypes'))
      return
    }
    const form = new FormData()
    files.forEach((file) => form.append('files', file))
    const controller = new AbortController()
    upload.current = controller
    setUploading(true)
    try {
      const result = await api.write<{ attachments: Attachment[] }>('/api/desktop/attachments', 'POST', form, controller.signal)
      if (!controller.signal.aborted) {
        setAttachments((current) => [...current, ...result.attachments])
        setError('')
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorText(cause, t('pi.uploadError')))
    } finally {
      upload.current = undefined
      if (!controller.signal.aborted) setUploading(false)
    }
  }

  async function submit(text: string, action?: RequirementAction) {
    if (disabled || sending || !text.trim()) return
    if (upload.current || uploading) {
      setError(t('pi.waitForAttachments'))
      textInput.current?.focus()
      return
    }
    setError('')
    if (await onSubmit(text.trim(), attachments.map((attachment) => attachment.id), action)) setAttachments([])
  }

  useImperativeHandle(ref, () => ({
    generateDraft(fallbackPrompt, revision) {
      void submit(prompt.trim() || fallbackPrompt, { type: 'draft', revision })
    },
  }))

  return (
    <Card as="section" radius="xl" padding="none" shadow="composer" className="pi-composer" aria-label={t('pi.taskInstructions')}>
      <form onSubmit={(event) => { event.preventDefault(); void submit(prompt) }}>
        <div className="pi-composer-body">
          {actionLabel && <div className="pi-composer-action">
            <Badge tone="brand" wrap>{actionLabel}</Badge>
            <IconButton size="xs" label={t('pi.clearAction')} icon={<X size={14} strokeWidth={1.75} />} onClick={clearAction} disabled={sending} />
          </div>}
          <TextArea
            ref={textInput}
            aria-label={t('pi.taskInstructions')}
            placeholder={t(agents ? 'pi.composePlaceholder' : 'pi.followUpPlaceholder')}
            className="pi-composer-text"
            rows={agents ? 3 : 2}
            maxLength={16000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            disabled={disabled || sending}
          />
          {!!attachments.length && <ul className="pi-attachment-list" aria-label={t('pi.attachments')}>
            {attachments.map((attachment) => <li key={attachment.id}>
              <div className="pi-attachment-chip">
                <Paperclip size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{attachment.name}</span>
                <IconButton label={t('pi.removeAttachment', { name: attachment.name })} icon={<X size={13} strokeWidth={1.75} />}
                  size="xs" onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))} disabled={sending} />
              </div>
              {attachment.warnings.map((warning, index) => <small key={index} role="status">{warning}</small>)}
            </li>)}
          </ul>}
          {error && <ErrorState size="sm" className="pi-composer-error" title={error} />}
          <div className="pi-composer-tools">
            <div className="pi-inline">
              <IconButton label={t('pi.addAttachments')} icon={<Paperclip size={18} strokeWidth={1.75} />} size="lg"
                loading={uploading} disabled={disabled || sending || attachments.length >= maxFiles}
                onClick={() => fileInput.current?.click()} aria-describedby={uploadHintId} />
              <span className="sr-only" id={uploadHintId}>{t('pi.attachmentTypes')}</span>
              <input ref={fileInput} type="file" multiple accept={extensions.join(',')} hidden aria-label={t('pi.addAttachments')}
                onChange={(event) => void addAttachments(event)} />
              {agents && onAgent && agents.length > 0
                ? <div className="pi-inline pi-composer-select">
                  <Bot size={17} strokeWidth={1.75} aria-hidden="true" />
                  <SelectField size="sm" label={t('pi.selectAgent')} labelHidden
                    options={agents.map((item) => ({ value: item.id, label: item.label }))}
                    value={agent?.id ?? ''} onChange={onAgent} disabled={sending} />
                </div>
                : agent && <span className="pi-inline pi-subtle"><Bot size={17} strokeWidth={1.75} aria-hidden="true" />{agent.label}</span>}
            </div>
            <div className="pi-inline">
              <span className="pi-shortcut" aria-hidden="true">{t('pi.sendShortcut')}</span>
              <Button type="submit" variant="accent" size="md" shape="circle" aria-label={t('pi.send')}
                icon={<ArrowUp size={20} strokeWidth={1.75} />} loading={sending} disabled={disabled || uploading || !prompt.trim()} />
            </div>
          </div>
        </div>
        <div className="pi-composer-foot">
          {!localClient && <span className="pi-inline"><Cloud size={15} strokeWidth={1.75} aria-hidden="true" />{t('pi.serverRun')}</span>}
          {!!groups?.length && onGroup && <span className="pi-inline pi-composer-select">
            <Folder size={15} strokeWidth={1.75} aria-hidden="true" />
            <SelectField size="sm" label={t('pi.selectGroup')} labelHidden
              options={groups.map((group) => ({ value: group.id, label: group.label }))}
              value={groupId ?? ''} onChange={onGroup} disabled={sending} />
          </span>}
          {footerContent}
        </div>
      </form>
    </Card>
  )
})
