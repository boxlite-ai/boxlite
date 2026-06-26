/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxService } from './box.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxEvents } from '../constants/box-events.constants'
import { BoxConflictError } from '../errors/box-conflict.error'

// ensureStartedForExec only touches boxRepository + eventEmitter; every other
// injected dependency is irrelevant to this unit, so they are stubbed out.
function makeService() {
  const boxRepository = { findOneByIdOrName: jest.fn(), updateWhere: jest.fn() } as any
  const eventEmitter = { emit: jest.fn(), emitAsync: jest.fn() } as any
  const noop = {} as any
  const service = new BoxService(
    boxRepository, // boxRepository
    noop, // runnerRepository
    noop, // sshAccessRepository
    noop, // runnerService
    noop, // volumeService
    noop, // configService
    noop, // warmPoolService
    eventEmitter, // eventEmitter
    noop, // organizationService
    noop, // runnerAdapterFactory
    noop, // redisLockProvider
    noop, // redis
    noop, // regionService
    noop, // boxLookupCacheInvalidationService
    noop, // boxActivityService
  )
  return { service, boxRepository, eventEmitter }
}

const stoppedBox = {
  id: 'box-1',
  state: BoxState.STOPPED,
  desiredState: BoxDesiredState.STOPPED,
  pending: false,
}

describe('BoxService.ensureStartedForExec', () => {
  // The control-plane never writes box.state directly; like start(), it flips
  // desiredState and lets the runner's reported state catch up. exec has
  // already auto-started the VM in the runtime, so box_sync will report STARTED
  // and — now that desiredState agrees — sync-states will not stop it back.
  it('flips a cleanly-stopped box to desiredState=STARTED and emits STARTED', async () => {
    const { service, boxRepository, eventEmitter } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    boxRepository.updateWhere.mockResolvedValue({
      ...stoppedBox,
      pending: true,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.ensureStartedForExec('box-1', 'org-1')

    expect(boxRepository.updateWhere).toHaveBeenCalledWith('box-1', {
      updateData: { pending: true, desiredState: BoxDesiredState.STARTED },
      whereCondition: { pending: false, state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED },
    })
    expect(eventEmitter.emit).toHaveBeenCalledWith(BoxEvents.STARTED, expect.anything())
  })

  it('is a no-op for an already-started box (idempotent)', async () => {
    const { service, boxRepository, eventEmitter } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({
      ...stoppedBox,
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
    } as any)

    await service.ensureStartedForExec('box-1', 'org-1')

    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('does not revive a box the user asked to destroy', async () => {
    const { service, boxRepository } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({
      ...stoppedBox,
      desiredState: BoxDesiredState.DESTROYED,
    } as any)

    await service.ensureStartedForExec('box-1', 'org-1')

    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('does not touch a box already mid-transition (pending)', async () => {
    const { service, boxRepository } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({ ...stoppedBox, pending: true } as any)

    await service.ensureStartedForExec('box-1', 'org-1')

    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('swallows a conflicting concurrent state change (best-effort)', async () => {
    const { service, boxRepository, eventEmitter } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    boxRepository.updateWhere.mockRejectedValue(new BoxConflictError())

    await expect(service.ensureStartedForExec('box-1', 'org-1')).resolves.toBeUndefined()
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })
})
