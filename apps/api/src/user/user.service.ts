/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { User, UserSSHKeyPair } from './user.entity'
import { DataSource, ILike, In, Repository } from 'typeorm'
import { CreateUserDto } from './dto/create-user.dto'
import * as crypto from 'crypto'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { UserEvents } from './constants/user-events.constant'
import { UpdateUserDto } from './dto/update-user.dto'
import { UserCreatedEvent } from './events/user-created.event'
import { UserDeletedEvent } from './events/user-deleted.event'
import { UserEmailVerifiedEvent } from './events/user-email-verified.event'

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly eventEmitter: EventEmitter2,
    private readonly dataSource: DataSource,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
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

    await this.dataSource.transaction(async (em) => {
      user = await em.save(user)
      await this.eventEmitter.emitAsync(
        UserEvents.CREATED,
        new UserCreatedEvent(em, user, defaultOrganizationDefaultRegionId),
      )
    })

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
    await this.dataSource.transaction(async (em) => {
      await em.delete(User, id)
      await this.eventEmitter.emitAsync(UserEvents.DELETED, new UserDeletedEvent(em, id))
    })
  }

  async regenerateKeyPair(id: string): Promise<User> {
    const user = await this.userRepository.findOneBy({ id: id })
    const keyPair = await this.generatePrivateKey()
    user.keyPair = keyPair
    return this.userRepository.save(user)
  }

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
