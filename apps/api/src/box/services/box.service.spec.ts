/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { BoxService } from './box.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxEvents } from '../constants/box-events.constants'
import { VolumeState } from '../enums/volume-state.enum'

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
    noop, // redisLockProvider
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

// attachVolume/detachVolume touch boxRepository.updateWhere + volumeService;
// every other injected dependency is irrelevant.
function makeVolumeAttachService() {
  const boxRepository = { updateWhere: jest.fn() } as any
  const volumeService = { findOneByIdOrName: jest.fn() } as any
  const noop = {} as any
  const service = new BoxService(
    boxRepository, // boxRepository
    noop, // runnerRepository
    noop, // runnerService
    volumeService, // volumeService
    noop, // configService
    noop, // warmPoolService
    noop, // eventEmitter
    noop, // organizationService
    noop, // runnerAdapterFactory
    noop, // redisLockProvider
    noop, // redis
    noop, // regionService
    noop, // boxLookupCacheInvalidationService
    noop, // boxActivityService
    noop, // jobRepository
    noop, // jobService
  )
  return { service, boxRepository, volumeService }
}

const readyVolume = { id: 'vol-1', name: 'my-vol', organizationId: 'org-1', state: VolumeState.READY } as any

describe('BoxService.attachVolume', () => {
  it('adds the volume to a stopped box and persists it via updateWhere', async () => {
    const { service, boxRepository, volumeService } = makeVolumeAttachService()
    const box = { ...stoppedBox, name: 'my-box', organizationId: 'org-1', volumes: [] }
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(box as any)
    volumeService.findOneByIdOrName.mockResolvedValue(readyVolume)
    boxRepository.updateWhere.mockImplementation((_id: string, { updateData }: any) => ({
      ...box,
      ...updateData,
    }))

    const result = await service.attachVolume('my-box', 'org-1', 'my-vol', '/data')

    expect(boxRepository.updateWhere).toHaveBeenCalledWith('box-1', {
      updateData: { volumes: [{ volumeId: 'vol-1', mountPath: '/data', readOnly: false }] },
      whereCondition: { pending: false, state: BoxState.STOPPED },
    })
    expect(result.volumes).toEqual([{ volumeId: 'vol-1', mountPath: '/data', readOnly: false }])
  })

  it('rejects a running box - no hot-plug', async () => {
    const { service, boxRepository, volumeService } = makeVolumeAttachService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({
      ...stoppedBox,
      state: BoxState.STARTED,
      volumes: [],
    } as any)

    await expect(service.attachVolume('my-box', 'org-1', 'my-vol', '/data')).rejects.toThrow(
      'Box must be stopped to attach a volume',
    )
    expect(volumeService.findOneByIdOrName).not.toHaveBeenCalled()
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('rejects a volume that is not ready', async () => {
    const { service, boxRepository, volumeService } = makeVolumeAttachService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({ ...stoppedBox, volumes: [] } as any)
    volumeService.findOneByIdOrName.mockResolvedValue({ ...readyVolume, state: VolumeState.PENDING_CREATE })

    await expect(service.attachVolume('my-box', 'org-1', 'my-vol', '/data')).rejects.toThrow(
      "Volume 'my-vol' is not in a ready state",
    )
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('rejects re-attaching an already-attached volume', async () => {
    const { service, boxRepository, volumeService } = makeVolumeAttachService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({
      ...stoppedBox,
      volumes: [{ volumeId: 'vol-1', mountPath: '/other' }],
    } as any)
    volumeService.findOneByIdOrName.mockResolvedValue(readyVolume)

    await expect(service.attachVolume('my-box', 'org-1', 'my-vol', '/data')).rejects.toThrow(
      /already attached/,
    )
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('rejects a mount path already used by another volume on the box', async () => {
    const { service, boxRepository, volumeService } = makeVolumeAttachService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({
      ...stoppedBox,
      volumes: [{ volumeId: 'vol-other', mountPath: '/data' }],
    } as any)
    volumeService.findOneByIdOrName.mockResolvedValue(readyVolume)

    await expect(service.attachVolume('my-box', 'org-1', 'my-vol', '/data')).rejects.toThrow(
      /already in use/,
    )
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('rejects an invalid mount path', async () => {
    const { service, volumeService } = makeVolumeAttachService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({ ...stoppedBox, volumes: [] } as any)
    volumeService.findOneByIdOrName.mockResolvedValue(readyVolume)

    await expect(service.attachVolume('my-box', 'org-1', 'my-vol', '/etc')).rejects.toThrow(/system directory/)
  })
})

describe('BoxService.detachVolume', () => {
  it('removes the volume from a stopped box and persists it via updateWhere', async () => {
    const { service, boxRepository, volumeService } = makeVolumeAttachService()
    const box = {
      ...stoppedBox,
      name: 'my-box',
      volumes: [{ volumeId: 'vol-1', mountPath: '/data' }],
    }
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(box as any)
    volumeService.findOneByIdOrName.mockResolvedValue(readyVolume)
    boxRepository.updateWhere.mockImplementation((_id: string, { updateData }: any) => ({
      ...box,
      ...updateData,
    }))

    const result = await service.detachVolume('my-box', 'org-1', 'my-vol')

    expect(boxRepository.updateWhere).toHaveBeenCalledWith('box-1', {
      updateData: { volumes: [] },
      whereCondition: { pending: false, state: BoxState.STOPPED },
    })
    expect(result.volumes).toEqual([])
  })

  it('rejects a running box - no hot-unplug', async () => {
    const { service, boxRepository } = makeVolumeAttachService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({
      ...stoppedBox,
      state: BoxState.STARTED,
      volumes: [{ volumeId: 'vol-1', mountPath: '/data' }],
    } as any)

    await expect(service.detachVolume('my-box', 'org-1', 'my-vol')).rejects.toThrow(
      'Box must be stopped to detach a volume',
    )
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('throws NotFoundException when the volume is not attached', async () => {
    const { service, boxRepository, volumeService } = makeVolumeAttachService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({ ...stoppedBox, volumes: [] } as any)
    volumeService.findOneByIdOrName.mockResolvedValue(readyVolume)

    await expect(service.detachVolume('my-box', 'org-1', 'my-vol')).rejects.toThrow(/not attached/)
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('force treats an unattached volume as already detached (idempotent no-op)', async () => {
    const { service, boxRepository, volumeService } = makeVolumeAttachService()
    const box = { ...stoppedBox, volumes: [] }
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(box as any)
    volumeService.findOneByIdOrName.mockResolvedValue(readyVolume)

    const result = await service.detachVolume('my-box', 'org-1', 'my-vol', true)

    expect(result).toBe(box)
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('force treats a nonexistent volume as already detached (idempotent no-op)', async () => {
    const { service, boxRepository, volumeService } = makeVolumeAttachService()
    const box = { ...stoppedBox, volumes: [] }
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(box as any)
    volumeService.findOneByIdOrName.mockRejectedValue(new NotFoundException("Volume 'my-vol' not found"))

    const result = await service.detachVolume('my-box', 'org-1', 'my-vol', true)

    expect(result).toBe(box)
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('without force, propagates a nonexistent-volume NotFoundException', async () => {
    const { service, boxRepository, volumeService } = makeVolumeAttachService()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({ ...stoppedBox, volumes: [] } as any)
    volumeService.findOneByIdOrName.mockRejectedValue(new NotFoundException("Volume 'my-vol' not found"))

    await expect(service.detachVolume('my-box', 'org-1', 'my-vol', false)).rejects.toThrow(NotFoundException)
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
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
