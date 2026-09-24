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
import { Repository } from 'typeorm'
import { ImageVersion } from '../../image/entities/image-version.entity'
import { ImageResolverService } from '../../image/services/image-resolver.service'

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
    noop, // boxExitCodeService
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
    noop, // imageAdmissionService
    noop, // imageResolverService
    noop, // imageRegistrarService
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
    noop, // boxExitCodeService
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
    noop, // imageAdmissionService
    noop, // imageResolverService
    noop, // imageRegistrarService
  )
  jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({
    id: 'MixedCaseBox',
    authToken: 'preview-token',
    region: 'region-1',
  } as any)

  return { service, redis, regionService }
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

  it.each([1, 3000, 8080, 22222, 65535])('signs a preview URL for port %i', async (port) => {
    const { service, redis } = makePreviewUrlService()

    const result = await service.getSignedPortPreviewUrl('MixedCaseBox', 'org-1', port)

    expect(result).toEqual({
      boxId: 'MixedCaseBox',
      port,
      token: expect.stringMatching(/^[a-z0-9]{16}$/),
      url: `https://${port}-${result.token}.proxy.example.test`,
    })
    expect(service.findOneByIdOrName).toHaveBeenCalledWith('MixedCaseBox', 'org-1')
    expect(redis.setex).toHaveBeenCalledWith(`box:signed-preview-url-token:${port}:${result.token}`, 60, 'MixedCaseBox')
  })

  it.each([0, 65536, 3000.5, NaN])('rejects invalid signed preview port %s before storing a token', async (port) => {
    const { service, redis } = makePreviewUrlService()

    await expect(service.getSignedPortPreviewUrl('MixedCaseBox', 'org-1', port)).rejects.toThrow('Invalid port')

    expect(redis.setex).not.toHaveBeenCalled()
  })

  it.each([1, 3600, 86400])('stores a service-port token with a lifetime of %i seconds', async (expiresInSeconds) => {
    const { service, redis } = makePreviewUrlService()

    const result = await service.getSignedPortPreviewUrl('MixedCaseBox', 'org-1', 3000, expiresInSeconds)

    expect(redis.setex).toHaveBeenCalledWith(
      `box:signed-preview-url-token:3000:${result.token}`,
      expiresInSeconds,
      'MixedCaseBox',
    )
  })

  it.each([0, 86401])('rejects invalid signed preview lifetime %i before storing a token', async (expiresInSeconds) => {
    const { service, redis } = makePreviewUrlService()

    await expect(service.getSignedPortPreviewUrl('MixedCaseBox', 'org-1', 22222, expiresInSeconds)).rejects.toThrow(
      'expiresInSeconds must be between 1 second and 24 hours',
    )

    expect(redis.setex).not.toHaveBeenCalled()
  })

  it.each([3000, 22222])('uses the regional proxy domain for signed preview port %i', async (port) => {
    const { service, regionService } = makePreviewUrlService()
    regionService.findOne.mockResolvedValue({ proxyUrl: 'https://regional.proxy.example.test' })

    const result = await service.getSignedPortPreviewUrl('MixedCaseBox', 'org-1', port)

    expect(result.url).toBe(`https://${port}-${result.token}.regional.proxy.example.test`)
    expect(regionService.findOne).toHaveBeenCalledWith('region-1', true)
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
    noop, // runnerService
    noop, // boxExitCodeService
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
    noop, // imageAdmissionService
    noop, // imageResolverService
    noop, // imageRegistrarService
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

describe('BoxService image reporting', () => {
  function makeService(boxState: BoxState, imageIsOrgOwned: boolean | null = true) {
    const box = {
      id: 'box-1',
      organizationId: 'org-1',
      runnerId: 'runner-1',
      image: 'quay.io/acme/app:v1',
      imageIsOrgOwned,
      state: boxState,
    }
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service as any, {
      // The ERROR case runs on past the image report into the real state
      // update, so the write it ends with has to exist.
      boxRepository: { findOne: jest.fn().mockResolvedValue(box), updateWhere: jest.fn() },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      imageRegistrarService: { onBoxStarted: jest.fn().mockResolvedValue(undefined) },
    })
    return { service, registrar: (service as any).imageRegistrarService }
  }

  const reported = { digest: `sha256:${'a'.repeat(64)}`, sizeBytes: 4096 }

  /**
   * The report arrives on a state the control plane usually already has: it
   * also learns a box is up by polling the runner, and whichever observation
   * lands first makes the other a no-op transition. Recording the image has to
   * survive that, or the catalog fills only when the race happens to go one way.
   */
  it('records the image even when the reported state is the one already stored', async () => {
    const { service, registrar } = makeService(BoxState.STARTED)

    await service.updateState('box-1', BoxState.STARTED, false, undefined, reported)

    expect(registrar.onBoxStarted).toHaveBeenCalledWith(
      'org-1',
      { ref: 'quay.io/acme/app:v1', isOrgOwned: true, runnerId: 'runner-1' },
      reported,
    )
  })

  /**
   * The registrar is told whose image this is rather than deciding, and what it
   * is told is what the box recorded when it was created. Passing the recorded
   * `false` through is the whole fix: recomputing here would ask the curated
   * set as it stands now, which is not the set this box was created against.
   */
  it('passes on the ownership the box recorded, not a fresh look at the curated set', async () => {
    const { service, registrar } = makeService(BoxState.STARTED, false)

    await service.updateState('box-1', BoxState.STARTED, false, undefined, reported)

    expect(registrar.onBoxStarted).toHaveBeenCalledWith(
      'org-1',
      { ref: 'quay.io/acme/app:v1', isOrgOwned: false, runnerId: 'runner-1' },
      reported,
    )
  })

  /**
   * A pull that failed reports ERROR. An image that never booted must not be in
   * the catalog, where it would count against the organization's limit and be
   * handed to the next box as if it had worked.
   */
  it('records nothing when the box is reporting an error', async () => {
    const { service, registrar } = makeService(BoxState.STARTED)

    await service.updateState('box-1', BoxState.ERROR, false, 'Failed to pull artifact image', reported)

    expect(registrar.onBoxStarted).not.toHaveBeenCalled()
  })

  /**
   * The state update is what the control plane acts on; a lost registration
   * only costs the next create one re-resolution.
   */
  it('does not fail the state update when registration throws', async () => {
    const { service, registrar } = makeService(BoxState.STARTED)
    registrar.onBoxStarted.mockRejectedValue(new Error('conflict'))

    await expect(service.updateState('box-1', BoxState.STARTED, false, undefined, reported)).resolves.toBeUndefined()
  })
})

describe('BoxService public defaults', () => {
  function makeCreateService(overrides: Record<string, unknown> = {}) {
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
      imageAdmissionService: { assert: jest.fn().mockResolvedValue(undefined) },
      imageResolverService: {
        resolve: jest.fn().mockResolvedValue({ ref: 'quay.io/acme/app@sha256:resolved', isOrgOwned: true }),
      },
      ...overrides,
    })
    return { service, boxRepository, runnerService, warmPoolService }
  }

  /**
   * Two collaborators now stand between the request and the box: admission
   * decides whether this image may be used at all, and the resolver decides
   * which ref a runner is handed. What is asserted here is the seam — both are
   * asked, and the box records the resolver's answer rather than what the
   * caller typed. Which ref the resolver picks is its own specification's job.
   */
  it('stores the ref the resolver returned, not the selector the caller sent', async () => {
    const { service, boxRepository } = makeCreateService()

    await service.create({ name: 'tenant-box', image: 'quay.io/acme/app:v1' } as any, { id: 'org-1' } as any)

    expect((service as any).imageAdmissionService.assert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'org-1' }),
      'quay.io/acme/app:v1',
    )
    expect((service as any).imageResolverService.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'org-1' }),
      'quay.io/acme/app:v1',
    )
    expect(boxRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'quay.io/acme/app@sha256:resolved' }),
      undefined,
    )
  })

  /**
   * The one path every existing caller takes, and the only one asserted through
   * the real resolver: a mocked one would make this a test of the mock. The
   * repository throws, so a curated selector reaching the database fails here
   * rather than merely costing a query.
   */
  it('still resolves a curated selector to its operator-configured ref', async () => {
    const repository = {
      createQueryBuilder: () => {
        throw new Error('a curated selector must not query the catalog')
      },
    } as unknown as Repository<ImageVersion>
    const { service, boxRepository } = makeCreateService({
      imageResolverService: new ImageResolverService(repository),
    })

    await service.create({ name: 'curated-box', image: 'python' } as any, { id: 'org-1' } as any)

    expect(boxRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ image: expect.stringContaining('boxlite-agent-python') }),
      undefined,
    )
  })

  /**
   * The pool holds boxes created with no organization, so an image one
   * organization owns must not be served from it. Asserted on the collaborators
   * rather than on the returned box: a fresh box is what a warm miss produces
   * too, so the outcome alone cannot tell the two apart.
   *
   * The Redis key matters on its own. `warm-pool:skip:<image>` is named after
   * the image, so reaching that line with a tenant-supplied ref would let a
   * caller decide a key's name.
   */
  it('neither consults the warm pool nor names a skip key for an org image', async () => {
    const { service, warmPoolService } = makeCreateService()

    await service.create({ name: 'tenant-box', image: 'quay.io/acme/app:v1' } as any, { id: 'org-1' } as any)

    expect((service as any).redis.exists).not.toHaveBeenCalled()
    expect(warmPoolService.fetchWarmPoolBox).not.toHaveBeenCalled()
  })

  it('still consults the warm pool for a curated image', async () => {
    const { service, warmPoolService } = makeCreateService({
      imageResolverService: {
        resolve: jest
          .fn()
          .mockResolvedValue({ ref: 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0', isOrgOwned: false }),
      },
      // No skip key: the default fixture has one, which would keep the pool
      // out of this test for a reason that has nothing to do with the image.
      redis: { exists: jest.fn().mockResolvedValue(0) },
    })

    await service.create({ name: 'curated-box', image: 'base' } as any, { id: 'org-1' } as any)

    expect((service as any).redis.exists).toHaveBeenCalled()
    expect(warmPoolService.fetchWarmPoolBox).toHaveBeenCalled()
  })

  /**
   * The other side of the same rule. A pool row is filled by a background
   * top-up, not by a request, so nothing upstream of here has checked its
   * image — and the box it creates belongs to no organization until one claims
   * it.
   */
  it('refuses to fill a warm pool row that names an image an organization owns', async () => {
    const { service, boxRepository } = makeCreateService()

    await expect(
      service.createForWarmPool({ id: 'pool-7', image: 'quay.io/acme/app:v1', target: 'region-1' } as any),
    ).rejects.toThrow(/pool-7/)
    expect(boxRepository.insert).not.toHaveBeenCalled()
  })

  it('fills a warm pool row that names a curated image', async () => {
    const { service, boxRepository } = makeCreateService()

    await service.createForWarmPool({
      id: 'pool-8',
      image: 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0',
      target: 'region-1',
      class: 'small',
      cpu: 2,
      mem: 4,
      disk: 10,
      gpu: 0,
      osUser: 'boxlite',
      env: {},
    } as any)

    expect(boxRepository.insert).toHaveBeenCalled()
  })

  it('asks admission before it asks the resolver', async () => {
    const { service } = makeCreateService()
    const order: string[] = []
    ;(service as any).imageAdmissionService.assert.mockImplementation(async () => void order.push('admission'))
    ;(service as any).imageResolverService.resolve.mockImplementation(async () => {
      order.push('resolver')
      return { ref: 'quay.io/acme/app@sha256:resolved', isOrgOwned: true }
    })

    await service.create({ name: 'ordered-box', image: 'quay.io/acme/app:v1' } as any, { id: 'org-1' } as any)

    // A refused image must not reach a catalog query.
    expect(order).toEqual(['admission', 'resolver'])
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
