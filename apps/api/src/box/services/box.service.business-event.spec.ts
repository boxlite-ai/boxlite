/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxService } from './box.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { recordBusinessEvent } from '../../common/utils/business-event.util'
import { currentLogContext, runWithLogContext } from '../../common/utils/business-event-context'

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
  })
  return service
}

const requested = (name: string) =>
  jest.mocked(recordBusinessEvent).mock.calls.find(([event]) => event.name === name && event.outcome === 'requested')

describe('BoxService business event actor', () => {
  beforeEach(() => jest.mocked(recordBusinessEvent).mockClear())

  it('records the log context actor on box.create', async () => {
    const service = makeCreateService()

    await runWithLogContext({ actorKind: 'user' }, () =>
      service.create({ name: 'fresh-box', image: 'base' } as any, { id: 'org-1' } as any),
    )

    expect(requested('box.create')?.[0]).toEqual(expect.objectContaining({ actorKind: 'user' }))
  })

  it('records the log context actor on box.stop and box.delete', async () => {
    const service = makeService()

    await runWithLogContext({ actorKind: 'user' }, () => service.stop('box-1', 'org-1'))
    await runWithLogContext({ actorKind: 'user' }, () => service.destroy('box-1', 'org-1'))

    expect(requested('box.stop')?.[0]).toEqual(expect.objectContaining({ actorKind: 'user' }))
    expect(requested('box.delete')?.[0]).toEqual(expect.objectContaining({ actorKind: 'user' }))
  })

  it('still records box.stop outside a log context, without an actor', async () => {
    const service = makeService()

    await service.stop('box-1', 'org-1')

    expect(requested('box.stop')?.[0]).toEqual(expect.objectContaining({ actorKind: undefined }))
  })

  it('destroys warm-pool boxes on unschedulable runners as warm_pool', async () => {
    const service = makeService()
    const contexts: unknown[] = []
    Object.assign(service as any, {
      runnerRepository: { find: jest.fn().mockResolvedValue([{ id: 'runner-1' }]) },
      boxRepository: { find: jest.fn().mockResolvedValue([startedBox]) },
    })
    jest.spyOn(service, 'destroy').mockImplementation(async () => {
      contexts.push(currentLogContext())
      return startedBox as any
    })

    await (service as any).handleUnschedulableRunners()

    expect(contexts).toEqual([{ actorKind: 'warm_pool' }])
  })

  it('stops a suspended organization box as org_suspension', async () => {
    const service = makeService()
    const contexts: unknown[] = []
    jest.spyOn(service, 'stop').mockImplementation(async () => {
      contexts.push(currentLogContext())
      return startedBox as any
    })

    await service.handleSuspendedBoxStopped({ boxId: 'box-1' } as any)

    expect(contexts).toEqual([{ actorKind: 'org_suspension' }])
  })
})
