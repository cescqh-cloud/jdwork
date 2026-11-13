import { Monitor } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ErrorState } from '@/components/ui/ErrorState'
import { errorText, type ClientConnections, type PiApi } from './api'
import { usePiTranslation } from './usePiTranslation'

type Props = { api: PiApi, value: ClientConnections, onSave: () => void }

export function ComputerUsePanel({ api, value, onSave }: Props) {
  const t = usePiTranslation()
  const [busy, setBusy] = useState<'save' | 'check'>()
  const [confirm, setConfirm] = useState(false)
  const [notice, setNotice] = useState<{ text: string, ok: boolean }>()

  async function perform(enabled?: boolean) {
    if (busy) return
    setBusy(enabled === undefined ? 'check' : 'save')
    setNotice(undefined)
    try {
      if (enabled === undefined) {
        setNotice(await api.write<{ text: string, ok: boolean }>('/api/client/test', 'POST', { section: 'computer', scene: 'default' }))
      } else {
        await api.write('/api/client/settings', 'PUT', { revision: value.revision, section: 'computer', value: { enabled } })
        onSave()
        setNotice({ text: t('pi.saved'), ok: true })
      }
    } catch (error) {
      setNotice({ text: errorText(error, t('pi.saveError')), ok: false })
    } finally {
      setBusy(undefined)
    }
  }

  return <Card as="section" padding="lg" radius="lg" className="pi-stack" aria-label={t('pi.clientComputer')}>
    <div className="pi-wrap">
      <h2 className="pi-inline"><Monitor size={17} strokeWidth={1.75} aria-hidden="true" />{t('pi.clientComputer')}</h2>
      <Badge tone={value.computerAvailable ? 'success' : 'warning'}>
        {t(value.computerAvailable ? 'pi.clientComputerInstalled' : 'pi.clientNoComputer')}
      </Badge>
    </div>
    <p className="pi-subtle">{t('pi.clientComputerHint')}</p>
    <div className="pi-wrap">
      <Button size="sm" variant={value.computerUse ? 'secondary' : 'primary'}
        disabled={!!busy || (!value.computerAvailable && !value.computerUse)} loading={busy === 'save' && !confirm}
        onClick={() => value.computerUse ? void perform(false) : setConfirm(true)}>
        {t(value.computerUse ? 'pi.clientDisable' : 'pi.clientEnable')}
      </Button>
      <Button size="sm" variant="secondary" disabled={!!busy || !value.computerAvailable} loading={busy === 'check'}
        onClick={() => void perform()}>{t('pi.clientCheckComputer')}</Button>
      <span className="pi-subtle" role="status">{t(value.computerUse ? 'pi.clientEnabled' : 'pi.clientDisabled')}</span>
    </div>
    {notice && (notice.ok ? <p role="status" className="pi-subtle">{notice.text}</p> : <ErrorState size="sm" title={notice.text} />)}
    {confirm && <ConfirmDialog open title={t('pi.clientEnable')} body={t('pi.clientEnableConfirm')}
      cancelLabel={t('pi.cancel')} confirmLabel={t('pi.clientEnable')} loading={!!busy}
      onClose={() => setConfirm(false)} onConfirm={async () => { await perform(true); setConfirm(false) }} />}
  </Card>
}
