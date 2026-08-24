/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { INestApplication, ValidationPipe } from '@nestjs/common'
import { PATH_METADATA } from '@nestjs/common/constants'
import { Test } from '@nestjs/testing'
import type { AddressInfo } from 'net'
import { ApiKey } from '../api-key/api-key.entity'
import { ApiKeyService } from '../api-key/api-key.service'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { SystemRole } from '../user/enums/system-role.enum'
import { BoxliteApiKeyController } from './boxlite-api-key.controller'

const VOLUME_LIFECYCLE = [
  OrganizationResourcePermission.READ_VOLUMES,
  OrganizationResourcePermission.WRITE_VOLUMES,
  OrganizationResourcePermission.DELETE_VOLUMES,
]

const BOXES_ONLY = [OrganizationResourcePermission.WRITE_BOXES, OrganizationResourcePermission.DELETE_BOXES]

/**
 * Covers the `openapi/box.openapi.yaml` operations createApiKey, listApiKeys
 * and revokeApiKey.
 */
describe('BoxliteApiKeyController', () => {
  let app: INestApplication
  let apiKeyService: { createApiKey: jest.Mock; getApiKeys: jest.Mock; deleteApiKey: jest.Mock }

  /** Boot the controller behind the real guard stack, authenticated as `callerPermissions`. */
  async function start(callerPermissions: OrganizationResourcePermission[]) {
    apiKeyService = {
      createApiKey: jest.fn(async (_orgId, _userId, name, permissions, expiresAt) => ({
        apiKey: { name, permissions, createdAt: new Date('2026-08-24T00:00:00.000Z'), expiresAt } as ApiKey,
        value: 'blk_test_minted',
      })),
      getApiKeys: jest.fn().mockResolvedValue([
        {
          name: 'session-provisioner',
          permissions: VOLUME_LIFECYCLE,
          createdAt: new Date('2026-08-24T00:00:00.000Z'),
          lastUsedAt: new Date('2026-08-24T01:00:00.000Z'),
        } as ApiKey,
      ]),
      deleteApiKey: jest.fn().mockResolvedValue(undefined),
    }

    const moduleRef = await Test.createTestingModule({
      controllers: [BoxliteApiKeyController],
      providers: [{ provide: ApiKeyService, useValue: apiKeyService }],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = {
            userId: 'user-1',
            email: 'dev@example.com',
            role: SystemRole.USER,
            organizationId: 'org-1',
            organization: { id: 'org-1' },
            apiKey: { permissions: callerPermissions } as ApiKey,
            organizationUser: { role: OrganizationMemberRole.OWNER, assignedRoles: [] },
          }
          return true
        },
      })
      // The resource guard needs org lookups it cannot do here; this controller
      // declares no required permissions, so allowing it keeps the grant rule
      // under test rather than the membership plumbing.
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
    await app.listen(0)
  }

  function url(path: string): string {
    const address = app.getHttpServer().address() as AddressInfo
    return `http://127.0.0.1:${address.port}${path}`
  }

  function post(path: string, body: unknown): Promise<Response> {
    return fetch(url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  afterEach(async () => {
    await app?.close()
  })

  it('mounts on the versioned REST namespace, with and without a routing prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BoxliteApiKeyController)).toEqual(['v1/api-keys', 'v1/:prefix/api-keys'])
  })

  it('mints a key carrying the full volume lifecycle', async () => {
    await start(VOLUME_LIFECYCLE)

    const response = await post('/api/v1/api-keys', {
      name: 'session-provisioner',
      permissions: VOLUME_LIFECYCLE,
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      name: 'session-provisioner',
      permissions: VOLUME_LIFECYCLE,
      value: 'blk_test_minted',
      created_at: '2026-08-24T00:00:00.000Z',
      expires_at: null,
    })
  })

  it('serves the same route under a routing prefix', async () => {
    await start(VOLUME_LIFECYCLE)

    const response = await post('/api/v1/org-1/api-keys', {
      name: 'session-provisioner',
      permissions: VOLUME_LIFECYCLE,
    })

    expect(response.status).toBe(201)
  })

  it('refuses to mint permissions the calling key does not hold', async () => {
    await start(BOXES_ONLY)

    const response = await post('/api/v1/api-keys', { name: 'escalate', permissions: VOLUME_LIFECYCLE })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      message: expect.stringContaining('read:volumes'),
    })
    expect(apiKeyService.createApiKey).not.toHaveBeenCalled()
  })

  it('rejects a permission outside the vocabulary before reaching the service', async () => {
    await start(VOLUME_LIFECYCLE)

    const response = await post('/api/v1/api-keys', { name: 'typo', permissions: ['read:volume'] })

    expect(response.status).toBe(400)
    expect(apiKeyService.createApiKey).not.toHaveBeenCalled()
  })

  it('rejects a key with no permissions at all', async () => {
    await start(VOLUME_LIFECYCLE)

    const response = await post('/api/v1/api-keys', { name: 'empty', permissions: [] })

    expect(response.status).toBe(400)
    expect(apiKeyService.createApiKey).not.toHaveBeenCalled()
  })

  it('rejects a name that would not survive the revoke path', async () => {
    await start(VOLUME_LIFECYCLE)

    const response = await post('/api/v1/api-keys', {
      name: 'team/session',
      permissions: [OrganizationResourcePermission.READ_VOLUMES],
    })

    expect(response.status).toBe(400)
    expect(apiKeyService.createApiKey).not.toHaveBeenCalled()
  })

  it('passes an expiry through to the service as a Date', async () => {
    await start(VOLUME_LIFECYCLE)

    await post('/api/v1/api-keys', {
      name: 'expiring',
      permissions: [OrganizationResourcePermission.READ_VOLUMES],
      expires_at: '2026-12-01T00:00:00.000Z',
    })

    expect(apiKeyService.createApiKey).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'expiring',
      [OrganizationResourcePermission.READ_VOLUMES],
      new Date('2026-12-01T00:00:00.000Z'),
    )
  })

  it('lists the caller keys without ever re-exposing their values', async () => {
    await start(VOLUME_LIFECYCLE)

    const response = await fetch(url('/api/v1/api-keys'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      api_keys: [
        {
          name: 'session-provisioner',
          permissions: VOLUME_LIFECYCLE,
          created_at: '2026-08-24T00:00:00.000Z',
          last_used_at: '2026-08-24T01:00:00.000Z',
          expires_at: null,
        },
      ],
    })
  })

  it('revokes a key by name', async () => {
    await start(VOLUME_LIFECYCLE)

    const response = await fetch(url('/api/v1/api-keys/session-provisioner'), { method: 'DELETE' })

    expect(response.status).toBe(204)
    expect(apiKeyService.deleteApiKey).toHaveBeenCalledWith('org-1', 'user-1', 'session-provisioner')
  })
})
