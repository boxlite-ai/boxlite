/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common'
import { BoxService } from './box.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxEvents } from '../constants/box-events.constants'

// ensureStartedForProxy only touches boxRepository + eventEmitter +
// organizationService; every other injected dependency is irrelevant.
function makeService(options: { billingEnabled?: boolean; billingError?: Error } = {}) {
  const boxRepository = {
    findOneByIdOrName: jest.fn(),
    conditionalStartForProxy: jest.fn(),
    updateWhere: jest.fn(),
    insert: jest.fn(),
  } as any
  const eventEmitter = { emit: jest.fn(), emitAsync: jest.fn() } as any
  // assertOrganizationIsNotSuspended mirrors the real implementation: throw
  // ForbiddenException when the org is suspended, no-op otherwise.
  const organizationService = {
    assertOrganizationIsNotSuspended: jest.fn((org: any) => {
      if (org?.suspended) {
        throw new ForbiddenException('Organization is suspended')
      }
    }),
  } as any
  const runnerService = {
    getRandomAvailableRunner: jest.fn().mockResolvedValue({ id: 'runner-1' }),
    findOneOrFail: jest.fn().mockResolvedValue({ id: 'runner-1', apiVersion: '0' }),
  } as any
  const volumeService = { validateVolumes: jest.fn() } as any
  const configService = { getOrThrow: jest.fn().mockReturnValue('region-1') } as any
  const warmPoolService = { fetchWarmPoolBox: jest.fn().mockResolvedValue(null) } as any
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn().mockResolvedValue(undefined),
  } as any
  const redis = { exists: jest.fn().mockResolvedValue(0) } as any
  const regionService = {
    findOneByName: jest.fn().mockResolvedValue(null),
    findOne: jest.fn().mockResolvedValue({ id: 'region-1' }),
  } as any
  const billingAccessService = {
    isEnabled: jest.fn().mockReturnValue(options.billingEnabled ?? false),
    assertHasAccess: jest.fn(async () => {
      if (options.billingError) throw options.billingError
      return null
    }),
  } as any
  const noop = {} as any
  const service = new BoxService(
    boxRepository, // boxRepository
    noop, // runnerRepository
    noop, // sshAccessRepository
    runnerService, // runnerService
    volumeService, // volumeService
    configService, // configService
    warmPoolService, // warmPoolService
    eventEmitter, // eventEmitter
    organizationService, // organizationService
    noop, // runnerAdapterFactory
    redisLockProvider, // redisLockProvider
    redis, // redis
    regionService, // regionService
    noop, // boxLookupCacheInvalidationService
    noop, // boxActivityService
    billingAccessService, // billingAccessService
  )
  return {
    service,
    boxRepository,
    eventEmitter,
    organizationService,
    runnerService,
    redisLockProvider,
    regionService,
    billingAccessService,
  }
}

const activeOrg = { id: 'org-1', suspended: false } as any
const suspendedOrg = { id: 'org-1', suspended: true } as any

const stoppedBox = {
  id: 'box-1',
  organizationId: 'org-1',
  region: 'region-1',
  cpu: 1,
  mem: 1,
  disk: 10,
  gpu: 0,
  state: BoxState.STOPPED,
  desiredState: BoxDesiredState.STOPPED,
  pending: false,
}

const insufficientBalance = new HttpException({ code: 'BILLING_BALANCE_REQUIRED' }, HttpStatus.PAYMENT_REQUIRED)

describe('BoxService billing admission', () => {
  it('rejects Create before selecting a runner when the requested allocation is not funded', async () => {
    const { service, runnerService, billingAccessService, redisLockProvider } = makeService({
      billingEnabled: true,
      billingError: insufficientBalance,
    })

    await expect(
      service.create(
        { target: 'region-1', cpu: 2, memory: 4, disk: 20 },
        activeOrg,
        { billingUserId: 'user-1' },
      ),
    ).rejects.toBe(insufficientBalance)

    expect(billingAccessService.assertHasAccess).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ cpu: 2, mem: 4, disk: 20, gpu: 0 }),
    )
    expect(runnerService.getRandomAvailableRunner).not.toHaveBeenCalled()
    expect(redisLockProvider.unlock).toHaveBeenCalled()
  })

  it('rejects Start before changing desiredState when the Box is not funded', async () => {
    const { service, boxRepository, billingAccessService } = makeService({
      billingEnabled: true,
      billingError: insufficientBalance,
    })
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)

    await expect(service.start('box-1', activeOrg)).rejects.toBe(insufficientBalance)

    expect(billingAccessService.assertHasAccess).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ boxId: 'box-1' }),
    )
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('rejects proxy auto-start before the conditional state update', async () => {
    const { service, boxRepository } = makeService({
      billingEnabled: true,
      billingError: insufficientBalance,
    })
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)

    await expect(service.ensureStartedForProxy('box-1', activeOrg)).rejects.toBe(insufficientBalance)

    expect(boxRepository.conditionalStartForProxy).not.toHaveBeenCalled()
  })

  it('rejects a running Box resource increase before entering the resizing state', async () => {
    const { service, boxRepository, billingAccessService } = makeService({
      billingEnabled: true,
      billingError: insufficientBalance,
    })
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({
      ...stoppedBox,
      runnerId: 'runner-1',
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
    } as any)

    await expect(service.resize('box-1', { cpu: 2 }, activeOrg)).rejects.toBe(insufficientBalance)

    expect(billingAccessService.assertHasAccess).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ boxId: 'box-1', cpu: 2 }),
    )
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })
})

describe('BoxService.ensureStartedForProxy', () => {
  // The control plane never writes box.state directly; like start(), it flips
  // desiredState and lets the runner's reported state catch up. The proxied
  // call has already auto-started the VM in the runtime, so box_sync will
  // report STARTED and — now that desiredState agrees — sync-states will not
  // stop it back.
  it('flips a cleanly-stopped box to desiredState=STARTED and emits STARTED', async () => {
    const { service, boxRepository, eventEmitter } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    boxRepository.conditionalStartForProxy.mockResolvedValue({
      ...stoppedBox,
      pending: true,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.ensureStartedForProxy('box-1', activeOrg)

    expect(boxRepository.conditionalStartForProxy).toHaveBeenCalledWith('box-1', 'org-1')
    expect(eventEmitter.emit).toHaveBeenCalledWith(BoxEvents.STARTED, expect.anything())
    // Also raise the desired-state event start() raises, so the notification
    // gateway and analytics observe the STOPPED→STARTED flip on autostart too.
    expect(eventEmitter.emit).toHaveBeenCalledWith(BoxEvents.DESIRED_STATE_UPDATED, expect.anything())
  })

  // Same gate as start() (~line 790). Without this, a suspended org could
  // exec / files / metrics a STOPPED box back to STARTED, bypassing the
  // start-time guard.
  it('throws ForbiddenException for a suspended organization', async () => {
    const { service, boxRepository, eventEmitter } = makeService()

    await expect(service.ensureStartedForProxy('box-1', suspendedOrg)).rejects.toThrow(ForbiddenException)

    expect(boxRepository.conditionalStartForProxy).not.toHaveBeenCalled()
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('is a no-op for an already-started box (idempotent)', async () => {
    const { service, boxRepository, eventEmitter } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({
      ...stoppedBox,
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
    } as any)

    await service.ensureStartedForProxy('box-1', activeOrg)

    expect(boxRepository.conditionalStartForProxy).not.toHaveBeenCalled()
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('does not revive a box the user asked to destroy', async () => {
    const { service, boxRepository } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({
      ...stoppedBox,
      desiredState: BoxDesiredState.DESTROYED,
    } as any)

    await service.ensureStartedForProxy('box-1', activeOrg)

    expect(boxRepository.conditionalStartForProxy).not.toHaveBeenCalled()
  })

  it('does not touch a box already mid-transition (pending)', async () => {
    const { service, boxRepository } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({ ...stoppedBox, pending: true } as any)

    await service.ensureStartedForProxy('box-1', activeOrg)

    expect(boxRepository.conditionalStartForProxy).not.toHaveBeenCalled()
  })

  // Conditional UPDATE matched zero rows = race lost or box transitioned out
  // of the eligible state between snapshot and write. Same no-op semantics
  // as the old BoxConflictError swallow.
  it('emits nothing when the conditional update matches zero rows (race lost)', async () => {
    const { service, boxRepository, eventEmitter } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    boxRepository.conditionalStartForProxy.mockResolvedValue(null)

    await expect(service.ensureStartedForProxy('box-1', activeOrg)).resolves.toBeUndefined()
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('swallows an unexpected DB failure without emitting', async () => {
    const { service, boxRepository, eventEmitter } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    boxRepository.conditionalStartForProxy.mockRejectedValue(new Error('db connection lost'))
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined)

    await expect(service.ensureStartedForProxy('box-1', activeOrg)).resolves.toBeUndefined()
    expect(eventEmitter.emit).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })
})
