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
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'

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
            findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'box-1' }),
            toBoxDto: jest.fn().mockResolvedValue({
              id: 'box-1',
              name: 'named',
              state: BoxState.STARTED,
              labels: {},
              advanced: { capabilities: { add: [], drop: [] } },
            }),
          },
        },
        {
          provide: BoxStateWaiterService,
          useValue: {},
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

  async function post(path: string, body: unknown): Promise<Response> {
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

  it('registers the strict policy-aware box read route', async () => {
    await startRoutingTestApp()

    const canonical = await get('/api/v1/boxes/named/strict')
    const prefixed = await get('/api/v1/default/boxes/named/strict')

    expect(canonical.status).toBe(200)
    expect(await canonical.json()).toMatchObject({
      box_id: 'box-1',
      advanced: { capabilities: { add: [], drop: [] } },
    })
    expect(prefixed.status).toBe(200)
  })

  it('registers the strict policy-aware box list route', async () => {
    await startRoutingTestApp()

    const canonical = await get('/api/v1/boxes/strict')
    const prefixed = await get('/api/v1/default/boxes/strict')

    expect(canonical.status).toBe(200)
    expect(await canonical.json()).toEqual({ boxes: [] })
    expect(prefixed.status).toBe(200)
    expect(await prefixed.json()).toEqual({ boxes: [] })
  })

  it('rejects unknown fields at the strict create boundary', async () => {
    await startRoutingTestApp()

    const response = await post('/api/v1/boxes/strict', {
      image: 'alpine:latest',
      advanced: {
        capabilities: {
          drop: ['NET_RAW'],
          future_security_option: true,
        },
      },
    })

    expect(response.status).toBe(400)
  })

  it('rejects explicit null throughout the strict advanced capability path', async () => {
    await startRoutingTestApp()

    const payloads = [
      { advanced: null },
      { advanced: { capabilities: null } },
      { advanced: { capabilities: { add: null } } },
      { advanced: { capabilities: { drop: null } } },
    ]

    for (const payload of payloads) {
      const response = await post('/api/v1/boxes/strict', {
        image: 'alpine:latest',
        ...payload,
      })
      expect(response.status).toBe(400)
    }
  })

  it.each([null, {}, { capabilities: { add: [], drop: [] } }])(
    'rejects any advanced key at the legacy create boundary',
    async (advanced) => {
      await startRoutingTestApp()

      const response = await post('/api/v1/boxes', {
        image: 'alpine:latest',
        advanced,
      })

      expect(response.status).toBe(400)
    },
  )

  it.each(['capAdd', 'capDrop', 'cap_add', 'cap_drop'])(
    'rejects prototype flat capability field %s at the legacy create boundary',
    async (field) => {
      await startRoutingTestApp()

      const response = await post('/api/v1/boxes', {
        image: 'alpine:latest',
        [field]: [],
      })

      expect(response.status).toBe(400)
    },
  )

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
