/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PATH_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { ValidationPipe, type INestApplication } from '@nestjs/common'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
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
import { AUDIT_CONTEXT_KEY, AuditContext } from '../audit/decorators/audit.decorator'

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
  let updateInboundEnabled: jest.Mock
  let setOutboundNetwork: jest.Mock

  async function startRoutingTestApp() {
    updateInboundEnabled = jest.fn((_boxId: string, inboundEnabled: boolean) => Promise.resolve({ inboundEnabled }))
    setOutboundNetwork = jest.fn((_id, policy) =>
      Promise.resolve({
        outboundEnabled: policy.mode === 'enabled',
        outboundAllowNet: policy.allow_net,
      }),
    )
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
            updateInboundEnabled,
            setOutboundNetwork,
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
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    // As main.ts validates every body, so a DTO's rules hold on its route here.
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
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
    expect(updateInboundEnabled).toHaveBeenCalledWith('box-1', mode === 'enabled', 'org-123')
  })

  it('routes outbound replacements ahead of the proxy catch-all', async () => {
    await startRoutingTestApp()
    for (const path of ['/api/v1/boxes/box-1/network/outbound', '/api/v1/default/boxes/box-1/network/outbound']) {
      const response = await put(path, { mode: 'enabled' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ mode: 'enabled', allow_net: [] })
      expect(setOutboundNetwork).toHaveBeenLastCalledWith('box-1', { mode: 'enabled', allow_net: [] }, 'org-123')
    }
  })

  it('reports a stored empty outbound allowlist as an empty list', async () => {
    await startRoutingTestApp()
    setOutboundNetwork.mockResolvedValueOnce({ outboundEnabled: false, outboundAllowNet: null })
    const response = await put('/api/v1/boxes/box-1/network/outbound', { mode: 'disabled' })
    expect(await response.json()).toEqual({ mode: 'disabled', allow_net: [] })
  })

  it('audits only the outbound policy fields', () => {
    const audit = new Reflector().get<AuditContext>(
      AUDIT_CONTEXT_KEY,
      BoxliteBoxController.prototype.updateOutboundNetwork,
    )
    const recorded = audit.requestMetadata?.body?.({
      body: { mode: 'enabled', allow_net: ['a.com'], extra: 'x' },
    } as never)
    expect(recorded).toEqual({ mode: 'enabled', allow_net: ['a.com'] })
  })

  it.each([
    {},
    { mode: 'off' },
    { mode: 'enabled', allow_net: [''] },
    { mode: 'enabled', allow_net: ['a.com,b.com'] },
    { mode: 'enabled', unknown: true },
  ])('rejects invalid outbound request %j', async (body) => {
    await startRoutingTestApp()
    const response = await put('/api/v1/boxes/box-1/network/outbound', body)
    expect(response.status).toBe(400)
    expect(setOutboundNetwork).not.toHaveBeenCalled()
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
    expect(updateInboundEnabled).not.toHaveBeenCalled()
  })

  // Clients call the inbound route only when the server advertises it, so a
  // server without the route reports "unsupported" rather than a bare 404.
  it('advertises inbound updates in /v1/config', async () => {
    await startRoutingTestApp()

    const response = await get('/api/v1/config')

    expect((await response.json()).capabilities.inbound_update_enabled).toBe(true)
  })

  // An older API ignores isPublic and would publish the port, so clients
  // refuse private prepare unless /v1/config advertises it.
  it('advertises private tunnels in /v1/config', async () => {
    await startRoutingTestApp()

    const response = await get('/api/v1/config')

    expect((await response.json()).capabilities.private_tunnels_enabled).toBe(true)
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
      get: jest
        .fn()
        .mockResolvedValue({ name: 'quay.io/acme/app', aliases: [], curated: false, versions: [], history: [] }),
    }
    await startApp([BoxliteImageController], [{ provide: ImageCatalogService, useValue: catalog }])

    const response = await get('/api/v1/images/quay.io%2Facme%2Fapp')

    expect(response.status).toBe(200)
    expect(catalog.get).toHaveBeenCalledWith({ id: 'org-123' }, 'quay.io/acme/app')
  })

  it('creates and deletes aliases with either routing prefix', async () => {
    const digest = `sha256:${'a'.repeat(64)}`
    const catalog = {
      createAlias: jest.fn().mockResolvedValue({
        name: 'quay.io/acme/app',
        aliases: ['stable'],
        curated: false,
        versions: [],
        history: [],
      }),
      deleteAlias: jest.fn().mockResolvedValue(undefined),
    }
    await startApp([BoxliteImageController], [{ provide: ImageCatalogService, useValue: catalog }])
    const address = app.getHttpServer().address() as AddressInfo
    for (const prefix of ['', '/default']) {
      const url = `http://127.0.0.1:${address.port}/api/v1${prefix}/images/quay.io%2Facme%2Fapp/aliases`
      const created = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'stable', digest }),
      })
      expect(created.status).toBe(201)
      expect((await created.json()).aliases).toEqual(['stable'])
      expect((await fetch(`${url}/stable`, { method: 'DELETE' })).status).toBe(204)
      for (const selector of ['tags', 'aliases']) {
        expect((await put(`/api/v1${prefix}/images/quay.io%2Facme%2Fapp/${selector}/stable`, { digest })).status).toBe(
          404,
        )
      }
    }
    expect(catalog.createAlias).toHaveBeenCalledWith(
      { id: 'org-123' },
      'quay.io/acme/app',
      'stable',
      { digest },
      undefined,
    )
    expect(catalog.deleteAlias).toHaveBeenCalledWith({ id: 'org-123' }, 'quay.io/acme/app', 'stable')
  })

  it('validates alias creation before asking the catalog', async () => {
    const catalog = { createAlias: jest.fn() }
    await startApp([BoxliteImageController], [{ provide: ImageCatalogService, useValue: catalog }])
    const address = app.getHttpServer().address() as AddressInfo
    for (const body of [
      {},
      { alias: 'stable', digest: 'latest' },
      { alias: '-bad', digest: `sha256:${'a'.repeat(64)}` },
    ]) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/images/quay.io%2Facme%2Fapp/aliases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(catalog.createAlias).not.toHaveBeenCalled()
  })

  it('answers registry logins with or without a routing prefix', async () => {
    const registries = { list: jest.fn().mockResolvedValue([]) }
    await startApp([BoxliteRegistryController], [{ provide: RegistriesService, useValue: registries }])

    for (const path of ['/api/v1/images/registries', '/api/v1/default/images/registries']) {
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

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/images/registries/not-a-uuid`, {
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
      {} as any,
      {} as any,
    )

    expect(service.matchAttachPath('/api/v1/boxes/box-1/executions/exec-1/attach')).toEqual({
      boxId: 'box-1',
      execId: 'exec-1',
    })
    expect(service.matchAttachPath('/api/v1/default/boxes/box-1/executions/exec-1/attach?ticket=t')).toEqual({
      boxId: 'box-1',
      execId: 'exec-1',
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
      {} as any,
      {} as any,
    )

    expect(service.matchAttachPath('/api/v1/boxes/box-1/network/tunnel?port=3000')).toBeNull()
  })
})
