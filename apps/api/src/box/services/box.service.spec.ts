/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { BoxService } from './box.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
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
    noop, // guestSshTrustService
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
    noop, // guestSshTrustService
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
    noop, // redis
    regionService, // regionService
    noop, // boxLookupCacheInvalidationService
    noop, // boxActivityService
    noop, // guestSshTrustService
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
      runnerService: { getRandomAvailableRunner: jest.fn().mockResolvedValue({ id: 'runner-1' }) },
      boxRepository,
      eventEmitter: { emitAsync: jest.fn().mockResolvedValue(undefined) },
      // Organizations without a CA get no trust bundle, which is the default
      // state; the delivery specs cover the populated case.
      guestSshTrustService: {
        resolveForNewBox: jest.fn().mockResolvedValue(null),
        isEnabledForOrganization: jest.fn().mockResolvedValue(false),
      },
      warmPoolService: { fetchWarmPoolBox: jest.fn().mockResolvedValue(null) },
      toBoxDto: jest.fn((box) => box),
    })
    return { service, boxRepository }
  }

  it('persists the organization-resolved SSH trust on the new box', async () => {
    // This is the API-side hop: without it the bundle never reaches the runner
    // and the guest listener is unreachable from the control plane. Remove the
    // assignment in BoxService.create and this fails.
    const trust = {
      listenAddr: '0.0.0.0:22',
      organizationId: 'org-1',
      boxId: 'ignored',
      caKeys: [{ keyId: 'ca-key-1', publicKey: 'ssh-ed25519 AAAA' }],
    }
    const { service, boxRepository } = makeCreateService()
    const resolve = jest.fn().mockResolvedValue(trust)
    Object.assign(service as any, {
      guestSshTrustService: { resolveForNewBox: resolve, isEnabledForOrganization: jest.fn().mockResolvedValue(true) },
    })

    await service.create({ name: 'ssh-box' } as any, { id: 'org-1' } as any)

    expect(boxRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ guestSshTrust: trust }))
    // Resolved against the real box id, and from organization policy only —
    // never from the request.
    expect(resolve).toHaveBeenCalledWith('org-1', expect.any(String))
  })

  it('leaves SSH trust null for an organization without a CA', async () => {
    const { service, boxRepository } = makeCreateService()

    await service.create({ name: 'plain-box' } as any, { id: 'org-1' } as any)

    expect(boxRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ guestSshTrust: null }))
  })

  it('bypasses the warm pool for an SSH-enabled organization', async () => {
    // A pre-warmed box booted with no trust, so serving one here would make
    // SSH availability depend on a pool hit.
    const { service } = makeCreateService()
    const fetchWarmPoolBox = jest.fn()
    const isEnabledForOrganization = jest.fn().mockResolvedValue(true)
    Object.assign(service as any, {
      // The harness defaults `warm-pool:skip` to set, which would short-circuit
      // the `||` before SSH is ever consulted and make this test vacuous.
      redis: { exists: jest.fn().mockResolvedValue(0) },
      guestSshTrustService: { resolveForNewBox: jest.fn().mockResolvedValue(null), isEnabledForOrganization },
      warmPoolService: { fetchWarmPoolBox },
    })

    await service.create({ name: 'ssh-box' } as any, { id: 'org-1' } as any)

    expect(isEnabledForOrganization).toHaveBeenCalledWith('org-1')
    expect(fetchWarmPoolBox).not.toHaveBeenCalled()
  })

  it('still uses the warm pool for an organization without SSH', async () => {
    // The counterpart to the bypass: without this, a bypass that fired
    // unconditionally would look correct above.
    const { service } = makeCreateService()
    const fetchWarmPoolBox = jest.fn().mockResolvedValue(null)
    Object.assign(service as any, {
      redis: { exists: jest.fn().mockResolvedValue(0) },
      guestSshTrustService: {
        resolveForNewBox: jest.fn().mockResolvedValue(null),
        isEnabledForOrganization: jest.fn().mockResolvedValue(false),
      },
      warmPoolService: { fetchWarmPoolBox },
    })

    await service.create({ name: 'plain-box' } as any, { id: 'org-1' } as any)

    expect(fetchWarmPoolBox).toHaveBeenCalled()
  })

  it.each([
    [undefined, true],
    [false, false],
  ])('defaults a fresh box to public=%s', async (requestedPublic, expectedPublic) => {
    const { service, boxRepository } = makeCreateService()

    await service.create({ name: 'fresh-box', public: requestedPublic } as any, { id: 'org-1' } as any)

    expect(boxRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ public: expectedPublic }))
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
