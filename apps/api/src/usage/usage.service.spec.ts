/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { getMetadataArgsStorage } from 'typeorm'
import { Box } from '../box/entities/box.entity'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../box/constants/box.constants'
import { BoxClass } from '../box/enums/box-class.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxState } from '../box/enums/box-state.enum'
import { RegionType } from '../region/enums/region-type.enum'
import { AddBoxUsagePeriods1785300000000 } from '../migrations/pre-deploy/1785300000000-add-box-usage-periods-migration'
import { BoxUsagePeriodArchive } from './entities/box-usage-period-archive.entity'
import { BoxUsagePeriod } from './entities/box-usage-period.entity'
import { UsageService } from './services/usage.service'

type UsageRepositoryMock = {
  createQueryBuilder: jest.Mock
  findOne: jest.Mock
  find: jest.Mock
  save: jest.Mock
  manager: {
    transaction: jest.Mock
  }
}

type TransactionManagerMock = {
  findOne: jest.Mock
  find: jest.Mock
  save: jest.Mock
  delete: jest.Mock
}

type LockProviderMock = {
  waitForLock: jest.Mock
  lock: jest.Mock
  unlock: jest.Mock
}

function makeBox(
  state: BoxState,
  desiredState: BoxDesiredState = BoxDesiredState.STARTED,
  overrides: Partial<Box> = {},
): Box {
  return {
    id: 'box-1',
    organizationId: 'org-1',
    region: 'us',
    runnerId: 'runner-1',
    state,
    desiredState,
    cpu: 2,
    mem: 4,
    disk: 10,
    gpu: 1,
    class: BoxClass.SMALL,
    ...overrides,
  } as Box
}

function makeOpenPeriod(overrides: Partial<BoxUsagePeriod> = {}): BoxUsagePeriod {
  return Object.assign(new BoxUsagePeriod(), {
    id: 'period-1',
    boxId: 'box-1',
    organizationId: 'org-1',
    startAt: new Date('2026-07-26T00:00:00.000Z'),
    endAt: null,
    cpu: 2,
    gpu: 1,
    gpuType: 'nvidia-a10',
    mem: 4,
    disk: 10,
    region: 'us',
    boxClass: BoxClass.SMALL,
    regionType: RegionType.DEDICATED,
    ...overrides,
  })
}

function setup() {
  const transactionManager: TransactionManagerMock = {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(async (value) => value),
    delete: jest.fn(),
  }
  const usageQueryBuilder = {
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  }
  const repository: UsageRepositoryMock = {
    createQueryBuilder: jest.fn().mockReturnValue(usageQueryBuilder),
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(async (value) => value),
    manager: {
      transaction: jest.fn(async (callback) => callback(transactionManager)),
    },
  }
  const locks: LockProviderMock = {
    waitForLock: jest.fn(),
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn(),
  }
  const boxQueryBuilder = {
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  }
  const boxRepository = {
    findOne: jest.fn().mockResolvedValue(makeBox(BoxState.STARTED)),
    createQueryBuilder: jest.fn().mockReturnValue(boxQueryBuilder),
  }
  const regionRepository = {
    findOne: jest.fn().mockResolvedValue({ regionType: RegionType.DEDICATED }),
  }
  const runnerService = {
    findOne: jest.fn().mockResolvedValue({ gpuType: 'nvidia-a10' }),
  }
  const service = new UsageService(
    repository as never,
    locks as never,
    boxRepository as never,
    regionRepository as never,
    runnerService as never,
  )

  return {
    boxRepository,
    boxQueryBuilder,
    usageQueryBuilder,
    locks,
    regionRepository,
    repository,
    runnerService,
    service,
    transactionManager,
  }
}

describe('UsageService', () => {
  it('opens a running allocation period with Daytona billing dimensions', async () => {
    const { locks, repository, service, transactionManager } = setup()
    repository.findOne.mockResolvedValue(null)

    await service.handleBoxStateUpdate({
      box: makeBox(BoxState.STARTED),
      oldState: BoxState.STARTING,
      newState: BoxState.STARTED,
    })

    expect(locks.waitForLock).toHaveBeenCalledWith('usage-period-box-1', 60)
    expect(transactionManager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        boxId: 'box-1',
        organizationId: 'org-1',
        endAt: null,
        cpu: 2,
        gpu: 1,
        gpuType: 'nvidia-a10',
        mem: 4,
        disk: 10,
        region: 'us',
        boxClass: BoxClass.SMALL,
        regionType: RegionType.DEDICATED,
      }),
    )
    expect(locks.unlock).toHaveBeenCalledWith('usage-period-box-1')
  })

  it('closes and opens an allocation in one transaction without a billing gap', async () => {
    const { repository, service, transactionManager } = setup()
    const oldPeriod = makeOpenPeriod()
    repository.findOne.mockResolvedValue(oldPeriod)
    transactionManager.findOne.mockResolvedValue(oldPeriod)

    await service.handleBoxStateUpdate({
      box: makeBox(BoxState.STARTED),
      oldState: BoxState.STARTING,
      newState: BoxState.STARTED,
    })

    expect(repository.manager.transaction).toHaveBeenCalledTimes(1)
    expect(transactionManager.save).toHaveBeenNthCalledWith(1, oldPeriod)
    expect(transactionManager.save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        startAt: oldPeriod.endAt,
        endAt: null,
        cpu: 2,
      }),
    )
  })

  it('splits usage with the resized resource snapshot when STARTED follows RESIZING', async () => {
    const { boxRepository, repository, service, transactionManager } = setup()
    const oldPeriod = makeOpenPeriod()
    boxRepository.findOne.mockResolvedValue(
      makeBox(BoxState.STARTED, BoxDesiredState.STARTED, { cpu: 4, gpu: 2, mem: 16, disk: 40, class: BoxClass.LARGE }),
    )
    repository.findOne.mockResolvedValue(oldPeriod)
    transactionManager.findOne.mockResolvedValue(oldPeriod)

    await service.handleBoxStateUpdate({
      box: makeBox(BoxState.STARTED, BoxDesiredState.STARTED, {
        cpu: 4,
        gpu: 2,
        mem: 16,
        disk: 40,
        class: BoxClass.LARGE,
      }),
      oldState: BoxState.RESIZING,
      newState: BoxState.STARTED,
    })

    expect(oldPeriod.endAt).toEqual(expect.any(Date))
    expect(transactionManager.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cpu: 4,
        gpu: 2,
        mem: 16,
        disk: 40,
        boxClass: BoxClass.LARGE,
      }),
    )
  })

  it('switches to disk-only usage at STOPPING', async () => {
    const { boxRepository, repository, service, transactionManager } = setup()
    const runningPeriod = makeOpenPeriod()
    boxRepository.findOne.mockResolvedValue(makeBox(BoxState.STOPPING, BoxDesiredState.STOPPED))
    repository.findOne.mockResolvedValue(runningPeriod)
    transactionManager.findOne.mockResolvedValue(runningPeriod)

    await service.handleBoxStateUpdate({
      box: makeBox(BoxState.STOPPING, BoxDesiredState.STOPPED),
      oldState: BoxState.STARTED,
      newState: BoxState.STOPPING,
    })

    expect(runningPeriod.endAt).toEqual(expect.any(Date))
    expect(transactionManager.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        endAt: null,
        cpu: 0,
        gpu: 0,
        gpuType: null,
        mem: 0,
        disk: 10,
      }),
    )
  })

  it('repairs a skipped STOPPING transition without duplicating disk-only periods', async () => {
    const { boxRepository, repository, service, transactionManager } = setup()
    const runningPeriod = makeOpenPeriod()
    boxRepository.findOne.mockResolvedValue(makeBox(BoxState.STOPPED, BoxDesiredState.STOPPED))
    repository.findOne.mockResolvedValueOnce(runningPeriod).mockResolvedValueOnce(runningPeriod)
    transactionManager.findOne.mockResolvedValue(runningPeriod)

    await service.handleBoxStateUpdate({
      box: makeBox(BoxState.STOPPED, BoxDesiredState.STOPPED),
      oldState: BoxState.STARTED,
      newState: BoxState.STOPPED,
    })

    expect(transactionManager.save).toHaveBeenCalledTimes(2)
    expect(transactionManager.save).toHaveBeenLastCalledWith(expect.objectContaining({ endAt: null, cpu: 0, disk: 10 }))
  })

  it('repairs skipped STOPPING for a zero-CPU box that still has GPU or RAM allocation', async () => {
    const { boxRepository, repository, service, transactionManager } = setup()
    const runningPeriod = makeOpenPeriod({ cpu: 0, gpu: 1, mem: 4 })
    boxRepository.findOne.mockResolvedValue(makeBox(BoxState.STOPPED, BoxDesiredState.STOPPED, { cpu: 0 }))
    repository.findOne.mockImplementation(async (options) => {
      return Array.isArray(options.where) ? runningPeriod : null
    })
    transactionManager.findOne.mockResolvedValue(runningPeriod)

    await service.handleBoxStateUpdate({
      box: makeBox(BoxState.STOPPED, BoxDesiredState.STOPPED, { cpu: 0 }),
      oldState: BoxState.STARTED,
      newState: BoxState.STOPPED,
    })

    expect(transactionManager.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        endAt: null,
        cpu: 0,
        gpu: 0,
        mem: 0,
        disk: 10,
      }),
    )
  })

  it('starts a new disk-only period when a stopped box finishes resizing', async () => {
    const { boxRepository, repository, service, transactionManager } = setup()
    const oldPeriod = makeOpenPeriod({
      cpu: 0,
      gpu: 0,
      gpuType: null,
      mem: 0,
      disk: 10,
    })
    const resizedBox = makeBox(BoxState.STOPPED, BoxDesiredState.STOPPED, { disk: 40 })
    boxRepository.findOne.mockResolvedValue(resizedBox)
    repository.findOne.mockImplementation(async (options) => {
      if (Array.isArray(options.where) && options.where.some((condition) => condition.disk)) {
        return oldPeriod
      }
      return null
    })
    transactionManager.findOne.mockResolvedValue(oldPeriod)

    await service.handleBoxStateUpdate({
      box: resizedBox,
      oldState: BoxState.RESIZING,
      newState: BoxState.STOPPED,
    })

    expect(transactionManager.save).toHaveBeenCalledTimes(2)
    expect(transactionManager.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ endAt: null, cpu: 0, gpu: 0, mem: 0, disk: 40 }),
    )
  })

  it('closes usage as soon as destroy is requested', async () => {
    const { repository, service } = setup()
    const openPeriod = makeOpenPeriod()
    repository.findOne.mockResolvedValue(openPeriod)

    await service.handleBoxDesiredStateUpdate({
      box: makeBox(BoxState.STARTED, BoxDesiredState.DESTROYED),
      oldDesiredState: BoxDesiredState.STARTED,
      newDesiredState: BoxDesiredState.DESTROYED,
    })

    expect(openPeriod.endAt).toEqual(expect.any(Date))
    expect(repository.save).toHaveBeenCalledTimes(1)
  })

  it('does not reopen usage from a stale STARTED event after destroy intent is persisted', async () => {
    const { boxRepository, repository, service, transactionManager } = setup()
    boxRepository.findOne.mockResolvedValue(makeBox(BoxState.STARTED, BoxDesiredState.DESTROYED))
    repository.findOne.mockResolvedValue(null)

    await service.handleBoxStateUpdate({
      box: makeBox(BoxState.STARTED),
      oldState: BoxState.STARTING,
      newState: BoxState.STARTED,
    })

    expect(repository.save).not.toHaveBeenCalled()
    expect(transactionManager.save).not.toHaveBeenCalled()
  })

  it('keeps the current usage period when the latest box state is RESIZING', async () => {
    const { boxRepository, repository, service, transactionManager } = setup()
    const openPeriod = makeOpenPeriod()
    boxRepository.findOne.mockResolvedValue(makeBox(BoxState.RESIZING, BoxDesiredState.STARTED))
    repository.findOne.mockResolvedValue(openPeriod)

    await service.handleBoxStateUpdate({
      box: makeBox(BoxState.STARTED),
      oldState: BoxState.STARTING,
      newState: BoxState.STARTED,
    })

    expect(openPeriod.endAt).toBeNull()
    expect(repository.save).not.toHaveBeenCalled()
    expect(transactionManager.save).not.toHaveBeenCalled()
  })

  it('rolls periods older than 24 hours and preserves stopped disk-only allocation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T00:00:00.000Z'))
    try {
      const { locks, repository, service, transactionManager } = setup()
      const oldPeriod = makeOpenPeriod({ cpu: 0, gpu: 0, gpuType: null, mem: 0 })
      const stoppedBox = makeBox(BoxState.STOPPED, BoxDesiredState.STOPPED)
      repository.find.mockResolvedValue([oldPeriod])
      transactionManager.findOne.mockImplementation(async (entity) =>
        entity === BoxUsagePeriod ? oldPeriod : stoppedBox,
      )

      await service.closeAndReopenUsagePeriods()

      expect(repository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          order: { startAt: 'ASC' },
          take: 100,
        }),
      )
      expect(transactionManager.save).toHaveBeenNthCalledWith(1, oldPeriod)
      expect(transactionManager.save).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          startAt: new Date('2026-07-28T00:00:00.000Z'),
          endAt: null,
          cpu: 0,
          gpu: 0,
          gpuType: null,
          mem: 0,
          disk: 10,
        }),
      )
      expect(locks.unlock).toHaveBeenCalledWith('close-and-reopen-usage-periods')
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps running and stopped RESIZING periods open across daily rollover', async () => {
    for (const desiredState of [BoxDesiredState.STARTED, BoxDesiredState.STOPPED]) {
      const { repository, service, transactionManager } = setup()
      const diskOnly = desiredState === BoxDesiredState.STOPPED
      const oldPeriod = makeOpenPeriod(diskOnly ? { cpu: 0, gpu: 0, gpuType: null, mem: 0 } : {})
      const resizingBox = makeBox(BoxState.RESIZING, desiredState)
      repository.find.mockResolvedValue([oldPeriod])
      transactionManager.findOne.mockImplementation(async (entity) =>
        entity === BoxUsagePeriod ? oldPeriod : resizingBox,
      )

      await service.closeAndReopenUsagePeriods()

      expect(transactionManager.save).toHaveBeenCalledTimes(2)
      expect(transactionManager.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ endAt: null, cpu: diskOnly ? 0 : 2, gpu: diskOnly ? 0 : 1, mem: diskOnly ? 0 : 4 }),
      )
    }
  })

  it('preserves stopped disk usage while the box is STARTING', async () => {
    const { repository, service, transactionManager } = setup()
    const oldPeriod = makeOpenPeriod({ cpu: 0, gpu: 0, gpuType: null, mem: 0 })
    const startingBox = makeBox(BoxState.STARTING, BoxDesiredState.STARTED)
    repository.find.mockResolvedValue([oldPeriod])
    transactionManager.findOne.mockImplementation(async (entity) =>
      entity === BoxUsagePeriod ? oldPeriod : startingBox,
    )

    await service.closeAndReopenUsagePeriods()

    expect(transactionManager.save).toHaveBeenCalledTimes(2)
    expect(transactionManager.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ endAt: null, cpu: 0, gpu: 0, mem: 0, disk: 10 }),
    )
  })

  it('does not reopen a stale period after destroy intent closed it', async () => {
    const { repository, service, transactionManager } = setup()
    const openPeriod = makeOpenPeriod()
    const destroyedBox = makeBox(BoxState.STARTED, BoxDesiredState.DESTROYED)
    repository.find.mockResolvedValue([openPeriod])
    transactionManager.findOne.mockImplementation(async (entity) =>
      entity === BoxUsagePeriod ? openPeriod : destroyedBox,
    )

    await service.closeAndReopenUsagePeriods()

    expect(openPeriod.endAt).toEqual(expect.any(Date))
    expect(transactionManager.save).toHaveBeenCalledTimes(1)
  })

  it('excludes unassigned warm-pool periods from daily rollover', async () => {
    const { repository, service } = setup()

    await service.closeAndReopenUsagePeriods()

    expect(repository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: expect.objectContaining({ _type: 'not' }),
        }),
      }),
    )
    const where = repository.find.mock.calls[0][0].where
    expect(where.organizationId._value).toBe(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION)
  })

  it('starts accounting existing billable boxes when the module initializes', async () => {
    const { boxQueryBuilder, boxRepository, repository, service } = setup()
    const existingBox = makeBox(BoxState.STARTED)
    boxQueryBuilder.getMany.mockResolvedValue([existingBox])
    boxRepository.findOne.mockResolvedValue(existingBox)
    repository.findOne.mockResolvedValue(null)

    await (service as unknown as { onModuleInit(): Promise<void> }).onModuleInit()

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ boxId: 'box-1', endAt: null, cpu: 2, disk: 10 }),
    )
  })

  it('reconciles missing RESIZING periods as running or disk-only usage', async () => {
    for (const desiredState of [BoxDesiredState.STARTED, BoxDesiredState.STOPPED]) {
      const { boxQueryBuilder, boxRepository, repository, service } = setup()
      const resizingBox = makeBox(BoxState.RESIZING, desiredState)
      boxQueryBuilder.getMany.mockResolvedValue([resizingBox])
      boxRepository.findOne.mockResolvedValue(resizingBox)
      repository.findOne.mockResolvedValue(null)

      await service.reconcileUsagePeriods()

      expect(boxQueryBuilder.where).toHaveBeenCalledWith('box.state IN (:...billableStates)', {
        billableStates: expect.arrayContaining([BoxState.RESIZING]),
      })
      const diskOnly = desiredState === BoxDesiredState.STOPPED
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ cpu: diskOnly ? 0 : 2, gpu: diskOnly ? 0 : 1, mem: diskOnly ? 0 : 4, disk: 10 }),
      )
    }
  })

  it('repairs stale usage dimensions when a lifecycle event is lost', async () => {
    const { boxRepository, repository, service, transactionManager, usageQueryBuilder } = setup()
    const stalePeriod = makeOpenPeriod({
      organizationId: 'org-old',
      region: 'us',
      cpu: 2,
      gpu: 1,
      mem: 4,
      disk: 10,
      boxClass: BoxClass.SMALL,
    })
    const currentBox = makeBox(BoxState.STARTED, BoxDesiredState.STARTED, {
      organizationId: 'org-2',
      region: 'eu',
      cpu: 4,
      gpu: 2,
      mem: 16,
      disk: 40,
      class: BoxClass.LARGE,
    })
    usageQueryBuilder.getMany.mockResolvedValue([stalePeriod])
    boxRepository.findOne.mockResolvedValue(currentBox)
    repository.findOne.mockResolvedValue(stalePeriod)
    transactionManager.findOne.mockResolvedValue(stalePeriod)

    await service.reconcileUsagePeriods()
    expect(usageQueryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringMatching(/usage\."organizationId" IS DISTINCT FROM[\s\S]*usage\.cpu IS DISTINCT FROM box\.cpu/),
      expect.objectContaining({ creationStates: expect.arrayContaining([BoxState.STARTED, BoxState.RESIZING]) }),
    )

    expect(stalePeriod.endAt).toEqual(expect.any(Date))
    expect(transactionManager.save).toHaveBeenNthCalledWith(1, stalePeriod)
    expect(transactionManager.save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        organizationId: 'org-2',
        region: 'eu',
        cpu: 4,
        gpu: 2,
        mem: 16,
        disk: 40,
        boxClass: BoxClass.LARGE,
      }),
    )
  })

  it('closes orphaned open periods during reconciliation', async () => {
    const { boxRepository, repository, service, usageQueryBuilder } = setup()
    const openPeriod = makeOpenPeriod()
    usageQueryBuilder.getMany.mockResolvedValue([openPeriod])
    boxRepository.findOne.mockResolvedValue(null)
    repository.findOne.mockResolvedValue(openPeriod)

    await service.reconcileUsagePeriods()

    expect(usageQueryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringMatching(/box\.id IS NULL[\s\S]*box\.state IN \(:\.\.\.closingStates\)/),
      expect.objectContaining({ destroyed: BoxDesiredState.DESTROYED }),
    )
    expect(openPeriod.endAt).toEqual(expect.any(Date))
    expect(repository.save).toHaveBeenCalledWith(openPeriod)
  })

  it('moves closed periods to the archive in one transaction', async () => {
    const { locks, service, transactionManager } = setup()
    const closedPeriod = makeOpenPeriod({ endAt: new Date('2026-07-28T00:00:00.000Z') })
    transactionManager.find.mockResolvedValue([closedPeriod])

    await service.archiveUsagePeriods()

    expect(transactionManager.find).toHaveBeenCalledWith(
      BoxUsagePeriod,
      expect.objectContaining({ order: { startAt: 'ASC' }, take: 5000 }),
    )
    expect(transactionManager.delete).toHaveBeenCalledWith(BoxUsagePeriod, ['period-1'])
    expect(transactionManager.save).toHaveBeenCalledWith([
      expect.objectContaining({
        boxId: 'box-1',
        organizationId: 'org-1',
        endAt: closedPeriod.endAt,
      }),
    ])
    expect(locks.unlock).toHaveBeenCalledWith('archive-usage-periods')
  })

  it('releases lifecycle and cron locks when persistence fails', async () => {
    const lifecycle = setup()
    lifecycle.transactionManager.findOne.mockRejectedValue(new Error('database unavailable'))

    await expect(
      lifecycle.service.handleBoxStateUpdate({
        box: makeBox(BoxState.STARTED),
        oldState: BoxState.STARTING,
        newState: BoxState.STARTED,
      }),
    ).rejects.toThrow('database unavailable')
    expect(lifecycle.locks.unlock).toHaveBeenCalledWith('usage-period-box-1')

    const cron = setup()
    cron.repository.manager.transaction.mockRejectedValue(new Error('archive unavailable'))

    await expect(cron.service.archiveUsagePeriods()).rejects.toThrow('archive unavailable')
    expect(cron.locks.unlock).toHaveBeenCalledWith('archive-usage-periods')
  })

  it('falls back to shared region and unknown GPU type when metadata lookup fails', async () => {
    const { regionRepository, repository, runnerService, service, transactionManager } = setup()
    repository.findOne.mockResolvedValue(null)
    regionRepository.findOne.mockRejectedValue(new Error('region unavailable'))
    runnerService.findOne.mockRejectedValue(new Error('runner unavailable'))

    await service.handleBoxStateUpdate({
      box: makeBox(BoxState.STARTED),
      oldState: BoxState.STARTING,
      newState: BoxState.STARTED,
    })

    expect(transactionManager.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        gpuType: null,
        regionType: RegionType.SHARED,
      }),
    )
  })
})

describe('Daytona-compatible usage persistence contract', () => {
  it('uses Box-equivalent period tables, fields, and one-open-period constraint', () => {
    const metadata = getMetadataArgsStorage()
    expect(metadata.tables.find((table) => table.target === BoxUsagePeriod)?.name).toBe('box_usage_periods')
    expect(metadata.tables.find((table) => table.target === BoxUsagePeriodArchive)?.name).toBe(
      'box_usage_periods_archive',
    )

    const columns = metadata.columns
      .filter((column) => column.target === BoxUsagePeriod)
      .map((column) => column.propertyName)
    expect(columns).toEqual(
      expect.arrayContaining([
        'boxId',
        'organizationId',
        'startAt',
        'endAt',
        'cpu',
        'gpu',
        'gpuType',
        'mem',
        'disk',
        'region',
        'boxClass',
        'regionType',
      ]),
    )

    const openPeriodIndex = metadata.indices.find(
      (index) => index.target === BoxUsagePeriod && index.name === 'box_usage_periods_one_open_period_per_box_idx',
    )
    expect(openPeriodIndex).toMatchObject({ unique: true, where: '"endAt" IS NULL' })
  })

  it('creates and removes the complete persistence contract in the expand migration', async () => {
    const queries: string[] = []
    const queryRunner = {
      query: jest.fn(async (query: string) => {
        queries.push(query)
      }),
    }
    const migration = new AddBoxUsagePeriods1785300000000()

    await migration.up(queryRunner as never)

    expect(queries.join('\n')).toContain('CREATE TABLE "box_usage_periods"')
    expect(queries.join('\n')).toContain('CREATE TABLE "box_usage_periods_archive"')
    expect(queries.join('\n')).toContain('"gpu_type" character varying')
    expect(queries.join('\n')).toContain('CREATE UNIQUE INDEX "box_usage_periods_one_open_period_per_box_idx"')
    expect(queries.join('\n')).toContain('CREATE INDEX "idx_box_usage_periods_archive_box_start_end"')

    queries.length = 0
    await migration.down(queryRunner as never)
    expect(queries).toEqual(['DROP TABLE "box_usage_periods_archive"', 'DROP TABLE "box_usage_periods"'])
  })
})
