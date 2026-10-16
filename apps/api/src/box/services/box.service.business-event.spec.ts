/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxService } from './box.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { recordBusinessEvent } from '../../common/utils/business-event.util'
import { Context } from '../../common/context/context'
import { PlatformReason } from '../../common/context/platform-reason.enum'

jest.mock('../../common/utils/business-event.util', () => ({ recordBusinessEvent: jest.fn() }))

const startedBox = {
  id: 'box-1',
  name: 'box-1',
  organizationId: 'org-1',
  state: BoxState.STARTED,
  desiredState: BoxDesiredState.STARTED,
  pending: false,
}

function makeService() {
  const service = Object.create(BoxService.prototype) as BoxService
  Object.assign(service as any, {
    findOneByIdOrName: jest.fn().mockResolvedValue(startedBox),
    boxRepository: { updateWhere: jest.fn().mockResolvedValue(startedBox) },
    eventEmitter: { emit: jest.fn() },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  })
  return service
}

function makeCreateService() {
  const service = Object.create(BoxService.prototype) as BoxService
  Object.assign(service as any, {
    getValidatedOrDefaultRegion: jest.fn().mockResolvedValue({ id: 'region-1' }),
    getValidatedOrDefaultClass: jest.fn().mockReturnValue('small'),
    organizationService: { assertOrganizationIsNotSuspended: jest.fn() },
    redis: { exists: jest.fn().mockResolvedValue(1) },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    runnerService: {
      getRandomAvailableRunner: jest.fn().mockResolvedValue({ id: 'runner-1', state: RunnerState.READY }),
    },
    boxRepository: { insert: jest.fn(async (box: any) => box) },
    eventEmitter: { emitAsync: jest.fn().mockResolvedValue(undefined) },
    toBoxDto: jest.fn((box) => box),
    imageAdmissionService: {
      assert: jest.fn().mockResolvedValue(undefined),
      spendColdPullBudget: jest.fn().mockResolvedValue(undefined),
    },
    imageResolverService: {
      resolve: jest.fn().mockResolvedValue({ ref: 'quay.io/acme/app@sha256:resolved', isOrgOwned: true }),
    },
  })
  return service
}

const requested = (name: string) =>
  jest.mocked(recordBusinessEvent).mock.calls.find(([event]) => event.name === name && event.outcome === 'requested')

describe('BoxService business event actor', () => {
  beforeEach(() => jest.mocked(recordBusinessEvent).mockClear())

  it('records the caller context on box.create', async () => {
    const service = makeCreateService()

    await service.create({ name: 'fresh-box', image: 'base' } as any, { id: 'org-1' } as any, Context.user())

    expect(requested('box.create')?.[0]).toEqual({
      name: 'box.create',
      outcome: 'requested',
      correlationId: expect.any(String),
      ctx: Context.user(),
    })
  })

  it('records the caller context on box.stop and box.delete, without an organization', async () => {
    const service = makeService()

    await service.stop('box-1', 'org-1', Context.user())
    await service.destroy('box-1', 'org-1', Context.user())

    for (const name of ['box.stop', 'box.delete']) {
      expect(requested(name)?.[0]).toEqual({ name, outcome: 'requested', correlationId: 'box-1', ctx: Context.user() })
    }
  })

  it('destroys warm-pool boxes on unschedulable runners as the platform, for the warm pool', async () => {
    const service = makeService()
    Object.assign(service as any, {
      runnerRepository: { find: jest.fn().mockResolvedValue([{ id: 'runner-1' }]) },
      boxRepository: { find: jest.fn().mockResolvedValue([startedBox]) },
    })
    const destroy = jest.spyOn(service, 'destroy').mockResolvedValue(startedBox as any)

    await (service as any).handleUnschedulableRunners()

    expect(destroy).toHaveBeenCalledWith('box-1', undefined, Context.platform(PlatformReason.WARM_POOL))
  })

  it('stops a suspended organization box as the platform, for the suspension', async () => {
    const service = makeService()
    const stop = jest.spyOn(service, 'stop').mockResolvedValue(startedBox as any)

    await service.handleSuspendedBoxStopped({ boxId: 'box-1' } as any)

    expect(stop).toHaveBeenCalledWith('box-1', undefined, Context.platform(PlatformReason.ORG_SUSPENSION))
  })
})
