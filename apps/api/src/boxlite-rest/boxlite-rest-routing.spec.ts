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
import { BoxliteImageController } from './boxlite-image.controller'
import { ImageCatalogService } from '../image/services/image-catalog.service'
import { BoxliteRegistryController } from './boxlite-registry.controller'
import { RegistriesService } from '../registry/services/registries.service'
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
  let updatePublicStatus: jest.Mock

  async function startRoutingTestApp() {
    updatePublicStatus = jest.fn((_boxId: string, isPublic: boolean) => Promise.resolve({ public: isPublic }))
    await startApp(
      // The module's order, with the proxy controller's catch-all routes
      // present, so one that shadowed PUT network/inbound would fail below.
      [BoxliteConfigController, BoxliteBoxController, BoxliteProxyController],
      [
        {
          provide: BoxService,
          useValue: {
            findAllDeprecated: jest.fn().mockResolvedValue([]),
            toBoxDtos: jest.fn().mockResolvedValue([]),
            updatePublicStatus,
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
    )
  }

  async function startApp(controllers: any[], providers: any[]) {
    const moduleRef = await Test.createTestingModule({ controllers, providers })
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
    ['/api/v1/boxes/box-1/network/inbound', 'enabled', true],
    ['/api/v1/default/boxes/box-1/network/inbound', 'disabled', false],
  ])('PUT %s sets inbound %s', async (path, mode, isPublic) => {
    await startRoutingTestApp()

    const response = await put(path, { mode })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ mode })
    expect(updatePublicStatus).toHaveBeenCalledWith('box-1', isPublic, 'org-123')
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
    expect(updatePublicStatus).not.toHaveBeenCalled()
  })

  // Clients call the inbound route only when the server advertises it, so a
  // server without the route reports "unsupported" rather than a bare 404.
  it('advertises inbound updates in /v1/config', async () => {
    await startRoutingTestApp()

    const response = await get('/api/v1/config')

    expect((await response.json()).capabilities.inbound_update_enabled).toBe(true)
  })

  it('answers image usage on its own route, with or without a routing prefix', async () => {
    const catalog = {
      usage: jest.fn().mockResolvedValue({ count: 1, limit: 20, knownBytes: 0 }),
      get: jest.fn(),
    }
    await startApp([BoxliteImageController], [{ provide: ImageCatalogService, useValue: catalog }])

    for (const path of ['/api/v1/images/usage', '/api/v1/default/images/usage']) {
      const response = await get(path)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ count: 1, limit: 20, known_bytes: 0 })
    }
    // Declared after `usage`, `:name` would have read "usage" as an image.
    expect(catalog.get).not.toHaveBeenCalled()
  })

  it('takes an encoded image name as one path parameter', async () => {
    const catalog = {
      get: jest.fn().mockResolvedValue({ name: 'quay.io/acme/app', tags: [], curated: false, versions: [] }),
    }
    await startApp([BoxliteImageController], [{ provide: ImageCatalogService, useValue: catalog }])

    const response = await get('/api/v1/images/quay.io%2Facme%2Fapp')

    expect(response.status).toBe(200)
    expect(catalog.get).toHaveBeenCalledWith({ id: 'org-123' }, 'quay.io/acme/app')
  })

  it('answers registry logins with or without a routing prefix', async () => {
    const registries = { list: jest.fn().mockResolvedValue([]) }
    await startApp([BoxliteRegistryController], [{ provide: RegistriesService, useValue: registries }])

    for (const path of ['/api/v1/registries', '/api/v1/default/registries']) {
      const response = await get(path)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ registries: [] })
    }
    expect(registries.list).toHaveBeenCalledWith('org-123')
  })

  it('refuses a registry login id that is not a UUID before the service sees it', async () => {
    const registries = { delete: jest.fn() }
    await startApp([BoxliteRegistryController], [{ provide: RegistriesService, useValue: registries }])
    const address = app.getHttpServer().address() as AddressInfo

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/registries/not-a-uuid`, {
      method: 'DELETE',
    })

    expect(response.status).toBe(400)
    expect(registries.delete).not.toHaveBeenCalled()
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
