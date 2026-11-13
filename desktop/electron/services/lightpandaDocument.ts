import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { parse, type DefaultTreeAdapterMap } from 'parse5'

const MAX_SOURCE_BYTES = 512 * 1024
const MAX_SNAPSHOT_BYTES = 96 * 1024
const documentTags = new Set(['article', 'main', 'section', 'header', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'code', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'caption', 'thead', 'tbody',
  'tfoot', 'tr', 'th', 'td', 'br', 'hr', 'details', 'summary'])
const omittedTags = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'canvas', 'iframe', 'object', 'embed',
  'form', 'button', 'input', 'textarea', 'select', 'option', 'img', 'picture', 'audio', 'video', 'source', 'track', 'nav', 'aside',
  'footer', 'dialog', 'link', 'meta', 'base'])

const ipv4 = new BlockList()
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) ipv4.addSubnet(address, bits, 'ipv4')
const ipv6 = new BlockList()
for (const [address, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) ipv6.addSubnet(address, bits, 'ipv6')
const globalIpv6 = new BlockList()
globalIpv6.addSubnet('2000::', 3, 'ipv6')

export function isPublicDocumentAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !ipv4.check(address, 'ipv4') : family === 6 && globalIpv6.check(address, 'ipv6') && !ipv6.check(address, 'ipv6')
}

export function approvedDocumentUrl(value: string): string | undefined {
  if (value.length > 2048 || !/^https:\/\//iu.test(value) || /[\u0000-\u0020\u007f\\?#]/u.test(value)) return undefined
  try {
    const url = new URL(value)
    if (url.username || url.password || url.port ||
        /\/(?:ierp|erp|k3cloud|login|oauth2?)(?:[/.]|$)/iu.test(decodeURIComponent(url.pathname)) ||
        !url.hostname.includes('.') || url.hostname.endsWith('.') || isIP(url.hostname) || url.hostname.startsWith('[') ||
        /\.(?:local|localhost|internal|invalid|test|example)$/u.test(url.hostname)) return undefined
    return url.href
  } catch { return undefined }
}

type Node = DefaultTreeAdapterMap['node']
const children = (node: Node): Node[] => 'childNodes' in node ? node.childNodes : []
const escape = (text: string) => text.replace(/[&<>]/gu, symbol => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[symbol]!)

function first(root: Node, predicate: (node: Node) => boolean): Node | undefined {
  const queue = [root]
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]!
    if (predicate(node)) return node
    for (const child of children(node)) queue.push(child)
  }
}

function hidden(node: Node) {
  return 'attrs' in node && node.attrs.some(attr => attr.name === 'hidden' || (attr.name === 'aria-hidden' && attr.value === 'true') ||
    (attr.name === 'style' && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(attr.value)))
}

function plainNode(node: Node): string {
  return node.nodeName === '#text' && 'value' in node ? node.value : ''
}

/** Builds a fresh document from inert text and structural tags. No source attributes or active content survive. */
export function projectAnonymousHtml(input: string) {
  if (Buffer.byteLength(input, 'utf8') > MAX_SOURCE_BYTES) throw new Error('Document exceeds the anonymous reader limit')
  const document = parse(input, { scriptingEnabled: false })
  if (first(document, node => node.nodeName === 'input' && 'attrs' in node &&
    node.attrs.some(attr => attr.name === 'type' && attr.value.toLowerCase() === 'password'))) {
    throw new Error('The anonymous document requires an interactive session')
  }
  const titleNode = first(document, node => node.nodeName === 'title')
  const title = titleNode ? children(titleNode).map(plainNode).join('').replace(/\s+/gu, ' ').trim().slice(0, 240) : ''
  const source = first(document, node => node.nodeName === 'main' && !hidden(node)) ??
    first(document, node => node.nodeName === 'article' && !hidden(node)) ?? first(document, node => node.nodeName === 'body')
  let textBytes = 0
  function project(node: Node, depth: number): string {
    if (depth > 64 || omittedTags.has(node.nodeName) || hidden(node)) return ''
    const text = plainNode(node)
    if (text) {
      textBytes += Buffer.byteLength(text.trim(), 'utf8')
      return escape(text)
    }
    const tag = node.nodeName
    const content = children(node).map(child => project(child, depth + 1)).join('')
    if (!documentTags.has(tag)) return content
    if (tag === 'br' || tag === 'hr') return `<${tag}>`
    return `<${tag}>${content}</${tag}>`
  }
  const content = source ? project(source, 0) : ''
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title></head><body>${content}</body></html>`
  if (textBytes < 4 || Buffer.byteLength(html, 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error('No bounded static document content')
  return { html, title }
}

export function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason)
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}

/** A credential-free GET to the one selected URL. Redirects and DNS results outside the public address space are rejected. */
export async function fetchAnonymousDocument(url: string, signal: AbortSignal): Promise<string> {
  if (approvedDocumentUrl(url) !== url) throw new Error('Document address is not permitted')
  const target = new URL(url)
  const addresses = await untilAborted(lookup(target.hostname, { all: true }), signal)
  if (!addresses.length || addresses.some(entry => !isPublicDocumentAddress(entry.address))) throw new Error('Document host is not public')
  // Connect to the vetted address directly. The original DNS name still authenticates the TLS peer and HTTP origin.
  const address = addresses.find(entry => entry.family === 4) ?? addresses[0]!
  return new Promise((resolve, reject) => {
    const req = request({ hostname: address.address, port: 443, servername: target.hostname, path: target.pathname, method: 'GET',
      agent: false, signal, rejectUnauthorized: true, headers: { Host: target.hostname, Accept: 'text/html', 'Accept-Encoding': 'identity' } }, response => {
      const contentType = response.headers['content-type'] ?? ''
      const charset = /;\s*charset\s*=\s*"?([A-Za-z0-9-]+)/iu.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8'
      const encoding = response.headers['content-encoding']
      if (response.statusCode !== 200 || !/^text\/html(?:\s*;|$)/iu.test(contentType) || (encoding && encoding !== 'identity') ||
          !['utf-8', 'utf8', 'gbk', 'gb2312', 'gb18030'].includes(charset) || Number(response.headers['content-length']) > MAX_SOURCE_BYTES) {
        response.destroy()
        reject(new Error('Anonymous HTML document is unavailable'))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.once('error', reject)
      response.once('aborted', () => reject(new Error('Anonymous document download interrupted')))
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > MAX_SOURCE_BYTES) {
          response.destroy()
          reject(new Error('Anonymous document exceeds the reader limit'))
        } else chunks.push(chunk)
      })
      response.once('end', () => {
        if (size > MAX_SOURCE_BYTES) return
        try { resolve(new TextDecoder(charset, { fatal: true }).decode(Buffer.concat(chunks, size))) }
        catch (error) { reject(error) }
      })
    })
    req.once('error', reject)
    req.end()
  })
}
