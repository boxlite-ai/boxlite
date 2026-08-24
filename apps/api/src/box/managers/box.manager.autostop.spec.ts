/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxManager } from './box.manager'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'

const BOX_ID = 'box-1'
const RUNNER_ID = 'runner-1'
const AUTO_STOP_SECONDS = 900

function makeCandidate(): Box {
  const box = new Box('us-east')
  box.id = BOX_ID
  box.runnerId = RUNNER_ID
  box.state = BoxState.STARTED
  box.desiredState = BoxDesiredState.STARTED
  box.pending = false
  box.autoStop = AUTO_STOP_SECONDS
  return box
}

/**
 * Harness for `autostopCheck`. The SQL candidate query is stubbed to return a
 * single STARTED box; the decision under test is the per-box re-check that
 * follows it: the sweeper re-reads the Redis-buffered activity after taking the
 * state lock and stops the box only when that time is older than `autoStop`.
 */
function makeHarness(lastActivityAt: Date) {
  const candidate = makeCandidate()

  // The candidate query chains .leftJoin/.where/…/.getMany(); only getMany's
  // result matters to the decision below it.
  const queryBuilder = {
    leftJoin: () => queryBuilder,
    where: () => queryBuilder,
    andWhere: () => queryBuilder,
    orderBy: () => queryBuilder,
    limit: () => queryBuilder,
    getMany: async () => [candidate],
  }

  const boxRepository = {
    createQueryBuilder: jest.fn(() => queryBuilder),
    updateWhere: jest.fn().mockResolvedValue(candidate),
  }
  const runnerService = {
    findAllReady: jest.fn().mockResolvedValue([{ id: RUNNER_ID }]),
  }
  const boxActivityService = {
    getLastActivityAt: jest.fn().mockResolvedValue(lastActivityAt),
  }
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn().mockResolvedValue(undefined),
  }

  const manager = new BoxManager(
    boxRepository as never,
    runnerService as never,
    boxActivityService as never,
    redisLockProvider as never,
    {} as never,
    {} as never,
    {} as never,
  )
  jest.spyOn(manager, 'syncInstanceState').mockResolvedValue(undefined)

  return { manager, updateWhere: boxRepository.updateWhere }
}

describe('BoxManager.autostopCheck', () => {
  it('stops a box whose last activity is older than autoStop', async () => {
    const { manager, updateWhere } = makeHarness(new Date(Date.now() - (AUTO_STOP_SECONDS + 1) * 1000))

    await manager.autostopCheck()

    expect(updateWhere).toHaveBeenCalledWith(
      BOX_ID,
      expect.objectContaining({
        updateData: expect.objectContaining({
          pending: true,
          desiredState: BoxDesiredState.STOPPED,
        }),
      }),
    )
  })

  it('leaves a box running while its activity is fresh', async () => {
    const { manager, updateWhere } = makeHarness(new Date())

    await manager.autostopCheck()

    expect(updateWhere).not.toHaveBeenCalled()
  })
})
