/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { Listener, verifyWebhook, WebhookError } from '@boxlite-ai/ci-listener'
import { SelfHost } from './self-host'
export function createHttp(
  listener: Listener,
  host: Pick<SelfHost, 'discoveryReady' | 'report'>,
  secret?: Buffer | ReadonlyMap<string, { application: string; secret: Buffer }>,
) {
  const routes = new Map<string, { application?: string; secret: Buffer }>()
  if (Buffer.isBuffer(secret)) routes.set('/v1/ci/github/webhook', { secret: Buffer.from(secret) })
  else if (secret)
    for (const [path, value] of secret) {
      if (
        !/^\/v1\/ci\/github\/webhook(?:\/[A-Za-z0-9_-]{1,128})?$/.test(path) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(value.application)
      )
        throw new Error('Invalid webhook App route')
      routes.set(path, { application: value.application, secret: Buffer.from(value.secret) })
    }
  let active = 0
  const tasks = new Set<Promise<void>>()
  const reply = (response: ServerResponse, status: number, body: object) => {
    if (!response.destroyed) {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
  }
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET' && request.url === '/healthz')
      return reply(response, 200, { process: 'running', discovery: host.discoveryReady ? 'ready' : 'pending' })
    const selected = routes.get(request.url || '')
    if (request.method !== 'POST' || !selected) return reply(response, 404, { error: 'not_found' })
    if (active >= 16) return reply(response, 503, { error: 'ingress_busy' })
    active++
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const data of request.iterator({ destroyOnReturn: false })) {
        const chunk = Buffer.from(data)
        bytes += chunk.length
        if (bytes > 1048576) {
          response.setHeader('Connection', 'close')
          request.resume()
          reply(response, 413, { error: 'payload_limit' })
          return
        }
        chunks.push(chunk)
      }
      const header = (name: string) =>
        typeof request.headers[name] === 'string' ? (request.headers[name] as string) : ''
      const event = verifyWebhook(
        {
          raw: Buffer.concat(chunks),
          signature: header('x-hub-signature-256'),
          delivery: header('x-github-delivery'),
          event: header('x-github-event'),
        },
        selected.secret,
      )
      if (!event) return reply(response, 202, { status: 'ignored' })
      if (selected.application) event.application = selected.application
      reply(response, 202, { status: await listener.receive(event) })
    } catch (error) {
      reply(response, error instanceof WebhookError ? error.status : 503, {
        error: error instanceof WebhookError ? 'invalid_webhook' : 'ingress_deferred',
      })
    } finally {
      active--
    }
  }
  const server = createServer((request, response) => {
    request.setTimeout(15000, () => request.destroy())
    const task = handle(request, response).catch((error) => {
      host.report(error, 'http-ingress')
      response.destroy()
    })
    tasks.add(task)
    void task.finally(() => tasks.delete(task))
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.keepAliveTimeout = 5000
  server.maxHeadersCount = 50
  return {
    server,
    close: async () => {
      const timer = setTimeout(() => server.closeAllConnections(), 5000)
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await Promise.allSettled([...tasks])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
