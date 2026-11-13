import type { Env, Hono } from 'hono'
import { html } from 'hono/html'
import { z } from 'zod'
import { createReleaseInput, pauseInput, publishInput } from './contract'
import { parse, type ReleaseRoutesOptions } from './route-utils'

const base = '/console/releases'
const status = { DRAFT: '草稿', PUBLISHED: '已发布', PAUSED: '已暂停', WITHDRAWN: '已撤回' }
const channels = { stable: '稳定版', canary: '灰度版', dev: '研发版' }
const css = `.release-main{max-width:1080px}.release-main nav{display:flex;gap:1rem;margin:1rem 0;flex-wrap:wrap}
.release-form{display:grid;gap:.85rem}.release-form input,.release-form select,.release-form textarea{font:inherit;min-width:0;max-width:100%}
.release-form select,.release-form textarea{padding:.6rem;border:1px solid #8d9bab;border-radius:6px}.release-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:.9rem}
.release-main button{width:fit-content}.release-main label:has(input[type=checkbox]){display:flex;align-items:center;gap:.5rem}
.release-badge{display:inline-block;background:#e7f2ee;color:#174d39;border-radius:999px;padding:.15rem .55rem}.release-note{background:#fcf6e5;border-color:#e2ce97}
.release-main p{overflow-wrap:anywhere}.release-main summary{font-weight:600;cursor:pointer}.release-main details>div{padding:.75rem 0}
.release-main dl{display:grid;grid-template-columns:minmax(8rem,max-content) minmax(0,1fr);gap:.5rem .75rem}.release-main dt{font-weight:600}.release-main dd{margin:0;overflow-wrap:anywhere}`

const uploadJs = `
for (const form of document.querySelectorAll('form[data-release-upload]')) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const file = form.querySelector('input[type=file]')?.files?.[0];
    const button = form.querySelector('button');
    const status = form.querySelector('[role=status]');
    const url = form.dataset.releaseUpload;
    if (!file || !button || !status || !/^\\/api\\/v1\\/admin\\/releases\\/[0-9a-f-]{36}\\/(?:manifest|package)$/i.test(url)) return;
    button.disabled = true;
    status.textContent = '正在上传并校验，请保持页面打开。';
    try {
      const response = await fetch(url, { method: 'PUT', credentials: 'same-origin', redirect: 'error',
        headers: { 'Content-Type': url.endsWith('/manifest') ? 'application/yaml' : 'application/octet-stream' }, body: file });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message || '上传未完成，请核对文件或重新登录。');
      }
      location.reload();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : '上传未完成。';
      button.disabled = false;
    }
  });
}`

function layout(title: string, content: ReturnType<typeof html>, scripts = false) {
  return html`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} · 力源金蝶研发工作台</title><link rel="stylesheet" href="/console.css"><link rel="stylesheet" href="${base}/style.css">
  ${scripts ? html`<script src="${base}/upload.js" defer></script>` : ''}</head><body><main class="release-main">
  <header><a href="/">企业控制台</a><h1>${title}</h1><nav><a href="${base}">客户端版本</a><a href="${base}/new">新建发布草稿</a></nav></header>${content}</main></body></html>`
}

function options(name: string, label: string, items: Array<{ id: string, label: string }>) {
  return html`<label>${label}<select multiple size="5" name="${name}">${items.map(item => html`<option value="${item.id}">${item.label}</option>`)}</select></label>`
}

function arrayField(value: unknown) { return value === undefined ? [] : Array.isArray(value) ? value : [value] }

export function mountReleaseConsole<E extends Env>(app: Hono<E>, { service, actor }: ReleaseRoutesOptions) {
  app.get(`${base}/style.css`, c => c.text(css, 200, { 'Content-Type': 'text/css; charset=utf-8' }))
  app.get(`${base}/upload.js`, c => c.text(uploadJs, 200, { 'Content-Type': 'application/javascript; charset=utf-8' }))

  app.get(base, async c => {
    const user = await actor(c, false)
    const offset = parse(z.coerce.number().int().min(0).max(50_000).default(0), c.req.query('offset'))
    const { releases } = await service.store.list(user, 30, offset)
    return c.html(layout('客户端版本', html`<p>上传构建生成的清单和安装包，核对签名和测试记录后再发布。</p>
      <section><div class="table-scroll"><table><thead><tr><th>版本</th><th>渠道</th><th>架构</th><th>状态</th><th>灰度</th><th>升级回报</th></tr></thead>
      <tbody>${releases.map(item => html`<tr><td><a href="${base}/${item.id}">${item.version}</a></td><td>${channels[item.channel]}</td><td>${item.arch}</td>
        <td><span class="release-badge">${status[item.status]}</span></td><td>${item.rolloutPercent}%</td><td>${item.health.healthy} 正常 · ${item.health.failed} 失败</td></tr>`)}</tbody></table></div>
      ${releases.length ? '' : html`<p>当前组织还没有发布草稿。</p>`}</section>
      <nav>${offset ? html`<a href="${base}?offset=${Math.max(0, offset - 30)}">上一页</a>` : ''}
      ${releases.length === 30 ? html`<a href="${base}?offset=${offset + 30}">下一页</a>` : ''}</nav>`))
  })

  app.get(`${base}/new`, async c => {
    const user = await actor(c, false)
    const search = parse(z.string().trim().max(120), c.req.query('search') ?? '')
    const group = await service.store.audiences(user, search)
    return c.html(layout('新建发布草稿', html`<section><form method="get" action="${base}/new" class="release-form">
      <label>查找灰度对象（按姓名、账号或部门）<input name="search" value="${search}" maxlength="120"></label><button class="secondary">查找</button></form></section>
      <section><form method="post" action="${base}/new" class="release-form"><div class="release-grid">
        <label>Windows 版本号<input name="version" required maxlength="96" placeholder="如 0.7.8"></label>
        <label>架构<select name="arch"><option value="x64">x64</option><option value="arm64">arm64</option><option value="ia32">ia32</option></select></label>
        <label>发布渠道<select name="channel"><option value="canary">灰度版</option><option value="stable">稳定版</option><option value="dev">研发版</option></select></label>
        <label>覆盖比例 %<input type="number" name="rolloutPercent" value="10" min="0" max="100" required></label></div>
        <details><summary>指定灰度对象</summary><div class="release-grid">
          ${options('targetDeviceIds', '设备', group.devices.map(item => ({ id: item.id, label: `${item.name} · ${item.version} · ${item.id.slice(0, 8)}` })))}
          ${options('targetUserIds', '人员', group.users.map(item => ({ id: item.id, label: `${item.name} · ${item.login}` })))}
          ${options('targetDepartmentIds', '部门', group.departments.map(item => ({ id: item.id, label: item.name })))}</div>
          <p>有指定对象时，在这些对象中按设备分配比例。研发版需要指定对象。</p></details>
        <details><summary>最低支持版本和暂停阈值</summary><div class="release-grid">
          <label>最低支持版本<input name="minClientVersion" maxlength="96"></label>
          <label>最高已测试版本<input name="maxTestedVersion" maxlength="96"></label>
          <label>最少已回报设备<input type="number" name="failureMinSample" min="1" max="1000" value="3" required></label>
          <label>失败比例达到 % 时暂停<input type="number" name="failureThresholdPercent" min="1" max="100" value="40" required></label></div>
          <label><input type="checkbox" name="securityRequired" value="yes">因安全或协议原因要求更新</label></details>
        <button>保存草稿</button></form></section>`))
  })
  app.post(`${base}/new`, async c => {
    const user = await actor(c, false)
    const data = await c.req.parseBody({ all: true })
    const item = await service.store.create(user, parse(createReleaseInput, { platform: 'win32', version: data.version, arch: data.arch, channel: data.channel,
      rolloutPercent: Number(data.rolloutPercent), minClientVersion: data.minClientVersion || null, maxTestedVersion: data.maxTestedVersion || null,
      securityRequired: data.securityRequired === 'yes', failureMinSample: Number(data.failureMinSample), failureThresholdPercent: Number(data.failureThresholdPercent),
      targetDeviceIds: arrayField(data.targetDeviceIds), targetUserIds: arrayField(data.targetUserIds), targetDepartmentIds: arrayField(data.targetDepartmentIds) }))
    return c.redirect(`${base}/${item.id}`, 303)
  })

  app.get(`${base}/:id`, async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    const item = await service.store.detail(user, id)
    const path = `${base}/${id}`
    const upload = `/api/v1/admin/releases/${id}`
    const selectedCount = item.targetDeviceIds.length + item.targetUserIds.length + item.targetDepartmentIds.length
    return c.html(layout(`Windows ${item.version}`, html`<section><dl>
      <dt>发布状态</dt><dd><span class="release-badge">${status[item.status]}</span></dd><dt>渠道和架构</dt><dd>${channels[item.channel]} · ${item.arch}</dd>
      <dt>覆盖比例</dt><dd>${item.rolloutPercent}%</dd><dt>灰度对象</dt><dd>${selectedCount
        ? `${item.targetDeviceIds.length} 台设备 · ${item.targetUserIds.length} 人 · ${item.targetDepartmentIds.length} 个部门`
        : '全部已绑定设备'}</dd>
      <dt>最低支持版本</dt><dd>${item.minClientVersion ?? '未设置'}</dd><dt>最高已测试版本</dt><dd>${item.maxTestedVersion ?? '未设置'}</dd>
      <dt>测试记录</dt><dd>${item.testEvidence ?? '待发布时填写'}</dd>
      ${item.pauseReason ? html`<dt>暂停原因</dt><dd>${item.pauseReason === 'FAILURE_THRESHOLD_REACHED' ? '升级失败比例达到设置阈值' : item.pauseReason}</dd>` : ''}
      </dl></section>
      <section><h2>清单和安装包</h2>
        ${item.manifest ? html`<p>已核对清单 · ${item.manifest.name} · ${item.manifest.size} 字节</p><code>${item.manifest.sha256}</code>` : html`<p>请先上传构建输出的 latest.yml。</p>`}
        ${item.status === 'DRAFT' && !item.artifact ? html`<form class="release-form" data-release-upload="${upload}/manifest">
          <label>构建清单<input type="file" required accept=".yml,.yaml"></label><button class="secondary">上传 latest.yml</button><p role="status"></p></form>` : ''}
        ${item.artifact && item.signer ? html`<p>安装包已核验 · ${item.signer.publisher} · ${item.signer.kind === 'authenticode' ? 'Windows Authenticode' : '仅限本机的测试夹具'}</p>
          <p>安装包 SHA-256</p><code>${item.artifact.sha256}</code><p>签名证书 SHA-256</p><code>${item.signer.fingerprint}</code>`
          : item.manifest && item.status === 'DRAFT' ? html`<form class="release-form" data-release-upload="${upload}/package">
            <label>Windows 安装包<input type="file" required accept=".exe"></label><button>上传并核验安装包</button><p role="status"></p></form>` : ''}
      </section>
      ${item.artifact && item.status === 'DRAFT' ? html`<section class="release-note"><h2>核对测试后发布</h2>
        <p>确认已在目标 Windows 架构的测试设备上安装并启动。填写测试记录后发布到所选渠道。</p>
        <form class="release-form" method="post" action="${path}/publish"><input type="hidden" name="expectedRevision" value="${item.revision}">
          <label>测试记录或验收编号<textarea name="testEvidence" required minlength="3" maxlength="500"></textarea></label><button>确认发布</button></form></section>` : ''}
      ${item.status === 'PUBLISHED' ? html`<section><h2>暂停推广</h2><form class="release-form" method="post" action="${path}/pause">
        <input type="hidden" name="expectedRevision" value="${item.revision}"><label>暂停原因<input name="reason" required minlength="3" maxlength="250"></label>
        <button class="secondary">暂停发布</button></form></section>` : ''}
      <section><h2>设备更新回报</h2><p>已获得候选 ${item.health.offered} 台 · 已下载 ${item.health.downloaded} 台 · 已安装待确认 ${item.health.installed} 台 · 正常 ${item.health.healthy} 台 · 失败 ${item.health.failed} 台</p></section>`, item.status === 'DRAFT' && !item.artifact))
  })
  app.post(`${base}/:id/publish`, async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    const data = await c.req.parseBody()
    const input = parse(publishInput, { expectedRevision: Number(data.expectedRevision), testEvidence: data.testEvidence })
    await service.publish(user, id, input.expectedRevision, input.testEvidence)
    return c.redirect(`${base}/${id}`, 303)
  })
  app.post(`${base}/:id/pause`, async c => {
    const user = await actor(c, false)
    const id = parse(z.uuid(), c.req.param('id'))
    const data = await c.req.parseBody()
    const input = parse(pauseInput, { expectedRevision: Number(data.expectedRevision), reason: data.reason })
    await service.store.pause(user, id, input.expectedRevision, input.reason)
    return c.redirect(`${base}/${id}`, 303)
  })
}
