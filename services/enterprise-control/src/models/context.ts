import type { z } from 'zod'
import { ControlError } from '../contract'
import type { MemoryStore } from '../memory/store'
import type { Actor } from '../store'
import type { modelContextInput } from './contract'
import type { ModelStore } from './store'

async function currentRecord<T>(read: Promise<T>): Promise<T | null> {
  try { return await read } catch (error) {
    if (error instanceof ControlError && (error.status === 404 || error.status === 410)) return null
    throw error
  }
}

export async function searchModelContext(models: ModelStore, memory: MemoryStore, actor: Actor, input: z.infer<typeof modelContextInput>) {
  const projectId = input.projectId ?? null
  const allowed = await models.contextPolicy(actor, input.modelId, projectId)
  const search = { query: input.query, limit: input.limit }
  const [memoryHits, knowledgeHits] = await Promise.all([
    input.source !== 'knowledge' ? memory.search(actor, search, allowed) : null,
    input.source !== 'memory' ? memory.searchKnowledge(actor, search, allowed) : null,
  ])
  const [memories, knowledge] = await Promise.all([
    Promise.all((memoryHits?.items ?? []).map(hit => currentRecord(memory.get(actor, hit.id)))),
    Promise.all((knowledgeHits?.items ?? []).map(hit => currentRecord(memory.getKnowledge(actor, hit.id, hit.revision)))),
  ])
  const current = await models.contextPolicy(actor, input.modelId, projectId)
  if (current.revision !== allowed.revision) throw new ControlError(409, 'MODEL_CONTEXT_CHANGED', 'The model or project policy changed. Search again.')
  return {
    revision: current.revision, modelId: input.modelId, projectId,
    memories: memories.flatMap((item, index) => item && item.status === 'active' && item.revision === memoryHits?.items[index]?.revision &&
      current.classifications.includes(item.classification) && (item.scope !== 'project_private' || item.projectId === projectId)
      ? [{ id: item.id, revision: item.revision, scope: item.scope, excerpt: Array.from(item.body).slice(0, 700).join(''),
          lastVerifiedAt: item.lastVerifiedAt }] : []),
    knowledge: knowledge.flatMap(item => item && item.status === 'ready' && current.classifications.includes(item.classification) &&
      (item.scope !== 'project_private' || item.projectId === projectId)
      ? [{ title: item.title, excerpt: item.excerpt, source: item.source, citation: item.citation }] : []),
  }
}
