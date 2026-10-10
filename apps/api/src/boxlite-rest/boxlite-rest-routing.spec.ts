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
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteConfigController } from './boxlite-config.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'
import { BoxliteVolumeController } from './boxlite-volume.controller'
import { CommerceBoxLimitService } from './commerce-box-limit.service'

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
  let updateInboundMode: jest.Mock

  async function startRoutingTestApp() {
    updateInboundMode = jest.fn((_boxId: string, inboundMode: string) => Promise.resolve({ inboundMode }))
    const moduleRef = await Test.createTestingModule({
      // The module's order, with the proxy controller's catch-all routes
      // present, so one that shadowed PUT network/inbound would fail below.
      controllers: [BoxliteConfigController, BoxliteBoxController, BoxliteProxyController],
      providers: [
        {
          provide: BoxService,
          useValue: {
            findAllDeprecated: jest.fn().mockResolvedValue([]),
            toBoxDtos: jest.fn().mockResolvedValue([]),
            updateInboundMode,
          },
        },
        {
          provide: BoxStateWaiterService,
          useValue: {},
        },
        {
          provide: CommerceBoxLimitService,
          useValue: {},
        },
      ],
    })
      // The proxy controller is here only for its routes. Mock whatever it
      // injects, so a constructor dependency added later (#1723 added
      // TunnelService) cannot stop these routing tests from building.
      .useMocker(() => ({}))
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

  async function put(path: string, body: unknown): Promise<Response> {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'PUT',
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

  it.each([
    ['/api/v1/boxes/box-1/network/inbound', 'enabled'],
    ['/api/v1/default/boxes/box-1/network/inbound', 'disabled'],
  ])('PUT %s sets inbound %s', async (path, mode) => {
    await startRoutingTestApp()

    const response = await put(path, { mode })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ mode })
    expect(updateInboundMode).toHaveBeenCalledWith('box-1', mode, 'org-123')
  })

  it.each([
    ['an unknown mode', { mode: 'public' }],
    ['a missing mode', {}],
    ['an unknown field', { mode: 'enabled', public: true }],
    ['an inbound allowlist', { mode: 'enabled', allow_net: ['10.0.0.0/8'] }],
  ])('rejects %s before changing inbound access', async (_label, body) => {
    await startRoutingTestApp()

    const response = await put('/api/v1/boxes/box-1/network/inbound', body)

    expect(response.status).toBe(400)
    expect(updateInboundMode).not.toHaveBeenCalled()
  })

  // Clients call the inbound route only when the server advertises it, so a
  // server without the route reports "unsupported" rather than a bare 404.
  it('advertises inbound updates in /v1/config', async () => {
    await startRoutingTestApp()

    const response = await get('/api/v1/config')

    expect((await response.json()).capabilities.inbound_update_enabled).toBe(true)
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
