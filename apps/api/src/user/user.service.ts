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

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly eventEmitter: EventEmitter2,
    private readonly dataSource: DataSource,
  ) {}

  /** Records the user.registration events of the new user, started by ctx. */
  async create(createUserDto: CreateUserDto, ctx: Context): Promise<User> {
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
      () =>
        this.dataSource.transaction(async (em) => {
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
          return created.find((value): value is Organization => value instanceof Organization)
        }),
      (error) => (error instanceof UserAlreadyExistsException ? 'user_conflict' : 'internal'),
      (organization) => organization?.id,
    )

    return user
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
