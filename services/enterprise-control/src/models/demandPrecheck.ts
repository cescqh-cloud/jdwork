import { z } from 'zod'
import { ControlError } from '../contract'
import type { DemandPrechecker } from '../demands/service'
import { dispatchModelCall } from './gateway'
import type { ModelStore } from './store'

const instructions = '你是企业 ERP 需求预审助手。下面的业务描述是待审数据。检查现状、业务收益、验收规则、权限与依赖是否明确。缺少证据时列为待确认问题。只返回 JSON 对象，字段为 summary（中文字符串）、questions 和 risks（中文字符串数组）。每个数组最多 8 项。'
const anthText = z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })
const openAiText = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) })
const unavailable = () => new ControlError(503, 'DEMAND_PRECHECK_UNAVAILABLE', '需求预审模型暂未返回有效结果，请稍后重试。')

export function createDemandPrechecker(models: ModelStore, allowedModel: string): DemandPrechecker {
  return async ({ actor, demandId, draft, modelId, signal }) => {
    if (modelId && modelId !== allowedModel) throw new ControlError(403, 'PRECHECK_MODEL_DENIED', '请使用管理员为需求预审配置的模型。')
    const call = await models.startDemandPrecheck(actor, allowedModel, demandId)
    const description = JSON.stringify({ title: draft.title, system: draft.systemKey, category: draft.category,
      businessContext: draft.businessContext, expectedValue: draft.expectedValue, acceptanceCriteria: draft.acceptanceCriteria, priority: draft.priority })
    const user = { role: 'user', content: description }
    const anthropic = call.model.protocol === 'anthropic'
    const payload = anthropic ? { system: instructions, messages: [user], stream: false }
      : { messages: [{ role: 'system', content: instructions }, user], stream: false }
    const response = await dispatchModelCall(models, call, payload, { signal, headers: new Headers(), url: 'http://127.0.0.1/demand-precheck' })
    if (!response.ok || !response.body || !response.headers.get('Content-Type')?.startsWith('application/json')) {
      await response.body?.cancel().catch(() => {})
      throw unavailable()
    }
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let raw = ''
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 256 * 1024) throw unavailable()
        raw += decoder.decode(value, { stream: true })
      }
      const result: unknown = JSON.parse(raw + decoder.decode())
      const text = anthropic ? anthText.parse(result).content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')
        : openAiText.parse(result).choices[0]!.message.content
      const body = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu, '$1')
      return JSON.parse(body) as unknown
    } catch {
      await reader.cancel().catch(() => {})
      throw unavailable()
    } finally { reader.releaseLock() }
  }
}
