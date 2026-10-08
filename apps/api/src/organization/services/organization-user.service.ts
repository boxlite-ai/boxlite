/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { InjectRepository } from '@nestjs/typeorm'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { DataSource, EntityManager, Repository } from 'typeorm'
import { OrganizationRoleService } from './organization-role.service'
import { OrganizationEvents } from '../constants/organization-events.constant'
import { OrganizationUserDto } from '../dto/organization-user.dto'
import { OrganizationUser } from '../entities/organization-user.entity'
import { OrganizationRole } from '../entities/organization-role.entity'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../enums/organization-resource-permission.enum'
import { OrganizationInvitationAcceptedEvent } from '../events/organization-invitation-accepted.event'
import { OrganizationResourcePermissionsUnassignedEvent } from '../events/organization-resource-permissions-unassigned.event'
import { OrganizationUserRemovedEvent } from '../events/organization-user-removed.event'
import { OnAsyncEvent } from '../../common/decorators/on-async-event.decorator'
import { UserService } from '../../user/user.service'
import { UserEvents } from '../../user/constants/user-events.constant'
import { UserDeletedEvent } from '../../user/events/user-deleted.event'

@Injectable()
export class OrganizationUserService {
  private readonly logger = new Logger(OrganizationUserService.name)

  constructor(
    @InjectRepository(OrganizationUser)
    private readonly organizationUserRepository: Repository<OrganizationUser>,
    private readonly organizationRoleService: OrganizationRoleService,
    private readonly userService: UserService,
    private readonly eventEmitter: EventEmitter2,
    private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  /** Redis key under which OrganizationAccessGuard caches a membership. */
  static membershipCacheKey(organizationId: string, userId: string): string {
    return `organization-user:${organizationId}:${userId}`
  }

  async findAll(organizationId: string): Promise<OrganizationUserDto[]> {
    const organizationUsers = await this.organizationUserRepository.find({
      where: { organizationId },
      relations: {
        assignedRoles: true,
      },
    })

    const userIds = organizationUsers.map((orgUser) => orgUser.userId)

    const users = await this.userService.findByIds(userIds)
    const userMap = new Map(users.map((user) => [user.id, user]))

    const dtos: OrganizationUserDto[] = organizationUsers.map((orgUser) => {
      const user = userMap.get(orgUser.userId)
      return OrganizationUserDto.fromEntities(orgUser, user)
    })

    return dtos
  }

  async findOne(organizationId: string, userId: string): Promise<OrganizationUser | null> {
    return this.organizationUserRepository.findOne({
      where: { organizationId, userId },
      relations: {
        assignedRoles: true,
      },
    })
  }

  async exists(organizationId: string, userId: string): Promise<boolean> {
    return this.organizationUserRepository.exists({
      where: { organizationId, userId },
    })
  }

  async updateAccess(
    organizationId: string,
    userId: string,
    role: OrganizationMemberRole,
    assignedRoleIds: string[],
  ): Promise<OrganizationUserDto> {
    let organizationUser = await this.organizationUserRepository.findOne({
      where: {
        organizationId,
        userId,
      },
      relations: {
        assignedRoles: true,
      },
    })

    if (!organizationUser) {
      throw new NotFoundException(`User with ID ${userId} not found in organization with ID ${organizationId}`)
    }

    // validate role
    if (organizationUser.role === OrganizationMemberRole.OWNER && role !== OrganizationMemberRole.OWNER) {
      const ownersCount = await this.organizationUserRepository.count({
        where: {
          organizationId,
          role: OrganizationMemberRole.OWNER,
        },
      })

      if (ownersCount === 1) {
        throw new ForbiddenException('The organization must have at least one owner')
      }
    }

    // validate assignments
    const assignedRoles = await this.organizationRoleService.findByIds(assignedRoleIds)
    if (assignedRoles.length !== assignedRoleIds.length) {
      throw new BadRequestException('One or more role IDs are invalid')
    }

    // check if any previous permissions are not present in the new assignments, api keys with those permissions will be revoked
    let permissionsToRevoke: OrganizationResourcePermission[] = []
    if (role !== OrganizationMemberRole.OWNER) {
      const prevPermissions = this.getAssignedPermissions(organizationUser.role, organizationUser.assignedRoles)
      const newPermissions = this.getAssignedPermissions(role, assignedRoles)
      permissionsToRevoke = Array.from(prevPermissions).filter((permission) => !newPermissions.has(permission))
    }

    organizationUser.role = role
    organizationUser.assignedRoles = assignedRoles

    if (permissionsToRevoke.length > 0) {
      await this.dataSource.transaction(async (em) => {
        organizationUser = await em.save(organizationUser)
        await this.eventEmitter.emitAsync(
          OrganizationEvents.PERMISSIONS_UNASSIGNED,
          new OrganizationResourcePermissionsUnassignedEvent(em, organizationId, userId, permissionsToRevoke),
        )
      })
    } else {
      organizationUser = await this.organizationUserRepository.save(organizationUser)
    }

    const user = await this.userService.findOne(userId)

    return OrganizationUserDto.fromEntities(organizationUser, user)
  }

  async delete(organizationId: string, userId: string): Promise<void> {
    const organizationUser = await this.organizationUserRepository.findOne({
      where: {
        organizationId,
        userId,
      },
    })

    if (!organizationUser) {
      throw new NotFoundException(`User with ID ${userId} not found in organization with ID ${organizationId}`)
    }

    // Listeners revoke what the membership granted, such as the member's API keys,
    // in the same transaction, so the rows are deleted together or not at all.
    const removal = await this.dataSource.transaction(async (em) => {
      const event = new OrganizationUserRemovedEvent(em, organizationId, userId)
      await this.removeWithEntityManager(em, organizationUser)
      await this.eventEmitter.emitAsync(OrganizationEvents.USER_REMOVED, event)
      return event
    })

    // Caches are cleared only after commit, so a request that refills one reads the removal.
    await removal.runAfterCommitTasks()
    const cacheKey = OrganizationUserService.membershipCacheKey(organizationId, userId)
    try {
      await this.redis.del(cacheKey)
    } catch (error) {
      this.logger.error(`Failed to invalidate membership cache ${cacheKey}:`, error)
    }
  }

  private async removeWithEntityManager(
    entityManager: EntityManager,
    organizationUser: OrganizationUser,
    force = false,
  ): Promise<void> {
    if (!force) {
      if (organizationUser.isDefaultForUser) {
        throw new ForbiddenException('Cannot remove a user from their default organization')
      }

      if (organizationUser.role === OrganizationMemberRole.OWNER) {
        const ownersCount = await entityManager.count(OrganizationUser, {
          where: {
            organizationId: organizationUser.organizationId,
            role: OrganizationMemberRole.OWNER,
          },
        })

        if (ownersCount === 1) {
          throw new ForbiddenException(
            `Organization with ID ${organizationUser.organizationId} must have at least one owner`,
          )
        }
      }
    }

    await entityManager.remove(organizationUser)
  }

  private async createWithEntityManager(
    entityManager: EntityManager,
    organizationId: string,
    userId: string,
    role: OrganizationMemberRole,
    assignedRoles: OrganizationRole[],
  ): Promise<OrganizationUser> {
    const organizationUser = new OrganizationUser()
    organizationUser.organizationId = organizationId
    organizationUser.userId = userId
    organizationUser.role = role
    organizationUser.assignedRoles = assignedRoles
    organizationUser.isDefaultForUser = false
    return entityManager.save(organizationUser)
  }

  @OnAsyncEvent({
    event: OrganizationEvents.INVITATION_ACCEPTED,
  })
  async handleOrganizationInvitationAcceptedEvent(
    payload: OrganizationInvitationAcceptedEvent,
  ): Promise<OrganizationUser> {
    return this.createWithEntityManager(
      payload.entityManager,
      payload.organizationId,
      payload.userId,
      payload.role,
      payload.assignedRoles,
    )
  }

  @OnAsyncEvent({
    event: UserEvents.DELETED,
  })
  async handleUserDeletedEvent(payload: UserDeletedEvent): Promise<void> {
    const memberships = await payload.entityManager.find(OrganizationUser, {
      where: {
        userId: payload.userId,
        isDefaultForUser: false,
      },
      relations: {
        organization: true,
      },
    })

    /*
    // TODO
    // user deletion will fail if the user is the only owner of some organization
    // potential improvements:
    //  - auto-delete the organization if there are no other members
    //  - auto-promote a new owner if there are other members
    */
    await Promise.all(memberships.map((membership) => this.removeWithEntityManager(payload.entityManager, membership)))
  }

  private getAssignedPermissions(
    role: OrganizationMemberRole,
    assignedRoles: OrganizationRole[],
  ): Set<OrganizationResourcePermission> {
    if (role === OrganizationMemberRole.OWNER) {
      return new Set(Object.values(OrganizationResourcePermission))
    }

    return new Set(assignedRoles.flatMap((role) => role.permissions))
  }
}
