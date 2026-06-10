/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { UserService } from './user.service'
import { UserCreatedEvent } from './events/user-created.event'

describe('UserService default organization compatibility', () => {
  it('accepts deprecated personal organization create-user fields as aliases for default organization fields', async () => {
    const eventEmitter = {
      emitAsync: jest.fn().mockResolvedValue(undefined),
    }
    const entityManager = {
      save: jest.fn(async (entity) => entity),
    }
    const dataSource = {
      transaction: jest.fn(async (callback) => callback(entityManager)),
    }
    const service = new UserService({} as never, eventEmitter as never, dataSource as never)
    jest.spyOn(service as never, 'generatePrivateKey').mockResolvedValue({
      privateKey: 'private-key',
      publicKey: 'public-key',
    } as never)

    await service.create({
      id: 'user-1',
      name: 'User One',
      personalOrganizationDefaultRegionId: 'region-1',
    } as never)

    const event = eventEmitter.emitAsync.mock.calls[0][1] as UserCreatedEvent
    expect(event.defaultOrganizationDefaultRegionId).toBe('region-1')
  })
})
