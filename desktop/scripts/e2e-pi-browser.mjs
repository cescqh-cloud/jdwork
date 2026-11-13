import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

const executable = process.argv[2] && resolve(process.argv[2])
assert.ok(executable, 'Pass the packaged win-unpacked/PiWorkbench.exe path')
const withComputer = process.argv.includes('--computer')
const legacyProfileArg = process.argv.find(arg => arg.startsWith('--legacy-profile='))
const testRoot = join(tmpdir(), 'liyuan-workbench-tests')
await mkdir(testRoot, { recursive: true })
const profile = await mkdtemp(join(testRoot, 'browser-check-'))
const legacyProfile = legacyProfileArg && resolve(legacyProfileArg.slice('--legacy-profile='.length))
if (legacyProfile) {
  assert.ok(withComputer && legacyProfile.startsWith(join(testRoot, 'browser-check-')), 'Use only an isolated earlier browser-check fixture')
  await mkdir(join(profile, 'client-data'))
  await copyFile(join(legacyProfile, 'client-data', 'connections.dpapi'), join(profile, 'client-data', 'connections.dpapi'))
  await copyFile(join(legacyProfile, 'Local State'), join(profile, 'Local State')).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
}
const orders = new Map([
  ['QA-ORDER-001', ['已占用', '未生成释放记录', '已过磅', '未生成', '待出库']],
  ['QA-ORDER-002', ['已占用', '已释放', '未过磅', '未生成', '待出库']],
])
const detailVisits = []
const pendingTasks = []
let journey
let activeTool
let modelError
let blockedRouteVisits = 0
const nativeTitle = 'Liyuan fixture ' + randomUUID().slice(0, 8)
const evidencePath = join(profile, 'native-effect.txt')
const nativeValue = '-Liyuan fixture value'
let nativeWindow
let testApprover

function control(page, label, action) {
  const match = page.controls.find(item => item.label === label && item.action === action)
  assert.ok(match, `Could not find ${action} control ${label}`)
  return match.id
}

function* loginJourney() {
  yield { action: 'open' }
  const blocked = yield { action: 'inspect' }
  assert.match(blocked, /请在打开的查询窗口完成登录/)
  assert.doesNotMatch(blocked, /login-fixture-field/)
  return '请在打开的查询窗口完成登录。'
}

function* orderJourney() {
  const unauthorized = yield { action: 'open', target: origin + '/save-order' }
  assert.match(unauthorized, /用户已保存或本轮给出的网页地址/)
  const crossSite = yield { action: 'open', target: origin.replace('127.0.0.1', 'localhost') + '/orders' }
  assert.match(crossSite, /用户已保存或本轮给出的网页地址/)
  const evidence = []
  for (const [id, states] of orders) {
    yield { action: 'open' }
    let page = JSON.parse(yield { action: 'inspect' })
    assert.equal(page.title, '模拟星瀚销售订单')
    assert.equal(page.controls.some(item => /保存|提交|删除|外部/.test(item.label)), false)
    const stale = control(page, '查询', 'click')
    yield { action: 'fill', target: control(page, '销售订单号', 'fill'), text: id }
    const refused = yield { action: 'click', target: stale }
    assert.match(refused, /重新读取网页/)
    page = JSON.parse(yield { action: 'inspect' })
    yield { action: 'click', target: control(page, '查询', 'click') }
    page = JSON.parse(yield { action: 'inspect' })
    assert.deepEqual(page.tables[0].rows[1], [id, '查看订单详情'])
    yield { action: 'click', target: control(page, '查看订单详情', 'click') }
    const detail = JSON.parse(yield { action: 'inspect' })
    assert.equal(new URL(detail.url).searchParams.get('order'), id)
    assert.deepEqual(detail.tables[0].rows[1], [id, ...states])
    evidence.push(`${id}（${detail.title}） ${detail.tables[0].rows[1].slice(1).join('，')}`)
  }
  return evidence.join('\n')
}

function findControl(node, name) {
  if (!node || typeof node !== 'object') return undefined
  const id = node.ref_id ?? node.ref
  if (node.name === name && typeof id === 'string') return id
  for (const value of Object.values(node)) {
    if (typeof value === 'object') {
      const ref = findControl(value, name)
      if (ref) return ref
    }
  }
  return undefined
}

function* computerJourney() {
  const windows = JSON.parse(yield { action: 'windows' })
  const window = windows.find(item => item.title === nativeTitle)
  assert.ok(window, 'Native test window was not visible to the packaged component')
  const target = String(window.id ?? window.window_id)
  assert.match(target, /^w-[1-9]\d*$/)
  let snapshot = JSON.parse(yield { action: 'snapshot', target })
  const field = findControl(snapshot.tree, 'Fixture value')
  const stale = findControl(snapshot.tree, 'Apply fixture value')
  assert.ok(field && stale, 'Expected input and button in native fixture: ' + JSON.stringify(snapshot.tree).slice(0, 1800))
  const picture = yield { action: 'screenshot', target }
  assert.ok(picture.image, 'The selected image-capable model did not receive the window screenshot')
  const match = /^data:image\/jpeg;base64,(.+)$/.exec(picture.image)
  assert.ok(match)
  const bytes = Buffer.from(match[1], 'base64')
  assert.ok(bytes.length > 1024 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
  writeFileSync(join(profile, 'fixture-screenshot.jpg'), bytes)
  yield { action: 'set_value', target: field, text: nativeValue }
  assert.match(yield { action: 'click', target: stale }, /最新快照/)
  snapshot = JSON.parse(yield { action: 'snapshot', target })
  assert.ok(JSON.stringify(snapshot.tree).includes(nativeValue), 'The actual Windows control did not receive the value')
  const apply = findControl(snapshot.tree, 'Apply fixture value')
  assert.ok(apply)
  yield { action: 'click', target: apply }
  snapshot = JSON.parse(yield { action: 'snapshot', target })
  assert.ok(JSON.stringify(snapshot.tree).includes('Applied ' + nativeValue), 'The native window did not confirm the click')
  return '已在 Windows 测试窗口完成截图、填写和点击。'
}

function modelReply(res, body) {
  assert.equal(body.model, 'pi-browser-fixture')
  assert.ok(body.tools.some(tool => tool.function.name === 'browser_query'))
  assert.equal(body.tools.some(tool => ['bash', 'mcp_connection'].includes(tool.function.name)), false)
  const last = body.messages.at(-1)
  const image = Array.isArray(last.content) ? last.content.find(part => part.type === 'image_url')?.image_url?.url : undefined
  if (last.role === 'user' && !image) {
    const task = pendingTasks.shift()
    assert.ok(task, 'Unexpected model call')
    activeTool = task.tool
    journey = task.script()
  }
  assert.ok(journey)
  assert.equal(body.tools.some(tool => tool.function.name === 'computer_use'), activeTool === 'computer_use')
  const output = typeof last.content === 'string' ? last.content : last.content.map(part => part.text ?? '').join('')
  const step = journey.next(image ? { image, text: output } : output)
  const delta = step.done
    ? { role: 'assistant', content: step.value }
    : { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${body.messages.length}`, type: 'function',
        function: { name: activeTool, arguments: JSON.stringify(step.value) } }] }
  const send = (delta, finish_reason) => res.write(`data: ${JSON.stringify({
    id: 'pi-browser-fixture', object: 'chat.completion.chunk', created: 1, model: 'pi-browser-fixture',
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`)
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  send(delta, null)
  send({}, step.done ? 'stop' : 'tool_calls')
  res.end('data: [DONE]\n\n')
}

const fixture = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin)
    if (url.pathname === '/v1/chat/completions') {
      let body = ''
      for await (const chunk of req) body += chunk
      modelReply(res, JSON.parse(body))
      return
    }
    if (url.pathname === '/fixture-login') {
      res.writeHead(302, { 'Set-Cookie': 'test_login=1; Path=/; HttpOnly; SameSite=Strict', Location: '/orders' }).end()
      return
    }
    if (url.pathname === '/save-order' || url.pathname === '/orders/delete') {
      blockedRouteVisits++
      res.writeHead(403).end()
      return
    }
    const html = (title, body) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(`<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>${body}`)
    if (!req.headers.cookie?.includes('test_login=1')) {
      html('模拟登录', '<form action="/fixture-login"><label>密码<input name="login-fixture-field" type="password"></label><button>登录</button></form>')
      return
    }
    const id = url.searchParams.get('order')
    const states = orders.get(id)
    if (url.pathname === '/detail' && states) {
      detailVisits.push(id)
      const fields = ['订单号', '预收占用', '预收释放', '过磅状态', '标准单', '出库']
      html('销售订单联查详情', `<table><caption>上下游状态</caption><tr>${fields.map(field => `<th>${field}</th>`).join('')}</tr>
        <tr>${[id, ...states].map(value => `<td>${value}</td>`).join('')}</tr></table>`)
      return
    }
    if (url.pathname === '/orders') {
      const result = states ? `<table><tr><th>订单号</th><th>操作</th></tr><tr><td>${id}</td>
        <td><a href="/detail?order=${id}" target="_blank">查看订单详情</a></td></tr></table>` : ''
      html('模拟星瀚销售订单', `<form action="/orders" role="search"><input name="order" placeholder="销售订单号"><button>查询</button></form>
        <button onclick="location.href='/save-order'">保存并提交</button>
        <a href="/orders/delete">查看并删除</a>
        <a href="${origin.replace('127.0.0.1', 'localhost')}/orders">查看外部站点</a>
        ${result}`)
      return
    }
    res.writeHead(404).end()
  } catch (error) {
    modelError = error
    res.writeHead(500).end()
  }
})
fixture.listen(0, '127.0.0.1')
await once(fixture, 'listening')
const origin = `http://127.0.0.1:${fixture.address().port}`
const processUnderTest = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--disable-background-networking'], {
  windowsHide: true, stdio: 'ignore',
})
const exited = once(processUnderTest, 'exit')
exited.catch(() => {})

async function waitFor(probe, message, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (modelError) throw modelError
    const result = await probe()
    if (result) return result
    if (processUnderTest.exitCode !== null) throw new Error(`Desktop exited with ${processUnderTest.exitCode}`)
    await pause(180)
  }
  throw new Error(message)
}

const sockets = []
const rendererErrors = []
try {
  const [port] = (await waitFor(
    () => readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => ''),
    'Packaged desktop did not start its isolated test inspection port',
  )).split('\n')
  const targets = () => fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
    .then(res => res.json()).catch(() => [])
  async function attach(predicate, name) {
    const target = await waitFor(async () => (await targets()).find(predicate), `Missing desktop page ${name}`)
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    sockets.push(socket)
    await once(socket, 'open', { signal: AbortSignal.timeout(12000) }).catch(error => {
      throw new Error(`Unable to attach to test window ${name}`, { cause: error })
    })
    let id = 0
    socket.addEventListener('message', event => {
      const frame = JSON.parse(event.data)
      if (frame.method === 'Runtime.exceptionThrown') {
        const details = frame.params.exceptionDetails
        rendererErrors.push(details.exception?.description ?? details.text)
      }
    })
    const command = async (method, params) => {
      const callId = ++id
      return new Promise((done, reject) => {
        const timer = setTimeout(() => { socket.removeEventListener('message', reply); reject(new Error('Desktop script timed out')) }, 25000)
        function reply(event) {
          const frame = JSON.parse(event.data)
          if (frame.id !== callId) return
          clearTimeout(timer)
          socket.removeEventListener('message', reply)
          if (frame.error || frame.result?.exceptionDetails) {
            reject(new Error(JSON.stringify(frame.error ?? frame.result.exceptionDetails)))
            return
          }
          done(frame.result.result?.value)
        }
        socket.addEventListener('message', reply)
        socket.send(JSON.stringify({ id: callId, method, params }))
      })
    }
    await command('Runtime.enable')
    return expression => command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  }
  const evaluate = await attach(item => item.url.endsWith('/desktop/'), 'workbench')
  await waitFor(() => evaluate("location.protocol === 'http:' && location.pathname === '/desktop/' && document.readyState === 'complete'"),
    'Workbench did not finish loading')
  const api = async (path, method = 'GET', body) => evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
      body: ${JSON.stringify(body === undefined ? undefined : JSON.stringify(body))}
    });
    if (!response.ok) throw Error('HTTP ' + response.status + ' ' + await response.text());
    return response.json();
  })()`)
  const auth = await api('/auth/config')
  assert.equal(auth.localClient, true)
  let settings = await api('/api/client/settings')
  if (withComputer) {
    assert.equal(await evaluate('document.title'), '力源金蝶研发工作台')
    if (legacyProfile) {
      assert.equal(settings.environment.name, '模拟星瀚')
      assert.equal(settings.models.default.imageInput, false)
      assert.equal(settings.models.default.hasKey, true)
      console.log('Legacy encrypted model and saved environment read successfully')
    } else {
      assert.equal(settings.environment.name, '星瀚 UAT')
      assert.equal(settings.environment.url, 'http://192.168.254.118:8022/ierp/')
    }
    assert.equal(settings.miniProgramApiUrl, 'https://unload.liyuan99.net/ext')
    assert.equal(settings.computerAvailable, true)
    assert.equal(settings.computerUse, false)
  }
  settings = await api('/api/client/settings', 'PUT', { section: 'model', revision: settings.revision, value: {
    scene: 'default', baseUrl: origin + '/v1', name: 'pi-browser-fixture', key: 'fake-fixture-key',
  } })
  assert.ok(settings.models.default.hasKey)
  assert.doesNotMatch(JSON.stringify(settings), /fake-fixture-key/)
  await api('/api/client/settings', 'PUT', { section: 'environment', revision: settings.revision, value: {
    name: '模拟星瀚', url: origin + '/orders',
  } })
  async function task(script, prompt, tool = 'browser_query') {
    pendingTasks.push({ script, tool })
    const before = new Set((await api('/api/tasks')).map(item => item.id))
    if (before.size) await evaluate("document.querySelector('.pi-sidebar nav .pi-nav-item').click(); true")
    await waitFor(() => evaluate("location.href.endsWith('/desktop/') && !!document.querySelector('.pi-composer textarea:not(:disabled)')"),
      'New task composer is unavailable').catch(async error => {
        const state = await evaluate("({ url: location.href, text: document.body.innerText.slice(0, 1200), resources: performance.getEntriesByType('resource').map(r => [new URL(r.name).pathname, r.responseStatus]) })")
        throw new Error(JSON.stringify({ message: error.message, state, rendererErrors }, null, 2))
      })
    await evaluate(`(() => {
      const input = document.querySelector('.pi-composer textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(prompt)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await waitFor(() => evaluate("!!document.querySelector('.pi-composer button[type=submit]:not(:disabled)')"),
      'The typed prompt did not enable Send')
    await evaluate("document.querySelector('.pi-composer button[type=submit]').click(); true")
    const submitted = await waitFor(async () => (await api('/api/tasks')).find(item => !before.has(item.id)),
      'The workbench did not submit the task')
    assert.equal(submitted.agentId, 'knowledge')
    const { id } = submitted
    const result = await waitFor(async () => {
      const record = await api('/api/tasks/' + id)
      return !['queued', 'running'].includes(record.status) && record
    }, 'The tool task did not finish', 60000)
    assert.equal(result.status, 'completed', JSON.stringify({ status: result.status, error: result.error }))
    assert.ok(result.tools.some(event => event.name === tool))
    return result.messages.at(-1).text
  }
  assert.match(await task(loginJourney, '请打开模拟星瀚查询销售订单'), /完成登录/)
  const login = await attach(item => item.url === origin + '/orders', 'fixture login')
  await login("document.querySelector('form').requestSubmit(); true")
  await waitFor(async () => (await targets()).find(item => item.title === '模拟星瀚销售订单'), 'Simulated login did not finish')
  const answer = await task(orderJourney, '请打开模拟星瀚，分别查询 QA-ORDER-001 和 QA-ORDER-002 的预收、过磅、标准单及出库状态。')
  assert.match(answer, /QA-ORDER-001[^\n]+未生成释放记录[^\n]+已过磅/)
  assert.match(answer, /QA-ORDER-002[^\n]+已释放[^\n]+未过磅/)
  await waitFor(() => evaluate("document.body.innerText.includes('未生成释放记录') && document.body.innerText.includes('未过磅')"),
    'The conversation did not display both evidence summaries')
  assert.deepEqual(detailVisits, [...orders.keys()])
  assert.equal(blockedRouteVisits, 0)
  console.log('Packaged client verified: manual login, two separate order queries, linked details, evidence returned, stale actions and unrelated routes denied')
  if (withComputer && !legacyProfile) {
    settings = await api('/api/client/settings')
    settings = await api('/api/client/settings', 'PUT', { section: 'model', revision: settings.revision, value: {
      scene: 'default', baseUrl: origin + '/v1', name: 'pi-browser-fixture', imageInput: true,
    } })
    assert.equal(settings.models.default.imageInput, true)
    const health = await api('/api/client/test', 'POST', { section: 'computer' })
    assert.equal(health.ok, true, health.text)
    settings = await api('/api/client/settings', 'PUT', { section: 'computer', revision: settings.revision, value: { enabled: true } })
    assert.equal(settings.computerUse, true)
    const fixtureFile = resolve('scripts/pi-computer-use-fixture.ps1')
    const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    function launchFixture(args) {
      const child = spawn(powershell, ['-NoProfile', '-Sta', '-File', fixtureFile, ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      let failure = ''
      child.stderr.on('data', chunk => { failure += chunk.toString() })
      child.once('error', error => { modelError = error })
      child.once('exit', (code, signal) => {
        if (code && !signal) modelError = Error('Native fixture failed: ' + failure)
      })
      return child
    }
    nativeWindow = launchFixture(['-Mode', 'Window', '-Title', nativeTitle, '-EvidencePath', evidencePath])
    testApprover = launchFixture(['-Mode', 'Approve', '-Title', '力源金蝶研发工作台工具确认', '-WorkbenchPid',
      String(processUnderTest.pid), '-ConfirmLabel', '允许这一步'])
    await pause(1400)
    assert.match(await task(computerJourney, `请用电脑操作查看测试窗口 ${nativeTitle}，按要求填写并点击测试按钮。`, 'computer_use'),
      /已在 Windows 测试窗口完成截图、填写和点击/)
    assert.equal(await readFile(evidencePath, 'utf8'), nativeValue)
    console.log('Packaged Computer Use verified: real Windows fixture discovered, screenshot received by mock model, native input and click confirmed independently')
  }
  await waitFor(() => readFile(join(profile, 'Local State'), 'utf8').catch(() => ''),
    'Chromium did not persist the encrypted profile metadata')
  console.log('Test profile: ' + profile)
} finally {
  for (const child of [testApprover, nativeWindow]) if (child?.exitCode === null) child.kill()
  for (const socket of sockets) socket.close()
  if (processUnderTest.exitCode === null) processUnderTest.kill()
  await exited.catch(() => {})
  fixture.closeAllConnections()
  await new Promise(done => fixture.close(done))
}
