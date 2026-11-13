import { ArrowUpRight, BookOpen, Globe, Monitor, Search } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'
import { Input } from '@/components/ui/Input'
import { SelectField } from '@/components/ui/SelectField'
import { errorText, type ClientConnections, type PiApi } from './api'
import { usePiTranslation } from './usePiTranslation'

type Tool = 'browser' | 'computer' | 'knowledge'
type Operation = 'open-environment' | 'computer-windows' | 'context' | 'context-search'
export type ToolSettingsSection = 'environment' | 'computer' | 'context'
type Reply = {
  ok: boolean, text: string,
  windows?: { id: string, title: string }[],
  matches?: { path: string, line: number, text: string }[],
}
type Props = {
  api: PiApi, value: ClientConnections, disabled: boolean, canDraft: boolean,
  onSettings: (section: ToolSettingsSection) => void, onDraft: (prompt: string) => void,
}

export function WorkbenchTools({ api, value, disabled, canDraft, onSettings, onDraft }: Props) {
  const t = usePiTranslation()
  const panelId = useId()
  const [selected, setSelected] = useState<Tool>()
  const [documentType, setDocumentType] = useState<'receipt' | 'order'>('receipt')
  const [number, setNumber] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<Operation>()
  const [reply, setReply] = useState<Reply>()
  const blocked = disabled || !!busy
  const connected = Boolean(value.management && value.hasContextKey)
  const receipt = t('pi.toolsReceipt')
  const order = t('pi.toolsPurchaseOrder')

  async function run(section: Operation, keywords?: string) {
    if (blocked) return
    setBusy(section)
    setReply(undefined)
    try {
      setReply(await api.write<Reply>('/api/client/test', 'POST', { section, ...(keywords && { query: keywords }) }))
    } catch (error) {
      setReply({ ok: false, text: errorText(error, t('pi.toolsFailed')) })
    } finally {
      setBusy(undefined)
    }
  }

  function draft(text: string) {
    onDraft(text)
    setSelected(undefined)
    setReply(undefined)
  }

  const tools = [
    { id: 'browser', label: t('pi.toolBrowser'), Icon: Globe,
      status: value.environment?.name || t('pi.toolsNoEnvironment'), ready: Boolean(value.environment) },
    { id: 'computer', label: t('pi.clientComputer'), Icon: Monitor,
      status: t(!value.computerAvailable ? 'pi.clientNoComputer' : value.computerUse ? 'pi.clientEnabled' : 'pi.clientDisabled'), ready: value.computerUse },
    { id: 'knowledge', label: t('pi.clientContext'), Icon: BookOpen,
      status: t(connected ? 'pi.toolsTokenSaved' : 'pi.toolsNeedsConnection'), ready: connected },
  ] as const
  const current = tools.find(({ id }) => id === selected)

  return <section className="pi-home-tools" aria-label={t('pi.toolsTitle')}>
    <h2>{t('pi.toolsTitle')}</h2>
    <div className="pi-tool-grid">
      {tools.map(({ id, label, Icon, status, ready }) => <button type="button" key={id} id={`${panelId}-${id}`}
        className="pi-tool-tile" aria-expanded={selected === id} aria-controls={selected === id ? panelId : undefined}
        aria-label={label} aria-describedby={`${panelId}-${id}-status`} disabled={blocked} onClick={() => {
          setSelected(selected === id ? undefined : id)
          setReply(undefined)
        }}>
        <span className="pi-tool-icon" data-tool={id}><Icon size={18} strokeWidth={1.75} aria-hidden="true" /></span>
        <span className="pi-tool-tile-text">
          <strong>{label}</strong>
          <span id={`${panelId}-${id}-status`} data-ready={ready} className="pi-tool-status">{status}</span>
        </span>
        <ArrowUpRight size={14} strokeWidth={1.75} className="pi-tool-arrow" aria-hidden="true" />
      </button>)}
    </div>
    {current && <div className="pi-tool-panel" id={panelId} role="region" aria-labelledby={`${panelId}-${current.id}`}>
      {selected === 'browser' && <>
        <p className="pi-subtle">{t('pi.toolsBrowserHint')}</p>
        <div className="pi-wrap">
          <Button size="sm" variant="secondary" loading={busy === 'open-environment'} disabled={blocked || !value.environment}
            icon={<Globe size={14} />} onClick={() => void run('open-environment')}>{t('pi.toolsOpenBrowser')}</Button>
          <Button size="sm" variant="ghost" disabled={blocked} onClick={() => onSettings('environment')}>{t('pi.toolsConfigure')}</Button>
        </div>
        {value.environment && canDraft && <form className="pi-tool-form" onSubmit={event => {
          event.preventDefault()
          if (!blocked && number.trim()) draft(t('pi.toolsDocumentPrompt', { type: documentType === 'receipt' ? receipt : order, number: number.trim() }))
        }}>
          <SelectField size="md" label={t('pi.toolsDocumentType')} value={documentType} onChange={setDocumentType} disabled={blocked}
            options={[{ value: 'receipt', label: receipt }, { value: 'order', label: order }]} />
          <Input size="md" label={t('pi.toolsDocumentNumber')} placeholder="CGSH-…" autoComplete="off" value={number} maxLength={80}
            onChange={event => setNumber(event.target.value)} disabled={blocked} />
          <Button type="submit" size="sm" variant="primary" disabled={blocked || !number.trim()}>{t('pi.toolsDraftQuery')}</Button>
        </form>}
      </>}
      {selected === 'computer' && <>
        <p className="pi-subtle">{t('pi.toolsComputerHint')}</p>
        <div className="pi-wrap">
          <Button size="sm" variant="primary" loading={busy === 'computer-windows'} disabled={blocked || !value.computerUse}
            icon={<Monitor size={14} />} onClick={() => void run('computer-windows')}>{t('pi.toolsListWindows')}</Button>
          <Button size="sm" variant="ghost" disabled={blocked} onClick={() => onSettings('computer')}>
            {t(value.computerUse ? 'pi.toolsConfigure' : 'pi.clientEnable')}
          </Button>
        </div>
      </>}
      {selected === 'knowledge' && <>
        <p className="pi-subtle">{t('pi.toolsKnowledgeHint')}</p>
        <form className="pi-tool-form pi-tool-search" onSubmit={event => {
          event.preventDefault()
          if (connected && query.trim()) void run('context-search', query.trim())
        }}>
          <Input size="md" label={t('pi.toolsKeyword')} value={query} autoComplete="off" maxLength={200}
            onChange={event => setQuery(event.target.value)} disabled={blocked || !connected} />
          <Button type="submit" size="sm" variant="primary" loading={busy === 'context-search'} disabled={blocked || !connected || !query.trim()}
            icon={<Search size={14} />}>{t('pi.toolsSearch')}</Button>
        </form>
        <div className="pi-wrap">
          <Button size="sm" variant="secondary" loading={busy === 'context'} disabled={blocked || !connected}
            onClick={() => void run('context')}>{t('pi.clientTestConnection')}</Button>
          <Button size="sm" variant="ghost" disabled={blocked} onClick={() => onSettings('context')}>{t('pi.toolsConfigure')}</Button>
        </div>
      </>}
      {reply && (reply.ok ? <p role="status" className="pi-subtle">{reply.text}</p> : <ErrorState size="sm" title={reply.text} />)}
      {reply?.ok && !!reply.windows?.length && <ul className="pi-tool-results">
        {reply.windows.map(window => <li key={window.id}>{canDraft
          ? <Button size="sm" variant="secondary" disabled={blocked} className="pi-tool-window"
            onClick={() => draft(t('pi.toolsWindowPrompt', { id: window.id }))}>{window.title}</Button>
          : <span>{window.title}</span>}
        </li>)}
      </ul>}
      {reply?.ok && !!reply.matches?.length && <ul className="pi-tool-results">
        {reply.matches.map(match => <li className="pi-tool-excerpt" key={`${match.path}:${match.line}`}>
          <strong>{match.path}:{match.line}</strong><p>{match.text}</p>
        </li>)}
      </ul>}
    </div>}
  </section>
}
