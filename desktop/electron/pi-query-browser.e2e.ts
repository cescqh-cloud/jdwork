import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { app, BrowserWindow } from 'electron'
import { createQueryBrowser } from './pi-query-browser'

// Bundle this entry for Node with Electron external and run it in Electron with a disposable profile.
const [profile, report] = process.argv.slice(2)
assert.ok(profile && report, 'Pass a temporary profile path and a report path')
app.setPath('userData', profile)
app.on('window-all-closed', () => {})

const home = `<!doctype html><meta charset="utf-8"><title>星瀚测试页</title>
<nav>
  <div data-entry="orders" style="cursor:pointer"><span>采购执行订单处理</span><span>（采购订单处理）</span></div>
  <div data-entry="receipts" style="cursor:pointer"><span>采购收货处理</span></div>
  <div data-entry="write" style="cursor:pointer">执行</div>
  <a href="javascript:void(0)">采购订单列表</a>
  <span>采购订单</span>
</nav>
<button>提交审批</button>
<output id="scroll-state">顶部</output><div style="height:1600px"></div>
<script>
document.querySelector('[data-entry=orders]').onclick = () => location.assign('/ierp/orders');
window.addEventListener('scroll', () => document.querySelector('#scroll-state').textContent = scrollY > 0 ? '已向下滚动' : '顶部');
</script>`

const orders = `<!doctype html><meta charset="utf-8"><title>采购订单列表</title>
<label>单据编号<input></label><button id="query">查询</button>
<button id="save">保存</button><output id="result"></output>
<div role="grid" aria-label="采购订单"><div role="row"><span role="columnheader">单据编号</span><span role="columnheader">状态</span></div></div>
<script>
document.querySelector('#query').onclick = () => {
  if (document.querySelector('input').value !== 'TEST-PO-0001') return;
  document.querySelector('[role=grid]').insertAdjacentHTML('beforeend',
    '<div role="row"><span role="gridcell">TEST-PO-0001</span><span role="gridcell">已审核</span></div>');
};
document.querySelector('#save').onclick = () => document.querySelector('#result').textContent = 'BUSINESS_WRITE';
</script>`

const receipts = `<!doctype html><meta charset="utf-8"><title>采购收货单列表</title>
<input id="quick-search" placeholder="搜索单据编号/供货供应商/物料编码/收货组织.名称">
<form method="post" action="/ierp/save">
  <input type="search" placeholder="搜索备注"><button>保存</button>
</form>
<output id="fixture-trace"></output>
<div role="grid" aria-label="采购收货单">
  <div role="row"><span role="columnheader">单据编号</span><span role="columnheader">状态</span></div>
  <div role="row" data-number="TEST-RCV-0001"><span role="gridcell">TEST-RCV-0001</span><span role="gridcell">已审核</span></div>
  <div role="row" data-number="TEST-RCV-0002"><span role="gridcell">TEST-RCV-0002</span><span role="gridcell">已收货</span></div>
</div>
<script>
const box = document.querySelector('#quick-search');
let searchValue = '';
const trace = [];
function log(event) {
  trace.push([event.type, event.key, event.keyCode, event.isTrusted, event.target.id]);
  document.querySelector('#fixture-trace').textContent = JSON.stringify(trace.slice(-8));
}
for (const name of ['keydown', 'keypress', 'keyup', 'input']) document.addEventListener(name, log, true);
box.addEventListener('input', event => {
  if (event.isTrusted) searchValue = box.value;
  if (box.value === 'TEST-MOVE-FOCUS') document.querySelector('form button').focus();
});
box.addEventListener('keydown', event => {
  if (!event.isTrusted || event.key !== 'Enter' || document.activeElement !== box) return;
  setTimeout(() => {
    for (const row of document.querySelectorAll('[data-number]')) row.hidden = row.dataset.number !== searchValue;
  }, 60);
});
</script>`

let saveRequests = 0
const site = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (req.url === '/ierp/orders') res.end(orders)
  else if (req.url === '/ierp/receipts') res.end(receipts)
  else if (req.url === '/ierp/login.html') res.end('<input name="account"><input type="password"><button>登录</button>')
  else if (req.url === '/ierp/save') { saveRequests++; res.end('BUSINESS_WRITE') }
  else res.end(home)
})

type Page = { title: string, controls: { id: string, label: string, action: 'click' | 'fill', searchOnEnter?: boolean }[], tables: { rows: string[][] }[], text: string }
type Turn = NonNullable<ReturnType<ReturnType<typeof createQueryBrowser>['forTurn']>>

async function inspect(turn: Turn): Promise<Page> {
  const result = await turn({ action: 'inspect' })
  assert.ok(result.ok, result.text)
  return JSON.parse(result.text) as Page
}

async function run() {
  await app.whenReady()
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve))
  const address = site.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}/ierp/?formId=home_page`
  const loginUrl = new URL('/ierp/login.html', url).href
  const browser = createQueryBrowser()
  const passed: string[] = []
  try {
    const signal = AbortSignal.timeout(25_000)
    const turn = browser.forTurn(url, '打开采购订单列表', signal)!
    assert.ok((await turn({ action: 'open' })).ok)
    assert.ok((await turn({ action: 'scroll' })).ok)
    let scrolled = await inspect(turn)
    for (let attempt = 0; !scrolled.text.includes('已向下滚动') && attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      scrolled = await inspect(turn)
    }
    assert.ok(scrolled.text.includes('已向下滚动'))
    assert.ok((await turn({ action: 'scroll', target: 'up' })).ok)
    const landing = await inspect(turn)
    const entry = landing.controls.find(control => control.label.replace(/\s/g, '') === '采购执行订单处理（采购订单处理）')
    assert.ok(entry, 'The custom purchase-order menu entry must have a click reference')
    assert.ok(landing.controls.some(control => control.label === '采购收货处理'))
    for (const label of ['执行', '提交审批', '采购订单列表', '采购订单']) {
      assert.ok(!landing.controls.some(control => control.label === label), `Unexpected click reference for ${label}`)
    }
    assert.ok((await turn({ action: 'click', target: entry.id })).ok)
    passed.push('Custom navigation exposed, write controls and inert text excluded')

    // Wait for the actual navigation instead of assuming that HTMLElement.click() completed it.
    let list = await inspect(turn)
    for (let attempt = 0; list.title !== '采购订单列表' && attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      list = await inspect(turn)
    }
    assert.equal(list.title, '采购订单列表')
    const oldQuery = list.controls.find(control => control.label === '查询')
    assert.ok(oldQuery)

    const nextTurn = browser.forTurn(url, '按单据编号 TEST-PO-0001 查询', signal)!
    assert.equal((await nextTurn({ action: 'click', target: oldQuery.id })).ok, false, 'A new turn must inspect before using any reference')
    const resumed = await inspect(nextTurn)
    assert.equal(resumed.title, '采购订单列表', 'A new turn must resume the current page')
    assert.ok((await nextTurn({ action: 'open' })).ok)
    const orderList = await inspect(nextTurn)
    assert.equal(orderList.title, '采购订单列表', 'Implicit open must preserve the current page')
    passed.push('Browser retained across turns with fresh references')

    const number = orderList.controls.find(control => control.action === 'fill' && control.label === '单据编号')
    assert.ok(number)
    assert.ok((await nextTurn({ action: 'fill', target: number.id, text: 'TEST-PO-0001' })).ok)
    assert.equal((await nextTurn({ action: 'click', target: oldQuery.id })).ok, false, 'References are consumed by a page action')
    const filtered = await inspect(nextTurn)
    assert.ok(!filtered.controls.some(control => control.label === '保存'))
    const query = filtered.controls.find(control => control.label === '查询')
    assert.ok(query)
    assert.ok((await nextTurn({ action: 'click', target: query.id })).ok)
    const result = await inspect(nextTurn)
    assert.ok(result.tables.some(table => table.rows.some(row => row.join('|') === 'TEST-PO-0001|已审核')))
    assert.ok(!result.text.includes('BUSINESS_WRITE'))
    passed.push('Order number filled and matching row read from the result grid')

    const receiptsUrl = new URL('/ierp/receipts', url).href
    const receiptTurn = browser.forTurn(receiptsUrl, '按单据编号 TEST-RCV-0002 查询采购收货单', signal)!
    assert.ok((await receiptTurn({ action: 'open', target: receiptsUrl })).ok)
    const before = await inspect(receiptTurn)
    const quickSearch = before.controls.find(control => control.label.startsWith('搜索单据编号/'))
    assert.ok(quickSearch)
    assert.ok((await receiptTurn({ action: 'fill', target: quickSearch.id, text: 'TEST-RCV-0002' })).ok)
    const unfiltered = await inspect(receiptTurn)
    assert.ok(unfiltered.tables.some(table => table.rows.some(row => row[0] === 'TEST-RCV-0001')), 'Filling alone must leave the list unfiltered')
    const quick = unfiltered.controls.find(control => control.label.startsWith('搜索单据编号/'))
    assert.ok(quick?.searchOnEnter, 'The receipt quick-search field must support Enter')
    const writeField = unfiltered.controls.find(control => control.label === '搜索备注')
    assert.ok(writeField && !writeField.searchOnEnter, 'A search-shaped field in a write form must not expose Enter')
    assert.equal((await receiptTurn({ action: 'search', target: writeField.id, text: 'TEST-RCV-0002' })).ok, false)
    const ready = await inspect(receiptTurn)
    const search = ready.controls.find(control => control.searchOnEnter)!
    const testWindow = BrowserWindow.getAllWindows()[0]!
    const hostKeys: string[] = []
    testWindow.webContents.on('before-input-event', (_event, input) => hostKeys.push(input.key))
    const submitted = await receiptTurn({ action: 'search', target: search.id, text: 'TEST-RCV-0002' })
    assert.ok(submitted.ok, submitted.text)
    const visibleNumbers = (page: Page) => page.tables.flatMap(table => table.rows).map(row => row[0]).filter(value => value?.startsWith('TEST-RCV-'))
    let receiptsResult = await inspect(receiptTurn)
    for (let attempt = 0; visibleNumbers(receiptsResult).length !== 1 && attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      receiptsResult = await inspect(receiptTurn)
    }
    assert.deepEqual(visibleNumbers(receiptsResult), ['TEST-RCV-0002'], JSON.stringify({ hostKeys, text: receiptsResult.text }))
    const focusRace = receiptsResult.controls.find(control => control.searchOnEnter)!
    assert.equal((await receiptTurn({ action: 'search', target: focusRace.id, text: 'TEST-MOVE-FOCUS' })).ok, false, 'Do not send Enter after focus leaves the selected search box')
    assert.deepEqual(visibleNumbers(await inspect(receiptTurn)), ['TEST-RCV-0002'])
    assert.equal(saveRequests, 0)
    passed.push('Receipt quick search sends trusted input and Enter, filters the grid, and rejects unsafe targets')

    assert.ok((await receiptTurn({ action: 'back' })).ok)
    let previousPage = await inspect(receiptTurn)
    for (let attempt = 0; previousPage.title !== '采购订单列表' && attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      previousPage = await inspect(receiptTurn)
    }
    assert.equal(previousPage.title, '采购订单列表')
    passed.push('Scrolling changes the page position and back returns to the previous page')

    assert.equal((await nextTurn({ action: 'open', target: loginUrl })).ok, false, 'Do not allow arbitrary URLs on the configured origin')
    const loginTurn = browser.forTurn(loginUrl, '', signal)!
    assert.ok((await loginTurn({ action: 'open', target: loginUrl })).ok)
    const login = await loginTurn({ action: 'inspect' })
    assert.ok(!login.ok && login.text.includes('需要登录'))
    passed.push('Exact URL scope and login boundary enforced')
    return passed
  } finally {
    browser.close()
    site.closeAllConnections()
    await new Promise<void>(resolve => site.close(() => resolve()))
  }
}

run().then(async passed => {
  await writeFile(report, JSON.stringify({ passed }))
  app.exit(0)
}, async error => {
  await writeFile(report, JSON.stringify({ error: String(error) }))
  app.exit(1)
})
