import { createHash } from 'node:crypto'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { ControlError } from '../contract'
import { assertCleanContext, classification, newKnowledgeInput, type Classification, type KnowledgeFileSource } from './contract'

export const knowledgeImportFileCount = 8
export const knowledgeImportFileBytes = 10_503
export const knowledgeImportRequestBytes = 96 * 1024
const maxFilename = 120
const importFields = z.strictObject({ projectId: z.uuid(), classification: classification.optional() })

export type KnowledgeUpload = {
  projectId: string
  classification: Classification
  files: { title: string; body: string; source: KnowledgeFileSource }[]
}

const invalidForm = () => new ControlError(400, 'KNOWLEDGE_IMPORT_INVALID', '请选择一个授权项目和要导入的文本文件。')
const tooLarge = () => new ControlError(413, 'KNOWLEDGE_IMPORT_SIZE', '导入批次或单份文件超过允许的大小。')
export const limitKnowledgeUpload = bodyLimit({ maxSize: knowledgeImportRequestBytes, onError: () => { throw tooLarge() } })

async function prepareFile(file: File, importedAt: string): Promise<KnowledgeUpload['files'][number]> {
  const name = file.name
  const normalized = name.normalize('NFKC')
  const extension = /\.(md|markdown|txt)$/iu.exec(name)?.[1]?.toLowerCase()
  const [type, ...parameters] = file.type.toLowerCase().split(';').map(value => value.trim())
  const format = extension === 'txt' ? 'text' : 'markdown'
  const compatible = type === '' || type === 'application/octet-stream' || type === 'text/plain' ||
    (format === 'markdown' && (type === 'text/markdown' || type === 'text/x-markdown'))
  if (!extension || !compatible || parameters.length > 1 ||
    parameters.some(value => !/^charset\s*=\s*(?:utf-8|"utf-8")$/u.test(value))) {
    throw new ControlError(400, 'KNOWLEDGE_IMPORT_FORMAT', '请选择 Markdown 或 TXT 文件。')
  }
  if (name.length > maxFilename || normalized.length > maxFilename || normalized !== normalized.trim() ||
    !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._()+【】（）-]*$/u.test(normalized)) {
    throw new ControlError(400, 'KNOWLEDGE_IMPORT_FILENAME', '请使用普通文件名，长度不超过 120 个字符。')
  }
  if (file.size > knowledgeImportFileBytes) throw tooLarge()
  const bytes = new Uint8Array(await file.arrayBuffer())
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/gu, '\n') } catch {
    throw new ControlError(400, 'KNOWLEDGE_IMPORT_ENCODING', '请选择以 UTF-8 编码保存的文本文件。')
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    throw new ControlError(400, 'KNOWLEDGE_IMPORT_ENCODING', '文件包含无法导入的控制字符。')
  }
  const title = name.slice(0, -(extension.length + 1)).trim()
  const body = text.trim()
  if (body.length > 3500) throw tooLarge()
  if (!body) throw new ControlError(400, 'KNOWLEDGE_IMPORT_EMPTY', '请移除空文件后再导入。')
  assertCleanContext(name, title, body)
  return { title, body, source: { name, key: normalized.toLowerCase(), format, bytes: bytes.byteLength,
    lines: text.split('\n').length, sha256: createHash('sha256').update(bytes).digest('hex'), importedAt } }
}

export async function readKnowledgeUpload(request: Request): Promise<KnowledgeUpload> {
  if (!/^multipart\/form-data\s*;/iu.test(request.headers.get('Content-Type') ?? '') ||
    !/^(?:identity)?$/iu.test(request.headers.get('Content-Encoding') ?? '')) throw invalidForm()
  const form = await request.formData().catch(() => { throw invalidForm() })
  if ([...form.keys()].some(key => !['projectId', 'classification', 'files'].includes(key)) ||
    form.getAll('projectId').length !== 1 || form.getAll('classification').length > 1) throw invalidForm()
  const input = importFields.safeParse({ projectId: form.get('projectId'), classification: form.get('classification') ?? undefined })
  if (!input.success) throw invalidForm()
  const items = form.getAll('files')
  if (!items.length || items.length > knowledgeImportFileCount || items.some(item => !(item instanceof File))) throw invalidForm()
  const date = new Date().toISOString()
  const files = await Promise.all((items as File[]).map(file => prepareFile(file, date)))
  if (new Set(files.map(file => file.source.key)).size !== files.length) {
    throw new ControlError(400, 'KNOWLEDGE_IMPORT_DUPLICATE', '本批次有同名文件，请核对后重新选择。')
  }
  const level = input.data.classification ?? 'internal'
  if (files.some(file => !newKnowledgeInput.safeParse({ scope: 'project_private', projectId: input.data.projectId,
    classification: level, title: file.title, body: file.body, source: { label: file.source.name } }).success)) throw invalidForm()
  return { projectId: input.data.projectId, classification: level, files }
}
