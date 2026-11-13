import { ArrowUpRight, BookOpen, Globe, Search } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ErrorState } from '@/components/ui/ErrorState'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { errorText, type Memory, type PiApi } from './api'
import { usePiResource } from './usePiResource'
import { usePiTranslation } from './usePiTranslation'

type Source = 'knowledge' | 'memory'
type KnowledgeLine = { path: string, line: number, text: string }
type Note = { title: string, path: string, content: string }

function webQueryUrl(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch { /* A missing or invalid business address keeps the link hidden. */ }
  return undefined
}

const businessUrl = webQueryUrl(import.meta.env.VITE_PI_WEB_QUERY_URL)

function SourceExcerpt({ api, hit, close }: { api: PiApi, hit: KnowledgeLine, close: () => void }) {
  const t = usePiTranslation()
  const note = usePiResource<Note>(api, '/api/vault/note?' + new URLSearchParams({ path: hit.path }))
  const lines = note.value?.content.split(/\r?\n/)
  const firstLine = Math.max(1, hit.line - 8)
  return <section className="pi-stack pi-web-query-note" aria-label={t('pi.webQueryNote')}>
    <div className="pi-between"><h3>{note.value?.title || hit.path}</h3>
      <Button type="button" size="sm" variant="secondary" onClick={close}>{t('pi.close')}</Button>
    </div>
    {Boolean(note.error) && <ErrorState size="sm" title={errorText(note.error, t('pi.loadError'))} />}
    {!note.error && !lines && <LoadingState variant="inline" label={t('pi.webQueryNote')} />}
    {lines && <ol start={firstLine} className="pi-web-note-lines">
      {lines.slice(firstLine - 1, hit.line + 8).map((line, index) => <li key={firstLine + index}
        data-match={firstLine + index === hit.line}>{line.slice(0, 2000)}{line.length > 2000 && '…'}</li>)}
    </ol>}
  </section>
}

export function WebQueryPanel({ api }: { api: PiApi }) {
  const t = usePiTranslation()
  const [source, setSource] = useState<Source>('knowledge')
  const [keywords, setKeywords] = useState('')
  const [search, setSearch] = useState('')
  const [selected, selectNote] = useState<KnowledgeLine>()
  const knowledgePath = search && source === 'knowledge' ? '/api/search?' + new URLSearchParams({ q: search }) : null
  const memoryPath = search && source === 'memory' ? '/api/memories?' + new URLSearchParams({ scope: 'project', state: 'active', q: search }) : null
  const knowledge = usePiResource<KnowledgeLine[]>(api, knowledgePath)
  const memory = usePiResource<{ memories: Memory[] }>(api, memoryPath)
  const results = source === 'knowledge' ? knowledge : memory
  const projectMemories = memory.value?.memories.filter(item => item.scope === 'project' && item.state === 'active')
  const count = source === 'knowledge' ? knowledge.value?.length : projectMemories?.length
  const shownMemories = projectMemories?.slice(0, 30)

  function changeSource(next: Source) {
    if (next === source) return
    setSource(next)
    selectNote(undefined)
  }

  return <section className="pi-page pi-stack" aria-labelledby="pi-web-query-title">
    <header className="pi-page-heading">
      <h1 id="pi-web-query-title">{t('pi.webQueryHeading')}</h1>
      <p className="pi-description">{t('pi.webQueryHint')}</p>
    </header>
    <Card as="section" padding="lg" radius="lg" className="pi-stack" aria-label={t('pi.webResourceSearch')}>
      <h2 className="pi-inline"><BookOpen size={17} aria-hidden="true" />{t('pi.webResourceSearch')}</h2>
      <SegmentedControl<Source> label={t('pi.webQuerySource')} value={source} appearance="raised" onChange={changeSource}
        items={[{ value: 'knowledge', label: t('pi.knowledge') }, { value: 'memory', label: t('pi.webSharedMemory') }]} />
      <form className="pi-tool-form pi-tool-search" onSubmit={event => {
        event.preventDefault()
        const query = keywords.trim()
        if (!query) return
        selectNote(undefined)
        if (query === search) results.refresh()
        else setSearch(query)
      }}>
        <Input size="md" label={t('pi.toolsKeyword')} value={keywords} maxLength={200} autoComplete="off"
          placeholder={t('pi.webQueryPlaceholder')} onChange={event => setKeywords(event.target.value)} />
        <Button type="submit" size="sm" variant="primary" icon={<Search size={15} />} disabled={!keywords.trim()}>{t('pi.toolsSearch')}</Button>
      </form>
      {search && Boolean(results.error) && <ErrorState size="sm" title={errorText(results.error, t('pi.loadError'))} onRetry={results.refresh} retryLabel={t('pi.retry')} />}
      {search && !results.error && count === undefined && <LoadingState variant="inline" label={t('pi.webQuerySearching')} />}
      {search && !results.error && count !== undefined && <p className="pi-subtle" role="status">
        {count ? t('pi.webQueryCount', { count }) : t('pi.webQueryEmpty')}
      </p>}
      {source === 'knowledge' && !!knowledge.value?.length && <ul className="pi-web-query-results">
        {knowledge.value.map(hit => {
          const expanded = selected?.path === hit.path && selected.line === hit.line
          return <li className="pi-tool-excerpt" key={`${hit.path}:${hit.line}`}>
            <strong>{hit.path}:{hit.line}</strong>
            <p>{hit.text}</p>
            {/\.md$/i.test(hit.path) && <Button type="button" size="sm" variant="ghost" aria-expanded={expanded}
              onClick={() => selectNote(expanded ? undefined : hit)}>{t('pi.webQueryOpenExcerpt', { line: hit.line })}</Button>}
            {expanded && <SourceExcerpt api={api} hit={hit} close={() => selectNote(undefined)} />}
          </li>
        })}
      </ul>}
      {source === 'memory' && !!shownMemories?.length && <ul className="pi-web-query-results">
        {shownMemories.map(item => <li className="pi-tool-excerpt" key={item.id}>
          <strong>{item.title}</strong>
          <p>{item.content.length > 1000 ? item.content.slice(0, 1000) + '…' : item.content}</p>
        </li>)}
      </ul>}
    </Card>
    <Card as="section" padding="lg" radius="lg" className="pi-stack" aria-label={t('pi.webBusinessTitle')}>
      <h2 className="pi-inline"><Globe size={17} aria-hidden="true" />{t('pi.webBusinessTitle')}</h2>
      <p className="pi-description">{t(businessUrl ? 'pi.webBusinessHint' : 'pi.webBusinessUnavailable')}</p>
      {businessUrl && <a className="pi-action-link" href={businessUrl} target="_blank" rel="noopener noreferrer">
        {t('pi.webOpenBusiness')}<ArrowUpRight size={15} aria-hidden="true" />
      </a>}
    </Card>
  </section>
}
