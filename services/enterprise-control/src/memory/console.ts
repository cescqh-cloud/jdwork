import type { Context, Env, Hono } from 'hono'
import { html } from 'hono/html'
import { z } from 'zod'
import type { Actor } from '../store'
import {
  candidateInput, editKnowledgeInput, editMemoryInput, MemoryRevisionConflict, newKnowledgeInput, searchInput,
  type Classification, type Scope,
} from './contract'
import { isReviewer } from './database'
import { knowledgeImportFileCount, limitKnowledgeUpload, readKnowledgeUpload } from './import'
import type { MemoryStore } from './store'

const memoriesPath = '/console/memories'
const knowledgePath = '/console/knowledge'
const revisionInput = z.coerce.number().int().min(1).max(2_147_483_647)
const scopeNames: Record<Scope, string> = {
  user_private: '个人', project_private: '项目成员', team_shared: '同部门成员', enterprise_reference: '企业成员',
}
type Scopes = Awaited<ReturnType<MemoryStore['availableScopes']>>
type Memory = Awaited<ReturnType<MemoryStore['get']>>
type Knowledge = Awaited<ReturnType<MemoryStore['getKnowledge']>>

interface MemoryConsoleOptions<E extends Env> {
  store: MemoryStore
  actor(c: Context<E>, deviceAllowed?: boolean): Promise<Actor>
  parse<T>(schema: z.ZodType<T>, input: unknown): T
  page(title: string, body: ReturnType<typeof html>): ReturnType<typeof html>
}

function option(value: string, label: string, current?: string | null) {
  return html`<option value="${value}"${value === current ? html` selected` : ''}>${label}</option>`
}

function scopesForm(available: Scopes, knowledge: boolean, current?: Knowledge) {
  return html`
    <label>共享范围<select name="scope" required>
      ${knowledge ? option('enterprise_reference', '企业成员', current?.scope) : option('user_private', '仅本人')}
      ${available.projects.length ? option('project_private', '项目成员', current?.scope) : ''}
      ${available.department ? option('team_shared', '同部门成员', current?.scope) : ''}
    </select></label>
    <label>项目<select name="projectId"><option value="">不选</option>
      ${available.projects.map(project => option(project.id, project.name, current?.projectId))}
    </select></label>
    <label>部门<select name="departmentId"><option value="">不选</option>
      ${available.department ? option(available.department.id, available.department.name, current?.departmentId) : ''}
    </select></label>
    <p>选项目范围时填写项目，选部门范围时填写部门。</p>`
}

function classificationForm(value: Classification = 'internal') {
  return html`<label>信息等级<select name="classification">
    ${option('general', '一般', value)}${option('internal', '内部', value)}${option('restricted', '受限', value)}
  </select></label>`
}

function revisionForm(revision: number) {
  return html`<input type="hidden" name="revision" value="${revision}">`
}

function memoryBodyForm(value?: Memory) {
  return html`<label>记忆正文<textarea name="body" rows="5" cols="36" required maxlength="2000">${value?.body ?? ''}</textarea></label>
    ${classificationForm(value?.classification)}
    <label>到期时间<input name="expiresAt" placeholder="2026-12-01T18:00:00+08:00" value="${value?.expiresAt ?? ''}"></label>`
}

function knowledgeForm(path: string, scopes: Scopes, item?: Knowledge, fixedProject = false) {
  return html`<form class="login" method="post" action="${path}" enctype="multipart/form-data">
    ${item ? revisionForm(item.revision) : ''}
    ${fixedProject && item?.projectId ? html`
      <input type="hidden" name="scope" value="project_private"><input type="hidden" name="projectId" value="${item.projectId}">
      <p>项目范围 · ${scopes.projects.find(project => project.id === item.projectId)?.name ?? '当前项目'}</p>
    ` : scopesForm(scopes, true, item)}
    <label>标题<input name="title" required maxlength="160" value="${item?.title ?? ''}"></label>
    <label>来源名称<input name="sourceLabel" required maxlength="120" value="${item?.source.label ?? ''}"></label>
    <label>来源链接<input type="url" name="sourceUrl" maxlength="300" value="${item?.source.url ?? ''}"></label>
    <label>正文<textarea name="body" rows="9" cols="36" required maxlength="3500">${item?.body ?? ''}</textarea></label>
    ${classificationForm(item?.classification)}
    <button>保存草稿</button>
  </form>`
}

function knowledgeImportForm(projects: Scopes['projects']) {
  return html`<form class="login" method="post" action="${knowledgePath}/import" enctype="multipart/form-data">
    <h2>批量导入项目资料</h2>
    <label>导入到项目<select name="projectId" required><option value="">请选择项目</option>
      ${projects.map(project => option(project.id, project.name))}
    </select></label>
    ${classificationForm()}
    <label>选择文本文件<input type="file" name="files" accept=".md,.markdown,.txt" multiple required></label>
    <p>每次最多 ${knowledgeImportFileCount} 份 UTF-8 Markdown 或 TXT，每份正文不超过 3500 字。</p>
    <p>导入的资料属于所选项目。保存为待发布，核对后逐份发布。</p>
    <button>导入为待发布</button>
  </form>`
}

function searchForm(path: string, label: string, query = '') {
  return html`<form class="login" method="post" action="${path}">
    <label>${label}<input name="query" required maxlength="160" value="${query}"></label><button>检索</button>
  </form>`
}

function sourceLink(item: Knowledge) {
  return item.source.url ? html`<a href="${item.source.url}" rel="noreferrer">${item.source.label}</a>` : html`${item.source.label}`
}

function importedSource(item: Knowledge) {
  const file = item.source.file
  return file ? html`<p>原始文件 ${file.name} · ${file.format === 'markdown' ? 'Markdown' : 'TXT'} · ${file.lines} 行</p>
    <p>导入时间 ${file.importedAt}</p><p>原文件校验值 <code>${file.sha256}</code></p>` : ''
}

function memoryResults(items: Memory[]) {
  return items.length ? html`<ul>${items.map(item => html`<li>
    <a href="${memoriesPath}/${item.id}">${Array.from(item.body).slice(0, 100).join('')}</a>
    <small> ${scopeNames[item.scope]} · 修订 ${item.revision}</small></li>`)}</ul>` : html`<p>暂无符合条件的记忆。</p>`
}

function knowledgeResults(items: Knowledge[]) {
  return items.length ? items.map(item => html`<section>
    <h2><a href="${knowledgePath}/${item.id}?revision=${item.revision}">${item.title}</a></h2>
    <p>${item.excerpt}</p><p>出处 ${sourceLink(item)} · 修订 ${item.revision}</p>
  </section>`) : html`<p>暂无符合条件的已发布知识。</p>`
}

function formScope(form: Record<string, unknown>) {
  return { scope: form.scope, projectId: form.projectId || undefined, departmentId: form.departmentId || undefined }
}

function formMemory(form: Record<string, unknown>) {
  return { body: form.body, expiresAt: form.expiresAt || null, classification: form.classification || undefined }
}

function formKnowledge(form: Record<string, unknown>) {
  return { ...formScope(form), title: form.title, body: form.body, classification: form.classification || undefined,
    source: { label: form.sourceLabel, url: form.sourceUrl || undefined } }
}

export function mountMemoryConsole<E extends Env>(app: Hono<E>, options: MemoryConsoleOptions<E>) {
  const { store, actor, parse, page } = options

  async function redirectAfter(c: Context<E>, work: Promise<unknown>, path: string) {
    try {
      await work
      return c.redirect(path, 303)
    } catch (error) {
      if (!(error instanceof MemoryRevisionConflict)) throw error
      const submitted = error.submitted as { body?: unknown }
      const current = error.current as { body?: unknown, revision: number }
      return c.html(page('记录已更新', html`<section><p>${error.message}</p>
        <p>当前修订 ${current.revision}</p><p>${String(current.body ?? '')}</p>
        <label>本次输入<textarea rows="5" cols="36" readonly>${String(submitted.body ?? '')}</textarea></label>
        <a href="${path}">返回最新记录</a></section>`), 409)
    }
  }

  app.get(memoriesPath, async c => {
    const user = await actor(c, false)
    const [scopes, candidates] = await Promise.all([store.availableScopes(user), store.candidates(user)])
    return c.html(page('记忆中心', html`
      ${searchForm(memoriesPath + '/search', '检索已生效的记忆')}
      <section><h2>候选与待审核</h2>${memoryResults(candidates)}</section>
      <form class="login" method="post" action="${memoriesPath}/candidates" enctype="multipart/form-data">
        <h2>新增候选记忆</h2>${scopesForm(scopes, false)}${memoryBodyForm()}
        <p>个人候选由本人启用。共享候选提交后，由有权限的负责人审核发布。</p>
        <button>保存候选</button>
      </form>`))
  })
  app.post(memoriesPath + '/search', async c => {
    const user = await actor(c, false)
    const input = parse(searchInput, { query: (await c.req.parseBody()).query })
    const result = await store.search(user, input)
    return c.html(page('记忆检索结果', html`${searchForm(memoriesPath + '/search', '检索已生效的记忆', input.query)}
      <section>${memoryResults(result.items)}</section><a href="${memoriesPath}">返回记忆中心</a>`))
  })
  app.post(memoriesPath + '/candidates', async c => {
    const user = await actor(c, false)
    const form = await c.req.parseBody()
    const record = await store.createCandidate(user, parse(candidateInput, { ...formScope(form), ...formMemory(form) }))
    return c.redirect(memoriesPath + '/' + record.id, 303)
  })
  app.get(memoriesPath + '/:id', async c => {
    const user = await actor(c, false)
    const item = await store.get(user, parse(z.uuid(), c.req.param('id')))
    const path = memoriesPath + '/' + item.id
    const owner = item.ownerId === user.id
    const reviewer = isReviewer(item.scope, user.roles)
    return c.html(page('记忆详情', html`<section>
      <p>${scopeNames[item.scope]} · ${item.status === 'active' ? '已生效' : '候选'} · 修订 ${item.revision}</p>
      <label>正文<textarea rows="5" cols="36" readonly>${item.body}</textarea></label>
      ${item.expiresAt ? html`<p>到期 ${item.expiresAt}</p>` : ''}
    </section>
    ${owner || reviewer ? html`<form class="login" method="post" action="${path}/edit" enctype="multipart/form-data">
      ${revisionForm(item.revision)}${memoryBodyForm(item)}<button>保存修改</button></form>
      <form method="post" action="${path}/remove">${revisionForm(item.revision)}<button class="secondary">删除记忆</button></form>` : ''}
    ${item.status === 'candidate' && (item.scope === 'user_private' ? owner : reviewer) ? html`
      <form method="post" action="${path}/publish">${revisionForm(item.revision)}
        <button>${item.scope === 'user_private' ? '启用记忆' : '审核发布'}</button></form>` : ''}
    <p><a href="${memoriesPath}">返回记忆中心</a></p>`))
  })
  app.post(memoriesPath + '/:id/edit', async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    const form = await c.req.parseBody()
    return redirectAfter(c, store.update(user, id, parse(revisionInput, form.revision), parse(editMemoryInput, formMemory(form))), memoriesPath + '/' + id)
  })
  app.post(memoriesPath + '/:id/publish', async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    return redirectAfter(c, store.publish(user, id, parse(revisionInput, (await c.req.parseBody()).revision)), memoriesPath + '/' + id)
  })
  app.post(memoriesPath + '/:id/remove', async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    return redirectAfter(c, store.remove(user, id, parse(revisionInput, (await c.req.parseBody()).revision)), memoriesPath)
  })

  app.get(knowledgePath, async c => {
    const user = await actor(c, false)
    const search = searchForm(knowledgePath + '/search', '检索已发布的企业知识')
    const admin = user.roles.includes('platform_admin')
    if (!isReviewer('project_private', user.roles)) return c.html(page('企业知识库', search))
    const [scopes, items] = await Promise.all([store.availableScopes(user), store.listKnowledge(user)])
    return c.html(page('企业知识库', html`${search}
      ${scopes.projects.length ? knowledgeImportForm(scopes.projects) : ''}
      <section><h2>可维护的知识</h2>${items.length ? html`<ul>${items.map(item => html`
        <li><a href="${knowledgePath}/${item.id}/edit">${item.title}</a> · ${scopeNames[item.scope]} · ${item.status === 'ready' ? '已发布' : '待发布'}</li>
      `)}</ul>` : html`<p>暂无知识条目。</p>`}</section>
      ${admin ? html`<h2>登记知识</h2>${knowledgeForm(knowledgePath + '/new', scopes)}` : ''}`))
  })
  app.use(knowledgePath + '/import', limitKnowledgeUpload)
  app.post(knowledgePath + '/import', async c => {
    const user = await actor(c, false)
    const result = await store.importProjectKnowledge(user, await readKnowledgeUpload(c.req.raw))
    const created = result.items.filter(item => item.created).length
    return c.html(page('项目资料导入结果', html`<section>
      <p>新增 ${created} 份待发布资料，已有资料 ${result.items.length - created} 份。</p>
      <ul>${result.items.map(({ document }) => html`<li>
        <a href="${knowledgePath}/${document.id}/edit">${document.title}</a>
        · ${document.status === 'ready' ? '已发布' : '待发布'} · 修订 ${document.revision}
      </li>`)}</ul></section><p><a href="${knowledgePath}">返回企业知识库</a></p>`), created ? 201 : 200)
  })
  app.post(knowledgePath + '/search', async c => {
    const user = await actor(c, false)
    const input = parse(searchInput, { query: (await c.req.parseBody()).query })
    const result = await store.searchKnowledge(user, input)
    return c.html(page('知识检索结果', html`${searchForm(knowledgePath + '/search', '检索已发布的企业知识', input.query)}
      ${knowledgeResults(result.items)}<a href="${knowledgePath}">返回企业知识库</a>`))
  })
  app.post(knowledgePath + '/new', async c => {
    const user = await actor(c, false)
    const item = await store.createKnowledge(user, parse(newKnowledgeInput, formKnowledge(await c.req.parseBody())))
    return c.redirect(knowledgePath + '/' + item.id + '/edit', 303)
  })
  app.get(knowledgePath + '/:id', async c => {
    const user = await actor(c, false)
    const item = await store.getKnowledge(user, parse(z.uuid(), c.req.param('id')), parse(revisionInput.optional(), c.req.query('revision')))
    return c.html(page(item.title, html`<section><p>出处 ${sourceLink(item)} · 修订 ${item.revision}</p>
      ${importedSource(item)}
      <label>正文<textarea rows="12" cols="36" readonly>${item.body}</textarea></label>
      <p>内容校验值</p><code>${item.citation.checksum}</code></section><a href="${knowledgePath}">返回企业知识库</a>`))
  })
  app.get(knowledgePath + '/:id/edit', async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    const [scopes, item] = await Promise.all([store.availableScopes(user), store.getManagedKnowledge(user, id)])
    const path = knowledgePath + '/' + id
    return c.html(page('维护知识', html`<p>修订 ${item.revision} · ${item.status === 'ready' ? '已发布' : '待发布'}</p>
      ${importedSource(item)}
      ${knowledgeForm(path + '/edit', scopes, item, Boolean(item.source.file) || !user.roles.includes('platform_admin'))}
      ${item.status === 'draft' ? html`<form method="post" action="${path}/publish">${revisionForm(item.revision)}<button>发布知识</button></form>` : ''}
      <form method="post" action="${path}/remove">${revisionForm(item.revision)}<button class="secondary">删除知识</button></form>
      <p><a href="${knowledgePath}">返回企业知识库</a></p>`))
  })
  app.post(knowledgePath + '/:id/edit', async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    const form = await c.req.parseBody()
    return redirectAfter(c, store.updateKnowledge(user, id, parse(revisionInput, form.revision), parse(editKnowledgeInput, formKnowledge(form))),
      knowledgePath + '/' + id + '/edit')
  })
  app.post(knowledgePath + '/:id/publish', async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    return redirectAfter(c, store.publishKnowledge(user, id, parse(revisionInput, (await c.req.parseBody()).revision)), knowledgePath + '/' + id + '/edit')
  })
  app.post(knowledgePath + '/:id/remove', async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    return redirectAfter(c, store.removeKnowledge(user, id, parse(revisionInput, (await c.req.parseBody()).revision)), knowledgePath)
  })
}
