/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { RunnerService } from './runner.service'

describe('RunnerService lookup singleflight', () => {
  function makeService() {
    const runner = {
      id: 'runner-1',
      unschedulable: false,
      capabilities: ['filestore'],
      dataDiskRef: { provider: 'gcp', project: 'project-1', zone: 'zone-1', diskName: 'disk-1' },
    }
    let release!: (value: typeof runner) => void
    const runnerRepository = { findOne: jest.fn(() => new Promise<typeof runner>((resolve) => (release = resolve))) }
    const service = new RunnerService(
      runnerRepository as any,
      {} as any,
      {} as any,
      {} as any,
      { getOrThrow: jest.fn().mockReturnValue(1) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )
    return { service, runnerRepository, release: (value: typeof runner) => release(value), runner }
  }

  it('loads once and returns independent entities to concurrent callers', async () => {
    const { service, runnerRepository, release, runner } = makeService()

    const first = service.findOne('runner-1')
    const second = service.findOne('runner-1')
    await Promise.resolve()
    expect(runnerRepository.findOne).toHaveBeenCalledTimes(1)
    release(runner)
    const [left, right] = await Promise.all([first, second])

    expect(runnerRepository.findOne).toHaveBeenCalledTimes(1)
    expect(left).toEqual(runner)
    expect(right).toEqual(runner)
    expect(left).not.toBe(right)
    left!.unschedulable = true
    left!.capabilities![0] = 'changed'
    left!.dataDiskRef!.diskName = 'changed'
    expect(right).toEqual(runner)
  })
})
