import { RunnerState } from '../enums/runner-state.enum'
import { RunnerService } from './runner.service'

describe('Runner reachability alarm', () => {
  const checked = (age: number, state = RunnerState.READY, written = true) => {
    const runner = { id: 'runner-1', apiVersion: '2', state, lastChecked: new Date(Date.now() - age) }
    const logger = { warn: jest.fn(), debug: jest.fn() }
    const service = Object.assign(Object.create(RunnerService.prototype), {
      serviceStartTime: new Date(Date.now() - 120_000),
      logger,
      runnerRepository: { update: jest.fn().mockResolvedValue({ affected: written ? 1 : 0 }) },
      dataSource: {},
      eventEmitter: { emit: jest.fn() },
    })
    return { run: () => service.checkRunnerV2Health(runner), logger }
  }

  it('publishes the cloud metric event when a stale heartbeat is recorded as unreachable', async () => {
    const health = checked(90_000)
    await health.run()
    expect(health.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'runner.unreachable', runnerId: 'runner-1' }),
    )
  })

  it.each([
    [1_000, RunnerState.READY, true],
    [90_000, RunnerState.UNRESPONSIVE, true],
    [90_000, RunnerState.READY, false],
  ] as const)('does not alarm for a fresh, repeated or superseded observation', async (age, state, written) => {
    const health = checked(age, state, written)
    await health.run()
    expect(health.logger.warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'runner.unreachable' }))
  })
  it.each([true, false])('samples ongoing heartbeat loss for consecutive alarm periods (outage=%s)', async (outage) => {
    const repository = { existsBy: jest.fn().mockResolvedValue(outage), find: jest.fn().mockResolvedValue([]) }
    const logger = { warn: jest.fn() }
    const service = Object.assign(Object.create(RunnerService.prototype), {
      serviceStartTime: new Date(Date.now() - 120_000),
      runnerRepository: repository,
      logger,
      redisLockProvider: { lock: jest.fn().mockResolvedValue(true), unlock: jest.fn() },
    })
    await service.handleCheckRunners()
    expect(repository.existsBy).toHaveBeenCalledWith(
      expect.objectContaining({ apiVersion: '2', state: RunnerState.UNRESPONSIVE }),
    )
    expect(logger.warn).toHaveBeenCalledTimes(outage ? 1 : 0)
    if (outage) expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'runner.unreachable' }))
  })
})
