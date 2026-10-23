/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationUserService } from './organization-user.service'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'

describe('OrganizationUserService membership lookups', () => {
  // TypeORM drops a where condition whose value is undefined, so the repository
  // answers with the organization's member whatever user is asked for.
  function serviceOverOneMember() {
    const member = { organizationId: 'org-1', userId: 'user-1', role: OrganizationMemberRole.OWNER }
    const repository = {
      findOne: jest.fn(async () => member),
      exists: jest.fn(async () => true),
    }
    return new OrganizationUserService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
  }

  // Machine credentials (runner, proxy, ...) carry no user, and callers such as the
  // preview access check pass their missing user id straight through.
  it('finds no membership for a caller without a user', async () => {
    const service = serviceOverOneMember()

    await expect(service.findOne('org-1', undefined as never)).resolves.toBeNull()
    await expect(service.exists('org-1', undefined as never)).resolves.toBe(false)
  })
})
