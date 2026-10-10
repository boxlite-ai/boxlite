/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EventEmitterModule } from '@nestjs/event-emitter'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { DataSource } from 'typeorm'
import { OrganizationRoleService } from './organization-role.service'
import { OrganizationUserService } from './organization-user.service'
import { OrganizationUser } from '../entities/organization-user.entity'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { ApiKey } from '../../api-key/api-key.entity'
import { ApiKeyService } from '../../api-key/api-key.service'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { TypedConfigService } from '../../config/typed-config.service'
import { UserService } from '../../user/user.service'

type StoredApiKey = Pick<ApiKey, 'organizationId' | 'userId' | 'name' | 'keyHash'>

// An entity manager over in-memory rows: find honours the where clause the
// production code builds, and remove drops exactly the rows it is handed.
function createEntityManager(apiKeys: StoredApiKey[]) {
  const removed: unknown[] = []
  const entityManager = {
    count: jest.fn().mockResolvedValue(2),
    find: jest.fn(async (_entity: unknown, { where }: { where: Partial<StoredApiKey> }) =>
      apiKeys.filter((apiKey) => apiKey.organizationId === where.organizationId && apiKey.userId === where.userId),
    ),
    remove: jest.fn(async (rows: unknown) => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        removed.push(row)
        const index = apiKeys.indexOf(row as StoredApiKey)
        if (index >= 0) apiKeys.splice(index, 1)
      }
    }),
  }
  return { entityManager, removed }
}

async function createServices(membership: OrganizationUser, apiKeys: StoredApiKey[]) {
  const { entityManager, removed } = createEntityManager(apiKeys)
  // Records when the transaction commits relative to each cache clear.
  const timeline: string[] = []
  const redis = {
    del: jest.fn(async (key: string) => {
      timeline.push(`del ${key}`)
      return 1
    }),
  }
  const dataSource = {
    transaction: async (work: (em: unknown) => Promise<unknown>) => {
      const result = await work(entityManager)
      timeline.push('commit')
      return result
    },
  }

  const moduleRef = await Test.createTestingModule({
    imports: [EventEmitterModule.forRoot()],
    providers: [
      OrganizationUserService,
      ApiKeyService,
      {
        provide: getRepositoryToken(OrganizationUser),
        useValue: { findOne: jest.fn().mockResolvedValue(membership), manager: entityManager },
      },
      { provide: getRepositoryToken(ApiKey), useValue: {} },
      { provide: DataSource, useValue: dataSource },
      { provide: getRedisConnectionToken(), useValue: redis },
      { provide: OrganizationRoleService, useValue: {} },
      { provide: UserService, useValue: {} },
      { provide: RedisLockProvider, useValue: {} },
      { provide: TypedConfigService, useValue: {} },
    ],
  }).compile()
  // Registers the @OnEvent listeners, so removal runs through the real event wiring.
  await moduleRef.init()

  return { service: moduleRef.get(OrganizationUserService), removed, timeline }
}

describe('OrganizationUserService.delete', () => {
  const membership = {
    organizationId: 'org-1',
    userId: 'user-2',
    role: OrganizationMemberRole.OWNER,
    isDefaultForUser: false,
  } as OrganizationUser

  it("revokes the removed member's API keys in that organization and nothing else", async () => {
    const removedMembersKey = { organizationId: 'org-1', userId: 'user-2', name: 'ci', keyHash: 'hash-ci' }
    const sameMemberOtherOrgKey = { organizationId: 'org-2', userId: 'user-2', name: 'ci', keyHash: 'hash-org-2' }
    const otherMembersKey = { organizationId: 'org-1', userId: 'user-1', name: 'ci', keyHash: 'hash-user-1' }
    const apiKeys = [removedMembersKey, sameMemberOtherOrgKey, otherMembersKey]
    const { service, removed } = await createServices(membership, apiKeys)

    await service.delete('org-1', 'user-2')

    expect(removed).toContain(membership)
    expect(apiKeys).toEqual([sameMemberOtherOrgKey, otherMembersKey])
  })

  // Cleared before commit, a concurrent request still sees the old rows and caches
  // them again, so the key and the membership would outlive the removal.
  it('clears the key and membership caches only after the removal commits', async () => {
    const removedMembersKey = { organizationId: 'org-1', userId: 'user-2', name: 'ci', keyHash: 'hash-ci' }
    const { service, timeline } = await createServices(membership, [removedMembersKey])

    await service.delete('org-1', 'user-2')

    expect(timeline).toEqual(['commit', 'del api-key:validation:hash-ci', 'del organization-user:org-1:user-2'])
  })
})
