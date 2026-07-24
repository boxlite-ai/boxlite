/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Runner } from '../entities/runner.entity'
import { RunnerService } from './runner.service'

describe('RunnerService metered scheduling', () => {
  it('only queries v2 runners as scheduling candidates', async () => {
    const find = jest.fn<Promise<Runner[]>, [unknown]>().mockResolvedValue([])
    const service = Object.assign(Object.create(RunnerService.prototype), {
      runnerRepository: { find },
      configService: {
        getOrThrow: jest.fn((key: string) => {
          if (key === 'runnerScore.thresholds.availability') return 10
          throw new Error(`unexpected config key ${key}`)
        }),
      },
    }) as RunnerService

    await service.findAvailableRunners({})

    expect(find).toHaveBeenCalledWith({
      where: expect.objectContaining({ apiVersion: '2' }),
    })
  })

  it.each([
    ['scheduling', 'updateSchedulingStatus', 'unschedulable'],
    ['draining', 'updateDrainingStatus', 'draining'],
  ] as const)(
    'updates %s with a field-level write so a cached Runner cannot roll back runtime fencing',
    async (_description, method, field) => {
      const runnerId = '00000000-0000-0000-0000-000000000010'
      const staleRunner = Object.assign(
        new Runner({
          region: 'region-1',
          name: 'runner-1',
          apiKey: 'key',
          apiVersion: '2',
        }),
        {
          id: runnerId,
          runtimeEpoch: '00000000-0000-0000-0000-000000000020',
          runtimeIncarnation: 1,
          runtimeSequence: 10,
        },
      )
      const canonicalRunner = {
        ...staleRunner,
        runtimeEpoch: '00000000-0000-0000-0000-000000000030',
        runtimeIncarnation: 2,
        runtimeSequence: 20,
      }
      const save = jest.fn(async (runner: Runner) => Object.assign(canonicalRunner, runner))
      const update = jest.fn(async (_id: string, patch: Partial<Runner>) => {
        Object.assign(canonicalRunner, patch)
        return { affected: 1 }
      })
      const emit = jest.fn()
      const service = Object.assign(Object.create(RunnerService.prototype), {
        runnerRepository: {
          findOne: jest.fn().mockResolvedValue(staleRunner),
          save,
          update,
        },
        dataSource: { queryResultCache: undefined },
        eventEmitter: { emit },
      }) as RunnerService

      await service[method](runnerId, true)

      expect(update).toHaveBeenCalledWith(runnerId, { [field]: true })
      expect(save).not.toHaveBeenCalled()
      expect(canonicalRunner).toMatchObject({
        [field]: true,
        runtimeEpoch: '00000000-0000-0000-0000-000000000030',
        runtimeIncarnation: 2,
        runtimeSequence: 20,
      })
      expect(emit).toHaveBeenCalledTimes(field === 'unschedulable' ? 1 : 0)
    },
  )
})
