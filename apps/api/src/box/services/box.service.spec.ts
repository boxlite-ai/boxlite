/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common'
import { BoxService } from './box.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxEvents } from '../constants/box-events.constants'

// ensureStartedForProxy only touches boxRepository, eventEmitter,
// organizationService, and Commerce admission; every other dependency is irrelevant.
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
  const commerceAdmission = {
    admit: jest.fn().mockResolvedValue(null),
    release: jest.fn().mockResolvedValue(undefined),
  }
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
    noop, // redisLockProvider
    noop, // redis
    noop, // regionService
    noop, // boxLookupCacheInvalidationService
    noop, // boxActivityService
    noop, // jobRepository
    noop, // jobService
    commerceAdmission as any, // commerceAdmission
  )
  return { service, boxRepository, eventEmitter, organizationService, commerceAdmission }
}

const activeOrg = { id: 'org-1', suspended: false } as any
const suspendedOrg = { id: 'org-1', suspended: true } as any

const stoppedBox = {
  id: 'box-1',
  organizationId: 'org-1',
  region: 'region-1',
  cpu: 2,
  gpu: 1,
  mem: 4,
  disk: 20,
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
    noop, // redisLockProvider
    redis, // redis
    regionService, // regionService
    noop, // boxLookupCacheInvalidationService
    noop, // boxActivityService
    noop, // jobRepository
    noop, // jobService
    noop, // commerceAdmission
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
    const { service, boxRepository, eventEmitter, commerceAdmission } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    boxRepository.conditionalStartForProxy.mockResolvedValue({
      ...stoppedBox,
      pending: true,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.ensureStartedForProxy('box-1', activeOrg)

    expect(commerceAdmission.admit).toHaveBeenCalledWith({
      scenario: 'START-BOX',
      organizationId: 'org-1',
      resources: { cpu: 2, gpu: 1, mem: 4, disk: 20 },
    })
    expect(commerceAdmission.admit.mock.invocationCallOrder[0]).toBeLessThan(
      boxRepository.conditionalStartForProxy.mock.invocationCallOrder[0],
    )
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
    const { service, boxRepository, eventEmitter, commerceAdmission } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({
      ...stoppedBox,
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
    } as any)

    await service.ensureStartedForProxy('box-1', activeOrg)

    expect(boxRepository.conditionalStartForProxy).not.toHaveBeenCalled()
    expect(commerceAdmission.admit).not.toHaveBeenCalled()
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
    const { service, boxRepository, eventEmitter, commerceAdmission } = makeService()
    const reservation = { organizationId: 'org-1', reservationId: 'reservation-1' }
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    commerceAdmission.admit.mockResolvedValue(reservation)
    boxRepository.conditionalStartForProxy.mockResolvedValue(null)

    const result = await service.ensureStartedForProxy('box-1', activeOrg)

    expect(result).toBe(stoppedBox)
    expect(commerceAdmission.release).toHaveBeenCalledWith(reservation)
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('does not emit and preserves an unexpected database failure', async () => {
    const { service, boxRepository, eventEmitter, commerceAdmission } = makeService()
    const reservation = { organizationId: 'org-1', reservationId: 'reservation-1' }
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    commerceAdmission.admit.mockResolvedValue(reservation)
    const databaseError = new Error('db connection lost')
    boxRepository.conditionalStartForProxy.mockRejectedValue(databaseError)

    await expect(service.ensureStartedForProxy('box-1', activeOrg)).rejects.toBe(databaseError)
    expect(commerceAdmission.release).toHaveBeenCalledWith(reservation)
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  }) // Unexpected database errors must remain visible to callers.

  it('does not submit a proxy start intent when Commerce rejects it', async () => {
    const { service, boxRepository, eventEmitter, commerceAdmission } = makeService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    commerceAdmission.admit.mockRejectedValue(new HttpException('INSUFFICIENT_AVAILABLE_CREDIT', 402))

    await expect(service.ensureStartedForProxy('box-1', activeOrg)).rejects.toMatchObject({ status: 402 })

    expect(boxRepository.conditionalStartForProxy).not.toHaveBeenCalled()
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('retains the reservation after the proxy start intent commits even if event delivery fails', async () => {
    const { service, boxRepository, eventEmitter, commerceAdmission } = makeService()
    const reservation = { organizationId: 'org-1', reservationId: 'reservation-1' }
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(stoppedBox as any)
    commerceAdmission.admit.mockResolvedValue(reservation)
    boxRepository.conditionalStartForProxy.mockResolvedValue({
      ...stoppedBox,
      pending: true,
      desiredState: BoxDesiredState.STARTED,
    })
    eventEmitter.emit.mockImplementationOnce(() => {
      throw new Error('event failed')
    })

    await expect(service.ensureStartedForProxy('box-1', activeOrg)).rejects.toThrow('event failed')

    expect(commerceAdmission.release).not.toHaveBeenCalled()
  })
})

function makeStartService(box = stoppedBox) {
  const boxRepository = {
    updateWhere: jest.fn().mockResolvedValue({
      ...box,
      pending: true,
      desiredState: BoxDesiredState.STARTED,
    }),
  }
  const commerceAdmission = {
    admit: jest.fn().mockResolvedValue(null),
    release: jest.fn().mockResolvedValue(undefined),
  }
  const eventEmitter = { emit: jest.fn() }
  const organizationService = { assertOrganizationIsNotSuspended: jest.fn() }
  const regionService = { findOne: jest.fn().mockResolvedValue({ id: 'region-1' }) }
  const service = Object.create(BoxService.prototype) as BoxService
  Object.assign(service as any, {
    boxRepository,
    commerceAdmission,
    eventEmitter,
    organizationService,
    regionService,
  })
  jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(box as any)
  return { service, boxRepository, commerceAdmission, eventEmitter, organizationService }
}

describe('BoxService.start Commerce admission', () => {
  it('admits resolved Box resources before committing a complete stopped-state CAS', async () => {
    const { service, boxRepository, commerceAdmission } = makeStartService()

    await service.start('box-1', activeOrg)

    expect(commerceAdmission.admit).toHaveBeenCalledWith({
      scenario: 'START-BOX',
      organizationId: 'org-1',
      resources: { cpu: 2, gpu: 1, mem: 4, disk: 20 },
    })
    expect(commerceAdmission.admit.mock.invocationCallOrder[0]).toBeLessThan(
      boxRepository.updateWhere.mock.invocationCallOrder[0],
    )
    expect(boxRepository.updateWhere).toHaveBeenCalledWith(
      'box-1',
      expect.objectContaining({
        whereCondition: {
          organizationId: 'org-1',
          state: BoxState.STOPPED,
          desiredState: BoxDesiredState.STOPPED,
          pending: false,
        },
      }),
    )
  })

  it('does not admit or write an already-started Box', async () => {
    const { service, boxRepository, commerceAdmission } = makeStartService({
      ...stoppedBox,
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
    })

    await service.start('box-1', activeOrg)

    expect(commerceAdmission.admit).not.toHaveBeenCalled()
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('does not write a start intent when Commerce rejects it', async () => {
    const { service, boxRepository, commerceAdmission } = makeStartService()
    commerceAdmission.admit.mockRejectedValue(new HttpException('INSUFFICIENT_AVAILABLE_CREDIT', 402))

    await expect(service.start('box-1', activeOrg)).rejects.toMatchObject({ status: 402 })

    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('releases an accepted reservation when the explicit start CAS fails', async () => {
    const { service, boxRepository, commerceAdmission } = makeStartService()
    const reservation = { organizationId: 'org-1', reservationId: 'reservation-1' }
    const databaseError = new Error('start CAS failed')
    commerceAdmission.admit.mockResolvedValue(reservation)
    boxRepository.updateWhere.mockRejectedValue(databaseError)

    await expect(service.start('box-1', activeOrg)).rejects.toBe(databaseError)

    expect(commerceAdmission.release).toHaveBeenCalledWith(reservation)
  })

  it('retains the reservation after the explicit start intent commits even if event delivery fails', async () => {
    const { service, commerceAdmission, eventEmitter } = makeStartService()
    const reservation = { organizationId: 'org-1', reservationId: 'reservation-1' }
    commerceAdmission.admit.mockResolvedValue(reservation)
    eventEmitter.emit.mockImplementationOnce(() => {
      throw new Error('event failed')
    })

    await expect(service.start('box-1', activeOrg)).rejects.toThrow('event failed')

    expect(commerceAdmission.release).not.toHaveBeenCalled()
  })
})

function makeRecoverService() {
  const errorBox = {
    ...stoppedBox,
    state: BoxState.ERROR,
    desiredState: BoxDesiredState.STARTED,
    runnerId: 'runner-1',
    recoverable: true,
  }
  const recoveredBox = {
    ...stoppedBox,
    runnerId: 'runner-1',
    recoverable: false,
  }
  const boxRepository = {
    updateWhere: jest
      .fn()
      .mockResolvedValueOnce(recoveredBox)
      .mockResolvedValueOnce({ ...recoveredBox, pending: true, desiredState: BoxDesiredState.STARTED }),
  }
  const commerceAdmission = {
    admit: jest.fn().mockResolvedValue(null),
    release: jest.fn().mockResolvedValue(undefined),
  }
  const runnerAdapter = { recoverBox: jest.fn().mockResolvedValue(undefined) }
  const runnerService = { findOneOrFail: jest.fn().mockResolvedValue({ id: 'runner-1', apiVersion: '1' }) }
  const runnerAdapterFactory = { create: jest.fn().mockResolvedValue(runnerAdapter) }
  const organizationService = { assertOrganizationIsNotSuspended: jest.fn() }
  const regionService = { findOne: jest.fn().mockResolvedValue({ id: 'region-1' }) }
  const eventEmitter = { emit: jest.fn() }
  const service = Object.create(BoxService.prototype) as BoxService
  Object.assign(service as any, {
    boxRepository,
    commerceAdmission,
    runnerService,
    runnerAdapterFactory,
    organizationService,
    regionService,
    eventEmitter,
  })
  jest.spyOn(service, 'findOneByIdOrName').mockResolvedValueOnce(errorBox as any).mockResolvedValue(recoveredBox as any)
  return { service, boxRepository, commerceAdmission, runnerAdapter, organizationService }
}

describe('BoxService.recover Commerce admission', () => {
  it('leaves an ordinary recovered Box stopped when START-BOX is rejected', async () => {
    const { service, boxRepository, commerceAdmission, runnerAdapter } = makeRecoverService()
    commerceAdmission.admit.mockRejectedValue(new HttpException('INSUFFICIENT_AVAILABLE_CREDIT', 402))

    await expect(service.recover('box-1', activeOrg)).rejects.toMatchObject({ status: 402 })

    expect(runnerAdapter.recoverBox).toHaveBeenCalled()
    expect(boxRepository.updateWhere).toHaveBeenCalledTimes(1)
    expect(boxRepository.updateWhere).toHaveBeenCalledWith(
      'box-1',
      expect.objectContaining({
        updateData: expect.objectContaining({
          state: BoxState.STOPPED,
          desiredState: BoxDesiredState.STOPPED,
        }),
      }),
    )
  })

  it('lets admin recovery start without Commerce while preserving normal start validation', async () => {
    const { service, boxRepository, commerceAdmission, organizationService } = makeRecoverService()

    await service.recoverAsAdmin('box-1', activeOrg)

    expect(commerceAdmission.admit).not.toHaveBeenCalled()
    expect(organizationService.assertOrganizationIsNotSuspended).toHaveBeenCalledWith(activeOrg)
    expect(boxRepository.updateWhere).toHaveBeenCalledTimes(2)
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
    noop,
    noop,
    noop,
    regionService,
    noop,
    noop,
    noop, // jobRepository
    noop, // jobService
    noop, // commerceAdmission
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
    const commerceAdmission = {
      admit: jest.fn().mockResolvedValue(null),
      release: jest.fn().mockResolvedValue(undefined),
    }
    const volumeService = { validateVolumes: jest.fn().mockResolvedValue(undefined) }
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service as any, {
      getValidatedOrDefaultRegion: jest.fn().mockResolvedValue({ id: 'region-1' }),
      getValidatedOrDefaultClass: jest.fn().mockReturnValue('small'),
      organizationService: { assertOrganizationIsNotSuspended: jest.fn() },
      commerceAdmission,
      volumeService,
      redis: { exists: jest.fn().mockResolvedValue(1) },
      warmPoolService,
      runnerService,
      redisLockProvider,
      boxRepository,
      eventEmitter: { emitAsync: jest.fn().mockResolvedValue(undefined) },
      toBoxDto: jest.fn((box) => box),
    })
    return {
      service,
      boxRepository,
      runnerService,
      redisLockProvider,
      commerceAdmission,
      volumeService,
      warmPoolService,
    }
  }

  it('checks Commerce with resolved resources before persisting a box', async () => {
    const { service, boxRepository, commerceAdmission } = makeCreateService()

    await service.create({ name: 'admitted-box' } as any, { id: 'org-1' } as any)

    expect(commerceAdmission.admit).toHaveBeenCalledWith({
      scenario: 'CREATE-BOX',
      organizationId: 'org-1',
      resources: { cpu: 1, gpu: 0, mem: 1, disk: 10 },
    })
    expect(commerceAdmission.admit.mock.invocationCallOrder[0]).toBeLessThan(
      boxRepository.insert.mock.invocationCallOrder[0],
    )
  })

  it('releases Commerce admission when a later local create step fails', async () => {
    const { service, boxRepository, commerceAdmission } = makeCreateService()
    const reservation = { organizationId: 'org-1', reservationId: '550e8400-e29b-41d4-a716-446655440000' }
    commerceAdmission.admit.mockResolvedValue(reservation)
    boxRepository.insert.mockRejectedValue(new Error('insert failed'))

    await expect(service.create({ name: 'rejected-box' } as any, { id: 'org-1' } as any)).rejects.toThrow('insert failed')
    expect(commerceAdmission.release).toHaveBeenCalledWith(reservation)
  })

  it('rejects invalid volumes before calling Commerce', async () => {
    const { service, commerceAdmission, volumeService } = makeCreateService()
    volumeService.validateVolumes.mockRejectedValue(new BadRequestException('volume is not ready'))

    await expect(
      service.create(
        { name: 'invalid-volume-box', volumes: [{ volumeId: 'volume-1', mountPath: '/data' }] } as any,
        { id: 'org-1' } as any,
      ),
    ).rejects.toThrow('volume is not ready')
    expect(commerceAdmission.admit).not.toHaveBeenCalled()
  })

  it('does not release Commerce admission after the box insert has committed', async () => {
    const { service, commerceAdmission } = makeCreateService()
    const reservation = { organizationId: 'org-1', reservationId: '550e8400-e29b-41d4-a716-446655440000' }
    commerceAdmission.admit.mockResolvedValue(reservation)
    ;(service as any).toBoxDto = jest.fn().mockRejectedValue(new Error('response mapping failed'))

    await expect(service.create({ name: 'committed-box' } as any, { id: 'org-1' } as any)).rejects.toThrow(
      'response mapping failed',
    )
    expect(commerceAdmission.release).not.toHaveBeenCalled()
  })

  it('propagates a cached 402 without persisting a box', async () => {
    const { service, boxRepository, commerceAdmission } = makeCreateService()
    commerceAdmission.admit.mockRejectedValue(new HttpException('INSUFFICIENT_AVAILABLE_CREDIT', 402))

    await expect(service.create({ name: 'unfunded-box' } as any, { id: 'org-1' } as any)).rejects.toMatchObject({
      status: 402,
    })
    expect(boxRepository.insert).not.toHaveBeenCalled()
  })

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
      expect(boxRepository.insert).toHaveBeenCalledWith(expect.objectContaining(expected))
    },
  )

  it.each([
    [undefined, true],
    [false, false],
  ])('defaults a fresh box to public=%s', async (requestedPublic, expectedPublic) => {
    const { service, boxRepository } = makeCreateService()

    await service.create({ name: 'fresh-box', public: requestedPublic } as any, { id: 'org-1' } as any)

    expect(boxRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ public: expectedPublic }))
  })

  it('persists secrets on a freshly created box', async () => {
    const { service, boxRepository } = makeCreateService()

    await service.create(
      { name: 'secret-box', image: 'base', secrets: [{ name: 'openai', value: 'sk-test' }] } as any,
      { id: 'org-1' } as any,
    )

    expect(boxRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: [{ name: 'openai', value: 'sk-test' }] }),
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
