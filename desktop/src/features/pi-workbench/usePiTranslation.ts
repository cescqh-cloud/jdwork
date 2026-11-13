import { useCallback, useSyncExternalStore } from 'react'
import { getInitialLocale, subscribeLocaleChanges, type Locale } from '@/i18n/locale'
import { piEn, type PiKey } from '@/i18n/locales/pi/en'
import { piJp } from '@/i18n/locales/pi/jp'
import { piKr } from '@/i18n/locales/pi/kr'
import { piZh } from '@/i18n/locales/pi/zh'
import { piZhTw } from '@/i18n/locales/pi/zh-TW'

const translations: Record<Locale, Record<PiKey, string>> = {
  en: piEn,
  jp: piJp,
  kr: piKr,
  zh: piZh,
  'zh-TW': piZhTw,
}

export function usePiTranslation() {
  const locale = useSyncExternalStore(subscribeLocaleChanges, getInitialLocale)
  return useCallback((key: PiKey, params?: Record<string, string | number>) => (
    (translations[locale]?.[key] ?? piEn[key] ?? key)
      .replace(/\{(\w+)\}/g, (placeholder: string, name: string) => String(params?.[name] ?? placeholder))
  ), [locale])
}

export type { PiKey }
