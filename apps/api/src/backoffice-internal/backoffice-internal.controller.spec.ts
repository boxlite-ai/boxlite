/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import type { AddressInfo } from 'node:net'
import { TypedConfigService } from '../config/typed-config.service'
import { BackofficeInternalController } from './backoffice-internal.controller'
import { BackofficeWorkloadAuthenticator, BackofficeWorkloadAuthGuard } from './backoffice-workload-auth'

const CURRENT_TOKEN = 'synthetic-current-workload-token'
const NEXT_TOKEN = 'synthetic-next-workload-token'
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

describe('Backoffice internal readiness', () => {
  let app: INestApplication | undefined

  async function startApp(enabled: boolean) {
    const values: Record<string, unknown> = {
      'backofficeInternal.enabled': enabled,
      'backofficeInternal.readTokenDigests.current': enabled ? digest(CURRENT_TOKEN) : undefined,
      'backofficeInternal.readTokenDigests.next': enabled ? digest(NEXT_TOKEN) : undefined,
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [BackofficeInternalController],
      providers: [
        BackofficeWorkloadAuthenticator,
        BackofficeWorkloadAuthGuard,
        {
          provide: TypedConfigService,
          useValue: { get: (key: string) => values[key] },
        },
      ],
    }).compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
  }

  async function request(method: 'GET' | 'POST', token?: string): Promise<Response> {
    if (!app) {
      throw new Error('test application is not running')
    }
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}/api/internal/backoffice/v1/readiness`, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    })
  }

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('returns 404 while the route family is disabled', async () => {
    await startApp(false)

    expect((await request('GET')).status).toBe(404)
  })

  it('rejects missing and invalid bearer credentials without reflecting them', async () => {
    await startApp(true)

    expect((await request('GET')).status).toBe(401)
    const invalidToken = 'synthetic-invalid-workload-token'
    const invalidResponse = await request('GET', invalidToken)

    expect(invalidResponse.status).toBe(401)
    expect(await invalidResponse.text()).not.toContain(invalidToken)
  })

  it.each([CURRENT_TOKEN, NEXT_TOKEN])('returns the capability handshake for a valid rotation slot', async (token) => {
    await startApp(true)

    const response = await request('GET', token)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toMatchObject({
      service: 'boxlite-api',
      contract: { major: 1, minor: 0 },
      capabilities: [],
    })
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false)
    expect(JSON.stringify(body)).not.toContain(token)
  })

  it('does not register a non-GET readiness route', async () => {
    await startApp(true)

    expect((await request('POST', CURRENT_TOKEN)).status).toBe(404)
  })

  it('omits the internal route from the public OpenAPI document', async () => {
    await startApp(true)
    if (!app) {
      throw new Error('test application is not running')
    }

    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build())

    expect(Object.keys(document.paths).filter((path) => path.includes('/internal/backoffice/'))).toEqual([])
  })
})
