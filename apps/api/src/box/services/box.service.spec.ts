/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { BoxService } from './box.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxEvents } from '../constants/box-events.constants'

// ensureStartedForProxy touches boxRepository + eventEmitter +
// organizationService + organizationUsageService; every other injected
// dependency is irrelevant.
function makeService() {
  const boxRepository = {
    findOneByIdOrName: jest.fn(),
    conditionalStartForProxy: jest.fn(),
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
  // Quota check passes by default; tests assert reservations are released when
  // the box does not actually start.
  const organizationUsageService = {
    validateOrganizationQuotas: jest.fn().mockResolvedValue({ cpu: 0, memory: 0, disk: 0, gpu: 0, count: 0 }),
    rollbackPendingUsage: jest.fn().mockResolvedValue(undefined),
  } as any
  const noop = {} as any
  const service = new BoxService(
    boxRepository, // boxRepository
    noop, // runnerRepository
    noop, // runnerService
    noop, // volumeService
    noop, // configService
    noop, // warmPoolService
    eventEmitter, // eventEmitter
    organizationService, // organizationService
    organizationUsageService, // organizationUsageService
    noop, // runnerAdapterFactory
    noop, // redisLockProvider
    noop, // redis
    noop, // regionService
    noop, // boxLookupCacheInvalidationService
    noop, // boxActivityService
    noop, // jobRepository
    noop, // jobService
  )
  return { service, boxRepository, eventEmitter, organizationService, organizationUsageService }
}

const activeOrg = { id: 'org-1', suspended: false } as any
const suspendedOrg = { id: 'org-1', suspended: true } as any

const stoppedBox = {
  id: 'box-1',
  state: BoxState.STOPPED,
  desiredState: BoxDesiredState.STOPPED,
  pending: false,
}

function makePreviewUrlService() {
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'proxy.domain') return 'proxy.example.test'
      if (key === 'proxy.protocol') return 'https'
      throw new Error(`unexpected config key ${key}`)
    }),
  } as any
  const redis = { setex: jest.fn() } as any
  const regionService = { findOne: jest.fn().mockResolvedValue(null) } as any
  const noop = {} as any
  const service = new BoxService(
    noop, // boxRepository
    noop, // runnerRepository
    noop, // runnerService
    noop, // volumeService
    configService, // configService
    noop, // warmPoolService
    noop, // eventEmitter
    noop, // organizationService
    noop, // organizationUsageService
    noop, // runnerAdapterFactory
    noop, // redisLockProvider
    redis, // redis
    regionService, // regionService
    noop, // boxLookupCacheInvalidationService
    noop, // boxActivityService
    noop, // jobRepository
    noop, // jobService
  )
  jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({
    id: 'MixedCaseBox',
    authToken: 'preview-token',
    region: 'region-1',
  } as any)

  return { service, redis }
}

describe('BoxService preview URLs', () => {
  it('creates case-safe direct preview URLs for service ports', async () => {
    const { service } = makePreviewUrlService()

    const result = await service.getPortPreviewUrl('MixedCaseBox', 'org-1', 3000)

    expect(result.boxId).toBe('MixedCaseBox')
    expect(result.url).toBe('https://3000-d-4d6978656443617365426f78.proxy.example.test')
    expect(result.token).toBe('preview-token')
  })

  it('keeps the existing direct preview URL format for terminal', async () => {
    const { service } = makePreviewUrlService()

    const result = await service.getPortPreviewUrl('MixedCaseBox', 'org-1', 22222)

    expect(result.url).toBe('https://22222-MixedCaseBox.proxy.example.test')
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
  // Conditional UPDATE matched zero rows = race lost. The docstring's contract is
  // "transitional states are returned unchanged", so the current box is returned and
  // nothing is emitted.
  it('returns the box unchanged and emits nothing when the conditional update matches zero rows (race lost)', async () => {
    const { service, boxRepository, eventEmitter } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    boxRepository.conditionalStartForProxy.mockResolvedValue(null)

    await expect(service.ensureStartedForProxy('box-1', activeOrg)).resolves.toBe(stoppedBox)
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })

  // Docstring: "Unexpected database errors propagate; AutoResume must never proxy
  // before readiness." So the error is rethrown, not swallowed.
  it('propagates an unexpected DB failure without emitting', async () => {
    const { service, boxRepository, eventEmitter } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    boxRepository.conditionalStartForProxy.mockRejectedValue(new Error('db connection lost'))

    await expect(service.ensureStartedForProxy('box-1', activeOrg)).rejects.toThrow('db connection lost')
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('rejects auto-resume when the org is over quota and does not start the box', async () => {
    const { service, boxRepository, organizationUsageService } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    organizationUsageService.validateOrganizationQuotas.mockRejectedValue(
      new BadRequestException('Organization quota exceeded'),
    )

    await expect(service.ensureStartedForProxy('box-1', activeOrg)).rejects.toThrow(BadRequestException)
    expect(boxRepository.conditionalStartForProxy).not.toHaveBeenCalled()
  })

  it('releases the quota reservation when the conditional start matches zero rows', async () => {
    const { service, boxRepository, organizationUsageService } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    boxRepository.conditionalStartForProxy.mockResolvedValue(null)

    await service.ensureStartedForProxy('box-1', activeOrg)

    expect(organizationUsageService.rollbackPendingUsage).toHaveBeenCalled()
  })
})

function makeNetworkTunnelService() {
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'proxy.domain') return 'proxy.example.test'
      if (key === 'proxy.protocol') return 'https'
      throw new Error(`unexpected config key ${key}`)
    }),
  } as any
  const regionService = { findOne: jest.fn().mockResolvedValue(null) } as any
  const noop = {} as any
  const service = new BoxService(
    noop,
    noop,
    noop,
    noop,
    configService,
    noop,
    noop,
    noop,
    noop, // organizationUsageService
    noop,
    noop,
    noop,
    regionService,
    noop,
    noop,
    noop, // jobRepository
    noop, // jobService
  )
  jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({
    id: 'MixedCaseBox',
    region: 'region-1',
  } as any)
  return service
}

describe('BoxService network tunnel URLs', () => {
  it('creates a case-safe endpoint for an SDK tunnel', async () => {
    const service = makeNetworkTunnelService()

    const result = await service.getNetworkTunnelUrl('MixedCaseBox', 'org-1', 3000)

    expect(result).toBe('https://3000-d-4d6978656443617365426f78.proxy.example.test')
  })
})

describe('BoxService public defaults', () => {
  function makeCreateService() {
    const boxRepository = { insert: jest.fn(async (box: any) => box) } as any
    const warmPoolService = { fetchWarmPoolBox: jest.fn().mockResolvedValue(undefined) }
    const runner = { id: 'runner-1', draining: false, state: RunnerState.READY }
    const runnerService = {
      getRandomAvailableRunner: jest.fn().mockResolvedValue(runner),
      findOneUncachedOrFail: jest.fn().mockResolvedValue(runner),
    }
    const redisLockProvider = {
      acquireLease: jest.fn().mockResolvedValue({
        signal: new AbortController().signal,
        release: jest.fn().mockResolvedValue(undefined),
      }),
    }
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service as any, {
      getValidatedOrDefaultRegion: jest.fn().mockResolvedValue({ id: 'region-1' }),
      getValidatedOrDefaultClass: jest.fn().mockReturnValue('small'),
      organizationService: { assertOrganizationIsNotSuspended: jest.fn() },
      organizationUsageService: {
        validateOrganizationQuotas: jest.fn().mockResolvedValue({ cpu: 0, memory: 0, disk: 0, gpu: 0, count: 0 }),
        rollbackPendingUsage: jest.fn().mockResolvedValue(undefined),
      },
      redis: { exists: jest.fn().mockResolvedValue(1) },
      warmPoolService,
      runnerService,
      redisLockProvider,
      boxRepository,
      eventEmitter: { emitAsync: jest.fn().mockResolvedValue(undefined) },
      toBoxDto: jest.fn((box) => box),
    })
    return { service, boxRepository, runnerService, redisLockProvider, warmPoolService }
  }

  it.each([
    [{ networkBlockAll: true }, { boxLimitedNetworkEgress: false }, { networkBlockAll: true }],
    [{ networkAllowList: '10.0.0.0/8' }, { boxLimitedNetworkEgress: false }, { networkAllowList: '10.0.0.0/8' }],
    [{}, { boxLimitedNetworkEgress: true }, { networkBlockAll: true }],
  ])('creates a fresh box instead of claiming a warm box when network policy is required', async (request, org, expected) => {
    const { service, boxRepository, warmPoolService } = makeCreateService()
    ;(service as any).redis.exists.mockResolvedValue(0)

    await service.create(
      { name: 'restricted-box', image: 'base', ...request } as any,
      { id: 'org-1', ...org } as any,
    )

    expect(warmPoolService.fetchWarmPoolBox).not.toHaveBeenCalled()
    expect(boxRepository.insert).toHaveBeenCalledWith(expect.objectContaining(expected))
  })

  it.each([
    [undefined, true],
    [false, false],
  ])('defaults a fresh box to public=%s', async (requestedPublic, expectedPublic) => {
    const { service, boxRepository } = makeCreateService()

    await service.create({ name: 'fresh-box', public: requestedPublic } as any, { id: 'org-1' } as any)

    expect(boxRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ public: expectedPublic }))
  })

  it('rechecks runner eligibility under the assignment fence before inserting', async () => {
    const { service, boxRepository, runnerService, redisLockProvider } = makeCreateService()
    runnerService.findOneUncachedOrFail
      .mockResolvedValueOnce({ id: 'runner-1', draining: true, state: RunnerState.READY })
      .mockResolvedValueOnce({ id: 'runner-1', draining: false, state: RunnerState.READY })

    await service.create({ name: 'fenced-box' } as any, { id: 'org-1' } as any)

    expect(redisLockProvider.acquireLease).toHaveBeenCalledWith('runner:runner-1:box-assignment', 30)
    expect(runnerService.findOneUncachedOrFail).toHaveBeenCalledTimes(2)
    expect(boxRepository.insert).toHaveBeenCalledTimes(1)
  })

  it('returns a committed box when the assignment lease aborts immediately after insert', async () => {
    const { service, boxRepository, redisLockProvider } = makeCreateService()
    const controller = new AbortController()
    redisLockProvider.acquireLease.mockResolvedValue({
      signal: controller.signal,
      release: jest.fn().mockResolvedValue(undefined),
    })
    boxRepository.insert.mockImplementation(async (box: any) => {
      controller.abort(new Error('lease lost after commit'))
      return box
    })

    await expect(service.create({ name: 'committed-box' } as any, { id: 'org-1' } as any)).resolves.toEqual(
      expect.objectContaining({ name: 'committed-box' }),
    )
  })

  it.each([
    [undefined, true],
    [false, false],
  ])('defaults an assigned warm-pool box to public=%s', async (requestedPublic, expectedPublic) => {
    const warmPoolBox = { id: 'warm-box', runnerId: 'runner-1', name: 'warm-box' } as any
    const update = jest.fn().mockResolvedValue(warmPoolBox)
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service as any, {
      boxRepository: { update },
      boxLookupCacheInvalidationService: { invalidateOrgId: jest.fn() },
      eventEmitter: { emit: jest.fn() },
      toBoxDto: jest.fn((box) => box),
    })

    await (service as any).assignWarmPoolBox(
      warmPoolBox,
      { name: 'assigned-box', public: requestedPublic },
      { id: 'org-1' },
    )

    expect(update).toHaveBeenCalledWith(
      'warm-box',
      expect.objectContaining({ updateData: expect.objectContaining({ public: expectedPublic }) }),
    )
  })
})
