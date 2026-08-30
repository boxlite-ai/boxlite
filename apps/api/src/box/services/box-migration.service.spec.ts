/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Not } from 'typeorm'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxMigrationService } from './box-migration.service'

type Harness = {
  service: BoxMigrationService
  runnerFind: jest.Mock
  markParkedBoxesForExport: jest.Mock
  lock: jest.Mock
  unlock: jest.Mock
  logger: { log: jest.Mock; error: jest.Mock }
}

function createService(
  params: { drainingRunnerIds?: string[]; acquiresLock?: boolean; marked?: number } = {},
): Harness {
  const { drainingRunnerIds = [], acquiresLock = true, marked = 0 } = params

  const service = Object.create(BoxMigrationService.prototype) as BoxMigrationService
  const runnerFind = jest.fn().mockResolvedValue(drainingRunnerIds.map((id) => ({ id })))
  const markParkedBoxesForExport = jest.fn().mockResolvedValue(marked)
  const lock = jest.fn().mockResolvedValue(acquiresLock)
  const unlock = jest.fn().mockResolvedValue(undefined)
  const logger = { log: jest.fn(), error: jest.fn() }

  ;(service as any).logger = logger
  ;(service as any).runnerRepository = { find: runnerFind }
  ;(service as any).boxRepository = { markParkedBoxesForExport }
  ;(service as any).redisLockProvider = { lock, unlock }

  return { service, runnerFind, markParkedBoxesForExport, lock, unlock, logger }
}

function runMarker(service: BoxMigrationService): Promise<void> {
  return (service as any).markBoxesOnDrainingRunners()
}

describe('BoxMigrationService marker loop', () => {
  it('marks the parked boxes of every draining runner', async () => {
    const { service, markParkedBoxesForExport, logger } = createService({
      drainingRunnerIds: ['runner-a', 'runner-b'],
      marked: 3,
    })

    await runMarker(service)

    expect(markParkedBoxesForExport).toHaveBeenCalledWith(['runner-a', 'runner-b'])
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('skips runners that have already been decommissioned', async () => {
    const { service, runnerFind } = createService({ drainingRunnerIds: ['runner-a'] })

    await runMarker(service)

    // A decommissioned runner cannot export anything, so marking its boxes
    // would open migrations that can only ever roll back.
    expect(runnerFind).toHaveBeenCalledWith({
      where: { draining: true, state: Not(RunnerState.DECOMMISSIONED) },
      select: ['id'],
    })
  })

  it('does not touch the box table when no runner is draining', async () => {
    const { service, markParkedBoxesForExport, unlock } = createService({ drainingRunnerIds: [] })

    await runMarker(service)

    expect(markParkedBoxesForExport).not.toHaveBeenCalled()
    expect(unlock).toHaveBeenCalledTimes(1)
  })

  it('yields to the worker that already holds the tick', async () => {
    const { service, runnerFind, markParkedBoxesForExport, unlock } = createService({
      drainingRunnerIds: ['runner-a'],
      acquiresLock: false,
    })

    await runMarker(service)

    expect(runnerFind).not.toHaveBeenCalled()
    expect(markParkedBoxesForExport).not.toHaveBeenCalled()
    // Releasing here would hand the tick to a second worker mid-flight.
    expect(unlock).not.toHaveBeenCalled()
  })

  it('releases the tick lock when marking fails', async () => {
    const { service, markParkedBoxesForExport, unlock, logger } = createService({ drainingRunnerIds: ['runner-a'] })
    markParkedBoxesForExport.mockRejectedValue(new Error('deadlock detected'))

    await expect(runMarker(service)).resolves.toBeUndefined()

    // A held lock would park the loop until the TTL expires, long after the
    // failure that caused it has passed.
    expect(unlock).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalled()
  })
})
