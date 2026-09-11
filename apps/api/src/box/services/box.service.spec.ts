/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException } from '@nestjs/common'
import { BoxService } from './box.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { BoxEvents } from '../constants/box-events.constants'

// ensureStartedForProxy only touches boxRepository + eventEmitter +
// organizationService; every other injected dependency is irrelevant.
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
    noop, // runnerAdapterFactory
    noop, // redis
    noop, // regionService
    noop, // boxLookupCacheInvalidationService
    noop, // boxActivityService
    noop, // jobRepository
    noop, // jobService
  )
  return { service, boxRepository, eventEmitter, organizationService }
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
    noop, // runnerAdapterFactory
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

  it('returns the latest box without emitting when another request wins the start race', async () => {
    const { service, boxRepository, eventEmitter } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    boxRepository.conditionalStartForProxy.mockResolvedValue(null)

    const result = await service.ensureStartedForProxy('box-1', activeOrg)

    expect(result).toBe(stoppedBox)
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('does not emit and preserves an unexpected database failure', async () => {
    const { service, boxRepository, eventEmitter } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    const databaseError = new Error('db connection lost')
    boxRepository.conditionalStartForProxy.mockRejectedValue(databaseError)

    await expect(service.ensureStartedForProxy('box-1', activeOrg)).rejects.toBe(databaseError)
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  }) // Unexpected database errors must remain visible to callers.
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
    }
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service as any, {
      getValidatedOrDefaultRegion: jest.fn().mockResolvedValue({ id: 'region-1' }),
      getValidatedOrDefaultClass: jest.fn().mockReturnValue('small'),
      organizationService: { assertOrganizationIsNotSuspended: jest.fn() },
      redis: { exists: jest.fn().mockResolvedValue(1) },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      warmPoolService,
      runnerService,
      boxRepository,
      eventEmitter: { emitAsync: jest.fn().mockResolvedValue(undefined) },
      toBoxDto: jest.fn((box) => box),
    })
    return { service, boxRepository, runnerService, warmPoolService }
  }

  it.each([
    [{ networkBlockAll: true }, { boxLimitedNetworkEgress: false }, { networkBlockAll: true }],
    [{ networkAllowList: '10.0.0.0/8' }, { boxLimitedNetworkEgress: false }, { networkAllowList: '10.0.0.0/8' }],
    [{}, { boxLimitedNetworkEgress: true }, { networkBlockAll: true }],
  ])(
    'creates a fresh box instead of claiming a warm box when network policy is required',
    async (request, org, expected) => {
      const { service, boxRepository, warmPoolService } = makeCreateService()
      ;(service as any).redis.exists.mockResolvedValue(0)

      await service.create({ name: 'restricted-box', image: 'base', ...request } as any, { id: 'org-1', ...org } as any)

      expect(warmPoolService.fetchWarmPoolBox).not.toHaveBeenCalled()
      expect(boxRepository.insert).toHaveBeenCalledWith(expect.objectContaining(expected), undefined)
    },
  )

  it.each([
    [undefined, false],
    [true, true],
  ])('defaults a fresh box to public=%s', async (requestedPublic, expectedPublic) => {
    const { service, boxRepository } = makeCreateService()

    await service.create({ name: 'fresh-box', public: requestedPublic } as any, { id: 'org-1' } as any)

    expect(boxRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ public: expectedPublic }), undefined)
  })

  it('persists secrets on a freshly created box', async () => {
    const { service, boxRepository } = makeCreateService()

    await service.create(
      { name: 'secret-box', image: 'base', secrets: [{ name: 'openai', value: 'sk-test' }] } as any,
      { id: 'org-1' } as any,
    )

    expect(boxRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: [{ name: 'openai', value: 'sk-test' }] }),
      undefined,
    )
  })

  it('creates a fresh box instead of claiming a warm box when secrets are present', async () => {
    const { service, boxRepository, warmPoolService } = makeCreateService()
    // Default exists=1 would skip the warm-pool branch outright; clear it so
    // the assertion below actually guards the secrets needsFreshBox path.
    ;(service as any).redis.exists.mockResolvedValue(0)

    await service.create(
      { name: 'secret-box', image: 'base', secrets: [{ name: 'openai', value: 'sk-test' }] } as any,
      { id: 'org-1' } as any,
    )

    expect(warmPoolService.fetchWarmPoolBox).not.toHaveBeenCalled()
    expect(boxRepository.insert).toHaveBeenCalled()
  })

  it.each([
    [undefined, false],
    [true, true],
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

// Assignment is what turns a chosen runner into a committed box row. The only
// seams it crosses are the candidate query and the insert — no transaction of
// its own, and no lock on the runner row.
describe('BoxService runner assignment', () => {
  function makeAssignment() {
    const runner = { id: 'runner-1', draining: false, state: RunnerState.READY }
    const boxRepository = { insert: jest.fn(async (box: any) => box) } as any
    const runnerService = { getRandomAvailableRunner: jest.fn().mockResolvedValue(runner) }
    // Wired even though assignment no longer reaches for it: a fixture that
    // omits a collaborator the code under test could use cannot tell an
    // unlocked assignment from a mis-assembled one.
    const dataSource = { transaction: jest.fn() }
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service as any, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      runnerService,
      dataSource,
      boxRepository,
    })

    // Drives the private assignment directly rather than through create(),
    // whose quota / region / warm-pool preamble only obscures it.
    const assign = (name = 'box-1') => {
      const box = { id: name, runnerId: undefined as string | undefined }
      return (service as any).persistOnAvailableRunner(box, { regions: ['us'] }, () => boxRepository.insert(box))
    }
    return { assign, boxRepository, runnerService, dataSource }
  }

  it('commits the box on the chosen runner without locking its row', async () => {
    const { assign, boxRepository, dataSource } = makeAssignment()

    const box = await assign()

    expect(box.runnerId).toBe('runner-1')
    expect(boxRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ runnerId: 'runner-1' }))
    // No transaction of its own means no row lock on the runner: a drain never
    // waits for this insert, and this insert never waits for a drain — so it can
    // land on a runner that goes draining in between, which is the accepted
    // trade.
    expect(dataSource.transaction).not.toHaveBeenCalled()
  })

  it('leaves an empty candidate set as the 400 it already is', async () => {
    const { assign, boxRepository, runnerService } = makeAssignment()
    runnerService.getRandomAvailableRunner.mockRejectedValue(new BadRequestError('No available runners'))

    // Nothing in that region and class can take this box. With no contention
    // left to mistake it for, there is no retryable reading of this failure.
    await expect(assign()).rejects.toMatchObject({ status: 400, message: 'No available runners' })
    expect(boxRepository.insert).not.toHaveBeenCalled()
  })
})
