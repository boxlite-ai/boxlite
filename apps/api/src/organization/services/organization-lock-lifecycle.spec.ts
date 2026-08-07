/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationService } from './organization.service'

describe('OrganizationService lock lifecycle', () => {
  it('holds the suspended-box lease until all stop events settle', async () => {
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      andWhereExists: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ id: 'org-1' }]),
    }
    const organizationRepository = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) }
    const boxRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), where: jest.fn() }),
      find: jest.fn().mockResolvedValue([{ id: 'box-1' }]),
    }
    let settleEvent!: () => void
    const eventEmitter = {
      emitAsync: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            settleEvent = resolve
          }),
      ),
    }
    const release = jest.fn().mockResolvedValue(undefined)
    const service = new OrganizationService(
      organizationRepository as any,
      boxRepository as any,
      eventEmitter as any,
      { getOrThrow: jest.fn().mockReturnValue(false) } as any,
      { acquireLease: jest.fn().mockResolvedValue({ release }) } as any,
      {} as any,
      {} as any,
      {} as any,
    )

    const stopping = service.stopSuspendedOrganizationBoxes()
    while (eventEmitter.emitAsync.mock.calls.length === 0) {
      await Promise.resolve()
    }

    expect(release).not.toHaveBeenCalled()
    settleEvent()
    await stopping
    expect(release).toHaveBeenCalled()
  })
})
