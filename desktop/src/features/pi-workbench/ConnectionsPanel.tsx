import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Checkbox } from '@/components/ui/Checkbox'
import { ErrorState } from '@/components/ui/ErrorState'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { SelectField } from '@/components/ui/SelectField'
import { errorText, type ClientConnections, type PiApi } from './api'
import { ComputerUsePanel } from './ComputerUsePanel'
import type { usePiResource } from './usePiResource'
import { usePiTranslation, type PiKey } from './usePiTranslation'

const sections = [
  ['model', 'pi.clientModel'], ['environment', 'pi.clientEnvironment'], ['computer', 'pi.clientComputer'],
  ['context', 'pi.clientContext'], ['mcp', 'pi.clientMcp'], ['management', 'pi.clientGovernance'],
] as const
type Section = typeof sections[number][0]
type FormSection = Exclude<Section, 'computer'>
const sceneLabels: [string, PiKey][] = [
  ['default', 'pi.clientDefaultModel'], ['research', 'pi.clientSceneResearch'], ['bugfix', 'pi.clientSceneBug'],
  ['report', 'pi.clientSceneReport'], ['testing', 'pi.clientSceneTest'], ['review', 'pi.clientSceneReview'], ['release', 'pi.clientSceneRelease'],
]
type Update = { version: string, release?: { version: string, notes: string } | null, updateAvailable?: boolean }
type Notice = { text: string, ok: boolean }
type Resource = ReturnType<typeof usePiResource<ClientConnections>>

export function ConnectionsPanel({ api, resource }: { api: PiApi, resource: Resource }) {
  const t = usePiTranslation()
  const [section, setSection] = useState<Section>(() => {
    const requested = new URLSearchParams(window.location.search).get('section')
    return sections.find(([id]) => id === requested)?.[0] ?? 'model'
  })
  function selectSection(next: Section) {
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'connections')
    url.searchParams.set('section', next)
    window.history.replaceState(null, '', url)
    setSection(next)
  }
  return <section className="pi-page pi-stack">
    <header className="pi-page-heading">
      <h1>{t('pi.clientConnections')}</h1>
      <p className="pi-description">{t('pi.clientConnectionHint')}</p>
    </header>
    <SegmentedControl label={t('pi.clientConnections')} appearance="raised" value={section} className="min-w-0 overflow-x-auto"
      items={sections.map(([value, label]) => ({ value, label: t(label) }))} onChange={selectSection} />
    {Boolean(resource.error) && <ErrorState title={errorText(resource.error, t('pi.loadError'))} retryLabel={t('pi.retry')} onRetry={resource.refresh} />}
    {!resource.value && !resource.error && <LoadingState label={t('pi.loadingWorkspace')} />}
    {resource.value && (section === 'computer'
      ? <ComputerUsePanel api={api} value={resource.value} onSave={resource.refresh} />
      : <ConnectionForms key={section} api={api} value={resource.value} section={section} onSave={resource.refresh}
        openUpdates={() => selectSection('management')} />)}
  </section>
}

function ConnectionForms({ api, value, section, onSave, openUpdates }: {
  api: PiApi, value: ClientConnections, section: FormSection, onSave: () => void, openUpdates: () => void,
}) {
  const t = usePiTranslation()
  const [scene, setScene] = useState('default')
  const [name, setName] = useState(() => section === 'model' ? value.models.default?.name ?? ''
    : section === 'environment' ? value.environment?.name ?? '' : value.mcp?.name ?? '')
  const [url, setUrl] = useState(() => section === 'model' ? value.models.default?.baseUrl ?? ''
    : section === 'environment' ? value.environment?.url ?? '' : section === 'management' ? value.management : value.mcp?.url ?? '')
  const [secret, setSecret] = useState('')
  const [dataCenter, setDataCenter] = useState(value.environment?.dataCenter ?? '')
  const [imageInput, setImageInput] = useState(value.models.default?.imageInput === true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<Notice & { operation?: string }>()
  const [update, setUpdate] = useState<Update>()

  async function operation(id: string, run: () => Promise<Notice>) {
    if (busy) return false
    setBusy(id)
    setNotice(undefined)
    try { const result = await run(); setNotice({ ...result, operation: id }); return result.ok }
    catch (error) { setNotice({ ok: false, text: errorText(error, t('pi.saveError')), operation: id }); return false }
    finally { setBusy('') }
  }

  const save = (target: string, settings: Record<string, unknown>) => operation(target === 'context' ? 'context-save' : 'save', async () => {
    const saved = await api.write<ClientConnections>('/api/client/settings', 'PUT', { revision: value.revision, section: target, value: settings })
    if (target === 'management') setUrl(saved.management)
    setSecret('')
    setUpdate(undefined)
    onSave()
    return { ok: true, text: t('pi.saved') }
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (section === 'model') void save(section, { scene, name, baseUrl: url, key: secret, imageInput })
    if (section === 'environment') void save(section, { name, url, dataCenter })
    if (section === 'management') void save(section, { url, releaseKey: secret })
    if (section === 'mcp') {
      let headers: unknown
      try { if (secret.trim()) headers = JSON.parse(secret) }
      catch { setNotice({ ok: false, text: t('pi.clientHeadersInvalid') }); return }
      void save(section, { name, url, headers })
    }
  }

  const test = (target: string) => operation(target, () => api.write<Notice>('/api/client/test', 'POST',
    target === 'mini-program' || target === 'context' ? { section: target } : { section: target, scene }))
  const clear = () => {
    void save(section, { scene, clear: true }).then(saved => {
      if (!saved) return
      setName('')
      setUrl('')
      setDataCenter('')
      setImageInput(false)
    })
  }

  const noticeElement = notice && (notice.ok ? <p role="status" className="pi-subtle">{notice.text}</p> : <ErrorState size="sm" title={notice.text} />)
  if (section === 'context') return <Card as="section" padding="lg" radius="lg" className="pi-stack" aria-label={t('pi.clientContext')}>
    <h2>{t('pi.clientContext')}</h2>
    <p className="pi-subtle">{t('pi.clientContextHint')}</p>
    {value.management && <p className="pi-subtle break-all">{value.management}</p>}
    <form className="pi-stack" onSubmit={event => {
      event.preventDefault()
      if (value.management && secret.trim()) void save('context', { key: secret })
    }}>
      <Input type="password" autoComplete="off" label={t('pi.clientContextKey')} value={secret} maxLength={128}
        hint={t(!value.management ? 'pi.clientContextSaveOrigin' : value.hasContextKey ? 'pi.clientContextKeySaved' : 'pi.clientContextKeyHint')}
        disabled={!!busy || !value.management} onChange={event => setSecret(event.target.value)} />
      <div className="pi-wrap">
        <Button type="submit" size="sm" variant="primary" loading={busy === 'context-save'}
          disabled={!!busy || !value.management || !secret.trim()}>{t('pi.save')}</Button>
        <Button type="button" size="sm" variant="secondary" loading={busy === 'context'}
          disabled={!!busy || !value.management || !value.hasContextKey} onClick={() => void test('context')}>{t('pi.clientTestConnection')}</Button>
        {value.hasContextKey && <Button type="button" size="sm" variant="ghost" disabled={!!busy || !value.management}
          onClick={() => void save('context', { clear: true })}>{t('pi.clientRemove')}</Button>}
        {!value.management && <Button type="button" size="sm" variant="ghost" onClick={openUpdates}>{t('pi.clientGovernance')}</Button>}
      </div>
    </form>
    {noticeElement}
  </Card>
  return <>
    <Card padding="lg" radius="lg" className="pi-stack">
      <h2>{t(sections.find(([id]) => id === section)![1])}</h2>
      <form className="pi-stack" onSubmit={submit}>
        {section === 'model' && <SelectField label={t('pi.scenes')} value={scene} disabled={!!busy}
          options={sceneLabels.map(([id, label]) => ({ value: id, label: t(label) }))}
          onChange={(id) => {
            const model = value.models[id]
            setScene(id)
            setName(model?.name ?? '')
            setUrl(model?.baseUrl ?? '')
            setSecret('')
            setImageInput(model?.imageInput === true)
          }} />}
        {section !== 'management' && <Input label={t(section === 'model' ? 'pi.modelName' : 'pi.clientName')}
          required value={name} maxLength={120} onChange={event => setName(event.target.value)} disabled={!!busy} />}
        <Input label={t(section === 'model' ? 'pi.modelDestination' : 'pi.clientUrl')}
          required value={url} maxLength={2048} onChange={event => setUrl(event.target.value)} disabled={!!busy} />
        {(section === 'model' || section === 'mcp') && <Input type="password" autoComplete="off"
          label={t(section === 'model' ? 'pi.personalApiKey' : 'pi.clientHeaders')} value={secret}
          hint={t(section === 'model' && value.models[scene]?.hasKey || section === 'mcp' && value.mcp?.hasHeaders
            ? 'pi.personalKeyRetain' : section === 'model' ? 'pi.clientKeyLocal' : 'pi.clientHeadersHint')}
          onChange={event => setSecret(event.target.value)} disabled={!!busy} />}
        {section === 'model' && <Checkbox label={t('pi.clientImageInput')} description={t('pi.clientImageInputHint')}
          checked={imageInput} onChange={event => setImageInput(event.target.checked)} disabled={!!busy} />}
        {section === 'management' && <Input label={t('pi.clientReleaseKey')} value={secret}
          hint={t(value.hasReleaseKey ? 'pi.clientReleaseKeySaved' : 'pi.clientReleaseKeyHint')}
          onChange={event => setSecret(event.target.value)} disabled={!!busy} />}
        {section === 'environment' && <Input label={t('pi.clientDataCenter')} value={dataCenter}
          onChange={event => setDataCenter(event.target.value)} disabled={!!busy} />}
        <div className="pi-wrap">
          <Button type="submit" size="sm" variant="primary" loading={busy === 'save'} disabled={!!busy}>{t('pi.save')}</Button>
          {section !== 'management' && <Button type="button" size="sm" variant="secondary" disabled={!!busy}
            onClick={() => void test(section)}>{t('pi.clientTestConnection')}</Button>}
          {section === 'environment' && value.environment && <Button type="button" size="sm" variant="secondary" disabled={!!busy}
            onClick={() => void test('open-environment')}>{t('pi.clientOpenEnvironment')}</Button>}
          {(section === 'model' && value.models[scene] || section === 'environment' && value.environment || section === 'mcp' && value.mcp) &&
            <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={clear}>{t('pi.clientRemove')}</Button>}
          {section === 'management' && <Button type="button" size="sm" variant="secondary" disabled={!!busy}
            onClick={() => void operation('update', async () => {
              const result = await api.write<Update>('/api/client/update', 'POST', {})
              setUpdate(result)
              return { ok: true, text: t(result.updateAvailable ? 'pi.newVersionAvailable' : result.release ? 'pi.upToDate' : 'pi.noRelease') }
            })}>{t('pi.clientCheckUpdate')}</Button>}
        </div>
      </form>
      {update && <div className="pi-stack">
        <p>{t('pi.installedVersion', { version: update.version })}</p>
        {update.release && <p>{t('pi.releaseVersion', { version: update.release.version })} · {update.release.notes}</p>}
        {update.updateAvailable && <Button size="sm" variant="secondary" disabled={!!busy}
          onClick={() => void operation('download', async () => {
            const result = await api.write<{ downloaded: boolean }>('/api/client/update', 'POST', { download: true })
            return { ok: true, text: t(result.downloaded ? 'pi.clientDownloaded' : 'pi.cancel') }
          })}>{t('pi.downloadInstaller')}</Button>}
      </div>}
      {notice?.operation !== 'mini-program' && noticeElement}
    </Card>
    {section === 'environment' && value.miniProgramApiUrl && <Card as="section" padding="lg" radius="lg" className="pi-stack"
      aria-label={t('pi.clientMiniProgram')}>
      <h2>{t('pi.clientMiniProgram')}</h2>
      <dl className="pi-stack">
        <dt>{t('pi.clientMiniProgramAddress')}</dt>
        <dd className="pi-subtle break-all">{value.miniProgramApiUrl}</dd>
      </dl>
      <p className="pi-subtle">{t('pi.clientMiniProgramHint')}</p>
      <div className="pi-wrap">
        <Button type="button" size="sm" variant="secondary" disabled={!!busy} loading={busy === 'mini-program'}
          onClick={() => void test('mini-program')}>{t('pi.clientMiniProgramTest')}</Button>
      </div>
      {notice?.operation === 'mini-program' && noticeElement}
    </Card>}
  </>
}
