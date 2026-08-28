/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PATH_METADATA } from '@nestjs/common/constants'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RedisLockProvider } from '../box/common/redis-lock.provider'
import { BoxRepository } from '../box/repositories/box.repository'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'
import { BoxliteVolumeController } from './boxlite-volume.controller'
import { CommerceBoxLimitService } from './services/commerce-box-limit.service'
import { RestBoxCreationService } from './services/rest-box-creation.service'

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
  fixRequestBody: jest.fn(),
}))
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

describe('BoxLite REST routing', () => {
  let app: INestApplication

  async function startRoutingTestApp() {
    const moduleRef = await Test.createTestingModule({
      controllers: [BoxliteBoxController],
      providers: [
        {
          provide: BoxService,
          useValue: {
            findAllDeprecated: jest.fn().mockResolvedValue([]),
            toBoxDtos: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: BoxStateWaiterService,
          useValue: {},
        },
        {
          provide: RestBoxCreationService,
          useClass: RestBoxCreationService,
        },
        {
          provide: CommerceBoxLimitService,
          useValue: { resolveLimit: jest.fn().mockResolvedValue({ kind: 'limited', value: 20 }) },
        },
        {
          provide: BoxRepository,
          useValue: { countQuotaBoxes: jest.fn() },
        },
        {
          provide: RedisLockProvider,
          useValue: { waitForLease: jest.fn().mockRejectedValue(new Error('Redis unavailable')) },
        },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = {
            organizationId: 'org-123',
            organization: { id: 'org-123' },
          }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0)
  }

  async function get(path: string): Promise<Response> {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}${path}`)
  }

  async function post(path: string, body: object): Promise<Response> {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  afterEach(async () => {
    await app?.close()
  })

  it('mounts box controllers at canonical and legacy default-prefix routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BoxliteBoxController)).toEqual(['v1/boxes', 'v1/:prefix/boxes'])
    expect(Reflect.getMetadata(PATH_METADATA, BoxliteProxyController)).toEqual(['v1/boxes', 'v1/:prefix/boxes'])
    expect(Reflect.getMetadata(PATH_METADATA, BoxliteVolumeController)).toEqual(['v1/volumes', 'v1/:prefix/volumes'])
  })

  it('registers canonical and legacy default-prefix routes in the Nest HTTP router', async () => {
    await startRoutingTestApp()

    const canonical = await get('/api/v1/boxes')
    const legacy = await get('/api/v1/default/boxes')

    expect(canonical.status).toBe(200)
    expect(await canonical.json()).toEqual({ boxes: [] })
    expect(legacy.status).toBe(200)
    expect(await legacy.json()).toEqual({ boxes: [] })
  })

  it('returns the 503 admission response when the creation lease is unavailable', async () => {
    await startRoutingTestApp()

    const response = await post('/api/v1/boxes', { image: 'alpine:latest' })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      message: 'Box creation admission is temporarily unavailable. Please try again.',
      code: 'upstream_unavailable',
    })
  })

  it('matches websocket attach upgrades with or without a routing prefix', () => {
    const service = new BoxliteWsProxyService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )

    expect(service.matchAttachPath('/api/v1/boxes/box-1/executions/exec-1/attach')).toEqual({ boxId: 'box-1' })
    expect(service.matchAttachPath('/api/v1/default/boxes/box-1/executions/exec-1/attach')).toEqual({
      boxId: 'box-1',
      tenant: 'default',
    })
  })

  it('does not route HTTP duplex tunnels through the websocket proxy', () => {
    const service = new BoxliteWsProxyService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )

    expect(service.matchAttachPath('/api/v1/boxes/box-1/network/tunnel?port=3000')).toBeNull()
  })
})
