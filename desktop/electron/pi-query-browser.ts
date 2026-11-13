import { createHash } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { ToolResult } from './pi-client-tools'

type BrowserAction = { action: string, target?: string, text?: string }
type ElementRecord = { id: string, node: HTMLElement, label: string, action: 'click' | 'fill', searchOnEnter?: boolean }
type PageResult = { error?: string, loginRequired?: boolean, searchReady?: boolean, label?: string }

function httpUrl(value: string) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('网页地址无效')
  return url
}

function sameOrigin(value: string, origin: string) {
  try { return httpUrl(value).origin === origin } catch { return false }
}

// Runs in Chromium's isolated world. Keep this function self contained.
function queryPage(command: BrowserAction): unknown {
  const state = globalThis as typeof globalThis & { __piQueryControls?: ElementRecord[], __piQuerySearch?: HTMLInputElement }
  const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()
  const clip = (value: string | null | undefined, max = 120) => clean(value).slice(0, max)
  const visible = (node: Element) => node.getClientRects().length > 0
    && node.ownerDocument.defaultView?.getComputedStyle(node).visibility !== 'hidden'
  const pageAddress = new URL(location.href)
  const credential = /token|password|secret|ticket|session|(?:^|[?#&])(?:code|sid|api[_-]?key)(?:=|$)/i
  for (const key of Array.from(pageAddress.searchParams.keys())) {
    if (credential.test(key)) pageAddress.searchParams.set(key, '…')
  }
  if (credential.test(pageAddress.hash)) pageAddress.hash = ''
  const documents: Document[] = []
  function visit(doc: Document) {
    documents.push(doc)
    if (documents.length >= 12) return
    for (const frame of Array.from(doc.querySelectorAll('iframe,frame')).slice(0, 12)) {
      if (documents.length >= 12) break
      if (!visible(frame)) continue
      const child = (frame as HTMLIFrameElement).contentDocument
      if (child) visit(child)
    }
  }
  visit(document)
  const login = documents.some(doc => Array.from(doc.querySelectorAll('input[type=password]')).some(visible))
  if (login) {
    state.__piQueryControls = []
    return { loginRequired: true }
  }
  const writeLabel = /删除|新增|编辑|修改|保存|提交|作废|审核|审批|驳回|确认出库|手工出库|补出库|推送|下推|生成|发送|支付|结算|导入|上传|禁用|启用|执行|关单|关闭订单|登出|退出|\b(?:delete|remove|new|edit|save|submit|approve|reject|pay|send|sign out|upload|import|execute)\b/i
  const writeAddress = /\b(?:delete|remove|edit|approve|save|submit|logout|create|disable|enable)\b/i
  const queryLabel = /查询|搜索|筛选|检索|查找|查看|详情|明细|列表|下一页|上一页|展开|收起|更多|高级|刷新|联查|上查|下查|^关闭$|\b(?:search|filter|find|details|view|next|previous|expand|refresh)\b/i
  const queryField = /查询|搜索|筛选|关键字|关键词|单号|编号|订单号|单据号|组织|期间|日期|search|filter|keyword|query|order.?no/i
  const semanticControl = 'a[href],button,input,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=treeitem],[aria-expanded]'
  const isKingdee = /^\/ierp(?:\/|$)/i.test(pageAddress.pathname)
  const entryLabel = (label: string) => /^(?:全部应用|应用中心|供应链云|采购管理|采购执行订单处理(?:[（(]采购订单处理[）)])?|采购订单(?:处理|列表)?|采购收货处理|采购收货单(?:列表)?)$/.test(label.replace(/\s+/g, ''))
  const labelOf = (node: HTMLElement) => {
    const input = node as HTMLInputElement
    return clean(node.getAttribute('aria-label') || node.getAttribute('title') || input.placeholder
      || Array.from(input.labels ?? [], label => label.textContent).join(' ') || node.innerText || node.getAttribute('name') || node.id)
  }
  const usable = (node: HTMLElement) => visible(node) && !node.matches(':disabled,[aria-disabled=true]')
    && !node.closest('[inert],[aria-hidden=true]')

  function canSearch(input: HTMLInputElement) {
    if (!['search', 'text'].includes(input.type) || input.readOnly || input.closest('dialog,[role=dialog],[role=alertdialog]')) return false
    const kingdeeLookup = isKingdee && /^搜索(?:单据编号|单据号|单号|订单号)(?:[\/／、\s]|$)/.test(clean(input.placeholder))
    if (input.type !== 'search' && input.getAttribute('role') !== 'searchbox' && !kingdeeLookup) return false
    const form = input.form
    if (!form) return true
    if (form.method !== 'get' || (form.target && form.target !== '_self') || (form.getAttribute('role') !== 'search' && !kingdeeLookup)) return false
    const url = new URL(form.action, input.ownerDocument.URL)
    if (url.origin !== location.origin || writeAddress.test(url.pathname + url.search + url.hash)) return false
    return Array.from(form.elements).every(control => {
      if (control === input) return true
      return control.matches('button[type=submit],button:not([type]),input[type=submit]')
        && !control.matches('[formaction],[formmethod],[formtarget]')
        && /^(?:搜索|查询|检索|查找|search|find)$/i.test(clean(control.getAttribute('value')) || labelOf(control as HTMLElement))
    })
  }

  const pendingSearch = state.__piQuerySearch
  state.__piQuerySearch = undefined
  const focusedSearch = (input: HTMLInputElement) => input.isConnected && usable(input) && canSearch(input)
    && input.ownerDocument.hasFocus() && input.ownerDocument.activeElement === input
  if (command.action === 'confirm_search') {
    if (!pendingSearch || !focusedSearch(pendingSearch) || pendingSearch.value !== command.text) return { searchReady: false }
    // Chromium can discard keyboard input until the new page has rendered a frame.
    return new Promise(resolve => {
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          clearTimeout(timeout)
          resolve({ searchReady: focusedSearch(pendingSearch) && pendingSearch.value === command.text })
        })
      })
      const timeout = setTimeout(() => {
        cancelAnimationFrame(frame)
        resolve({ searchReady: false })
      }, 1_000)
    })
  }

  function kingdeeEntries(doc: Document) {
    const entries = new Set<HTMLElement>()
    if (!isKingdee || !doc.body) return entries
    const textNodes = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    for (let scanned = 0; scanned < 5000 && entries.size < 16; scanned++) {
      const text = textNodes.nextNode()
      if (!text) break
      if (!/采购|应用|供应链/.test(text.nodeValue ?? '')) continue
      // Kingdee home tiles can be styled divs or spans. Keep this exception scoped to known navigation labels.
      for (let node = text.parentElement, depth = 0; node && node !== doc.body && depth < 4; node = node.parentElement, depth++) {
        if (node.closest('form,[role=dialog],table,[role=grid],[role=table]')) break
        const control = node.closest(semanticControl)
        if (control && control !== node) continue
        const style = doc.defaultView?.getComputedStyle(node)
        const pointerEntry = style?.cursor === 'pointer' && node.parentElement
          && doc.defaultView?.getComputedStyle(node.parentElement).cursor !== 'pointer'
        if ((control || pointerEntry) && usable(node) && entryLabel(labelOf(node))
          && ![node.getAttribute('title'), node.getAttribute('aria-label'), node.innerText]
            .some(label => label && writeLabel.test(label) && !entryLabel(label))) entries.add(node)
        if (control || pointerEntry) break
      }
    }
    return entries
  }

  const controls: ElementRecord[] = []
  for (const doc of documents) {
    const entries = kingdeeEntries(doc)
    const semantic = Array.from(doc.querySelectorAll<HTMLElement>(semanticControl)).slice(0, 1600)
    for (const node of new Set([...entries, ...semantic])) {
      if (controls.length >= 42) break
      if (!usable(node)) continue
      const input = node as HTMLInputElement
      const label = labelOf(node)
      const isEntry = entries.has(node)
      if (!label || (!isEntry && writeLabel.test(label))) continue
      let action: ElementRecord['action'] | undefined
      let searchOnEnter = false
      if (node.tagName === 'INPUT' || node.tagName === 'SELECT') {
        const tagType = input.type || 'text'
        const queryArea = node.closest('form[role=search],[role=search],.search,.query,.filter,[class*=search],[class*=filter],[id*=query]')
        searchOnEnter = node.tagName === 'INPUT' && canSearch(input)
        if (['search', 'text', 'number', 'date', 'select-one'].includes(tagType) && !input.readOnly
          && (searchOnEnter || tagType === 'search' || queryField.test(label) || queryArea)) action = 'fill'
      } else if (node.tagName === 'A') {
        const href = (node as HTMLAnchorElement).href
        if (!URL.canParse(href, doc.URL)) continue
        const url = new URL(href, doc.URL)
        const navigation = node.closest('nav,[role=navigation],[role=tree],[role=menu]')
        if (url.origin === location.origin && ['http:', 'https:'].includes(url.protocol)
          && (isEntry || navigation || queryLabel.test(label) || /^[A-Z]{2,}[A-Z0-9]*-[A-Z\d-]{3,}$/i.test(label))
          && !writeAddress.test(url.pathname + url.search + url.hash)
          && !node.hasAttribute('download')) action = 'click'
      } else if (isEntry || queryLabel.test(label) || ['tab', 'treeitem'].includes(node.getAttribute('role') ?? '')
        || (node.getAttribute('role') === 'menuitem' && node.closest('nav,[role=navigation]'))) {
        action = 'click'
      }
      if (action) controls.push({ id: `e${controls.length + 1}`, node, label, action, ...(searchOnEnter ? { searchOnEnter } : {}) })
    }
  }
  if (command.action === 'inspect') {
    state.__piQueryControls = controls
    const tables: { name: string, rows: string[][] }[] = []
    let tableBudget = 3800
    let truncated = controls.length >= 42
    for (const table of documents.flatMap(doc => Array.from(doc.querySelectorAll<HTMLElement>('table,[role=grid],[role=table]'))).filter(visible).slice(0, 5)) {
      const name = clip(table.getAttribute('aria-label') || table.querySelector('caption')?.textContent, 80)
      const rows: string[][] = []
      const candidates = Array.from(table.querySelectorAll<HTMLElement>('tr,[role=row]')).filter(visible)
      for (const row of candidates.slice(0, 20)) {
        const cells = Array.from(row.querySelectorAll<HTMLElement>('th,td,[role=columnheader],[role=gridcell],[role=cell]'))
          .slice(0, 24).map(cell => clip(cell.innerText, 96))
        tableBudget -= JSON.stringify(cells).length + 1
        if (tableBudget < 0) break
        if (cells.length) rows.push(cells)
      }
      truncated ||= candidates.length > rows.length
      if (rows.length) tables.push({ name, rows })
      if (tableBudget < 0) break
    }
    const pageText = documents.map(doc => doc.body?.innerText ?? '').join('\n').trim()
    return {
      url: pageAddress.href.slice(0, 600), title: clip(document.title),
      controls: controls.map(({ id, action, label, searchOnEnter }) => ({ id, action, label: clip(label, 72), searchOnEnter })),
      tables, text: clip(pageText, 1800), truncated: truncated || pageText.length > 1800,
    }
  }
  if (command.action === 'scroll') {
    window.scrollBy(0, command.target === 'up' ? -640 : 640)
    state.__piQueryControls = []
    return { ok: true }
  }
  const previous = state.__piQueryControls?.find(entry => entry.id === command.target)
  const search = command.action === 'search'
  const expectedAction = search ? 'fill' : command.action
  const live = previous && controls.find(entry => entry.node === previous.node && entry.action === expectedAction && entry.label === previous.label)
  if (!live) return { error: '请重新读取网页，并选择当前可查询的控件' }
  state.__piQueryControls = []
  const node = live.node
  if (search) {
    if (!previous?.searchOnEnter || !live.searchOnEnter) return { error: '请使用带有回车搜索标记的查询框' }
    const input = node as HTMLInputElement
    input.focus({ preventScroll: true })
    if (!focusedSearch(input)) return { error: '搜索框未获得焦点，请重新读取页面' }
    input.select()
    state.__piQuerySearch = input
    return { searchReady: true, label: clip(live.label, 72) }
  }
  if (command.action === 'click') {
    const link = node as HTMLAnchorElement
    if (node.tagName === 'A' && link.target === '_blank') node.ownerDocument.defaultView?.location.assign(link.href)
    else node.click()
    return { ok: true, label: clip(live.label, 72) }
  }
  const win = node.ownerDocument.defaultView as (Window & typeof globalThis) | null
  if (!win) return { error: '查询控件已失效' }
  const value = command.text ?? ''
  if (node.tagName === 'SELECT') {
    const select = node as HTMLSelectElement
    const option = Array.from(select.options).find(item => !item.disabled && (item.value === value || clip(item.text) === value))
    if (!option) return { error: '该筛选项没有对应选项' }
    select.value = option.value
  } else {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set
    if (!setter) return { error: '无法填写该查询字段' }
    setter.call(node, value)
  }
  node.dispatchEvent(new win.Event('input', { bubbles: true }))
  node.dispatchEvent(new win.Event('change', { bubbles: true }))
  return { ok: true, label: clip(live.label, 72) }
}

export function createQueryBrowser() {
  const windows = new Map<string, BrowserWindow>()

  async function open(url: URL, signal?: AbortSignal, resume = false) {
    signal?.throwIfAborted()
    let win = windows.get(url.origin)
    if (!win || win.isDestroyed()) {
      if (windows.size >= 6) throw new Error('请先关闭不使用的网页连接')
      const partition = 'persist:pi-query-' + createHash('sha256').update(url.origin).digest('hex').slice(0, 22)
      win = new BrowserWindow({
        title: 'Pi 网页查询', width: 1180, height: 800,
        webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
      })
      windows.set(url.origin, win)
      const contents = win.webContents
      const allowed = (value: string) => sameOrigin(value, url.origin)
      contents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false))
      contents.session.setPermissionCheckHandler(() => false)
      contents.session.removeAllListeners('will-download')
      contents.session.on('will-download', event => event.preventDefault())
      contents.on('will-navigate', (event, value) => { if (!allowed(value)) event.preventDefault() })
      contents.on('will-redirect', (event, value) => { if (!allowed(value)) event.preventDefault() })
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.on('closed', () => windows.delete(url.origin))
    }
    const currentUrl = win.webContents.getURL()
    if (currentUrl !== url.href && !(resume && sameOrigin(currentUrl, url.origin))) {
      const current = win
      const abort = () => { if (!current.isDestroyed()) current.webContents.stop() }
      const timer = setTimeout(abort, 20_000)
      signal?.addEventListener('abort', abort, { once: true })
      try { await win.loadURL(url.href) }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    }
    signal?.throwIfAborted()
    if (win.isMinimized()) win.restore()
    win.show()
    return win
  }

  return {
    async showEnvironment(url: string) { await open(httpUrl(url)) },
    forTurn(environment: string | undefined, prompt: string, signal: AbortSignal) {
      const allowed = new Map<string, URL>()
      for (const text of [environment, ...(prompt.match(/https?:\/\/[^\s<>"'，。！？；）]+/g) ?? [])]) {
        if (!text) continue
        try { const url = httpUrl(text); allowed.set(url.href, url) } catch {}
      }
      const home = allowed.values().next().value
      if (!home) return undefined
      const origins = new Set(Array.from(allowed.values(), url => url.origin))
      let current = origins.size === 1 ? windows.get(home.origin) : undefined
      let inspectedUrl: string | undefined
      let busy = false
      return async (input: unknown): Promise<ToolResult> => {
        const failure = (text: string): ToolResult => ({ ok: false, text })
        if (!input || typeof input !== 'object') return failure('网页查询参数无效')
        if (busy) return failure('请等待上一个网页动作结束')
        signal.throwIfAborted()
        busy = true
        const { action, target, text } = input as BrowserAction
        try {
          if (action === 'open') {
            const url = target ? httpUrl(target) : home
            if (!allowed.has(url.href)) return failure('请打开用户已保存或本轮给出的网页地址，再从页面内查询')
            inspectedUrl = undefined
            current = await open(url, signal, !target)
            return { ok: true, text: '已打开网页，请读取当前页面。' }
          }
          if (!current || current.isDestroyed()) return failure('请先打开已连接的网页')
          const currentUrl = current.webContents.getURL()
          if (!Array.from(origins).some(origin => sameOrigin(currentUrl, origin))) return failure('当前页不在本轮已连接的站点范围内')
          if (action === 'back') {
            inspectedUrl = undefined
            const history = current.webContents.navigationHistory
            if (history.canGoBack()) history.goBack()
            return { ok: true, text: '已返回，请重新读取页面。' }
          }
          const search = action === 'search'
          const fillsText = action === 'fill' || search
          const needsReference = action === 'click' || fillsText
          if (!['inspect', 'click', 'fill', 'search', 'scroll'].includes(action)
            || (needsReference && (typeof target !== 'string' || !/^e[1-9]\d{0,2}$/.test(target)))
            || (fillsText && (typeof text !== 'string' || text.length > 400 || /[\x00-\x1f]/.test(text)))
            || (search && !text?.trim())) {
            return failure('网页查询参数无效')
          }
          if (needsReference && inspectedUrl !== currentUrl) return failure('请先读取当前页，再使用本次读取给出的控件引用')
          inspectedUrl = undefined
          const contents = current.webContents
          const runPage = (command: BrowserAction) => contents.executeJavaScriptInIsolatedWorld(1359, [{
            code: `(${queryPage.toString()})(${JSON.stringify(command)})`,
          }]) as Promise<PageResult>
          if (search) {
            if (current.isMinimized()) current.restore()
            current.focus()
            contents.focus()
          }
          const result = await runPage({ action, target, text })
          signal.throwIfAborted()
          if (result?.loginRequired) return failure('该环境需要登录。请在打开的查询窗口完成登录，然后继续原对话。')
          if (result?.error) return failure(result.error)
          if (search) {
            if (!result?.searchReady || !current.isFocused() || contents.getURL() !== currentUrl) return failure('搜索框已失去焦点，请重新读取页面')
            const query = text!.trim()
            await contents.insertText(query)
            signal.throwIfAborted()
            const check = await runPage({ action: 'confirm_search', text: query })
            signal.throwIfAborted()
            if (!check?.searchReady || !current.isFocused() || contents.getURL() !== currentUrl) return failure('搜索框已切换或未接收完整内容，请重新读取页面')
            contents.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Return' })
            contents.sendInputEvent({ type: 'char', keyCode: '\r' })
            contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
            return { ok: true, text: JSON.stringify({ enterSent: true, label: result.label, next: '请重新读取列表核对筛选结果。' }) }
          }
          if (action === 'inspect') inspectedUrl = currentUrl
          return { ok: true, text: JSON.stringify(result) }
        } catch (error) {
          signal.throwIfAborted()
          return failure(error instanceof Error && error.message === '请先关闭不使用的网页连接' ? error.message : '网页尚未完成加载或查询控件不可用，请重新读取。')
        } finally { busy = false }
      }
    },
    close() {
      for (const win of windows.values()) if (!win.isDestroyed()) win.destroy()
      windows.clear()
    },
  }
}
