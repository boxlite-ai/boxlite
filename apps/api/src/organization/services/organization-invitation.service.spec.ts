/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationInvitationService } from './organization-invitation.service'
import { OrganizationInvitationStatus } from '../enums/organization-invitation-status.enum'
import { ConfigService } from '@nestjs/config'
import { OrganizationInvitation } from '../entities/organization-invitation.entity'
import { OrganizationEvents } from '../constants/organization-events.constant'
import { OrganizationInvitationController } from '../controllers/organization-invitation.controller'
import { FindOperator } from 'typeorm'

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

  const staleInvitations = [
    ['no longer pending', OrganizationInvitationStatus.ACCEPTED, 60_000],
    ['expired', OrganizationInvitationStatus.PENDING, -60_000],
  ] as const

  it('answers 409 when cancelling an invitation that is no longer pending', async () => {
    const { service, repository } = serviceFor({
      status: OrganizationInvitationStatus.ACCEPTED,
      expiresAt: new Date(Date.now() + 60_000),
    })

    await expect(service.cancel('org-1', 'inv-1')).rejects.toMatchObject({ status: 409 })
    expect(repository.save).not.toHaveBeenCalled()
  })

  it('allows removing an expired pending invitation without making it acceptable', async () => {
    const expired = { status: OrganizationInvitationStatus.PENDING, expiresAt: new Date(0) }
    const { service, repository } = serviceFor(expired)
    await expect(service.accept('inv-1', 'user-1')).rejects.toMatchObject({ status: 409 })
    await expect(service.cancel('org-1', 'inv-1')).resolves.toBeUndefined()
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: OrganizationInvitationStatus.CANCELLED }),
    )
    expect(repository.findOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 'inv-1', organizationId: 'org-1' } }),
    )
  })

  it.each(staleInvitations)('answers 409 when updating an invitation that is %s', async (_, status, expiresInMs) => {
    const { service, repository } = serviceFor({ status, expiresAt: new Date(Date.now() + expiresInMs) })

    await expect(service.update('org-1', 'inv-1', { assignedRoleIds: [] } as never)).rejects.toMatchObject({
      status: 409,
    })
    expect(repository.save).not.toHaveBeenCalled()
  })
})

describe('Expired invitation management listing', () => {
  it('includes expired pending rows in the console but keeps the default listing unexpired-only', async () => {
    const rows = [
      {
        id: 'live',
        organizationId: 'org-1',
        status: OrganizationInvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 60_000),
      },
      { id: 'expired', organizationId: 'org-1', status: OrganizationInvitationStatus.PENDING, expiresAt: new Date(0) },
      {
        id: 'cancelled',
        organizationId: 'org-1',
        status: OrganizationInvitationStatus.CANCELLED,
        expiresAt: new Date(0),
      },
      {
        id: 'other-org',
        organizationId: 'org-2',
        status: OrganizationInvitationStatus.PENDING,
        expiresAt: new Date(0),
      },
    ].map((row) => ({ ...row, organization: { name: 'Acme' }, assignedRoles: [] }))
    const repository = {
      find: jest.fn(
        async ({
          where,
        }: {
          where: { organizationId: string; status: OrganizationInvitationStatus; expiresAt?: FindOperator<Date> }
        }) =>
          rows.filter(
            (row) =>
              row.organizationId === where.organizationId &&
              row.status === where.status &&
              (!where.expiresAt || row.expiresAt > where.expiresAt.value),
          ),
      ),
    }
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
    const controller = new OrganizationInvitationController(service)
    expect((await controller.findPending('org-1')).map((row) => row.id)).toEqual(['live', 'expired'])
    expect((await service.findPending('org-1')).map((row) => row.id)).toEqual(['live'])
  })
})

describe('OrganizationInvitationService lifetime', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-15T12:00:00Z')))
  afterEach(() => jest.useRealTimers())

  function createService() {
    const repository = {
      findOne: jest.fn(async () => null),
      save: jest.fn(async (value: OrganizationInvitation) => value),
    }
    const events = { emit: jest.fn() }
    const service = new OrganizationInvitationService(
      repository as never,
      { findOne: async () => ({ id: 'org-1', name: 'Acme' }) } as never,
      {} as never,
      { findByIds: async () => [] } as never,
      { findOneByEmail: async () => null } as never,
      events as never,
      {} as never,
      new ConfigService({ organizationInvitation: { ttlSeconds: 3600 } }),
    )
    return { service, repository, events }
  }

  it('stores the configured deadline and sends that same deadline to the mail event', async () => {
    const { service, repository, events } = createService()
    await service.create(
      'org-1',
      { email: 'invitee@example.com', role: 'owner', assignedRoleIds: [] } as never,
      'owner@example.com',
    )
    const expiresAt = new Date('2026-10-15T13:00:00Z')
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ expiresAt }))
    expect(events.emit).toHaveBeenCalledWith(
      OrganizationEvents.INVITATION_CREATED,
      expect.objectContaining({ expiresAt }),
    )
  })

  it('preserves an explicit API deadline', async () => {
    const { service, repository } = createService()
    const expiresAt = new Date('2026-10-16T12:00:00Z')
    await service.create(
      'org-1',
      { email: 'invitee@example.com', role: 'owner', assignedRoleIds: [], expiresAt } as never,
      'owner@example.com',
    )
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ expiresAt }))
  })
})
