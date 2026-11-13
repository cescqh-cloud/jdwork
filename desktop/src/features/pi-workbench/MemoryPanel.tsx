import { BookMarked, CirclePlus, Pencil } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { TextArea } from '@/components/ui/TextArea'
import { usePiTranslation, type PiKey } from './usePiTranslation'
import { errorText, type Memory, type MemoryScope, type MemoryState, type PiApi } from './api'
import { noInlineImages } from './presentation'
import { usePiResource } from './usePiResource'

const memoryStates: Record<MemoryState, [PiKey, Tone]> = {
  candidate: ['pi.memoryCandidate', 'warning'],
  active: ['pi.memoryActive', 'success'],
  archived: ['pi.memoryArchived', 'neutral'],
}

type Editor = Pick<Memory, 'title' | 'content'> & { id?: string, revision?: number }

export function MemoryPanel({ api, admin }: { api: PiApi, admin: boolean }) {
  const t = usePiTranslation()
  const [scope, setScope] = useState<MemoryScope>('personal')
  const [editor, setEditor] = useState<Editor>()
  const [expanded, setExpanded] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const canWrite = admin || scope === 'personal'
  const path = '/api/memories'
  const list = usePiResource<{ memories: Memory[] }>(api, `${path}?scope=${scope}`)

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!canWrite || !editor?.title.trim() || !editor.content.trim() || busy) return
    setBusy('save')
    setError('')
    try {
      const { title, content, id, revision } = editor
      if (id) await api.write(`${path}/${encodeURIComponent(id)}`, 'PATCH', { title: title.trim(), content, revision })
      else await api.write(path, 'POST', { title: title.trim(), content, scope, state: 'candidate' })
      setEditor(undefined)
      list.refresh()
    } catch (cause) {
      setError(errorText(cause, t('pi.saveError')))
    } finally {
      setBusy('')
    }
  }

  async function changeState(memory: Memory, state: MemoryState) {
    if (!canWrite || busy) return
    setBusy(memory.id)
    setError('')
    try {
      await api.write(`${path}/${encodeURIComponent(memory.id)}`, 'PATCH', { state, revision: memory.revision })
      list.refresh()
    } catch (cause) {
      setError(errorText(cause, t('pi.saveError')))
      list.refresh()
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="pi-page">
      <header className="pi-page-heading">
        <p className="pi-kicker">{t('pi.manage')}</p>
        <h1>{t('pi.memory')}</h1>
        <p className="pi-description">{t('pi.memoryHint')}</p>
      </header>
      <div className="pi-between">
        <SegmentedControl<MemoryScope> label={t('pi.memoryScope')} value={scope} appearance="raised"
          items={[
            { value: 'personal', label: t('pi.personalMemory'), disabled: !!busy },
            { value: 'project', label: t('pi.projectMemory'), disabled: !!busy },
          ]}
          onChange={(value) => { setScope(value); setError(''); setEditor(undefined); setExpanded('') }} />
        {canWrite && !editor && <Button variant="primary" size="base" disabled={!!busy}
          icon={<CirclePlus size={16} strokeWidth={1.75} />}
          onClick={() => { setError(''); setEditor({ title: '', content: '' }) }}>{t('pi.newMemory')}</Button>}
      </div>
      {error && <ErrorState title={error} size="sm" />}
      {Boolean(list.error) && <ErrorState title={errorText(list.error, t('pi.loadError'))} size="sm"
        onRetry={list.refresh} retryLabel={t('pi.retry')} />}
      {!list.value && !list.error && <LoadingState label={t('pi.loadingMemory')} />}
      {editor && <Card radius="lg" padding="lg">
        <form onSubmit={(event) => void save(event)} className="pi-stack">
          <Input label={t('pi.memoryTitle')} value={editor.title} required maxLength={160} disabled={!!busy}
            onChange={(event) => setEditor({ ...editor, title: event.target.value })} />
          <TextArea label={t('pi.memoryContent')} value={editor.content} required maxLength={16000} rows={6} disabled={!!busy}
            onChange={(event) => setEditor({ ...editor, content: event.target.value })} />
          <div className="pi-wrap">
            <Button type="submit" variant="primary" size="base" disabled={!editor.title.trim() || !editor.content.trim()} loading={busy === 'save'}>
              {t(editor.id ? 'pi.save' : 'pi.saveCandidate')}
            </Button>
            <Button size="base" variant="ghost" disabled={!!busy} onClick={() => { setEditor(undefined); setError('') }}>{t('pi.cancel')}</Button>
          </div>
        </form>
      </Card>}
      {list.value?.memories.length === 0 && <EmptyState variant="plain" title={t('pi.noMemory')}
        icon={<BookMarked size={21} strokeWidth={1.75} />} />}
      {list.value?.memories.map((memory) => {
        const [stateLabel, tone] = memoryStates[memory.state]
        return <Card as="article" className="pi-stack" key={memory.id}>
          <div className="pi-between">
            <h2>{memory.title}</h2>
            <Badge tone={tone} size="sm">{t(stateLabel)}</Badge>
          </div>
          <div className="pi-wrap">
            <Button size="sm" variant="secondary" aria-expanded={expanded === memory.id}
              onClick={() => setExpanded(expanded === memory.id ? '' : memory.id)}>
              {t(expanded === memory.id ? 'pi.hideMemory' : 'pi.readMemory')}
            </Button>
            {canWrite && !editor && <>
              <Button size="sm" variant="ghost" disabled={!!busy} icon={<Pencil size={15} strokeWidth={1.75} />}
                onClick={() => { setError(''); setEditor(memory) }}>{t('pi.editMemory')}</Button>
              {memory.state !== 'active' && <Button size="sm" variant="tonal" loading={busy === memory.id} disabled={!!busy}
                onClick={() => void changeState(memory, 'active')}>{t('pi.enableMemory')}</Button>}
              {memory.state !== 'archived' && <Button size="sm" variant="ghost" disabled={!!busy}
                onClick={() => void changeState(memory, 'archived')}>{t('pi.archiveMemory')}</Button>}
            </>}
          </div>
          {expanded === memory.id && <MarkdownRenderer content={memory.content} resolveImageSrc={noInlineImages} />}
        </Card>
      })}
    </section>
  )
}
