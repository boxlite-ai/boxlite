/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { OrganizationUserService } from './organization-user.service'

describe('OrganizationUserService cache invalidation', () => {
  it('invalidates membership access after the removal transaction commits', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(1) }
    const service = new OrganizationUserService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      redis as any,
    )
    let afterCommit!: () => Promise<void>
    const event = {
      organizationId: 'org-1',
      userId: 'user-1',
      afterCommit: jest.fn((task: () => Promise<void>) => (afterCommit = task)),
    }

    await service.handleOrganizationUserRemovedEvent(event as any)
    await afterCommit()

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      'organization-access:generation:organization-user:org-1:user-1',
      'organization-user:org-1:user-1',
    )
  })
})
