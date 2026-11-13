import { html } from 'hono/html'
import { role } from '../contract'
import type { ModelStore, ModelUsageRow } from './store'

type AdminData = Awaited<ReturnType<ModelStore['admin']>>
type Provider = AdminData['providers'][number]
type CatalogModel = AdminData['models'][number]

const roleLabels = {
  platform_admin: '平台管理员', it_lead: '信息中心负责人', project_owner: '项目负责人', developer: '开发人员',
  requester: '需求发起人', approver: '需求审批人', auditor: '审计员',
}
const classes = [['general', '通用'], ['internal', '内部'], ['restricted', '受限']] as const
const capabilities = [['text', '文本'], ['tools', '工具调用'], ['vision', '图像'], ['reasoning', '推理']] as const
const check = (value: boolean | undefined) => value ? 'checked' : ''
const select = (value: boolean | undefined) => value ? 'selected' : ''

function providerForm(provider: Provider | undefined) {
  return html`<form class="login" method="post" action="/console/models/providers">
    <label>供应商代码<input name="id" required maxlength="64" value="${provider?.id ?? ''}" ${provider ? 'readonly' : ''}></label>
    <label>供应商名称<input name="displayName" required maxlength="120" value="${provider?.displayName ?? ''}"></label>
    <label>协议<select name="protocol"><option value="openai">OpenAI Chat</option>
      <option value="anthropic" ${select(provider?.protocol === 'anthropic')}>Anthropic Messages</option></select></label>
    <label>API 基础地址<input type="url" name="baseUrl" required value="${provider?.baseUrl ?? ''}" placeholder="https://模型地址/v1"></label>
    <label>认证方式<select name="authHeader"><option value="bearer">Bearer</option>
      <option value="x-api-key" ${select(provider?.authHeader === 'x-api-key')}>x-api-key</option></select></label>
    <label>供应商密钥<input name="apiKey" type="password" maxlength="1024" ${provider ? '' : 'required'} autocomplete="new-password"></label>
    ${provider ? html`<small>留空保留原密钥。更改地址、协议或认证方式时请重新填写。</small>` : ''}
    <fieldset><legend>允许处理的数据分类</legend>${classes.map(([id, label]) => html`<label class="choice">
      <input name="classifications" type="checkbox" value="${id}" ${check(provider ? provider.classifications.includes(id) : id === 'general')}>${label}</label>`)}</fieldset>
    <label class="choice"><input name="streamUsage" type="checkbox" ${check(provider?.streamUsage ?? true)}>请求 OpenAI 流式用量</label>
    <label class="choice"><input name="enabled" type="checkbox" ${check(provider?.enabled ?? true)}>启用供应商</label>
    <button>保存供应商</button>
  </form>`
}

function catalogForm(data: AdminData, model: CatalogModel | undefined) {
  return html`<form class="login" method="post" action="/console/models/catalog">
    <label>目录代码<input name="id" required maxlength="64" value="${model?.id ?? ''}" ${model ? 'readonly' : ''}></label>
    <label>显示名称<input name="displayName" required maxlength="120" value="${model?.displayName ?? ''}"></label>
    <label>供应商<select name="providerId" required>${data.providers.map(provider => html`<option value="${provider.id}"
      ${select(model?.providerId === provider.id)}>${provider.displayName}</option>`)}</select></label>
    <label>供应商模型名称<input name="upstreamModel" required maxlength="200" value="${model?.upstreamModel ?? ''}"></label>
    <div class="field-pair"><label>上下文 Token<input type="number" name="contextWindow" min="1024" max="2000000" required value="${model?.contextWindow ?? 65536}"></label>
    <label>最大输出 Token<input type="number" name="maxOutputTokens" min="1" max="2000000" required value="${model?.maxOutputTokens ?? 16384}"></label></div>
    <fieldset><legend>模型能力</legend>${capabilities.map(([id, label]) => html`<label class="choice">
      <input type="checkbox" name="capabilities" value="${id}" ${check(model ? model.capabilities.includes(id) : id === 'text')}>${label}</label>`)}</fieldset>
    <label>默认推理强度<select name="defaultEffort"><option value="">跟随客户端</option>
      ${['low', 'medium', 'high'].map((effort, index) => html`<option value="${effort}" ${select(model?.defaultEffort === effort)}>${['低', '中', '高'][index]}</option>`)}</select></label>
    <fieldset><legend>可用角色</legend>${role.options.map(id => html`<label class="choice">
      <input type="checkbox" name="allowedRoles" value="${id}" ${check(model ? model.allowedRoles.includes(id) : id === 'developer')}>${roleLabels[id]}</label>`)}</fieldset>
    <label>项目范围<select name="projectId"><option value="">全组织（按角色）</option>${data.projects.map(project => html`
      <option value="${project.id}" ${select(model?.projectId === project.id)}>${project.name}</option>`)}</select></label>
    <div class="field-pair"><label>每人每日硬额度<input type="number" min="1" max="1000000000" name="dailyTokens" value="${model?.dailyTokens ?? ''}" placeholder="不限"></label>
    <label>每人每日提醒阈值<input type="number" min="1" max="1000000000" name="softDailyTokens" value="${model?.softDailyTokens ?? ''}" placeholder="未设"></label></div>
    <small>额度按 UTC 自然日与模型统计。请求前预留上下文和输出 Token，返回后用供应商用量结算。</small>
    <label class="choice"><input name="isDefault" type="checkbox" ${check(model?.isDefault)}>设为该范围默认模型</label>
    <label class="choice"><input name="allowContext" type="checkbox" ${check(model?.allowContext)}>允许检索授权记忆和知识</label>
    <label class="choice"><input name="allowErpRead" type="checkbox" ${check(model?.allowErpRead)}>允许查询授权的金蝶测试接口</label>
    <small>需启用工具调用。查询结果会进入使用该模型的对话。</small>
    <label class="choice"><input name="enabled" type="checkbox" ${check(model?.enabled ?? true)}>上架模型</label>
    <button>发布模型配置</button>
  </form>`
}

export function usageTable(usage: ModelUsageRow[], data?: AdminData) {
  return usage.length ? html`<div class="table-scroll"><table><thead><tr>
    <th>日期 (UTC)</th>${data ? html`<th>用户</th><th>部门</th><th>项目</th>` : ''}<th>设备</th><th>模型</th><th>场景</th><th>请求</th>
    <th>输入 / 输出 Token</th><th>计入额度</th><th>错误</th><th>提醒</th></tr></thead><tbody>${usage.map(item => html`<tr>
    <td>${item.day}</td>${data ? html`<td>${data.users.find(user => user.id === item.userId)?.displayName ?? item.userId}</td>
    <td>${data.departments.find(dept => dept.id === item.departmentId)?.name ?? '—'}</td>
    <td>${data.projects.find(project => project.id === item.projectId)?.name ?? '—'}</td>` : ''}
    <td>${item.deviceId?.slice(0, 8) ?? '网页'}</td><td>${data?.models.find(model => model.id === item.modelId)?.displayName ?? item.modelId}</td>
    <td>${item.purpose === 'demand_precheck' ? '需求预审' : '交互会话'}</td>
    <td>${item.requests}</td><td>${item.reportedInputTokens} / ${item.reportedOutputTokens}</td><td>${item.chargedTokens}</td>
    <td>${item.errors}</td><td>${item.softLimitReached ? '接近额度' : '—'}</td></tr>`)}</tbody></table></div>` : html`<p>最近 7 天暂无企业模型调用。</p>`
}

export function modelConsole(data: AdminData, usage: ModelUsageRow[], selectedProvider?: string, selectedModel?: string, selectedProject?: string) {
  const provider = data.providers.find(item => item.id === selectedProvider)
  const model = data.models.find(item => item.id === selectedModel)
  const project = data.projects.find(item => item.id === selectedProject)
  const users = data.users.map(user => html`<option value="${user.id}">${user.displayName}</option>`)
  return html`
    <p>保存配置后，已连接的桌面客户端会刷新可用模型。<a href="/">返回控制台</a></p>
    <section><h2>供应商</h2><ul>${data.providers.map(item => html`<li>
      <a href="?provider=${item.id}">${item.displayName}</a> · ${item.protocol} · ${item.enabled ? '已启用' : '已停用'}</li>`)}</ul>
      <details ${provider ? 'open' : ''}><summary>${provider ? '编辑供应商' : '添加供应商'}</summary>${providerForm(provider)}</details></section>
    <section><h2>模型与访问权限</h2><ul>${data.models.map(item => html`<li>
      <a href="?model=${item.id}">${item.displayName}</a> · ${item.providerId} · ${item.enabled ? '已上架' : '已下架'}</li>`)}</ul>
      ${data.providers.length ? html`<details ${model ? 'open' : ''}><summary>${model ? '编辑模型' : '添加模型'}</summary>
      ${catalogForm(data, model)}</details>` : html`<p>先登记一个供应商。</p>`}</section>
    <section><h2>项目和成员</h2><ul>${data.projects.map(item => html`<li><a href="?project=${item.id}">${item.name}</a> ·
      ${classes.find(([id]) => id === item.classification)?.[1]} · ${item.active ? '启用' : '停用'}</li>`)}</ul>
      <details ${project ? 'open' : ''}><summary>${project ? '编辑项目' : '添加项目'}</summary><form class="login" action="/console/models/projects" method="post">
      ${project ? html`<input type="hidden" name="id" value="${project.id}">` : ''}<label>项目名称<input name="name" required value="${project?.name ?? ''}"></label>
      <label>数据分类<select name="classification">${classes.map(([id, label]) => html`<option value="${id}" ${select(project?.classification === id)}>${label}</option>`)}</select></label>
      <label class="choice"><input type="checkbox" name="active" ${check(project?.active ?? true)}>启用项目</label><button>保存项目</button></form></details>
      ${data.projects.length && data.users.length ? html`<details><summary>分配或撤销项目成员</summary><form class="login" action="/console/models/memberships" method="post">
      <label>项目<select name="projectId" required>${data.projects.map(item => html`<option value="${item.id}">${item.name}</option>`)}</select></label>
      <label>成员<select name="userId" required>${users}</select></label><label>操作<select name="enabled"><option value="true">授予访问</option>
      <option value="false">撤销访问</option></select></label><button>保存项目权限</button></form><ul>${data.members.map(item => html`<li>
      ${data.projects.find(entry => entry.id === item.projectId)?.name} · ${data.users.find(user => user.id === item.userId)?.displayName ?? '已停用成员'}</li>`)}</ul></details>` : ''}</section>
    <section><h2>部门归集</h2><details><summary>添加部门</summary><form class="login" action="/console/models/departments" method="post">
      <label>部门名称<input name="name" required></label><button>保存部门</button></form></details>
      ${data.users.length && data.departments.length ? html`<details><summary>设置成员部门</summary><form class="login" action="/console/models/department-assignments" method="post">
      <label>成员<select name="userId" required>${users}</select></label><label>部门<select name="departmentId"><option value="">未分配</option>
      ${data.departments.map(item => html`<option value="${item.id}">${item.name}</option>`)}</select></label><button>保存归集</button></form></details>` : ''}</section>
    <section><h2>企业模型用量</h2>${usageTable(usage, data)}</section>`
}
