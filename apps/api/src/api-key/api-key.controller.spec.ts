/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException } from '@nestjs/common'
import { ApiKey } from './api-key.entity'
import { ApiKeyController } from './api-key.controller'
import { ApiKeyService } from './api-key.service'
import { CreateApiKeyDto } from './dto/create-api-key.dto'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { SystemRole } from '../user/enums/system-role.enum'

describe('ApiKeyController.createApiKey — expiry is bounded by the calling key', () => {
  const CALLER_EXPIRY = new Date('2026-10-01T00:00:00.000Z')

  function controller() {
    const apiKeyService = {
      createApiKey: jest.fn().mockResolvedValue({ apiKey: {} as ApiKey, value: 'blk_test_minted' }),
    }
    return { controller: new ApiKeyController(apiKeyService as unknown as ApiKeyService), apiKeyService }
  }

  function keyCallerContext(expiresAt?: Date): OrganizationAuthContext {
    return {
      userId: 'user-1',
      email: 'dev@example.com',
      role: SystemRole.USER,
      organizationId: 'org-1',
      organization: { id: 'org-1' },
      apiKey: { permissions: [OrganizationResourcePermission.WRITE_BOXES], expiresAt } as ApiKey,
      organizationUser: { role: OrganizationMemberRole.OWNER, assignedRoles: [] },
    } as OrganizationAuthContext
  }

  function dto(expiresAt?: Date): CreateApiKeyDto {
    return { name: 'child', permissions: [OrganizationResourcePermission.WRITE_BOXES], expiresAt } as CreateApiKeyDto
  }

  it('refuses a child expiry later than the calling key expiry', async () => {
    const { controller: sut, apiKeyService } = controller()

    await expect(
      sut.createApiKey(keyCallerContext(CALLER_EXPIRY), dto(new Date('2027-01-01T00:00:00.000Z'))),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(apiKeyService.createApiKey).not.toHaveBeenCalled()
  })

  it('caps a non-expiring child to the calling key expiry', async () => {
    const { controller: sut, apiKeyService } = controller()

    await sut.createApiKey(keyCallerContext(CALLER_EXPIRY), dto(undefined))

    expect(apiKeyService.createApiKey).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'child',
      [OrganizationResourcePermission.WRITE_BOXES],
      CALLER_EXPIRY,
    )
  })

  it('preserves an earlier child expiry', async () => {
    const { controller: sut, apiKeyService } = controller()
    const earlier = new Date('2026-09-01T00:00:00.000Z')

    await sut.createApiKey(keyCallerContext(CALLER_EXPIRY), dto(earlier))

    expect(apiKeyService.createApiKey).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'child',
      [OrganizationResourcePermission.WRITE_BOXES],
      earlier,
    )
  })

  it('leaves a non-expiring caller and interactive sessions unbounded', async () => {
    const { controller: sut, apiKeyService } = controller()
    const requested = new Date('2030-01-01T00:00:00.000Z')

    await sut.createApiKey(keyCallerContext(undefined), dto(requested))
    const interactive = { ...keyCallerContext(undefined), apiKey: undefined } as OrganizationAuthContext
    await sut.createApiKey(interactive, dto(requested))

    expect(apiKeyService.createApiKey).toHaveBeenCalledTimes(2)
    expect(apiKeyService.createApiKey).toHaveBeenNthCalledWith(
      1,
      'org-1',
      'user-1',
      'child',
      expect.anything(),
      requested,
    )
    expect(apiKeyService.createApiKey).toHaveBeenNthCalledWith(
      2,
      'org-1',
      'user-1',
      'child',
      expect.anything(),
      requested,
    )
  })
})
