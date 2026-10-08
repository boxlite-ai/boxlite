/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationInvitationService } from './organization-invitation.service'
import { OrganizationInvitationStatus } from '../enums/organization-invitation-status.enum'

// A script must tell a stale invitation (409) from a missing owner role (403).
describe('OrganizationInvitationService state errors', () => {
  function serviceFor(invitation: { status: OrganizationInvitationStatus; expiresAt: Date }) {
    const repository = { findOne: jest.fn(async () => invitation), save: jest.fn() }
    const service = new OrganizationInvitationService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    return { service, repository }
  }

  it.each([
    ['no longer pending', OrganizationInvitationStatus.ACCEPTED, 60_000],
    ['expired', OrganizationInvitationStatus.PENDING, -60_000],
  ])('answers 409 when cancelling an invitation that is %s', async (_, status, expiresInMs) => {
    const { service, repository } = serviceFor({ status, expiresAt: new Date(Date.now() + expiresInMs) })

    await expect(service.cancel('org-1', 'inv-1')).rejects.toMatchObject({ status: 409 })
    expect(repository.save).not.toHaveBeenCalled()
  })
})
