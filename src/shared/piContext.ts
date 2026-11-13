export type PiContextInput =
  | { kind: 'prompt' }
  | { kind: 'knowledge' | 'memory'; query: string }

export type PiContextResult = { kind: PiContextInput['kind']; text: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parsePiContextInput(value: unknown): PiContextInput | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (value.kind === 'prompt' && keys.length === 1) return { kind: 'prompt' }
  if ((value.kind !== 'knowledge' && value.kind !== 'memory') || keys.length !== 2
    || typeof value.query !== 'string' || /[\u0000-\u001f\u007f]/.test(value.query)) return null
  const query = value.query.trim()
  return query.length > 0 && query.length <= 160 ? { kind: value.kind, query } : null
}

export function parsePiContextResult(value: unknown, kind: PiContextInput['kind']): PiContextResult | null {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.kind !== kind
    || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 32_000) return null
  return { kind, text: value.text }
}
