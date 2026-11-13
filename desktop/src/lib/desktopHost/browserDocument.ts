export type BrowserDocumentFallbackReason = 'engine-not-configured' | 'invalid-configuration' | 'address-not-approved' |
  'active-page-session' | 'anonymous-document-unavailable' | 'lightpanda-unavailable' | 'lightpanda-busy'

export interface BrowserDocumentResult {
  engine: 'lightpanda' | 'chromium'
  fallbackReason: BrowserDocumentFallbackReason | null
  sourceUrl: string
  title: string
  text: string
  format: 'markdown' | 'text'
  truncated: boolean
}
