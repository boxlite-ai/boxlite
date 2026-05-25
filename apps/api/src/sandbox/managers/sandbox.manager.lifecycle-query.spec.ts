/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({ v4: jest.fn(() => 'test-uuid') }))

import { SandboxManager } from './sandbox.manager'

describe('SandboxManager lifecycle activity queries', () => {
  function buildQueryBuilder() {
    return {
      innerJoin: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    }
  }

  function buildManager(queryBuilder = buildQueryBuilder()) {
    const sandboxRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    }

    const runnerService = {
      findAllReady: jest.fn().mockResolvedValue([{ id: 'runner-1' }]),
    }

    const redisLockProvider = {
      lock: jest.fn().mockResolvedValue(true),
      unlock: jest.fn().mockResolvedValue(undefined),
    }

    const manager = new SandboxManager(
      sandboxRepository as any,
      runnerService as any,
      redisLockProvider as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )

    return { manager, queryBuilder }
  }

  it('auto-stop joins sandbox last activity via entity metadata and orders by property path', async () => {
    const { manager, queryBuilder } = buildManager()

    await manager.autostopCheck()

    expect(queryBuilder.innerJoin).toHaveBeenCalledWith('sandbox.lastActivityAt', 'activity')
    expect(queryBuilder.addSelect).toHaveBeenCalledWith('activity.lastActivityAt')
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('sandbox.lastBackupAt', 'ASC')
  })

  it('auto-archive joins sandbox last activity via entity metadata and orders by property path', async () => {
    const { manager, queryBuilder } = buildManager()

    await manager.autoArchiveCheck()

    expect(queryBuilder.innerJoin).toHaveBeenCalledWith('sandbox.lastActivityAt', 'activity')
    expect(queryBuilder.addSelect).toHaveBeenCalledWith('activity.lastActivityAt')
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('sandbox.lastBackupAt', 'ASC')
  })

  it('auto-delete joins sandbox last activity via entity metadata and orders by activity property path', async () => {
    const { manager, queryBuilder } = buildManager()

    await manager.autoDeleteCheck()

    expect(queryBuilder.innerJoin).toHaveBeenCalledWith('sandbox.lastActivityAt', 'activity')
    expect(queryBuilder.addSelect).toHaveBeenCalledWith('activity.lastActivityAt')
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('activity.lastActivityAt', 'ASC')
  })
})
