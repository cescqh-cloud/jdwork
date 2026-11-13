import { z } from 'zod'
import { auditCategory, auditFilter, auditPage, auditQuery } from './audit/contract'
import { controlTitle, enrollInput, loginInput, refreshInput, revokeInput, role, tokenSchema } from './contract'
import { assignInput, bindInput, checkInput as deliveryCheckInput, materialVerificationInput, reviewInput, transitionInput } from './delivery/contract'
import { confirmImportInput, demandDetail, demandEvidence, demandSubmission, demandSummary, editDemand, identityInput,
  newDemand, precheckInput, submitInput, templateInput } from './demands/contract'
import { scanInput } from './demands/routes'
import { assistantErpInput, assistantErpOutput, erpEnvironmentList, erpExecuteInput, erpKey, erpPlanDecision, erpPlanInput, erpPlanListView, erpPlanView,
  runErpQueryInput, runErpQueryOutput } from './erp/contract'
import { candidateInput, editKnowledgeInput, editMemoryInput, newKnowledgeInput, searchInput } from './memory/contract'
import { knowledgeImportFileBytes, knowledgeImportFileCount, knowledgeImportRequestBytes } from './memory/import'
import { capability, departmentInput, effort, grantInput, membershipInput, modelContextInput, modelInput, projectInput, protocol, providerInput, userDepartmentInput } from './models/contract'
import { architecture as updateArchitecture, candidateOutput as updateCandidate, channel as updateChannel, checkOutput as updateCheck,
  clientVersion as updateClientVersion, createReleaseInput, pauseInput, platform as updatePlatform, publishInput, reportInput } from './releases/contract'

const session = z.object({ accessToken: tokenSchema, expiresAt: z.iso.datetime() })
const deviceSession = session.extend({ refreshToken: tokenSchema })
const device = z.object({ id: z.uuid(), platform: z.enum(['win32', 'darwin', 'linux']), clientVersion: z.string() })
const policy = z.object({ revision: z.number().int(), expiresAt: z.iso.datetime(), features: z.object({
  demands: z.boolean(), models: z.boolean(), memories: z.boolean(), updates: z.boolean(),
}) })
const cursor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const bootstrap = z.object({ user: z.object({ id: z.uuid(), displayName: z.string(), roles: z.array(role) }), device: device.nullable(), policy, cursor })
const events = z.object({ cursor, events: z.array(z.object({ eventId: z.uuid(), sequence: cursor, type: z.string(),
  resourceId: z.uuid(), revision: z.number().int(), occurredAt: z.iso.datetime() })) })
const catalog = z.object({ revision: z.number().int(), expiresAt: z.iso.datetime(), models: z.array(z.object({ providerId: z.string(), modelId: z.string(),
  displayName: z.string(), protocol, capabilities: z.array(capability), contextWindow: z.number().int(), maxOutputTokens: z.number().int(),
  defaultEffort: effort.nullable(), proxyEndpoint: z.string(), projectId: z.uuid().nullable(), isDefault: z.boolean(),
  canSearchContext: z.boolean(), canQueryErp: z.boolean(),
  quota: z.object({ dailyTokens: z.number().int().nullable(), softDailyTokens: z.number().int().nullable() }),
})) })
const usage = z.object({ usage: z.array(z.object({ day: z.iso.date(), userId: z.uuid(), deviceId: z.uuid().nullable(), departmentId: z.uuid().nullable(),
  projectId: z.uuid().nullable(), modelId: z.string(), purpose: z.enum(['interactive', 'demand_precheck']), requests: z.number().int(),
  reportedInputTokens: z.string(), reportedOutputTokens: z.string(), chargedTokens: z.string(), errors: z.number().int(), softLimitReached: z.boolean(),
})) })
const error = z.object({ error: z.object({ code: z.string(), message: z.string() }), requestId: z.uuid() })
const schema = (value: z.ZodType, io: 'input' | 'output' = 'output') => z.toJSONSchema(value, { io, unrepresentable: 'any' })
const content = (value: z.ZodType, io?: 'input' | 'output') => ({ 'application/json': { schema: schema(value, io) } })
const object = z.looseObject({})
const none: Record<string, string[]>[] = []
const bearer = [{ sessionBearer: [] }]
const sessionSecurity = [...bearer, { webSession: [] }]
const modelSecurity = [{ modelGrantBearer: [] }, { modelGrantKey: [] }]
const parameter = (name: string, location: 'path' | 'query' | 'header', value: z.ZodType, required = location === 'path') => ({ name, in: location, required, schema: schema(value) })
const demandId = parameter('id', 'path', z.uuid())
const processCode = parameter('processCode', 'path', z.string())
const page = [parameter('limit', 'query', z.number().int().min(1).max(100)), parameter('offset', 'query', z.number().int().min(0))]
const recordId = parameter('id', 'path', z.uuid())
const ifMatch = parameter('If-Match', 'header', z.string().regex(/^"[1-9]\d*"$/u), true)
const namedScope = z.object({ id: z.uuid(), name: z.string() })
const releaseId = parameter('id', 'path', z.uuid())
const erpEnvironment = parameter('id', 'path', erpKey)
const erpPlan = parameter('planId', 'path', z.uuid())
const importedKnowledge = z.object({ items: z.array(z.object({ created: z.boolean(), document: z.object({
  id: z.uuid(), tenantId: z.uuid(), scope: z.literal('project_private'), projectId: z.uuid(), departmentId: z.null(),
  title: newKnowledgeInput.shape.title, revision: z.number().int().min(1), aclVersion: z.number().int(), indexRevision: z.number().int().nullable(),
  status: z.enum(['draft', 'ready']), classification: newKnowledgeInput.shape.classification.unwrap(), excerpt: z.string(),
  source: newKnowledgeInput.shape.source.extend({ file: z.object({ name: z.string(), format: z.enum(['markdown', 'text']),
    bytes: z.number().int(), lines: z.number().int(), sha256: z.string().regex(/^[a-f0-9]{64}$/u), importedAt: z.iso.datetime(),
  }) }), citation: z.object({ documentId: z.uuid(), revision: z.number().int(), checksum: z.string(), href: z.string() }),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}) })).max(knowledgeImportFileCount) })
const auditParameters = [parameter('from', 'query', z.iso.date()), parameter('to', 'query', z.iso.date()), parameter('category', 'query', auditCategory),
  parameter('limit', 'query', auditQuery.shape.limit), parameter('cursor', 'query', auditQuery.shape.cursor)]
const updateVersionQuery = [parameter('platform', 'query', updatePlatform, true), parameter('arch', 'query', updateArchitecture, true),
  parameter('currentVersion', 'query', updateClientVersion, true)]

function uploadMedia(type: string) {
  return { required: true, content: { [type]: { schema: { type: 'string', format: 'binary' } } } }
}

function operation(summary: string, options: { input?: z.ZodType, output?: z.ZodType, status?: number,
  security?: Record<string, string[]>[], parameters?: ReturnType<typeof parameter>[], description?: string } = {}) {
  return {
    summary, description: options.description, security: options.security ?? sessionSecurity, parameters: options.parameters,
    requestBody: options.input ? { required: true, content: content(options.input, 'input') } : undefined,
    responses: { [options.status ?? 200]: { description: '请求成功', content: content(options.output ?? object) },
      default: { description: '请求未完成', content: content(error) } },
  }
}

function gateway(summary: string, vendor: 'anthropic' | 'openai') {
  const apiReference = vendor === 'anthropic' ? 'https://platform.claude.com/docs/en/build-with-claude/streaming'
    : 'https://developers.openai.com/api/reference/resources/chat'
  return {
    summary, security: modelSecurity,
    description: `请求模型字段使用目录 modelId。消息、工具及流式负载遵循供应商协议。${apiReference}`,
    requestBody: { required: true, content: content(z.looseObject({ model: z.string(), stream: z.boolean().optional() }), 'input') },
    responses: { '200': { description: '供应商 JSON 或 SSE', content: { ...content(object), 'text/event-stream': { schema: { type: 'string' } } } },
      default: { description: '模型访问、额度或供应商错误', content: content(object) } },
  }
}

export const controlOpenApi = {
  openapi: '3.1.0', info: { title: `${controlTitle}控制服务`, version: '1.0.0' },
  components: { securitySchemes: {
    sessionBearer: { type: 'http', scheme: 'bearer', description: '经验证的桌面设备或 Web 会话令牌' },
    webSession: { type: 'apiKey', in: 'cookie', name: '__Host-enterprise-session', description: '生产网页会话。变更请求须带同源 Origin。' },
    modelGrantBearer: { type: 'http', scheme: 'bearer', description: '按模型、设备及会话签发的短期代理凭证' },
    modelGrantKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: '短期代理凭证的 Anthropic 客户端兼容传法' },
  } },
  paths: {
    '/api/v1/admin/audit': { get: operation('按组织读取脱敏操作记录', { parameters: auditParameters, output: auditPage,
      description: '仅平台管理员或审计员的控制台会话可用。默认最近七个 UTC 日期。' }) },
    '/api/v1/admin/audit/export': { post: {
      ...operation('导出并留痕', { input: auditFilter, description: '仅平台管理员或审计员的控制台会话可用。每次最多 1000 条。' }),
      responses: { '200': { description: '脱敏 CSV', content: { 'text/csv': { schema: { type: 'string' } } },
        headers: { 'X-Audit-Export-Truncated': { schema: { type: 'string', enum: ['true', 'false'] } } } },
        default: { description: '导出未完成', content: content(error) } },
    } },
    '/healthz': { get: operation('服务和依赖就绪状态', { security: none, output: z.object({ ok: z.literal(true), redis: z.boolean() }) }) },
    '/api/v1/auth/exchange': { post: operation('开发账号登录', { security: none, input: loginInput, output: session }) },
    '/api/v1/devices/challenge': { post: operation('生成一次性设备绑定码', { status: 201, output: z.object({ challenge: tokenSchema, expiresAt: z.iso.datetime() }) }) },
    '/api/v1/devices/enroll': { post: operation('校验设备签名并绑定', { security: none, input: enrollInput, output: deviceSession, status: 201 }) },
    '/api/v1/devices/refresh': { post: operation('校验设备签名并轮换会话', { security: none, input: refreshInput, output: deviceSession }) },
    '/api/v1/devices/revoke': { post: operation('平台管理员撤销设备', { input: revokeInput, output: z.object({ revoked: z.literal(true) }) }) },
    '/api/v1/admin/devices': { get: operation('平台管理员查看本组织设备') },
    '/api/v1/bootstrap': { get: operation('当前身份、设备、策略与增量游标', { output: bootstrap }) },
    '/api/v1/client/policy': { get: operation('当前策略，可使用 ETag', { output: policy }) },
    '/api/v1/events': { get: operation('在权限范围内重放增量事件', { parameters: [parameter('cursor', 'query', cursor)], output: events }) },
    '/api/v1/models/catalog': { get: operation('当前设备的授权模型目录', { security: bearer, parameters: [parameter('projectId', 'query', z.uuid())], output: catalog }) },
    '/api/v1/models/grants': { post: operation('获取短期模型代理凭证', { security: bearer, input: grantInput, status: 201,
      output: session.extend({ proxyEndpoint: z.string() }) }) },
    '/api/v1/models/context': { post: operation('检索与所选模型、项目和数据分类匹配的授权上下文', { security: bearer, input: modelContextInput }) },
    '/api/v1/models/erp': { post: operation('为当前会话列出或执行授权的金蝶测试查询', { security: bearer,
      input: assistantErpInput, output: assistantErpOutput, description: '仅已绑定设备。核验当前模型与会话短期凭证、项目权限和查询配置。' }) },
    '/api/v1/model-gateway/anthropic/v1/messages': { post: gateway('转发 Anthropic Messages', 'anthropic') },
    '/api/v1/model-gateway/anthropic/v1/messages/count_tokens': { post: gateway('转发 Anthropic 输入 Token 估算', 'anthropic') },
    '/api/v1/model-gateway/openai/v1/chat/completions': { post: gateway('转发 OpenAI Chat Completions', 'openai') },
    '/api/v1/model-usage/me': { get: operation('本人最近七天的模型用量', { output: usage }) },
    '/api/v1/admin/model-usage': { get: operation('组织最近七天的模型用量', { output: usage }) },
    '/api/v1/admin/models': { get: operation('平台管理员查看模型和组织配置') },
    '/api/v1/admin/models/providers': { post: operation('登记或编辑供应商', { input: providerInput }) },
    '/api/v1/admin/models/catalog': { post: operation('发布或下架模型', { input: modelInput }) },
    '/api/v1/admin/model-projects': { post: operation('设置项目和数据分类', { input: projectInput }) },
    '/api/v1/admin/model-project-memberships': { post: operation('授予或撤销项目成员', { input: membershipInput }) },
    '/api/v1/admin/model-departments': { post: operation('登记部门', { input: departmentInput }) },
    '/api/v1/admin/model-department-assignments': { post: operation('设置成员所属部门', { input: userDepartmentInput }) },
    '/api/v1/demands/status': { get: operation('需求预审、钉钉连接和回调配置状态', { output: z.object({ oaConfigured: z.boolean(), callbackConfigured: z.boolean(), aiPrecheckConfigured: z.boolean() }) }) },
    '/api/v1/demands/templates': { get: operation('可用的钉钉需求模板与可选审批人节点') },
    '/api/v1/demands': { get: operation('查询有权访问的需求', { parameters: page, output: z.object({ demands: z.array(demandSummary) }) }),
      post: operation('新建需求草稿', { input: newDemand, output: demandDetail, status: 201,
        description: '桌面端显式保存到云端时可带请求标识，重试相同操作返回已有草稿和写入回执。' }) },
    '/api/v1/demands/backlog': { get: operation('查询已审批通过的需求池', { parameters: page, output: z.object({ demands: z.array(demandSummary) }) }) },
    '/api/v1/demands/{id}': { get: operation('读取需求详情及审批证据', { parameters: [demandId], output: demandDetail }),
      patch: operation('按草稿修订号修改需求', { parameters: [demandId], input: editDemand, output: demandDetail,
        description: '相同请求标识仅用于重放同一份写入，草稿修订冲突返回 409。写入不改变已冻结审批快照。' }) },
    '/api/v1/demands/{id}/versions/{versionId}': { get: operation('读取冻结版本的快照和哈希', { parameters: [demandId, parameter('versionId', 'path', z.uuid())], output: demandEvidence }) },
    '/api/v1/demands/{id}/precheck': { post: operation('请求受控模型对当前草稿预审', { parameters: [demandId], input: precheckInput, output: demandDetail }) },
    '/api/v1/demands/{id}/submit': { post: operation('冻结版本并排队发起 OA 审批', { parameters: [demandId], input: submitInput, output: demandSubmission, status: 202 }) },
    '/api/v1/demands/{id}/reconcile': { post: operation('排队核对钉钉实例', { parameters: [demandId], status: 202 }) },
    '/api/v1/demands/{id}/confirm-import': { post: operation('确认授权模板导入的需求', { parameters: [demandId], input: confirmImportInput, output: demandDetail }) },
    '/api/v1/admin/demands/templates': { get: operation('查看授权的钉钉模板'), put: operation('绑定模板和字段映射', { input: templateInput }) },
    '/api/v1/admin/demands/identities': { get: operation('按登录名查询钉钉员工映射', { parameters: [parameter('login', 'query', z.string())] }),
      put: operation('绑定钉钉员工标识', { input: identityInput }) },
    '/api/v1/admin/demands/templates/{processCode}/scan': { post: operation('授权模板补扫', { parameters: [processCode], input: scanInput, status: 202 }) },
    '/api/v1/integrations/dingtalk/{tenantSlug}/callback': { post: operation('接收验签后的钉钉加密事件', { security: none,
      parameters: [parameter('tenantSlug', 'path', z.string()), parameter('signature', 'query', z.string()), parameter('msg_signature', 'query', z.string()),
        parameter('timestamp', 'query', z.string()), parameter('nonce', 'query', z.string())], input: z.object({ encrypt: z.string() }) }) },
    '/api/v1/memories/candidates': { get: operation('读取本人及有权审核的记忆候选', { parameters: [page[0]!] }),
      post: operation('保存明确选择的记忆候选', { input: candidateInput, status: 201, parameters: [parameter('Idempotency-Key', 'header', z.uuid())] }) },
    '/api/v1/memories/scopes': { get: operation('当前账号有权使用的项目和部门', { output: z.object({ projects: z.array(namedScope), department: namedScope.nullable() }) }) },
    '/api/v1/memories/search': { post: operation('在当前授权范围内检索已发布记忆', { input: searchInput }) },
    '/api/v1/memories/changes': { get: operation('按个人游标重放授权记录及删除或撤权墓碑', { parameters: [parameter('cursor', 'query', cursor)] }) },
    '/api/v1/memories/{id}': { get: operation('读取当前授权记忆', { parameters: [recordId] }),
      patch: operation('按修订编辑记忆', { parameters: [recordId, ifMatch], input: editMemoryInput }),
      delete: operation('按修订删除记忆', { parameters: [recordId, ifMatch] }) },
    '/api/v1/memories/{id}/publish': { post: operation('按修订审核发布记忆', { parameters: [recordId, ifMatch] }) },
    '/api/v1/knowledge/search': { post: operation('在授权且可检索的知识中查找并返回引用', { input: searchInput }) },
    '/api/v1/knowledge/{id}': { get: operation('读取当前授权的知识来源', { parameters: [recordId, parameter('revision', 'query', z.number().int().min(1))] }) },
    '/api/v1/admin/knowledge': { get: operation('管理者查看有权维护的知识', { parameters: [page[0]!] }),
      post: operation('登记知识来源与草稿', { input: newKnowledgeInput, status: 201 }) },
    '/api/v1/admin/knowledge/import': { post: {
      ...operation('批量导入授权项目的文本资料为知识草稿', { output: importedKnowledge, status: 201,
        description: `仅项目成员中有发布权限的网页会话。每份最多 ${knowledgeImportFileBytes} 字节及 3500 个字符，整批最多 ${knowledgeImportRequestBytes} 字节。` }),
      requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', additionalProperties: false,
        required: ['projectId', 'files'], properties: {
          projectId: { type: 'string', format: 'uuid' }, classification: schema(newKnowledgeInput.shape.classification.unwrap()),
          files: { type: 'array', minItems: 1, maxItems: knowledgeImportFileCount, items: { type: 'string', format: 'binary' },
            description: '重复提交 files 字段。支持 UTF-8 Markdown 与 TXT 文件。' },
        } }, encoding: { files: { style: 'form', explode: true } } } } },
      responses: { '200': { description: '本批均为已有文件', content: content(importedKnowledge) },
        '201': { description: '新增知识草稿', content: content(importedKnowledge) }, default: { description: '导入未完成', content: content(error) } },
    } },
    '/api/v1/admin/knowledge/{id}': { get: operation('读取可维护知识', { parameters: [recordId] }),
      patch: operation('按修订调整知识与访问范围', { parameters: [recordId, ifMatch], input: editKnowledgeInput }),
      delete: operation('按修订撤回知识', { parameters: [recordId, ifMatch] }) },
    '/api/v1/admin/knowledge/{id}/publish': { post: operation('按修订发布就绪知识', { parameters: [recordId, ifMatch] }) },
    '/api/v1/admin/releases': { get: operation('平台管理员查看版本发布记录', { parameters: page }),
      post: operation('建立版本发布草稿', { input: createReleaseInput, status: 201 }) },
    '/api/v1/admin/releases/audience': { get: operation('查询可指定的灰度设备、用户和部门', { parameters: [parameter('search', 'query', z.string())] }) },
    '/api/v1/admin/releases/{id}': { get: operation('查看版本签名、状态和健康报告汇总', { parameters: [releaseId] }) },
    '/api/v1/admin/releases/{id}/manifest': { put: { ...operation('上传原始 electron-builder 清单', { parameters: [releaseId] }), requestBody: uploadMedia('application/yaml') } },
    '/api/v1/admin/releases/{id}/package': { put: { ...operation('流式上传并验证 Windows 安装包', { parameters: [releaseId] }), requestBody: uploadMedia('application/octet-stream') } },
    '/api/v1/admin/releases/{id}/publish': { post: operation('签名发布已验证的版本', { parameters: [releaseId], input: publishInput }) },
    '/api/v1/admin/releases/{id}/pause': { post: operation('暂停当前版本的分发', { parameters: [releaseId], input: pauseInput }) },
    '/api/v1/updates/key': { get: operation('查看当前发布公钥的诊断信息', { security: bearer,
      description: '客户端使用构建内受信公钥执行验签。此接口仅提供诊断信息。', output: z.object({ keyId: z.string(), publicKey: z.string() }) }) },
    '/api/v1/updates/check': { get: operation('当前设备的候选版本和兼容提示', { security: bearer,
      parameters: [...updateVersionQuery, parameter('channel', 'query', updateChannel)], output: updateCheck }) },
    '/api/v1/updates/manifest/{channel}': { get: operation('设备可见的签名版本清单', { security: bearer,
      parameters: [...updateVersionQuery, parameter('channel', 'path', updateChannel)], output: updateCandidate.nullable() }) },
    '/api/v1/updates/feed/{releaseId}/{filename}': {
      get: { summary: '下载有权接收的原始清单或安装包', security: bearer,
        parameters: [parameter('releaseId', 'path', z.uuid()), parameter('filename', 'path', z.string()), parameter('Range', 'header', z.string())],
        responses: { '200': { description: '完整文件', content: uploadMedia('application/octet-stream').content },
          '206': { description: '单段文件范围', content: uploadMedia('application/octet-stream').content }, '416': { description: '无效文件范围' },
          default: { description: '请求未完成', content: content(error) } } },
      head: { summary: '检查授权文件的长度或范围', security: bearer,
        parameters: [parameter('releaseId', 'path', z.uuid()), parameter('filename', 'path', z.string()), parameter('Range', 'header', z.string())],
        responses: { '200': { description: '完整文件头' }, '206': { description: '单段文件范围头' }, '416': { description: '无效文件范围' } } },
    },
    '/api/v1/client/update-reports': { post: operation('报告下载、安装、启动健康或失败', { security: bearer, input: reportInput }) },
    '/api/v1/demands/{id}/assign': { post: operation('将当前已批准的需求版本分配给项目成员', { parameters: [demandId], input: assignInput, status: 201 }) },
    '/api/v1/deliveries': { get: operation('查询有权访问的开发交付任务', { parameters: [parameter('demandId', 'query', z.uuid()), page[0]!] }) },
    '/api/v1/deliveries/assignment-options': { get: operation('获取需求的可分配版本、项目与成员', { parameters: [parameter('demandId', 'query', z.uuid(), true)] }) },
    '/api/v1/deliveries/{id}': { get: operation('查看交付状态、当前修订和可用操作', { parameters: [recordId] }) },
    '/api/v1/deliveries/{id}/bind': { post: operation('绑定已登记设备的原生 Worktree 与会话', { parameters: [recordId, ifMatch], input: bindInput }) },
    '/api/v1/deliveries/{id}/checks': { post: operation('对冻结材料执行静态规则检查', { parameters: [recordId, ifMatch, parameter('Idempotency-Key', 'header', z.uuid())],
      input: deliveryCheckInput, status: 201 }) },
    '/api/v1/deliveries/{id}/checks/{runId}': { get: operation('读取有权查看的检查证据', { parameters: [recordId, parameter('runId', 'path', z.uuid())] }) },
    '/api/v1/deliveries/{id}/materials': { post: operation('由绑定的设备核验检查材料或登记材料已变化', {
      parameters: [recordId, ifMatch], input: materialVerificationInput,
    }) },
    '/api/v1/deliveries/{id}/reviews': { post: operation('由独立复审人确认或退回当前检查结果', { parameters: [recordId, ifMatch], input: reviewInput }) },
    '/api/v1/deliveries/{id}/transition': { post: operation('推进开发、登记测试证据或确认验收', { parameters: [recordId, ifMatch], input: transitionInput }) },
    '/api/v1/erp/environments': { get: operation('查看当前项目有权访问的金蝶只读查询', { output: erpEnvironmentList }) },
    '/api/v1/erp/environments/{id}/read': { post: operation('按项目执行预登记的金蝶只读查询', {
      parameters: [erpEnvironment], input: runErpQueryInput, output: runErpQueryOutput,
    }) },
    '/api/v1/erp/environments/{id}/plans': {
      get: operation('查看当前项目有权访问的 ERP 写操作申请', {
        parameters: [erpEnvironment, parameter('projectId', 'query', z.uuid(), true)], output: erpPlanListView,
      }),
      post: operation('冻结独立的 ERP 写操作申请', { parameters: [erpEnvironment], input: erpPlanInput, output: erpPlanView, status: 201 }),
    },
    '/api/v1/erp/environments/{id}/plans/{planId}/decision': { post: operation('由同项目的独立 ERP 审批人核对申请', {
      parameters: [erpEnvironment, erpPlan], input: erpPlanDecision, output: erpPlanView, description: '仅控制台用户会话可审批。',
    }) },
    '/api/v1/erp/environments/{id}/plans/{planId}/execute': { post: operation('核验 ERP 写入权限和已审批版本', {
      parameters: [erpEnvironment, erpPlan], input: erpExecuteInput, output: erpPlanView,
      description: '金蝶连接当前仅开放只读。正式运行的服务对实际写入返回 ERP_WRITE_DISABLED。',
    }) },
  },
}
