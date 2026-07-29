/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxRepository } from './box.repository'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxEvents } from '../constants/box-events.constants'

function makeBox(): Box {
  const box = new Box('eu')
  box.id = 'abcdefghijkl' // BOX_ID_REGEX: 12 alphanumerics
  box.organizationId = 'org-1'
  box.name = 'box-1'
  box.state = BoxState.STARTED
  box.desiredState = BoxDesiredState.STARTED
  box.osUser = 'boxlite'
  return box
}

/**
 * A repository whose transaction runs the callback and then fails, standing in
 * for a COMMIT that does not land (deadlock, lost connection, a throw from
 * anything still running after the callback body).
 */
function makeRepository(options: { commitFails: boolean }) {
  const box = makeBox()
  const entityManager = {
    findOne: jest.fn().mockResolvedValue(box),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  }
  const manager = {
    transaction: jest.fn(async (cb: (em: typeof entityManager) => Promise<unknown>) => {
      const result = await cb(entityManager)
      if (options.commitFails) {
        throw new Error('could not serialize access due to concurrent update')
      }
      return result
    }),
  }
  const dataSource = { getRepository: () => ({ manager }) } as never
  const eventEmitter = { emit: jest.fn(), emitAsync: jest.fn() }

  const repo = new BoxRepository(dataSource, eventEmitter as never, {} as never)
  jest
    .spyOn(repo as never as { invalidateLookupCacheOnUpdate: () => void }, 'invalidateLookupCacheOnUpdate')
    .mockImplementation(() => undefined)
  jest
    .spyOn(repo as never as { upsertLastActivity: () => Promise<void> }, 'upsertLastActivity')
    .mockResolvedValue(undefined)

  return { repo, eventEmitter, box }
}

describe('BoxRepository.updateWhere event emission', () => {
  afterEach(() => jest.restoreAllMocks())

  it('emits the state change once the write is durable', async () => {
    const { repo, eventEmitter } = makeRepository({ commitFails: false })

    await repo.updateWhere('abcdefghijkl', {
      updateData: { state: BoxState.STOPPED },
      whereCondition: { state: BoxState.STARTED },
    })

    const emitted = eventEmitter.emit.mock.calls.map((call) => call[0])
    expect(emitted).toContain(BoxEvents.STATE_UPDATED)
  })

  // A usage period opened for a transition that never committed is a phantom
  // charge: metering writes on its own connection, so nothing rolls it back.
  it('does not emit a state change when the transaction fails to commit', async () => {
    const { repo, eventEmitter } = makeRepository({ commitFails: true })

    await expect(
      repo.updateWhere('abcdefghijkl', {
        updateData: { state: BoxState.STOPPED },
        whereCondition: { state: BoxState.STARTED },
      }),
    ).rejects.toThrow(/serialize access/)

    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('does not emit a desired-state change when the transaction fails to commit', async () => {
    const { repo, eventEmitter } = makeRepository({ commitFails: true })

    await expect(
      repo.updateWhere('abcdefghijkl', {
        updateData: { desiredState: BoxDesiredState.STOPPED },
        whereCondition: { desiredState: BoxDesiredState.STARTED },
      }),
    ).rejects.toThrow(/serialize access/)

    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })
})
