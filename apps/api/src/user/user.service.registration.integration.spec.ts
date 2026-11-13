/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter'
import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { RedisLockProvider } from '../box/common/redis-lock.provider'
import { BoxRepository } from '../box/repositories/box.repository'
import { Context } from '../common/context/context'
import { CustomNamingStrategy } from '../common/utils/naming-strategy.util'
import { TypedConfigService } from '../config/typed-config.service'
import { EncryptionService } from '../encryption/encryption.service'
import { OrganizationEvents } from '../organization/constants/organization-events.constant'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationInvitation } from '../organization/entities/organization-invitation.entity'
import { OrganizationRole } from '../organization/entities/organization-role.entity'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationService } from '../organization/services/organization.service'
import { RegionService } from '../region/services/region.service'
import { SystemRole } from './enums/system-role.enum'
import { UserCreatedEvent } from './events/user-created.event'
import { User } from './user.entity'
import { CommerceInternalClient } from '../commerce/commerce-internal.client'
import { UserService } from './user.service'

const integration = process.env.DB_HOST ? describe : describe.skip

integration.each(['user_id_pk', 'PK_cace4a159ff9f2512dd42373760'])(
  'UserService registration transaction with primary key %s (real PostgreSQL)',
  (primaryKey) => {
    const schema = `user_registration_${process.pid}_${randomUUID().replaceAll('-', '')}`
    let db: DataSource
    let module: TestingModule
    let service: UserService
    let events: EventEmitter2
    let createDefaultOrganization: jest.SpyInstance

    beforeAll(async () => {
      db = await new DataSource({
        type: 'postgres',
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
        schema,
        entities: [User, Organization, OrganizationUser, OrganizationRole, OrganizationInvitation],
        namingStrategy: new CustomNamingStrategy(),
        synchronize: false,
        extra: { options: `-c search_path=${schema},public -c statement_timeout=10000` },
      }).initialize()
      await db.query(`CREATE SCHEMA "${schema}"`)
      await db.synchronize()
      if (primaryKey !== 'user_id_pk') {
        await db.query(`ALTER TABLE "${schema}"."user" RENAME CONSTRAINT "user_id_pk" TO "${primaryKey}"`)
      }
    })

    afterAll(async () => {
      if (!db?.isInitialized) return
      try {
        await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      } finally {
        await db.destroy()
      }
    })

    beforeEach(async () => {
      await db.getRepository(Organization).deleteAll()
      await db.getRepository(User).deleteAll()
      module = await Test.createTestingModule({
        imports: [EventEmitterModule.forRoot()],
        providers: [
          UserService,
          { provide: CommerceInternalClient, useValue: {} },
          OrganizationService,
          { provide: DataSource, useValue: db },
          { provide: getRepositoryToken(User), useValue: db.getRepository(User) },
          { provide: getRepositoryToken(Organization), useValue: db.getRepository(Organization) },
          { provide: BoxRepository, useValue: {} },
          { provide: TypedConfigService, useValue: { get: () => false, getOrThrow: () => false } },
          { provide: RedisLockProvider, useValue: { lock: async () => false } },
          { provide: RegionService, useValue: {} },
          { provide: EncryptionService, useValue: {} },
        ],
      }).compile()
      await module.init()
      events = module.get(EventEmitter2)
      service = module.get(UserService)
      createDefaultOrganization = jest.spyOn(module.get(OrganizationService), 'handleUserCreatedEvent')
    })

    afterEach(async () => {
      await module?.close()
      jest.restoreAllMocks()
    })

    it('rejects a duplicate ID with 409 without changing the user or emitting another creation event', async () => {
      const original = await service.create(
        { id: 'existing', name: 'Original', email: 'original@gmail.com' },
        Context.admin(),
      )
      createDefaultOrganization.mockClear()

      await expect(
        service.create({ id: original.id, name: 'Replacement', email: 'replacement@gmail.com' }, Context.admin()),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'user_already_exists' },
        cause: { driverError: { code: '23505', constraint: primaryKey } },
      })

      expect(await db.getRepository(User).findOneByOrFail({ id: original.id })).toEqual(original)
      expect(createDefaultOrganization).not.toHaveBeenCalled()
      expect(await db.getRepository(Organization).count()).toBe(1)
      expect(await db.getRepository(OrganizationUser).count()).toBe(1)
    })

    it('commits one user, default organization and owner for concurrent requests with the same ID', async () => {
      const results = await Promise.allSettled([
        service.create({ id: 'concurrent', name: 'First', email: 'first@gmail.com' }, Context.user()),
        service.create({ id: 'concurrent', name: 'Second', email: 'second@gmail.com' }, Context.user()),
      ])
      const winners = results.filter((result) => result.status === 'fulfilled')
      const losers = results.filter((result) => result.status === 'rejected')

      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)
      expect(losers[0].reason).toMatchObject({ status: 409, response: { code: 'user_already_exists' } })
      expect(await db.getRepository(User).findOneByOrFail({ id: 'concurrent' })).toEqual(winners[0].value)
      expect(createDefaultOrganization).toHaveBeenCalledTimes(1)
      expect(await db.getRepository(User).count()).toBe(1)
      expect(await db.getRepository(Organization).count()).toBe(1)
      expect(await db.getRepository(OrganizationUser).findOneByOrFail({ userId: 'concurrent' })).toMatchObject({
        role: OrganizationMemberRole.OWNER,
        isDefaultForUser: true,
      })
    })

    it('passes database defaults to the organization event and returns them to the caller', async () => {
      const user = await service.create({ id: 'defaults', name: 'Default User' }, Context.admin())
      const event = createDefaultOrganization.mock.calls[0][0] as UserCreatedEvent

      expect(user).toMatchObject({
        role: SystemRole.USER,
        email: '',
        emailVerified: false,
        createdAt: expect.any(Date),
      })
      expect(event.user).toEqual(user)
      expect(await db.getRepository(Organization).findOneByOrFail({ createdBy: user.id })).toMatchObject({
        suspended: true,
        suspensionReason: 'Please verify your email address',
      })
    })

    it('rolls back the user, organization and owner when organization creation fails', async () => {
      const failure = new Error('organization creation failed')
      events.on(OrganizationEvents.CREATED, async () => {
        throw failure
      })

      await expect(service.create({ id: 'rollback', name: 'Rollback' }, Context.user())).rejects.toBe(failure)

      expect(await db.getRepository(User).count()).toBe(0)
      expect(await db.getRepository(Organization).count()).toBe(0)
      expect(await db.getRepository(OrganizationUser).count()).toBe(0)
    })
  },
)
