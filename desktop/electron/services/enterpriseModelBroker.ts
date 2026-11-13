import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { enterpriseBrokerEnv, isEnterpriseProjectId, parseEnterpriseContextInput, parseEnterpriseGrantInput } from '../../../src/shared/enterpriseModels'
import { parseEnterpriseErpInput } from '../../../src/shared/enterpriseErp'
import type { EnterpriseBridge } from './enterpriseBridge'
import { parsePiContextInput, parsePiContextResult } from '../../../src/shared/piContext'

const host = '127.0.0.1'
const maxRequestBytes = 4 * 1024
declare const LIYUAN_DESKTOP_OFFICE_HTTP_ORIGIN: string | undefined

async function readBrokerInput(request: IncomingMessage): Promise<unknown> {
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.byteLength
    if (length > maxRequestBytes) return null
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as unknown } catch { return null }
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

/** A loopback channel provisioned only to the bundled sidecar process. */
export class EnterpriseModelBroker {
  private readonly secret = randomBytes(32).toString('base64url')
  private server: Server | null = null
  private startup: Promise<NodeJS.ProcessEnv> | null = null

  constructor(
    private readonly bridge: Pick<EnterpriseBridge, 'models' | 'modelGrant'> & Partial<Pick<EnterpriseBridge, 'modelContext' | 'modelErp' | 'piContext'>>,
    private readonly officeHttpOrigin?: string,
  ) {}

  get available() {
    return this.server?.listening === true
  }

  start(): Promise<NodeJS.ProcessEnv> {
    if (this.startup) return this.startup
    const server = createServer({ requestTimeout: 15_000, headersTimeout: 5_000 }, (request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent && !response.destroyed) json(response, 503, { error: 'Enterprise model unavailable' })
        else response.destroy()
      })
    })
    this.server = server
    const startup = new Promise<NodeJS.ProcessEnv>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, host, () => {
        const address = server.address()
        if (!address || typeof address === 'string') return reject(new Error('Enterprise broker failed to bind'))
        resolve({
          [enterpriseBrokerEnv.origin]: `http://${host}:${address.port}`,
          [enterpriseBrokerEnv.secret]: this.secret,
          ...(typeof LIYUAN_DESKTOP_OFFICE_HTTP_ORIGIN === 'string'
            && this.officeHttpOrigin === LIYUAN_DESKTOP_OFFICE_HTTP_ORIGIN
            ? { [enterpriseBrokerEnv.officeOrigin]: LIYUAN_DESKTOP_OFFICE_HTTP_ORIGIN } : {}),
        })
      })
    })
    this.startup = startup
    return startup.catch(error => {
      if (this.startup === startup) this.stop()
      throw error
    })
  }

  stop() {
    const server = this.server
    this.server = null
    this.startup = null
    server?.close()
    server?.closeAllConnections()
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const credential = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${this.secret}`)
    if (request.headers.origin || credential.length !== expected.length || !timingSafeEqual(credential, expected)) {
      json(response, 401, { error: 'Enterprise broker credential required' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/catalog') {
      const projectId = url.searchParams.get('projectId') ?? undefined
      if (projectId !== undefined && !isEnterpriseProjectId(projectId)) {
        json(response, 400, { error: 'Invalid enterprise project' })
        return
      }
      json(response, 200, await this.bridge.models(projectId))
      return
    }
    if (request.method === 'POST' && url.pathname === '/grant') {
      const input = parseEnterpriseGrantInput(await readBrokerInput(request))
      if (!input) {
        json(response, 400, { error: 'Invalid enterprise model scope' })
        return
      }
      const grant = await this.bridge.modelGrant(input)
      json(response, grant ? 200 : 403, grant ?? { error: 'Enterprise model unavailable or not authorized' })
      return
    }
    if (request.method === 'POST' && url.pathname === '/context') {
      const input = parseEnterpriseContextInput(await readBrokerInput(request))
      if (!input) {
        json(response, 400, { error: 'Invalid enterprise context scope' })
        return
      }
      const context = await this.bridge.modelContext?.(input)
      json(response, context ? 200 : 403, context ?? { error: 'Enterprise context unavailable or not authorized' })
      return
    }
    if (request.method === 'POST' && url.pathname === '/pi-context') {
      const abort = new AbortController()
      const closed = () => { if (!response.writableFinished) abort.abort() }
      response.once('close', closed)
      try {
        const input = parsePiContextInput(await readBrokerInput(request))
        if (abort.signal.aborted || response.destroyed) return
        if (!input) {
          json(response, 400, { error: 'Invalid shared context request' })
          return
        }
        const value = await this.bridge.piContext?.(input, abort.signal)
        const result = parsePiContextResult(value, input.kind)
        if (!abort.signal.aborted && !response.destroyed) {
          json(response, result ? 200 : 403, result ?? { error: 'Shared context unavailable or not authorized' })
        }
      } finally { response.off('close', closed) }
      return
    }
    if (request.method === 'POST' && url.pathname === '/erp') {
      const abort = new AbortController()
      const closed = () => { if (!response.writableFinished) abort.abort() }
      response.once('close', closed)
      try {
        const input = parseEnterpriseErpInput(await readBrokerInput(request))
        if (abort.signal.aborted || response.destroyed) return
        if (!input) {
          json(response, 400, { error: 'Invalid enterprise ERP query' })
          return
        }
        const result = await this.bridge.modelErp?.(input, abort.signal)
        if (!abort.signal.aborted && !response.destroyed) {
          json(response, result ? 200 : 403, result ?? { error: 'Enterprise ERP query unavailable or not authorized' })
        }
      } finally { response.off('close', closed) }
      return
    }
    json(response, 404, { error: 'Enterprise broker route not found' })
  }
}
