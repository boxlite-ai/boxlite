/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { LinkedIdentityService } from './linked-identity.service'

describe('LinkedIdentityService access cache invalidation', () => {
  it('invalidates both users after memberships move', async () => {
    const secondary = { id: 'secondary' }
    const membership = { organizationId: 'org-1', role: 'member', isDefaultForUser: false }
    const queryBuilder = {
      setLock: () => queryBuilder,
      where: () => queryBuilder,
      getOne: async () => secondary,
    }
    const entityManager = {
      createQueryBuilder: () => queryBuilder,
      findOne: async () => ({ id: 'primary' }),
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM "organization_user" WHERE "userId" = $1')) {
          return params[0] === 'secondary' ? [membership] : []
        }
        return []
      }),
    }
    const dataSource = {
      transaction: async (operation: (manager: typeof entityManager) => Promise<unknown>) => operation(entityManager),
    }
    const redis = { eval: jest.fn().mockResolvedValue(1), del: jest.fn() }
    const service = new LinkedIdentityService(dataSource as any, redis as any)

    await service.adopt('primary', 'secondary')

    expect(redis.eval).toHaveBeenCalledTimes(2)
    for (const userId of ['primary', 'secondary']) {
      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        2,
        `organization-access:generation:organization-user:org-1:${userId}`,
        `organization-user:org-1:${userId}`,
      )
    }
  })
})
