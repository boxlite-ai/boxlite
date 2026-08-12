/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { BoxliteProxyController } from './boxlite-proxy.controller'

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
  fixRequestBody: jest.fn(),
}))
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

describe('BoxLite network tunnel authorization integration', () => {
  const boxService = {
    getNetworkTunnelUrl: jest.fn().mockResolvedValue('https://3000-t-capability.proxy.test'),
  }
  const controller = new BoxliteProxyController(boxService as never, {} as never, {} as never)
  const guard = new OrganizationResourceActionGuard(
    { findOne: jest.fn().mockResolvedValue({ id: 'org-1' }) } as never,
    {
      findOne: jest.fn().mockResolvedValue({
        role: OrganizationMemberRole.MEMBER,
        assignedRoles: [],
      }),
    } as never,
    new Reflector(),
  )

  beforeAll(() => {
    ;(guard as any).redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    }
  })

  beforeEach(() => {
    boxService.getNetworkTunnelUrl.mockClear()
  })

  it('rejects tunnel minting when the API key lacks write:boxes', async () => {
    const request = apiKeyRequest([OrganizationResourcePermission.READ_VOLUMES])

    await expect(guard.canActivate(tunnelContext(request))).resolves.toBe(false)

    expect(boxService.getNetworkTunnelUrl).not.toHaveBeenCalled()
  })

  it('mints a tenant-scoped tunnel capability for an authorized API key', async () => {
    const request = apiKeyRequest([OrganizationResourcePermission.WRITE_BOXES])

    await expect(guard.canActivate(tunnelContext(request))).resolves.toBe(true)
    await expect(controller.proxyNetworkTunnel(request.user as never, 'tenant-box', 3000)).resolves.toEqual({
      uri: 'https://3000-t-capability.proxy.test',
    })
    expect(boxService.getNetworkTunnelUrl).toHaveBeenCalledWith('tenant-box', 'org-1', 3000)
  })

  function apiKeyRequest(permissions: OrganizationResourcePermission[]) {
    return {
      params: {},
      user: {
        role: 'user',
        userId: 'user-1',
        email: 'user@example.test',
        organizationId: 'org-1',
        apiKey: {
          organizationId: 'org-1',
          permissions,
        },
      },
    }
  }

  function tunnelContext(request: ReturnType<typeof apiKeyRequest>): ExecutionContext {
    return {
      getClass: () => BoxliteProxyController,
      getHandler: () => BoxliteProxyController.prototype.proxyNetworkTunnel,
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext
  }
})
