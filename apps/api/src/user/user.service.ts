/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { User, UserSSHKeyPair } from './user.entity'
import { DataSource, EntityManager, ILike, In, Repository } from 'typeorm'
import { CreateUserDto } from './dto/create-user.dto'
import * as crypto from 'crypto'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { UserEvents } from './constants/user-events.constant'
import { UpdateUserDto } from './dto/update-user.dto'
import { UserCreatedEvent } from './events/user-created.event'
import { UserDeletedEvent } from './events/user-deleted.event'
import { UserEmailVerifiedEvent } from './events/user-email-verified.event'
import { UserRegistration } from './user-registration.entity'
import { UserRegistrationService } from './user-registration.service'
import { OrganizationReferralService } from '../organization-referral/organization-referral.service'
import { RegistrationException, isLockTimeout } from '../organization-referral/referral-code'
import { Organization } from '../organization/entities/organization.entity'

export interface RegistrationContext {
  referredCode?: string
  confirmInvitation?: boolean
}

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly eventEmitter: EventEmitter2,
    private readonly dataSource: DataSource,
    private readonly registrations: UserRegistrationService,
    private readonly referrals: OrganizationReferralService,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
    return this.withSubjectLock(createUserDto.id, async (em) => {
      const registration = await em.findOneBy(UserRegistration, { userId: createUserDto.id })
      const existing = await em.findOneBy(User, { id: createUserDto.id })
      if (registration && !existing) throw new RegistrationException(410, 'registration_unavailable')
      if (existing) throw new RegistrationException(409, 'registration_already_finalized')
      const user = await this.createWithEntityManager(em, createUserDto)
      await this.registrations.record(em, user, undefined, true)
      return user
    })
  }

  async authenticate(dto: CreateUserDto, context: RegistrationContext = {}): Promise<User> {
    return this.withSubjectLock(dto.id, async (em) => {
      let user = await em.findOneBy(User, { id: dto.id })
      let registration = await em.findOneBy(UserRegistration, { userId: dto.id })
      if (registration && !user) throw new RegistrationException(410, 'registration_unavailable')

      if (!user) {
        const inviter = context.referredCode ? await this.referrals.resolveInviter(em, context.referredCode) : undefined
        user = await this.createWithEntityManager(em, dto, inviter)
        registration = await this.registrations.record(em, user, inviter, true)
      } else {
        registration ??= await this.registrations.record(em, user)
        this.registrations.assertReplay(registration, context.referredCode)
        const becameVerified = !user.emailVerified && dto.emailVerified === true
        if (user.name === 'Unknown' || !user.email) user.name = dto.name
        if (dto.email) user.email = dto.email
        if (becameVerified) user.emailVerified = true
        user = await em.save(user)
        if (becameVerified) {
          await this.eventEmitter.emitAsync(UserEvents.EMAIL_VERIFIED, new UserEmailVerifiedEvent(em, user.id))
          await this.registrations.confirm(em, user, registration)
        }
      }
      if (context.confirmInvitation) await this.registrations.confirm(em, user, registration)
      return user
    })
  }

  private async withSubjectLock<T>(userId: string, operation: (em: EntityManager) => Promise<T>): Promise<T> {
    if (typeof userId !== 'string' || !userId) throw new RegistrationException(401, 'invalid_identity')
    try {
      return await this.dataSource.transaction(async (em) => {
        await em.query("SET LOCAL lock_timeout = '5s'")
        await em.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['user-registration:' + userId])
        return operation(em)
      })
    } catch (error) {
      if (isLockTimeout(error)) throw new RegistrationException(503, 'registration_busy')
      throw error
    }
  }

  private async createWithEntityManager(
    em: EntityManager,
    createUserDto: CreateUserDto,
    inviter?: Organization,
  ): Promise<User> {
    const defaultOrganizationDefaultRegionId =
      createUserDto.defaultOrganizationDefaultRegionId ?? createUserDto.personalOrganizationDefaultRegionId
    let user = new User()
    user.id = createUserDto.id
    user.name = createUserDto.name
    const keyPair = await this.generatePrivateKey()
    user.keyPair = keyPair
    user.publicKeys = []
    user.emailVerified = createUserDto.emailVerified

    if (createUserDto.email) {
      user.email = createUserDto.email
    }

    if (createUserDto.role) {
      user.role = createUserDto.role
    }

    user = await em.save(user)
    await this.eventEmitter.emitAsync(
      UserEvents.CREATED,
      new UserCreatedEvent(
        em,
        user,
        defaultOrganizationDefaultRegionId,
        inviter ? { inviterOrganizationId: inviter.id, referredCode: inviter.referralCode } : undefined,
      ),
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
    await this.withSubjectLock(id, async (em) => {
      const user = await em.findOneBy(User, { id })
      if (user && !(await em.findOneBy(UserRegistration, { userId: id }))) {
        await this.registrations.record(em, user)
      }
      await em.delete(User, id)
      await this.eventEmitter.emitAsync(UserEvents.DELETED, new UserDeletedEvent(em, id))
    })
  }

  /**
   * @deprecated The generated keys are no longer consumed by anything.
   * Scheduled for removal in a future release.
   */
  async regenerateKeyPair(id: string): Promise<User> {
    const user = await this.userRepository.findOneBy({ id: id })
    const keyPair = await this.generatePrivateKey()
    user.keyPair = keyPair
    return this.userRepository.save(user)
  }

  /**
   * @deprecated Feeds only the deprecated {@link User.keyPair} column.
   * Scheduled for removal in a future release.
   */
  private generatePrivateKey(): Promise<UserSSHKeyPair> {
    const comment = 'boxlite'

    return new Promise((resolve, reject) => {
      crypto.generateKeyPair(
        'rsa',
        {
          modulusLength: 4096,
          publicKeyEncoding: {
            type: 'pkcs1',
            format: 'pem',
          },
          privateKeyEncoding: {
            type: 'pkcs1',
            format: 'pem',
          },
        },
        (error, publicKey, privateKey) => {
          if (error) {
            reject(error)
          } else {
            resolve({
              publicKey: this.encodeOpenSshRsaPublicKey(publicKey, comment),
              privateKey,
            })
          }
        },
      )
    })
  }

  private encodeOpenSshRsaPublicKey(publicKeyPem: string, comment: string): string {
    const publicKey = crypto.createPublicKey(publicKeyPem)
    const jwk = publicKey.export({ format: 'jwk' }) as { e?: string; n?: string }

    if (!jwk.e || !jwk.n) {
      throw new Error('Failed to export RSA public key as JWK')
    }

    const wireKey = Buffer.concat([
      this.encodeSshString(Buffer.from('ssh-rsa')),
      this.encodeSshMpint(this.base64UrlToBuffer(jwk.e)),
      this.encodeSshMpint(this.base64UrlToBuffer(jwk.n)),
    ])

    return `ssh-rsa ${wireKey.toString('base64')} ${comment}`
  }

  private encodeSshString(value: Buffer): Buffer {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(value.length, 0)
    return Buffer.concat([length, value])
  }

  private encodeSshMpint(value: Buffer): Buffer {
    const needsSignPadding = value.length > 0 && (value[0] & 0x80) !== 0
    const normalized = needsSignPadding ? Buffer.concat([Buffer.from([0]), value]) : value
    return this.encodeSshString(normalized)
  }

  private base64UrlToBuffer(value: string): Buffer {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    return Buffer.from(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='), 'base64')
  }

  async update(userId: string, updateUserDto: UpdateUserDto): Promise<User> {
    return this.withSubjectLock(userId, async (em) => {
      const user = await em.findOneBy(User, { id: userId })
      if (!user) throw new NotFoundException(`User with ID ${userId} not found.`)
      const registration =
        (await em.findOneBy(UserRegistration, { userId })) ?? (await this.registrations.record(em, user))
      const becameVerified = !user.emailVerified && updateUserDto.emailVerified === true
      if (updateUserDto.name) user.name = updateUserDto.name
      if (updateUserDto.email) user.email = updateUserDto.email
      if (updateUserDto.role) user.role = updateUserDto.role
      if (becameVerified) user.emailVerified = true
      await em.save(user)
      if (becameVerified) {
        await this.eventEmitter.emitAsync(UserEvents.EMAIL_VERIFIED, new UserEmailVerifiedEvent(em, user.id))
        await this.registrations.confirm(em, user, registration)
      }
      return user
    })
  }
}
