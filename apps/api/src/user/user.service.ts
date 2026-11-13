/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { User } from './user.entity'
import { DataSource, ILike, In, QueryFailedError, Repository } from 'typeorm'
import { CreateUserDto } from './dto/create-user.dto'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { UserEvents } from './constants/user-events.constant'
import { UpdateUserDto } from './dto/update-user.dto'
import { UserCreatedEvent } from './events/user-created.event'
import { UserDeletedEvent } from './events/user-deleted.event'
import { UserEmailVerifiedEvent } from './events/user-email-verified.event'
import { recordOutcomes } from '../common/utils/business-event.util'
import { Organization } from '../organization/entities/organization.entity'
import { Context } from '../common/context/context'
import { normalizeRegistrationEmail } from './registration-email'
import { UserAlreadyExistsException } from './user-already-exists.exception'

import { CommerceInternalClient } from '../commerce/commerce-internal.client'
import { CommerceConflictError, CommerceUnavailableError } from '../commerce/commerce.errors'
import { ReferralRegistrationException } from '../exceptions/referral-registration.exception'

function registrationExceptionType(error: unknown): string {
  if (error instanceof ReferralRegistrationException) {
    return error.code
  }
  return error instanceof UserAlreadyExistsException ? 'user_conflict' : 'internal'
}

// Commerce's answers refuse the sign-up with a code the client acts on; any
// other failure is a bug and surfaces unchanged.
function referralRefusal(error: unknown): unknown {
  if (error instanceof CommerceConflictError) {
    return new ReferralRegistrationException('referral_conflict')
  }
  if (error instanceof CommerceUnavailableError) {
    return new ReferralRegistrationException('referral_unavailable')
  }
  return error
}

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly eventEmitter: EventEmitter2,
    private readonly dataSource: DataSource,
    private readonly commerce: CommerceInternalClient,
  ) {}

  /**
   * @param ctx the actor and reason recorded on registration business events.
   * @param referralCode the raw referral code sent with the request creating the account.
   * It is ignored when blank or when Commerce is not configured; otherwise it must
   * resolve to the inviting organization, and Commerce must accept the referral
   * event sent before the account commits, or no user is created.
   * @throws ReferralRegistrationException when a referral code cannot be resolved,
   * the account has no email Commerce accepts, or Commerce refuses the referral event.
   */
  async create(createUserDto: CreateUserDto, ctx: Context, referralCode?: string): Promise<User> {
    const email = createUserDto.email ? normalizeRegistrationEmail(createUserDto.email) : undefined

    const defaultOrganizationDefaultRegionId =
      createUserDto.defaultOrganizationDefaultRegionId ?? createUserDto.personalOrganizationDefaultRegionId
    let user = new User()
    user.id = createUserDto.id
    user.name = createUserDto.name
    user.publicKeys = []
    user.emailVerified = createUserDto.emailVerified

    if (email) {
      user.email = email
    }

    if (createUserDto.role) {
      user.role = createUserDto.role
    }

    await recordOutcomes(
      { name: 'user.registration', correlationId: createUserDto.id, ctx },
      async () => {
        user.referredByOrganizationId = await this.resolveReferral(referralCode, user.email)
        return this.dataSource.transaction(async (em) => {
          try {
            await em.insert(User, user)
          } catch (error) {
            if (
              error instanceof QueryFailedError &&
              error.driverError.code === '23505' &&
              (error.driverError.constraint === 'user_id_pk' ||
                error.driverError.constraint === 'PK_cace4a159ff9f2512dd42373760')
            ) {
              throw new UserAlreadyExistsException(error)
            }
            throw error
          }
          // Event handlers need the persisted defaults, including role and emailVerified.
          user = await em.findOneByOrFail(User, { id: user.id })
          // The default organization's listener returns it; the registration belongs to it.
          const created = await this.eventEmitter.emitAsync(
            UserEvents.CREATED,
            new UserCreatedEvent(em, user, defaultOrganizationDefaultRegionId),
          )
          if (user.referredByOrganizationId) {
            try {
              await this.commerce.publishReferralNewer(user.referredByOrganizationId, user)
            } catch (error) {
              throw referralRefusal(error)
            }
          }
          return created.find((value): value is Organization => value instanceof Organization)
        })
      },
      registrationExceptionType,
      (organization) => organization?.id,
    )

    return user
  }

  private async resolveReferral(referralCode: string | undefined, email: string | undefined): Promise<string | null> {
    if (!referralCode?.trim() || !this.commerce.isConfigured()) {
      return null
    }
    if (!this.commerce.acceptsInviteeEmail(email)) {
      throw new ReferralRegistrationException('referral_email_required')
    }

    let organizationId: string | null
    try {
      organizationId = await this.commerce.resolveReferralCode(referralCode)
    } catch (error) {
      throw referralRefusal(error)
    }
    if (!organizationId) {
      throw new ReferralRegistrationException('invalid_referral_code')
    }
    return organizationId
  }

  async findAll(): Promise<User[]> {
    return this.userRepository.find()
  }

  async findByIds(ids: string[]): Promise<User[]> {
    if (ids.length === 0) {
      return []
    }

    return this.userRepository.find({
      where: {
        id: In(ids),
      },
    })
  }

  async findOne(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } })
  }

  async findOneOrFail(id: string): Promise<User> {
    return this.userRepository.findOneOrFail({ where: { id } })
  }

  async findOneByEmail(email: string, ignoreCase = false): Promise<User | null> {
    return this.userRepository.findOne({
      where: {
        email: ignoreCase ? ILike(email) : email,
      },
    })
  }

  async remove(id: string): Promise<void> {
    const deletion = await this.dataSource.transaction(async (em) => {
      await em.delete(User, id)
      const event = new UserDeletedEvent(em, id)
      await this.eventEmitter.emitAsync(UserEvents.DELETED, event)
      return event
    })
    await deletion.runAfterCommitTasks()
  }

  // TODO: discuss if we need separate methods for updating specific fields
  async update(userId: string, updateUserDto: UpdateUserDto): Promise<User> {
    const user = await this.userRepository.findOne({
      where: {
        id: userId,
      },
    })

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found.`)
    }

    if (updateUserDto.name) {
      user.name = updateUserDto.name
    }

    if (updateUserDto.email) {
      user.email = updateUserDto.email
    }

    if (updateUserDto.role) {
      user.role = updateUserDto.role
    }

    if (updateUserDto.emailVerified) {
      user.emailVerified = updateUserDto.emailVerified
      await this.dataSource.transaction(async (em) => {
        await em.save(user)
        await this.eventEmitter.emitAsync(UserEvents.EMAIL_VERIFIED, new UserEmailVerifiedEvent(em, user.id))
      })
    }

    return this.userRepository.save(user)
  }
}
