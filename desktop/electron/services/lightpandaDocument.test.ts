/** @vitest-environment node */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAnonymousDocument } from './lightpandaDocument'

const { lookup, request } = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup }))
vi.mock('node:https', () => ({ request }))

const documentUrl = 'https://docs.example.com/manual'

function respond(statusCode: number, headers: Record<string, string>, body?: Buffer | string) {
  request.mockImplementation((_options, onResponse: (value: unknown) => void) => {
    const req = new EventEmitter()
    return Object.assign(req, {
      end() {
        const response = Object.assign(new PassThrough(), { statusCode, headers })
        onResponse(response)
        if (!response.destroyed) response.end(body)
      },
    })
  })
}

beforeEach(() => {
  request.mockReset()
  lookup.mockReset().mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
})

describe('anonymous document request boundary', () => {
  it('uses the vetted IP for one TLS request and keeps the original TLS identity', async () => {
    respond(200, { 'content-type': 'text/html; charset=utf-8' }, '<p>模拟正文</p>')
    const signal = new AbortController().signal
    await expect(fetchAnonymousDocument(documentUrl, signal)).resolves.toBe('<p>模拟正文</p>')
    expect(lookup).toHaveBeenCalledExactlyOnceWith('docs.example.com', { all: true })
    expect(request).toHaveBeenCalledExactlyOnceWith({
      hostname: '1.1.1.1', port: 443, servername: 'docs.example.com', path: '/manual',
      method: 'GET', agent: false, signal, rejectUnauthorized: true,
      headers: { Host: 'docs.example.com', Accept: 'text/html', 'Accept-Encoding': 'identity' },
    }, expect.any(Function))
  })

  it('does not send a request if DNS also returns a private address', async () => {
    lookup.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }, { address: '192.168.0.10', family: 4 }])
    await expect(fetchAnonymousDocument(documentUrl, new AbortController().signal)).rejects.toThrow('not public')
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects redirects without looking up or requesting the target', async () => {
    respond(302, { location: 'https://another.example.com/manual', 'content-type': 'text/html' })
    await expect(fetchAnonymousDocument(documentUrl, new AbortController().signal)).rejects.toThrow('unavailable')
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['application/pdf', 'identity', Buffer.from('not an HTML document')],
    ['text/html', 'gzip', Buffer.from('compressed response not supported')],
    ['text/html', 'identity', Buffer.alloc(512 * 1024 + 1)],
  ])('rejects unsupported type, encoding or oversized body (%s, %s)', async (type, encoding, body) => {
    respond(200, { 'content-type': type, 'content-encoding': encoding }, body)
    await expect(fetchAnonymousDocument(documentUrl, new AbortController().signal)).rejects.toThrow(/unavailable|exceeds/u)
  })
})
