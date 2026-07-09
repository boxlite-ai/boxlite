/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ExpressAdapter } from '@nestjs/platform-express'
import { ServeStaticModule } from '@nestjs/serve-static'
import type { INestApplication, NestModule } from '@nestjs/common'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import express from 'express'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiPrefixRewriteMiddleware, createApiPrefixRewriteMiddleware } from './api-prefix-rewrite.middleware'

@Controller('health')
class TestHealthController {
  @Get()
  live() {
    return { status: 'ok' }
  }
}

function getWithHost(
  port: number,
  path: string,
  host: string,
): Promise<{ headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: { Host: host },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          resolve({ headers: res.headers, body })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('ApiPrefixRewriteMiddleware', () => {
  const previousHosts = process.env.UNPREFIXED_API_HOSTS
  let app: INestApplication | undefined
  let dashboardDir: string | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
    if (dashboardDir) {
      rmSync(dashboardDir, { recursive: true, force: true })
      dashboardDir = undefined
    }
    process.env.UNPREFIXED_API_HOSTS = previousHosts
  })

  it('routes unprefixed canonical API-host requests to API controllers before dashboard static fallback', async () => {
    process.env.UNPREFIXED_API_HOSTS = 'api.dev.boxlite.ai'
    dashboardDir = mkdtempSync(join(tmpdir(), 'boxlite-dashboard-'))
    writeFileSync(join(dashboardDir, 'index.html'), '<html>dashboard fallback</html>')

    @Module({
      imports: [
        ServeStaticModule.forRoot({
          rootPath: dashboardDir,
          exclude: ['/api/{*path}'],
        }),
      ],
      controllers: [TestHealthController],
    })
    class TestRoutingModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(ApiPrefixRewriteMiddleware).forRoutes({ path: '{*path}', method: RequestMethod.ALL })
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [TestRoutingModule],
    }).compile()
    const expressApp = express()
    expressApp.use(createApiPrefixRewriteMiddleware(['api.dev.boxlite.ai']))
    app = moduleRef.createNestApplication(new ExpressAdapter(expressApp))
    app.setGlobalPrefix('api')
    await app.listen(0)

    const address = app.getHttpServer().address() as AddressInfo
    const res = await getWithHost(address.port, '/health', 'api.dev.boxlite.ai')

    expect(res.headers['content-type']).toContain('application/json')
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' })
  })

  it('leaves dashboard-host request URLs untouched', () => {
    const req = {
      headers: { host: 'dev.boxlite.ai' },
      url: '/health',
    } as any
    const next = jest.fn()

    createApiPrefixRewriteMiddleware(['api.dev.boxlite.ai'])(req, {} as any, next)

    expect(req.url).toBe('/health')
    expect(next).toHaveBeenCalledTimes(1)
  })
})
