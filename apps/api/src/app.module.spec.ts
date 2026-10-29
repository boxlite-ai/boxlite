// http-proxy-middleware is ESM-only and sits in AppModule's import graph via
// the boxlite-rest proxy controller; nothing here exercises it.
jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: () => () => undefined,
  fixRequestBody: () => undefined,
}))

/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MODULE_METADATA } from '@nestjs/common/constants'
import { AppModule } from './app.module'
import { UsageModule } from './usage/usage.module'
import { StatusSyncModule } from './status-sync/status-sync.module'
import { LoggerModule } from 'nestjs-pino'
import { createServer } from 'node:http'
import { Writable } from 'node:stream'
import { AddressInfo } from 'node:net'
import pinoHttp from 'pino-http'

// The usage ledger is driven entirely by events and cron jobs — nothing imports
// it and no request path touches it — so dropping this registration disables
// billing silently. It was in fact lost once in a convergence merge (#715).
describe('AppModule registrations', () => {
  it('registers the usage ledger', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as Array<unknown>

    expect(imports).toContain(UsageModule)
  })

  // Same failure mode as the usage ledger: the status sync is cron-only, so
  // dropping this registration silently freezes the public status page.
  it('registers the status sync', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as Array<unknown>

    expect(imports).toContain(StatusSyncModule)
  })

  it('omits MCP bearer credentials, consent URLs and response headers from real request logs', async () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule)
    const module = imports.find((item: { module?: unknown }) => item.module === LoggerModule)
    const factory = module.providers.find((item: { useFactory?: unknown }) => item.useFactory).useFactory
    const { pinoHttp: options } = factory({
      get: (key: string) =>
        key === 'production' ? true : { requests: { enabled: true }, level: 'info', console: { disabled: false } },
    })
    let logs = ''
    const logger = pinoHttp(
      options,
      new Writable({
        write(chunk, _encoding, next) {
          logs += chunk.toString()
          next()
        },
      }),
    )
    const server = createServer((req, res) => {
      logger(req, res)
      res.setHeader('set-cookie', 'session=private-cookie')
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      for (const path of [
        '/api/mcp',
        '/api/mcp-consent/approve',
        '/mcp/consent?challenge=private-challenge&state=private-state',
      ]) {
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
          headers: { authorization: 'Bearer private-bearer', cookie: 'session=private-cookie' },
        })
        expect(response.status).toBe(200)
        await response.text()
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    expect(logs).toContain('"statusCode":200')
    for (const secret of ['private-bearer', 'private-challenge', 'private-state', 'private-cookie'])
      expect(logs).not.toContain(secret)
  })
})
