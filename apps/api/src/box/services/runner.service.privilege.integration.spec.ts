/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Runner } from '../entities/runner.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { RunnerService } from './runner.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `runner_privilege_${process.pid}_${randomUUID().replaceAll('-', '')}`

describeIfDatabase('RunnerService privilege capability (integration, real Postgres)', () => {
  let dataSource: DataSource
  let runners: Repository<Runner>
  let service: RunnerService
  let ownsSchema = false
  const runnerAdapter = { healthCheck: jest.fn(), runnerInfo: jest.fn() }
  const eventEmitter = { emit: jest.fn() }

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Runner],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      installExtensions: false,
      uuidExtension: 'pgcrypto',
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    runners = dataSource.getRepository(Runner)
    service = new RunnerService(
      runners,
      { create: jest.fn().mockResolvedValue(runnerAdapter) } as any,
      {} as any,
      { lock: jest.fn().mockResolvedValue(true), unlock: jest.fn().mockResolvedValue(undefined) } as any,
      { get: () => 5, getOrThrow: () => 1 } as any,
      {} as any,
      eventEmitter as any,
      dataSource,
      {} as any,
    )
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) return
    try {
      if (ownsSchema) await dataSource.query(`DROP SCHEMA "${schemaName}" CASCADE`)
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    await runners.clear()
    runnerAdapter.healthCheck.mockReset().mockResolvedValue(undefined)
    runnerAdapter.runnerInfo.mockReset().mockResolvedValue({})
    eventEmitter.emit.mockClear()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  async function readyRunner(name: string, supportsPrivileged?: boolean, apiVersion = '2'): Promise<Runner> {
    const runner = new Runner({
      region: 'us',
      name,
      apiKey: 'test-key',
      apiVersion,
      apiUrl: `http://${name}.runner.test`,
    })
    runner.state = RunnerState.READY
    runner.availabilityScore = 100
    if (supportsPrivileged !== undefined) Object.assign(runner, { supportsPrivileged })
    return runners.save(runner)
  }

  it('selects reported support for privileged requests and keeps ordinary candidates', async () => {
    const legacy = await readyRunner('legacy')
    const unsupported = await readyRunner('unsupported', false)
    const supported = await readyRunner('supported', true)

    const privileged = await service.findAvailableRunners({ requiresPrivileged: true })
    expect(privileged.map((runner) => runner.id)).toEqual([supported.id])
    const ordinary = await service.findAvailableRunners({})
    expect(ordinary.map((runner) => runner.id).sort()).toEqual([legacy.id, unsupported.id, supported.id].sort())
  })

  it.each([
    [{ availabilityScore: 0 }, false],
    [{ availabilityScore: 1 }, true],
    [{ availabilityScore: 2 }, true],
    [{ unschedulable: true }, false],
    [{ draining: true }, false],
    [{ state: RunnerState.DECOMMISSIONED }, false],
  ])('uses the same eligibility for creation and resize: %j', async (changes, accepted) => {
    const runner = await readyRunner('resize')
    await runners.update(runner.id, changes)
    const candidates = await service.findAvailableRunners({})
    expect(candidates.some((candidate) => candidate.id === runner.id)).toBe(accepted)
    expect((await service.findAvailableRunner(runner.id)) !== null).toBe(accepted)
  })

  it('admits an existing Runner outside the top ten without moving its Box', async () => {
    const current = await readyRunner('current')
    await runners.update(current.id, { availabilityScore: 1 })
    for (let i = 0; i < 10; i++) await readyRunner(`higher-${i}`)
    expect((await service.findAvailableRunners({})).some((runner) => runner.id === current.id)).toBe(false)
    expect((await service.findAvailableRunner(current.id))?.id).toBe(current.id)
  })

  it('rejects privileged placement when no runner reports support', async () => {
    await readyRunner('legacy')
    await readyRunner('unsupported', false)

    await expect(service.getRandomAvailableRunner({ requiresPrivileged: true })).rejects.toThrow('No available runners')
  })

  it.each([undefined, false])('clears prior privilege support when the next report is %s', async (reported) => {
    const runner = await readyRunner('reporter')
    await service.updateRunnerHealth(runner.id, undefined, undefined, undefined, undefined, undefined, 'dev', true)
    expect(await runners.findOneByOrFail({ id: runner.id })).toMatchObject({ supportsPrivileged: true })

    await service.updateRunnerHealth(runner.id, undefined, undefined, undefined, undefined, undefined, 'dev', reported)
    expect(await runners.findOneByOrFail({ id: runner.id })).toMatchObject({ supportsPrivileged: false })
    expect(await service.findAvailableRunners({ requiresPrivileged: true })).toEqual([])
  })

  it.each([true, false])('preserves stored privilege support %s when the v0 info read fails', async (stored) => {
    const runner = await readyRunner('failed-info', stored, '0')
    runnerAdapter.runnerInfo.mockRejectedValueOnce(new Error('runner info unavailable'))

    await (service as any).handleCheckRunners()

    expect(runnerAdapter.healthCheck).toHaveBeenCalledTimes(1)
    expect(runnerAdapter.runnerInfo).toHaveBeenCalledTimes(1)
    expect(await runners.findOneByOrFail({ id: runner.id })).toMatchObject({
      state: RunnerState.READY,
      supportsPrivileged: stored,
    })
  })

  it.each([undefined, false, true])('uses privilege support %s from a successful v0 info report', async (reported) => {
    const runner = await readyRunner('successful-info', true, '0')
    runnerAdapter.runnerInfo.mockResolvedValueOnce(reported === undefined ? {} : { supportsPrivileged: reported })

    await (service as any).handleCheckRunners()

    expect(runnerAdapter.runnerInfo).toHaveBeenCalledTimes(1)
    expect(await runners.findOneByOrFail({ id: runner.id })).toMatchObject({
      state: RunnerState.READY,
      supportsPrivileged: reported === true,
    })
  })

  it('leaves a newer capability report untouched when the v0 info read fails', async () => {
    const runner = await readyRunner('overlapping-info', true, '0')
    runnerAdapter.runnerInfo.mockImplementationOnce(async () => {
      await service.updateRunnerHealth(runner.id, undefined, undefined, undefined, undefined, undefined, 'new', false)
      throw new Error('runner info unavailable')
    })

    await (service as any).handleCheckRunners()

    expect(await runners.findOneByOrFail({ id: runner.id })).toMatchObject({ supportsPrivileged: false })
    expect(await service.findAvailableRunners({ requiresPrivileged: true })).toEqual([])
  })

  it.each([true, false])(
    'does not persist a cancelled check after its delayed read (info failed: %s)',
    async (infoFailed) => {
      const runner = await readyRunner('delayed-info', true, '0')
      const infoStarted = deferred()
      const readStarted = deferred()
      const releaseRead = deferred()
      const updateFinished = deferred()
      const findOne = service.findOne.bind(service)
      const updateHealth = service.updateRunnerHealth.bind(service)
      jest.spyOn(service, 'findOne').mockImplementationOnce(async (id) => {
        const result = await findOne(id)
        readStarted.resolve()
        await releaseRead.promise
        return result
      })
      jest.spyOn(service, 'updateRunnerHealth').mockImplementationOnce((...args) => {
        const update = updateHealth(...args)
        void update.then(updateFinished.resolve, updateFinished.resolve)
        return update
      })
      runnerAdapter.runnerInfo
        .mockImplementationOnce((signal: AbortSignal) => {
          infoStarted.resolve()
          if (!infoFailed) return Promise.resolve({ supportsPrivileged: true, appVersion: 'old' })
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        })
        .mockResolvedValueOnce({ supportsPrivileged: false, appVersion: 'retry' })
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })

      const poll = (service as any).handleCheckRunners()
      try {
        await infoStarted.promise
        if (!infoFailed) await readStarted.promise
        await jest.advanceTimersByTimeAsync(5000)
        await readStarted.promise
        await jest.advanceTimersByTimeAsync(500)
        await poll
        const retryReport = await runners.findOneByOrFail({ id: runner.id })
        expect(retryReport).toMatchObject({ supportsPrivileged: false, appVersion: 'retry' })
        expect(runnerAdapter.runnerInfo).toHaveBeenCalledTimes(2)
        expect(eventEmitter.emit).toHaveBeenCalledTimes(1)

        // Resume the old read only after the retry has committed its report.
        await jest.advanceTimersByTimeAsync(1000)
        releaseRead.resolve()
        await updateFinished.promise

        expect(await runners.findOneByOrFail({ id: runner.id })).toMatchObject({
          supportsPrivileged: false,
          appVersion: 'retry',
          lastChecked: retryReport.lastChecked,
        })
        expect(eventEmitter.emit).toHaveBeenCalledTimes(1)
        expect(await service.findAvailableRunners({ requiresPrivileged: true })).toEqual([])
      } finally {
        releaseRead.resolve()
        await updateFinished.promise
      }
    },
  )
})
