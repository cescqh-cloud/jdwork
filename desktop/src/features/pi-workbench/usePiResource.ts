import { useEffect, useReducer, useState } from 'react'
import type { PiApi } from './api'

export function usePiResource<T>(api: PiApi, path: string | null, generation = 0) {
  const [refreshId, refresh] = useReducer((id: number) => id + 1, 0)
  const [result, setResult] = useState<{ path: string, value?: T, error?: unknown }>()

  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    void api.get<T>(path, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setResult({ path, value })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setResult((previous) => ({
          path, value: previous?.path === path ? previous.value : undefined, error,
        }))
      },
    )
    return () => controller.abort()
  }, [api, path, generation, refreshId])

  return {
    value: result?.path === path ? result?.value : undefined,
    error: result?.path === path ? result?.error : undefined,
    refresh,
  }
}
