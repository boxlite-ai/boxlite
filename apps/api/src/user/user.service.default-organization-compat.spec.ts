/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { UserService } from './user.service'
import { UserCreatedEvent } from './events/user-created.event'
import { Context } from '../common/context/context'
import { User } from './user.entity'

describe('UserService default organization compatibility', () => {
  it('accepts deprecated personal organization create-user fields as aliases for default organization fields', async () => {
    const eventEmitter = {
      // EventEmitter2.emitAsync resolves to one result per listener.
      emitAsync: jest.fn().mockResolvedValue([]),
    }
    let insertedUser: User
    const entityManager = {
      insert: jest.fn(async (_entity, user: User) => {
        insertedUser = user
      }),
      findOneByOrFail: jest.fn(async () => insertedUser),
    }
    const dataSource = {
      transaction: jest.fn(async (callback) => callback(entityManager)),
    }
    const service = new UserService({} as never, eventEmitter as never, dataSource as never)

    await service.create(
      {
        id: 'user-1',
        name: 'User One',
        personalOrganizationDefaultRegionId: 'region-1',
      } as never,
      Context.user(),
    )

    const event = eventEmitter.emitAsync.mock.calls[0][1] as UserCreatedEvent
    expect(event.defaultOrganizationDefaultRegionId).toBe('region-1')
  })
})
