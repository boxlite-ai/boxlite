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
      {
        acquireLease: jest.fn().mockResolvedValue({ signal: new AbortController().signal, release }),
      } as any,
      {} as any,
      {} as any,
      {} as any,
    )

    const stopping = service.stopSuspendedOrganizationBoxes()
    for (let attempt = 0; attempt < 10 && eventEmitter.emitAsync.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve()
    }

    expect(eventEmitter.emitAsync).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
    settleEvent()
    await stopping
    expect(release).toHaveBeenCalled()
  })

  it('waits for every started stop event before releasing after one fails', async () => {
    const eventError = new Error('event failed')
    const controller = new AbortController()
    let settleSibling!: () => void
    const release = jest.fn().mockResolvedValue(undefined)
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      andWhereExists: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ id: 'org-1' }]),
    }
    const service = new OrganizationService(
      { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) } as any,
      {
        createQueryBuilder: jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), where: jest.fn() }),
        find: jest.fn().mockResolvedValue([{ id: 'box-1' }, { id: 'box-2' }]),
      } as any,
      {
        emitAsync: jest
          .fn()
          .mockImplementationOnce(() => {
            controller.abort(eventError)
            return Promise.reject(eventError)
          })
          .mockImplementationOnce(
            () =>
              new Promise<void>((resolve) => {
                settleSibling = resolve
              }),
          ),
      } as any,
      { getOrThrow: jest.fn().mockReturnValue(false) } as any,
      {
        acquireLease: jest.fn().mockResolvedValue({ signal: controller.signal, release }),
      } as any,
      {} as any,
      {} as any,
      {} as any,
    )

    const stopping = service.stopSuspendedOrganizationBoxes()
    for (let attempt = 0; attempt < 10 && !settleSibling; attempt += 1) {
      await Promise.resolve()
    }

    expect(settleSibling).toBeDefined()
    expect(release).not.toHaveBeenCalled()
    settleSibling()
    await expect(stopping).rejects.toBe(eventError)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
