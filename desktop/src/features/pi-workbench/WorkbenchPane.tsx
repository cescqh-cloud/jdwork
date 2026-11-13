import { Component, Suspense, type ReactNode } from 'react'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { usePiTranslation } from './usePiTranslation'

class PaneErrorBoundary extends Component<{ children: ReactNode, fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function WorkbenchPane({ children, loadingLabel }: { children: ReactNode, loadingLabel: string }) {
  const t = usePiTranslation()
  return (
    <PaneErrorBoundary fallback={<ErrorState className="pi-pane-error" size="sm"
      title={t('pi.panelLoadError')} retryLabel={t('pi.refreshPage')} onRetry={() => window.location.reload()} />}>
      <Suspense fallback={<LoadingState label={loadingLabel} />}>{children}</Suspense>
    </PaneErrorBoundary>
  )
}
