/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException } from '@nestjs/common'
import { OrganizationInvitationService } from './organization-invitation.service'
import { OrganizationService } from './organization.service'
import { OrganizationUserService } from './organization-user.service'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { OrganizationInvitationAcceptedEvent } from '../events/organization-invitation-accepted.event'
import { SystemRole } from '../../user/enums/system-role.enum'
import { UserCreatedEvent } from '../../user/events/user-created.event'
import { UserDeletedEvent } from '../../user/events/user-deleted.event'
import { OrganizationDto } from '../dto/organization.dto'

const legacyOrganizationPersonalFlag = ['pers', 'onal'].join('')

function createEntityManager() {
  const saved: unknown[] = []
  const entityManager = {
    count: jest.fn().mockResolvedValue(0),
    findOne: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(undefined),
    save: jest.fn(async (entity) => {
      saved.push(entity)
      return entity
    }),
    transaction: jest.fn(async (callback) => callback(entityManager)),
  }

  return { entityManager, saved }
}

function createOrganizationService() {
  const configService = {
    get: jest.fn(() => undefined),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'organizationBoxDefaultLimitedNetworkEgress') return false
      throw new Error(`Unexpected config key: ${key}`)
    }),
  }

  return new OrganizationService(
    { manager: {} } as never,
    {} as never,
    {} as never,
    { emitAsync: jest.fn() } as never,
    configService as never,
    {} as never,
    {} as never,
    {} as never,
  )
}

describe('default organization membership semantics', () => {
  it('keeps the deprecated Organization.personal response field as an alias for the authenticated user default flag', () => {
    const dto = OrganizationDto.fromOrganization(
      {
        id: 'org-1',
        name: 'Default Organization',
        createdBy: 'user-1',
        createdAt: new Date('2026-06-08T00:00:00.000Z'),
        updatedAt: new Date('2026-06-08T00:00:00.000Z'),
        suspended: false,
        maxCpuPerBox: 4,
        maxMemoryPerBox: 8,
        maxDiskPerBox: 10,
        templateDeactivationTimeoutMinutes: 20160,
        boxLimitedNetworkEgress: false,
        authenticatedRateLimit: null,
        boxCreateRateLimit: null,
        boxLifecycleRateLimit: null,
        authenticatedRateLimitTtlSeconds: null,
        boxCreateRateLimitTtlSeconds: null,
        boxLifecycleRateLimitTtlSeconds: null,
      } as never,
      true,
    )

    expect(dto.isDefaultForAuthenticatedUser).toBe(true)
    expect(dto.personal).toBe(true)
  })

  it('creates signup default organizations as normal organizations with a default owner membership', async () => {
    const { entityManager, saved } = createEntityManager()
    const service = createOrganizationService()

    const organization = await service.handleUserCreatedEvent(
      new UserCreatedEvent(
        entityManager as never,
        {
          id: 'user-1',
          emailVerified: true,
          role: SystemRole.USER,
        } as never,
      ),
    )

    expect(organization.name).toBe('Default Organization')
    expect(organization).not.toHaveProperty('personal')
    expect(organization.users).toHaveLength(1)
    expect(organization.users[0]).toMatchObject({
      userId: 'user-1',
      role: OrganizationMemberRole.OWNER,
      isDefaultForUser: true,
    })
    expect(saved).toContain(organization)
  })

  it('allows invitations to default organizations because they are regular organizations', async () => {
    const organizationInvitationRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(async (invitation) => invitation),
    }
    const service = new OrganizationInvitationService(
      organizationInvitationRepository as never,
      {
        findOne: jest.fn().mockResolvedValue({
          id: 'org-1',
          name: 'Default Organization',
          [legacyOrganizationPersonalFlag]: true,
        }),
      } as never,
      {
        findOne: jest.fn().mockResolvedValue(null),
      } as never,
      {
        findByIds: jest.fn().mockResolvedValue([]),
      } as never,
      {
        findOneByEmail: jest.fn().mockResolvedValue(null),
      } as never,
      {
        emit: jest.fn(),
      } as never,
      {} as never,
      {} as never,
    )

    await expect(
      service.create(
        'org-1',
        {
          email: 'member@example.com',
          role: OrganizationMemberRole.MEMBER,
          assignedRoleIds: [],
        },
        'user-1',
      ),
    ).resolves.toMatchObject({
      organizationId: 'org-1',
      email: 'member@example.com',
    })
  })

  it('creates accepted invitation memberships as non-default memberships', async () => {
    const { entityManager } = createEntityManager()
    const service = new OrganizationUserService({} as never, {} as never, {} as never, {} as never, {} as never)

    await expect(
      service.handleOrganizationInvitationAcceptedEvent(
        new OrganizationInvitationAcceptedEvent(
          entityManager as never,
          'org-1',
          'user-2',
          OrganizationMemberRole.MEMBER,
          [],
        ),
      ),
    ).resolves.toMatchObject({
      organizationId: 'org-1',
      userId: 'user-2',
      role: OrganizationMemberRole.MEMBER,
      isDefaultForUser: false,
    })
  })

  it('protects removing a user from their default organization unless forced', async () => {
    const organizationUserRepository = {
      findOne: jest.fn().mockResolvedValue({
        organizationId: 'org-1',
        userId: 'user-1',
        role: OrganizationMemberRole.MEMBER,
        isDefaultForUser: true,
      }),
      manager: {
        remove: jest.fn(),
      },
    }
    const service = new OrganizationUserService(
      organizationUserRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )

    await expect(service.delete('org-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenException)
    expect(organizationUserRepository.manager.remove).not.toHaveBeenCalled()
  })

  it('does not delete a default organization that still has other members when its creator is deleted', async () => {
    const organization = { id: 'org-1' }
    const deletedUserMembership = {
      organizationId: 'org-1',
      userId: 'user-1',
      role: OrganizationMemberRole.OWNER,
      isDefaultForUser: true,
    }
    const fallbackOwner = {
      organizationId: 'org-1',
      userId: 'user-2',
      role: OrganizationMemberRole.MEMBER,
      isDefaultForUser: false,
    }
    const entityManager = {
      count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0),
      findOne: jest
        .fn()
        .mockResolvedValueOnce({ organization })
        .mockResolvedValueOnce(deletedUserMembership)
        .mockResolvedValueOnce(fallbackOwner),
      remove: jest.fn().mockResolvedValue(undefined),
      save: jest.fn(async (entity) => entity),
    }
    const service = createOrganizationService()

    await service.handleUserDeletedEvent(new UserDeletedEvent(entityManager as never, 'user-1'))

    expect(fallbackOwner.role).toBe(OrganizationMemberRole.OWNER)
    expect(entityManager.save).toHaveBeenCalledWith(fallbackOwner)
    expect(entityManager.remove).toHaveBeenCalledWith(deletedUserMembership)
    expect(entityManager.remove).not.toHaveBeenCalledWith(organization)
  })
})
