/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { Runner } from '../entities/runner.entity'
import { WarmPool } from '../entities/warm-pool.entity'
import { BoxClass } from '../enums/box-class.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxRepository } from '../repositories/box.repository'
import { BoxWarmPoolService } from './box-warm-pool.service'
import { BoxService } from './box.service'
import { Context } from '../../common/context/context'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `warm_pool_claim_${process.pid}_${randomUUID().replaceAll('-', '')}`

const IMAGE = 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0'
const REGION = 'region-1'

/**
 * The pool tuple apart from `gpu` and the region, so a test can build two pool
 * rows that differ in nothing but `gpu` and see which boxes each one may claim.
 */
const SHARED_SPEC = {
  image: IMAGE,
  class: BoxClass.SMALL,
  cpu: 2,
  mem: 4,
  disk: 10,
  osUser: 'boxlite',
  env: {},
}

describeIfDatabase('BoxWarmPoolService.fetchWarmPoolBox (integration, real Postgres)', () => {
  let dataSource: DataSource
  let boxes: Repository<Box>
  let warmPools: Repository<WarmPool>
  let runners: Repository<Runner>
  let service: BoxWarmPoolService
  let repository: BoxRepository
  let ownsSchema = false
  let runnerId: string

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Box, BoxLastActivity, Runner, WarmPool],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()

    boxes = dataSource.getRepository(Box)
    warmPools = dataSource.getRepository(WarmPool)
    runners = dataSource.getRepository(Runner)

    repository = new BoxRepository(
      dataSource,
      { emit: jest.fn() } as never,
      {
        invalidate: jest.fn(),
        invalidateOrgId: jest.fn(),
      } as never,
    )
    service = new BoxWarmPoolService(
      warmPools,
      repository,
      runners,
      { lock: jest.fn().mockResolvedValue(true), unlock: jest.fn() } as never,
      {
        getOrThrow: jest.fn((key: string) => (key === 'warmPool.candidateLimit' ? 10 : 0)),
      } as never,
      { emit: jest.fn(), emitAsync: jest.fn() } as never,
      { set: jest.fn(), exists: jest.fn() } as never,
    )
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return
    }
    try {
      if (ownsSchema) {
        await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      }
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."warm_pool"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."runner"`)

    const runner = new Runner({ region: REGION, name: 'runner-1', apiKey: 'k', apiVersion: '1' })
    runner.state = RunnerState.READY
    runner.unschedulable = false
    runner.availabilityScore = 100
    runnerId = (await runners.save(runner)).id
  })

  async function insertPool(gpu: number): Promise<void> {
    await warmPools.save(warmPools.create({ ...SHARED_SPEC, target: REGION, gpu, gpuType: '', pool: 1 }))
  }

  async function insertWarmBox(gpu: number): Promise<string> {
    const box = new Box(REGION, `warm-gpu-${gpu}`)
    Object.assign(box, {
      ...SHARED_SPEC,
      gpu,
      runnerId,
      organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
    })
    return (await boxes.save(box)).id
  }

  function fetchFor(gpu: number) {
    return service.fetchWarmPoolBox({
      ...SHARED_SPEC,
      target: REGION,
      gpu,
      organizationId: 'org-1',
      state: BoxState.STARTED,
    })
  }

  /**
   * Two pool rows may differ in nothing but `gpu` — the index over the tuple is
   * not unique — so a GPU pool and a CPU pool can exist for the same image and
   * class. The pool row is then chosen with `gpu`, but the box that serves the
   * request has to be chosen with it too, or the request is answered by a box
   * from the other pool.
   */
  it('does not hand a GPU warm box to a request that asked for none', async () => {
    await insertPool(0)
    await insertPool(1)
    await insertWarmBox(1)

    await expect(fetchFor(0)).resolves.toBeNull()
  })

  it('hands over the box whose gpu count the request asked for', async () => {
    await insertPool(0)
    await insertPool(1)
    const cpuBoxId = await insertWarmBox(0)
    await insertWarmBox(1)

    const claimed = await fetchFor(0)

    expect(claimed?.id).toBe(cpuBoxId)
  })

  it('nested virtualization excludes legacy pool boxes from claims', async () => {
    await insertPool(0)
    const id = await insertWarmBox(0)
    await dataSource.query(`UPDATE "${schemaName}"."box" SET "nestedVirtualization" = NULL WHERE id = $1`, [id])

    await expect(fetchFor(0)).resolves.toBeNull()
  })

  it('nested virtualization retains retiring legacy capacity until destruction completes', async () => {
    const id = await insertWarmBox(0)
    await dataSource.query(`UPDATE "${schemaName}"."box" SET "nestedVirtualization" = NULL WHERE id = $1`, [id])
    await boxes.update(id, { desiredState: BoxDesiredState.DESTROYED, pending: true })
    const spec = { ...SHARED_SPEC, target: REGION, gpu: 0 }

    expect(await (service as any).countPoolBoxes(spec)).toBe(1)
    await boxes.update(id, { state: BoxState.DESTROYED, pending: false })
    expect(await (service as any).countPoolBoxes(spec)).toBe(0)
  })

  function retirementService(): BoxService {
    return Object.assign(Object.create(BoxService.prototype), {
      boxRepository: repository,
      runnerRepository: runners,
      eventEmitter: { emit: jest.fn() },
      logger: { error: jest.fn() },
    })
  }

  it.each([BoxState.STARTED, BoxState.STOPPED, BoxState.ERROR])(
    'nested virtualization retires legacy unassigned boxes in state %s',
    async (state) => {
      const id = await insertWarmBox(0)
      await boxes.update(id, { state })
      await dataSource.query(`UPDATE "${schemaName}"."box" SET "nestedVirtualization" = NULL WHERE id = $1`, [id])
      const retirement = retirementService() as any
      await retirement.retireUnusableWarmPoolBoxes()

      expect((await boxes.findOneByOrFail({ id })).desiredState).toBe(BoxDesiredState.DESTROYED)
    },
  )

  it('nested virtualization retirement protects a concurrent ownership claim', async () => {
    const id = await insertWarmBox(0)
    const retirement = retirementService()
    const update = repository.updateWhere.bind(repository)
    const claimedOrg = randomUUID()
    const spy = jest.spyOn(repository, 'updateWhere').mockImplementationOnce(async (boxId, params) => {
      await boxes.update(boxId, { organizationId: claimedOrg })
      return update(boxId, params)
    })
    try {
      await expect(retirement.destroy(id, BOX_WARM_POOL_UNASSIGNED_ORGANIZATION, Context.admin())).rejects.toThrow()
      const box = await boxes.findOneByOrFail({ id })
      expect(box.organizationId).toBe(claimedOrg)
      expect(box.desiredState).toBe(BoxDesiredState.STARTED)
    } finally {
      spy.mockRestore()
    }
  })
})
