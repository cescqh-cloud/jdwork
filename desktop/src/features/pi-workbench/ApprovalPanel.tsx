import { ChevronRight, ClipboardCheck, FileText, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react'
import { ActionDialog } from '@/components/ui/ActionDialog'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { SelectField } from '@/components/ui/SelectField'
import { TextArea } from '@/components/ui/TextArea'
import { errorText, PiApiError, type Identity, type PiApi } from './api'
import { usePiTranslation, type PiKey } from './usePiTranslation'

type Environment = 'test' | 'production'
type ApprovalInput = { title: string } & (
  { kind: 'requirement', snapshot: { revision: number, content: string } } |
  { kind: 'erp_write', snapshot: { environment: Environment, object: string, documentNumber: string, change: string, reason: string } }
)
type Status = 'pending' | 'approved' | 'rejected' | 'returned' | 'withdrawn'
type Actor = Pick<Identity, 'id' | 'name'>
type Approval = ApprovalInput & {
  id: string, status: Status, submittedBy: Actor, submittedAt: string, snapshotHash: string,
  decision?: { by: Actor, at: string, comment: string },
}
type ApprovalPage = { approvals: Approval[], nextCursor?: string }
type Action = 'approve' | 'reject' | 'return' | 'withdraw'
const statusLabels: Record<Status, [PiKey, Tone]> = {
  pending: ['pi.releasePending', 'warning'], approved: ['pi.releaseApproved', 'success'],
  rejected: ['pi.approvalRejected', 'danger'], returned: ['pi.approvalReturned', 'warning'], withdrawn: ['pi.withdrawn', 'neutral'],
}
const actionLabels: Record<Action, PiKey> = {
  approve: 'pi.releaseApprove', reject: 'pi.approvalReject', return: 'pi.approvalReturn', withdraw: 'pi.approvalWithdraw',
}
const kindLabels = { requirement: 'pi.requirements', erp_write: 'pi.approvalErpWrite' } as const
const environmentLabels = { test: 'pi.approvalTest', production: 'pi.approvalProduction' } as const
const path = '/api/approvals'
const requirementLimit = 48_000
const emptyDocument = { title: '', revision: '', content: '' }

function ApprovalForm({ busy, onSubmit }: { busy: boolean, onSubmit: (input: ApprovalInput) => Promise<boolean> }) {
  const t = usePiTranslation()
  const [kind, setKind] = useState<ApprovalInput['kind']>('requirement')
  const [document, setDocument] = useState(emptyDocument)
  const [environment, setEnvironment] = useState<Environment | ''>('')
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const blocked = busy || reading

  async function importMarkdown(file: File) {
    setReading(true)
    setError('')
    try {
      if (!/\.md$/iu.test(file.name) || file.size > requirementLimit * 4) throw new Error()
      const content = await file.text()
      if (!content.trim() || content.length > requirementLimit) throw new Error()
      // The exported file has a document heading followed by the Workbench revision line.
      const exported = /^# ([^\r\n]+)\r?\n\r?\n任务 [^\r\n]+? · 修订 ([1-9]\d*) · (?:已确认|草稿) · /u.exec(content)
      const revision = exported?.[2] ?? /^requirements?-v([1-9]\d*)\.md$/iu.exec(file.name)?.[1]
      setDocument((previous) => ({
        content, title: exported?.[1]?.slice(0, 180) ?? previous.title,
        revision: revision && Number.isSafeInteger(Number(revision)) ? revision : previous.revision,
      }))
    } catch {
      setError(t('pi.approvalImportError'))
    } finally {
      setReading(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (blocked) return
    const title = document.title.trim()
    if (!title) return
    const form = event.currentTarget
    let input: ApprovalInput
    if (kind === 'requirement') {
      const revision = Number(document.revision)
      if (!Number.isSafeInteger(revision) || revision < 1 || !document.content.trim()) return
      input = { title, kind, snapshot: { revision, content: document.content } }
    } else {
      const values = new FormData(form)
      const read = (key: string) => String(values.get(key) ?? '').trim()
      const object = read('object')
      const documentNumber = read('documentNumber')
      const change = read('change')
      const reason = read('reason')
      if (!environment || !object || !documentNumber || !change || !reason) return
      input = { title, kind, snapshot: { environment, object, documentNumber, change, reason } }
    }
    if (await onSubmit(input)) {
      form.reset()
      setDocument(emptyDocument)
      setEnvironment('')
      setError('')
    }
  }

  return <Card as="section" padding="lg" radius="lg" className="pi-approval-form" aria-labelledby="pi-approval-create">
    <h2 className="pi-inline" id="pi-approval-create"><Plus size={17} aria-hidden="true" />{t('pi.approvalNew')}</h2>
    <form className="pi-stack" onSubmit={(event) => void submit(event)}>
      <SelectField label={t('pi.approvalType')} value={kind} onChange={setKind} disabled={blocked} options={[
        { value: 'requirement', label: t(kindLabels.requirement) }, { value: 'erp_write', label: t(kindLabels.erp_write) },
      ]} />
      <Input label={t('pi.approvalTitle')} value={document.title} maxLength={180} required disabled={blocked}
        onChange={(event) => setDocument({ ...document, title: event.target.value })} />
      {kind === 'requirement' ? <>
        <div className="pi-approval-fields">
          <Input label={t('pi.documentVersion')} inputMode="numeric" pattern="[1-9][0-9]*" maxLength={16} required disabled={blocked}
            value={document.revision} onChange={(event) => setDocument({ ...document, revision: event.target.value })} />
          <Input label={t('pi.approvalMarkdown')} type="file" accept=".md,text/markdown" disabled={blocked} onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) void importMarkdown(file)
          }} />
        </div>
        <TextArea label={t('pi.approvalRequirementsText')} value={document.content} maxLength={requirementLimit} rows={7}
          onChange={(event) => setDocument({ ...document, content: event.target.value })} required disabled={blocked} />
      </> : <>
        <SelectField label={t('pi.approvalTarget')} value={environment} onChange={setEnvironment} required disabled={blocked} options={[
          { value: '', label: t('pi.approvalSelectEnvironment'), disabled: true },
          { value: 'test', label: t(environmentLabels.test) }, { value: 'production', label: t(environmentLabels.production) },
        ]} />
        <div className="pi-approval-fields">
          <Input label={t('pi.approvalObject')} name="object" maxLength={120} required disabled={blocked} />
          <Input label={t('pi.toolsDocumentNumber')} name="documentNumber" maxLength={120} required disabled={blocked} />
        </div>
        <TextArea label={t('pi.approvalChange')} name="change" maxLength={4000} rows={3} required disabled={blocked} />
        <TextArea label={t('pi.approvalReason')} name="reason" maxLength={2000} rows={3} required disabled={blocked} />
      </>}
      {error && <ErrorState title={error} size="sm" />}
      <p className="pi-subtle">{t(kind === 'requirement' ? 'pi.approvalSnapshotHint' : 'pi.approvalExecutionNote')}</p>
      <Button type="submit" size="base" variant="primary" className="pi-fit" disabled={blocked}>{t('pi.approvalSubmit')}</Button>
    </form>
  </Card>
}

function ApprovalRecord({ item, identity, busy, review }: {
  item: Approval, identity: Identity, busy: boolean, review: (item: Approval, action: Action) => void,
}) {
  const t = usePiTranslation()
  const [label, tone] = statusLabels[item.status]
  const actions: Action[] = []
  if (item.status === 'pending') {
    if (identity.admin) actions.push('approve', 'return', 'reject')
    if (identity.id === item.submittedBy.id) actions.push('withdraw')
  }
  return <details className="pi-approval-record">
    <summary className="pi-between">
      <span className="pi-approval-record-title"><ChevronRight size={15} aria-hidden="true" /><strong>{item.title}</strong></span>
      <Badge size="sm" tone={tone}>{t(label)}</Badge>
      <span className="pi-subtle pi-approval-byline">{t(kindLabels[item.kind])} · {item.submittedBy.name} ·{' '}
        <time dateTime={item.submittedAt}>{new Date(item.submittedAt).toLocaleString()}</time>
      </span>
    </summary>
    <div className="pi-approval-record-body pi-stack">
      {item.kind === 'requirement' ? <>
        <p className="pi-subtle">{t('pi.versionNumber', { revision: item.snapshot.revision })}</p>
        <pre className="pi-approval-text">{item.snapshot.content}</pre>
      </> : <>
        <dl className="pi-release-facts">
          <dt>{t('pi.approvalTarget')}</dt><dd><Badge size="sm" tone={item.snapshot.environment === 'production' ? 'warning' : 'neutral'}>
            {t(environmentLabels[item.snapshot.environment])}</Badge></dd>
          <dt>{t('pi.approvalObject')}</dt><dd>{item.snapshot.object}</dd>
          <dt>{t('pi.toolsDocumentNumber')}</dt><dd>{item.snapshot.documentNumber}</dd>
          <dt>{t('pi.approvalChange')}</dt><dd className="pi-approval-prewrap">{item.snapshot.change}</dd>
          <dt>{t('pi.approvalReason')}</dt><dd className="pi-approval-prewrap">{item.snapshot.reason}</dd>
        </dl>
        {item.status === 'approved' && <p className="pi-subtle">{t('pi.approvalExecutionNote')}</p>}
      </>}
      <dl className="pi-release-facts">
        <dt>{t('pi.checksum')}</dt><dd><code>{item.snapshotHash}</code></dd>
        {item.decision && <>
          <dt>{t('pi.approvalDecisionBy')}</dt><dd>{item.decision.by.name} ·{' '}
            <time dateTime={item.decision.at}>{new Date(item.decision.at).toLocaleString()}</time></dd>
          {item.decision.comment && <><dt>{t('pi.approvalComment')}</dt><dd className="pi-approval-prewrap">{item.decision.comment}</dd></>}
        </>}
      </dl>
      {actions.length > 0 && <div className="pi-wrap">
        {actions.map((action) => <Button type="button" size="sm" key={action} disabled={busy}
          variant={action === 'approve' ? 'primary' : action === 'reject' ? 'danger-outline' : 'secondary'}
          onClick={() => review(item, action)}>{t(actionLabels[action])}</Button>)}
      </div>}
    </div>
  </details>
}

export function ApprovalPanel({ api, identity }: { api: PiApi, identity: Identity }) {
  const t = usePiTranslation()
  const [page, setPage] = useState<ApprovalPage>()
  const [refreshId, refresh] = useReducer((value: number) => value + 1, 0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>()
  const [writeError, setWriteError] = useState<unknown>()
  const [decision, setDecision] = useState<{ item: Approval, action: Action }>()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(undefined)
    void api.get<ApprovalPage>(path, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPage(result)
    }, (error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [api, refreshId])

  async function loadMore() {
    if (loading || busy || !page?.nextCursor) return
    setLoading(true)
    setLoadError(undefined)
    try {
      const next = await api.get<ApprovalPage>(`${path}?before=${encodeURIComponent(page.nextCursor)}`)
      const known = new Set(page.approvals.map((item) => item.id))
      setPage({ ...next, approvals: [...page.approvals, ...next.approvals.filter((item) => !known.has(item.id))] })
    } catch (error) {
      setLoadError(error)
    } finally {
      setLoading(false)
    }
  }

  async function save(method: 'POST' | 'PATCH', endpoint: string, body: unknown) {
    if (inFlight.current || loading) return false
    inFlight.current = true
    setBusy(true)
    setWriteError(undefined)
    try {
      const { approval } = await api.write<{ approval: Approval }>(endpoint, method, body)
      setPage((previous) => ({ ...previous, approvals: method === 'POST'
        ? [approval, ...(previous?.approvals ?? []).filter((item) => item.id !== approval.id)]
        : (previous?.approvals ?? []).map((item) => item.id === approval.id ? approval : item) }))
      return true
    } catch (error) {
      setWriteError(error)
      if (error instanceof PiApiError && error.status === 409) {
        setDecision(undefined)
        refresh()
      }
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  async function decide() {
    if (!decision) return
    const { item, action } = decision
    const detail = comment.trim()
    if ((action === 'reject' || action === 'return') && !detail) return
    if (await save('PATCH', `${path}/${encodeURIComponent(item.id)}`, { action, ...(detail && { comment: detail }) })) setDecision(undefined)
  }

  function review(item: Approval, action: Action) {
    setWriteError(undefined)
    setComment('')
    setDecision({ item, action })
  }

  const list = page?.approvals ?? []
  const pending = list.filter((item) => item.status === 'pending')
  const history = list.filter((item) => item.status !== 'pending')
  const blocked = loading || busy
  const requiresComment = decision?.action === 'reject' || decision?.action === 'return'
  const showRecords = (items: Approval[]) => items.map((item) => <ApprovalRecord key={item.id}
    item={item} identity={identity} busy={blocked} review={review} />)

  return <section className="pi-approval-page">
    <header className="pi-page-heading">
      <p className="pi-kicker pi-inline"><ClipboardCheck size={15} aria-hidden="true" />{t('pi.manage')}</p>
      <h1>{t('pi.approvalCenter')}</h1>
      <p className="pi-description">{t('pi.approvalLead')}</p>
    </header>
    {Boolean(loadError) && <ErrorState title={errorText(loadError, t('pi.loadError'))} size="sm" onRetry={refresh} retryLabel={t('pi.retry')} />}
    {Boolean(writeError) && !decision && <ErrorState title={errorText(writeError, t('pi.approvalRequestError'))} size="sm" />}
    <div className="pi-approval-layout">
      <div className="pi-stack pi-approval-queue">
        <section className="pi-stack" aria-labelledby="pi-approval-pending">
          <div className="pi-between">
            <h2 id="pi-approval-pending">{t('pi.releasePending')}</h2>
            <Button type="button" variant="secondary" size="sm" disabled={blocked}
              icon={<RefreshCw size={14} aria-hidden="true" />} onClick={refresh}>{t('pi.refreshPage')}</Button>
          </div>
          {!page && loading && <LoadingState label={t('pi.connecting')} size="sm" />}
          {page && (pending.length > 0 ? showRecords(pending) : <EmptyState size="sm" variant="dashed"
            title={t('pi.approvalEmptyPending')} icon={<ClipboardCheck size={18} aria-hidden="true" />} />)}
        </section>
        {page && <section className="pi-stack" aria-labelledby="pi-approval-history">
          <h2 id="pi-approval-history">{t('pi.approvalHistory')}</h2>
          {history.length > 0 ? showRecords(history) : <EmptyState size="sm" variant="dashed"
            title={t('pi.approvalEmptyHistory')} icon={<FileText size={18} aria-hidden="true" />} />}
        </section>}
        {page?.nextCursor && <Button type="button" size="sm" variant="secondary" className="pi-fit" disabled={blocked}
          onClick={() => void loadMore()}>{t('pi.approvalLoadMore')}</Button>}
      </div>
      <ApprovalForm busy={blocked} onSubmit={(input) => save('POST', path, input)} />
    </div>
    {decision && <ActionDialog open title={t(actionLabels[decision.action])} loading={busy}
      onClose={() => { setDecision(undefined); setWriteError(undefined) }} body={<div className="pi-stack">
        <p className="pi-approval-prewrap"><strong>{decision.item.title}</strong></p>
        {decision.action === 'approve' && decision.item.kind === 'erp_write' && <p className="pi-subtle">{t('pi.approvalExecutionNote')}</p>}
        <TextArea label={t('pi.approvalComment')} value={comment} onChange={(event) => setComment(event.target.value)}
          maxLength={1000} required={requiresComment} disabled={busy} rows={3} />
        {Boolean(writeError) && <ErrorState title={errorText(writeError, t('pi.approvalRequestError'))} size="sm" />}
      </div>} actions={[
        { label: t('pi.cancel'), onClick: () => { setDecision(undefined); setWriteError(undefined) } },
        { label: t(actionLabels[decision.action]), variant: decision.action === 'reject' || decision.action === 'withdraw' ? 'danger' : 'primary',
          disabled: requiresComment && !comment.trim(), onClick: decide, loading: busy },
      ]} />}
  </section>
}
