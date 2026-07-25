/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PATH_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import type { ExecutionContext, INestApplication } from '@nestjs/common'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteConfigController } from './boxlite-config.controller'
import { BoxliteMeController } from './boxlite-me.controller'
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
      {} as any,
    )

    expect(service.matchAttachPath('/api/v1/boxes/box-1/network/tunnel?port=3000')).toBeNull()
  })
})

describe('BoxLite REST permissions', () => {
  const READ_BOXES: OrganizationResourcePermission[] = []
  const WRITE_BOXES = [OrganizationResourcePermission.WRITE_BOXES]
  const DELETE_BOXES = [OrganizationResourcePermission.DELETE_BOXES]

  const routePermissions: Array<
    [controller: object, handlerName: string, expectedPermissions: OrganizationResourcePermission[]]
  > = [
    [BoxliteConfigController.prototype, 'getConfig', READ_BOXES],
    [BoxliteMeController.prototype, 'getMe', READ_BOXES],
    [BoxliteBoxController.prototype, 'createBox', WRITE_BOXES],
    [BoxliteBoxController.prototype, 'listBoxes', READ_BOXES],
    [BoxliteBoxController.prototype, 'getBox', READ_BOXES],
    [BoxliteBoxController.prototype, 'headBox', READ_BOXES],
    [BoxliteBoxController.prototype, 'removeBox', DELETE_BOXES],
    [BoxliteBoxController.prototype, 'startBox', WRITE_BOXES],
    [BoxliteBoxController.prototype, 'stopBox', WRITE_BOXES],
    [BoxliteProxyController.prototype, 'proxyExec', WRITE_BOXES],
    [BoxliteProxyController.prototype, 'proxyExecSignal', WRITE_BOXES],
    [BoxliteProxyController.prototype, 'proxyExecResize', WRITE_BOXES],
    [BoxliteProxyController.prototype, 'proxyExecStatus', WRITE_BOXES],
    [BoxliteProxyController.prototype, 'proxyExecKill', WRITE_BOXES],
    [BoxliteProxyController.prototype, 'proxyFiles', WRITE_BOXES],
    [BoxliteProxyController.prototype, 'proxyMetrics', READ_BOXES],
    [BoxliteProxyController.prototype, 'proxyNetworkTunnel', WRITE_BOXES],
  ]

  it.each(routePermissions)('%s.%s declares its required Box permission', (controller, handlerName, expected) => {
    const handler = (controller as Record<string, unknown>)[handlerName]

    expect(Reflect.getMetadata(RequiredOrganizationResourcePermissions.KEY, handler)).toEqual(expected)
  })

  function permissionContext(
    controller: object,
    handler: object,
    apiKeyPermissions?: OrganizationResourcePermission[],
  ): ExecutionContext {
    const apiKey =
      apiKeyPermissions === undefined
        ? undefined
        : {
            organizationId: 'org-123',
            userId: 'user-1',
            name: 'owner-key',
            permissions: apiKeyPermissions,
          }

    const request = {
      params: {},
      user: {
        organizationId: 'org-123',
        userId: 'user-1',
        email: 'owner@example.com',
        role: 'user',
        apiKey,
      },
    }

    return {
      getClass: () => controller,
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext
  }

  function permissionGuard(): OrganizationResourceActionGuard {
    const organizationService = {
      findOne: jest.fn().mockResolvedValue({ id: 'org-123' }),
    }
    const organizationUserService = {
      findOne: jest.fn().mockResolvedValue({
        organizationId: 'org-123',
        userId: 'user-1',
        role: OrganizationMemberRole.OWNER,
        assignedRoles: [],
      }),
    }
    const guard = new OrganizationResourceActionGuard(
      organizationService as never,
      organizationUserService as never,
      new Reflector(),
    )
    ;(guard as any).redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    }
    return guard
  }

  it('keeps an owner API key constrained by its own Box permissions', async () => {
    const context = permissionContext(BoxliteBoxController, BoxliteBoxController.prototype.createBox, [])

    await expect(permissionGuard().canActivate(context)).resolves.toBe(false)
  })

  it('lets an interactive owner use Box write routes without an assigned role', async () => {
    const context = permissionContext(BoxliteBoxController, BoxliteBoxController.prototype.createBox)

    await expect(permissionGuard().canActivate(context)).resolves.toBe(true)
  })

  it('fails closed when a BoxLite Box route has no permission metadata', async () => {
    const unclassifiedHandler = function unclassifiedHandler() {}
    const context = permissionContext(
      BoxliteBoxController,
      unclassifiedHandler,
      Object.values(OrganizationResourcePermission),
    )

    await expect(permissionGuard().canActivate(context)).resolves.toBe(false)
  })
})
