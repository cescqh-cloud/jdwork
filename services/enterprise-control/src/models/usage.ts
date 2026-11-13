import type { Protocol } from './contract'
import type { CallUsage } from './store'

const observeLimit = 1024 * 1024
const boundary = /\r?\n\r?\n/u
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null

export class UsageObserver {
  readonly tokens: CallUsage = { inputTokens: null, outputTokens: null, complete: false }
  failed = false
  private pending = ''
  private discardEvent = false
  private readonly decoder = new TextDecoder()

  constructor(private readonly protocol: Protocol, private readonly streaming: boolean) {}

  write(value: Uint8Array) {
    this.add(this.decoder.decode(value, { stream: true }))
  }

  end() {
    this.add(this.decoder.decode())
    if (!this.discardEvent && this.pending) {
      if (this.streaming) this.sse(this.pending)
      else this.json(this.pending, true)
    }
    this.pending = ''
  }

  private add(value: string) {
    if (!this.streaming) {
      if (!this.discardEvent && this.pending.length + value.length <= observeLimit) this.pending += value
      else { this.pending = ''; this.discardEvent = true }
      return
    }
    this.pending += value
    let separator = boundary.exec(this.pending)
    while (separator) {
      if (!this.discardEvent && separator.index <= observeLimit) this.sse(this.pending.slice(0, separator.index))
      this.pending = this.pending.slice(separator.index + separator[0].length)
      this.discardEvent = false
      separator = boundary.exec(this.pending)
    }
    if (this.pending.length > observeLimit || (this.discardEvent && this.pending.length > 3)) {
      this.discardEvent = true
      this.pending = this.pending.slice(-3)
    }
  }

  private sse(frame: string) {
    const data = frame.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n')
    if (data && data !== '[DONE]') this.json(data, false)
  }

  private json(body: string, fullResponse: boolean) {
    let parsed: Record<string, unknown> | undefined
    try { parsed = record(JSON.parse(body)) } catch { return }
    if (!parsed) return
    if (parsed.error || parsed.type === 'error') { this.failed = true; return }
    if (this.protocol === 'openai') {
      const usage = record(parsed.usage)
      if (!usage) return
      this.tokens.inputTokens = count(usage.prompt_tokens)
      this.tokens.outputTokens = count(usage.completion_tokens)
      this.tokens.complete = this.tokens.inputTokens !== null && this.tokens.outputTokens !== null
      return
    }
    const usage = record(record(parsed.message)?.usage ?? parsed.usage)
    const input = count(usage?.input_tokens)
    const output = count(usage?.output_tokens)
    if (input !== null) this.tokens.inputTokens = input + (count(usage?.cache_creation_input_tokens) ?? 0) + (count(usage?.cache_read_input_tokens) ?? 0)
    if (output !== null) this.tokens.outputTokens = Math.max(this.tokens.outputTokens ?? 0, output)
    if (fullResponse || parsed.type === 'message_stop' || (parsed.type === 'message_delta' && record(parsed.delta)?.stop_reason)) {
      this.tokens.complete = this.tokens.inputTokens !== null && this.tokens.outputTokens !== null
    }
  }
}
