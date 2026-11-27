/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { OrganizationRoleService } from './organization-role.service'

describe('OrganizationRoleService cache invalidation', () => {
  it('invalidates every assigned member after role permissions change', async () => {
    const role = {
      id: 'role-1',
      organizationId: 'org-1',
      isGlobal: false,
      users: [
        { organizationId: 'org-1', userId: 'user-1' },
        { organizationId: 'org-1', userId: 'user-2' },
      ],
    }
    const repository = {
      findOne: jest.fn().mockResolvedValue(role),
      save: jest.fn().mockImplementation(async (value) => value),
    }
    const redis = { eval: jest.fn().mockResolvedValue(1) }
    const service = new OrganizationRoleService(repository as any)
    ;(service as any).redis = redis

    await service.update('org-1', 'role-1', { name: 'Support', description: 'Support', permissions: [] })

    expect(redis.eval).toHaveBeenCalledTimes(2)
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      'organization-access:generation:organization-user:org-1:user-1',
      'organization-user:org-1:user-1',
    )
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      'organization-access:generation:organization-user:org-1:user-2',
      'organization-user:org-1:user-2',
    )
  })
})
