/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { ApiKey } from '../api-key/api-key.entity'
import { ApiKeyService } from '../api-key/api-key.service'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { UserService } from '../user/user.service'
import { McpAuthorizationService } from './mcp-authorization.service'

describe('McpAuthorizationService', () => {
  const key = {
    userId: 'user-1',
    organizationId: 'org-1',
    keyHash: 'stored-hash',
    name: 'agent',
    permissions: [Permission.WRITE_BOXES],
  } as ApiKey
  let keys: { getApiKeyByValue: jest.Mock; getApiKeyByHash: jest.Mock }
  let users: { findOne: jest.Mock }
  let memberships: { findOne: jest.Mock }
  let service: McpAuthorizationService

  beforeEach(() => {
    keys = { getApiKeyByValue: jest.fn().mockResolvedValue(key), getApiKeyByHash: jest.fn().mockResolvedValue(key) }
    users = {
      findOne: jest.fn().mockResolvedValue({ id: key.userId, email: 'user@example.com', role: SystemRole.USER }),
    }
    memberships = { findOne: jest.fn().mockResolvedValue({ role: OrganizationMemberRole.OWNER }) }
    service = new McpAuthorizationService(
      keys as unknown as ApiKeyService,
      users as unknown as UserService,
      { findOne: jest.fn().mockResolvedValue({ id: key.organizationId }) } as unknown as OrganizationService,
      memberships as unknown as OrganizationUserService,
      undefined as never,
      undefined as never,
      undefined as never,
    )
  })

  it('binds the organization to the key and limits an owner to that key’s permissions', async () => {
    const caller = await service.authenticateKey('test-bearer')
    expect(caller.organizationId).toBe(key.organizationId)
    expect(caller.scopes).toEqual(['boxes:read', 'boxes:write'])
    expect(caller.credential).toEqual({ kind: 'api_key', keyHash: key.keyHash })
    await expect(service.authorize(caller, 'boxes:delete')).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('checks current membership even when the key still holds a removed permission', async () => {
    const caller = await service.authenticateKey('test-bearer')
    memberships.findOne.mockResolvedValue({ role: OrganizationMemberRole.MEMBER, assignedRoles: [] })
    await expect(service.authorize(caller, 'boxes:write')).rejects.toBeInstanceOf(ForbiddenException)
    memberships.findOne.mockResolvedValue(null)
    await expect(service.authorize(caller, 'boxes:read')).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('rejects a revoked key before dispatch instead of using its authenticated snapshot', async () => {
    const caller = await service.authenticateKey('test-bearer')
    keys.getApiKeyByHash.mockRejectedValue(new NotFoundException())
    await expect(service.authorize(caller, 'boxes:write')).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('rejects keys moved to another user or organization', async () => {
    const caller = await service.authenticateKey('test-bearer')
    keys.getApiKeyByHash.mockResolvedValue({ ...key, userId: 'other-user' })
    await expect(service.authorize(caller, 'boxes:read')).rejects.toBeInstanceOf(UnauthorizedException)
    keys.getApiKeyByHash.mockResolvedValue({ ...key, organizationId: 'other-org' })
    await expect(service.authorize(caller, 'boxes:read')).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('rejects machine, admin and expired credentials', async () => {
    keys.getApiKeyByValue.mockRejectedValueOnce(new NotFoundException())
    await expect(service.authenticateKey('machine-secret')).rejects.toBeInstanceOf(UnauthorizedException)
    users.findOne.mockResolvedValueOnce({ id: key.userId, role: SystemRole.ADMIN })
    await expect(service.authenticateKey('admin-key')).rejects.toBeInstanceOf(UnauthorizedException)
    keys.getApiKeyByValue.mockResolvedValueOnce({ ...key, expiresAt: new Date(0) })
    await expect(service.authenticateKey('expired-key')).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('propagates storage outages instead of misreporting revoked credentials', async () => {
    const unavailable = new Error('database unavailable')
    keys.getApiKeyByValue.mockRejectedValue(unavailable)
    await expect(service.authenticateKey('test-bearer')).rejects.toBe(unavailable)
  })
})
