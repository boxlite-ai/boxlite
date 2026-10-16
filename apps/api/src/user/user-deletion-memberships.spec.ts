/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EventEmitterModule } from '@nestjs/event-emitter'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { DataSource, FindOperator } from 'typeorm'
import { User } from './user.entity'
import { UserService } from './user.service'
import { ApiKey } from '../api-key/api-key.entity'
import { ApiKeyService } from '../api-key/api-key.service'
import { RedisLockProvider } from '../box/common/redis-lock.provider'
import { BoxRepository } from '../box/repositories/box.repository'
import { BoxService } from '../box/services/box.service'
import { TypedConfigService } from '../config/typed-config.service'
import { EncryptionService } from '../encryption/encryption.service'
import { NotificationEmitter } from '../notification/gateways/notification-emitter.abstract'
import { NotificationService } from '../notification/services/notification.service'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationRoleService } from '../organization/services/organization-role.service'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { Region } from '../region/entities/region.entity'
import { RegionService } from '../region/services/region.service'

async function createServices(sharedDefault: boolean) {
  const defaultOrg = Object.assign(new Organization(), { id: 'default' })
  const invitedOrg = Object.assign(new Organization(), { id: 'invited' })
  const membership = (organization: Organization, userId: string, isDefaultForUser: boolean) =>
    Object.assign(new OrganizationUser(), {
      organization,
      organizationId: organization.id,
      userId,
      isDefaultForUser,
      role: isDefaultForUser ? OrganizationMemberRole.OWNER : OrganizationMemberRole.MEMBER,
    })
  const memberships = [membership(defaultOrg, 'deleted', true), membership(invitedOrg, 'deleted', false)]
  const remainingMember = membership(sharedDefault ? defaultOrg : invitedOrg, 'remaining', false)
  memberships.push(remainingMember)
  const key = (organizationId: string, userId: string) =>
    Object.assign(new ApiKey(), { organizationId, userId, keyHash: `${organizationId}-${userId}` })
  const otherKey = key(remainingMember.organizationId, 'remaining')
  const keys = [key('default', 'deleted'), key('invited', 'deleted'), otherKey]
  const users = [Object.assign(new User(), { id: 'deleted' })]
  const organizations = [defaultOrg, invitedOrg]
  const rows = new Map<unknown, object[]>([
    [User, users],
    [Organization, organizations],
    [OrganizationUser, memberships],
    [ApiKey, keys],
  ])
  // Only the database boundary is replaced. Queries filter real entity rows and
  // remove uses object identity; organization deletion models its membership FK.
  const find = async (entity: unknown, { where }: { where: Record<string, unknown> }) =>
    (rows.get(entity) ?? []).filter((row) =>
      Object.entries(where).every(([field, value]) => {
        // TypeORM 0.3 ignores undefined where values by default.
        if (value === undefined) return true
        const actual = (row as Record<string, unknown>)[field]
        if (value instanceof FindOperator && value.type === 'not') return actual !== value.value
        return actual === value
      }),
    )
  const remove = async (entities: object | object[]) => {
    for (const entity of Array.isArray(entities) ? entities : [entities]) {
      for (const collection of rows.values()) {
        const index = collection.indexOf(entity)
        if (index >= 0) collection.splice(index, 1)
      }
      if (entity instanceof Organization) {
        for (let i = memberships.length - 1; i >= 0; i--) {
          if (memberships[i].organizationId === entity.id) memberships.splice(i, 1)
        }
      }
      if (entity instanceof OrganizationUser) {
        // TypeORM remove clears primary columns on the supplied entity.
        Object.assign(entity, { organizationId: undefined, userId: undefined })
      }
    }
  }
  const entityManager = {
    find,
    findOne: async (...args: Parameters<typeof find>) => (await find(...args))[0] ?? null,
    count: async (...args: Parameters<typeof find>) => (await find(...args)).length,
    save: async (entity: object) => entity,
    remove,
    delete: async (entity: unknown, id: string) => remove(await find(entity, { where: { id } })),
  }
  const timeline: string[] = []
  const moduleRef = await Test.createTestingModule({
    imports: [EventEmitterModule.forRoot()],
    providers: [
      UserService,
      OrganizationService,
      OrganizationUserService,
      ApiKeyService,
      NotificationService,
      ...[User, Organization, OrganizationUser, ApiKey, Region].map((entity) => ({
        provide: getRepositoryToken(entity),
        useValue: { manager: entityManager },
      })),
      {
        provide: DataSource,
        useValue: {
          transaction: async (work: (em: unknown) => Promise<unknown>) => {
            const result = await work(entityManager)
            timeline.push('commit')
            return result
          },
        },
      },
      {
        provide: getRedisConnectionToken(),
        useValue: {
          del: async (key: string) => {
            timeline.push(`del ${key}`)
            return 1
          },
        },
      },
      {
        provide: NotificationEmitter,
        useValue: {
          leaveOrganizationRoom: (userId: string, organizationId: string) => {
            timeline.push(`leave ${organizationId}:${userId}`)
          },
        },
      },
      { provide: TypedConfigService, useValue: { getOrThrow: () => false } },
      { provide: RedisLockProvider, useValue: { lock: async () => false } },
      ...[OrganizationRoleService, BoxRepository, BoxService, RegionService, EncryptionService].map((provide) => ({
        provide,
        useValue: {},
      })),
    ],
  }).compile()
  await moduleRef.init()
  return { moduleRef, keys, otherKey, users, memberships, organizations, remainingMember, timeline }
}

describe('review regressions: account deletion', () => {
  it.each([false, true])(
    'revokes every removed membership after commit (shared default: %s)',
    async (sharedDefault) => {
      const state = await createServices(sharedDefault)
      try {
        await state.moduleRef.get(UserService).remove('deleted')

        expect(state.users).toEqual([])
        expect(state.memberships).toEqual([state.remainingMember])
        expect(state.keys).toEqual([state.otherKey])
        expect(state.organizations.map((organization) => organization.id)).toEqual(
          sharedDefault ? ['default', 'invited'] : ['invited'],
        )
        if (sharedDefault) expect(state.remainingMember.role).toBe(OrganizationMemberRole.OWNER)
        expect(state.timeline[0]).toBe('commit')
        expect(state.timeline.slice(1).sort()).toEqual(
          [
            'del api-key:validation:default-deleted',
            'del api-key:validation:invited-deleted',
            'del organization-user:default:deleted',
            'del organization-user:invited:deleted',
            'leave default:deleted',
            'leave invited:deleted',
          ].sort(),
        )
      } finally {
        await state.moduleRef.close()
      }
    },
  )
})
