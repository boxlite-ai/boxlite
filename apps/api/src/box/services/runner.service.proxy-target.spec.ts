/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { RunnerService } from './runner.service'

describe('RunnerService proxy target cache', () => {
  function makeService() {
    const target = {
      id: 'runner-1',
      apiUrl: 'http://runner.local',
      proxyUrl: null,
      apiKey: 'runner-key',
      currentStartedBoxes: 99,
      availabilityScore: 1,
    }
    const runnerRepository = {
      findOne: jest.fn().mockResolvedValue(target),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    }
    const remove = jest.fn().mockResolvedValue(undefined)
    const service = new RunnerService(
      runnerRepository as any,
      {} as any,
      {} as any,
      {} as any,
      { getOrThrow: jest.fn().mockReturnValue(1) } as any,
      {} as any,
      {} as any,
      { queryResultCache: { remove } } as any,
      {} as any,
    )
    return { service, runnerRepository, remove, target }
  }

  it('coalesces cold reads and serves later reads from the narrow local cache', async () => {
    const { service, runnerRepository } = makeService()

    const [first, second] = await Promise.all([
      service.findProxyTarget('runner-1'),
      service.findProxyTarget('runner-1'),
    ])
    const third = await service.findProxyTarget('runner-1')

    expect(runnerRepository.findOne).toHaveBeenCalledTimes(1)
    expect(runnerRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'runner-1' },
      select: ['id', 'apiUrl', 'proxyUrl', 'apiKey'],
      cache: { id: 'runner:proxy-target:runner-1', milliseconds: 60_000 },
    })
    expect(first).toEqual({
      id: 'runner-1',
      apiUrl: 'http://runner.local',
      proxyUrl: null,
      apiKey: 'runner-key',
    })
    expect(first).not.toHaveProperty('currentStartedBoxes')
    expect(first).not.toHaveProperty('availabilityScore')
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(second).not.toBe(first)
    expect(third).not.toBe(first)
  })

  it('keeps the target cached across load-only updates', async () => {
    const { service, runnerRepository } = makeService()
    await service.findProxyTarget('runner-1')

    await (service as any).updateRunnerUnlessDecommissioned('runner-1', {
      currentStartedBoxes: 100,
      availabilityScore: 2,
    })
    await service.findProxyTarget('runner-1')

    expect(runnerRepository.findOne).toHaveBeenCalledTimes(1)
  })

  it('invalidates the target when its endpoint changes', async () => {
    const { service, runnerRepository, remove } = makeService()
    await service.findProxyTarget('runner-1')

    await (service as any).updateRunnerUnlessDecommissioned('runner-1', { apiUrl: 'http://new-runner.local' })
    await service.findProxyTarget('runner-1')

    expect(runnerRepository.findOne).toHaveBeenCalledTimes(2)
    expect(remove).toHaveBeenCalledWith(['runner:proxy-target:runner-1'])
  })
})
