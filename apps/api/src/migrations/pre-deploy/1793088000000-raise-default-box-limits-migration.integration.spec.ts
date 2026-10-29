import { randomUUID } from 'node:crypto'
import { DataSource, getMetadataArgsStorage, QueryRunner } from 'typeorm'
import { Migration1741087887225 } from '../1741087887225-migration'
import { Organization } from '../../organization/entities/organization.entity'
import { OrganizationDto } from '../../organization/dto/organization.dto'
import { BoxService } from '../../box/services/box.service'
import { RunnerState } from '../../box/enums/runner-state.enum'
import { Context } from '../../common/context/context'
import { createBoxToCreateBox } from '../../boxlite-rest/mappers/box-to-box.mapper'
import { RaiseDefaultBoxLimits1793088000000 } from './1793088000000-raise-default-box-limits-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const maximum = { maxCpuPerBox: 16, maxMemoryPerBox: 32, maxDiskPerBox: 100 }

describeIfDatabase('RaiseDefaultBoxLimits1793088000000 (integration, real Postgres)', () => {
  let admin: DataSource
  let dataSource: DataSource
  let queryRunner: QueryRunner
  let databaseName: string
  let ownsDatabase = false
  const migration = new RaiseDefaultBoxLimits1793088000000()
  const connection = {
    type: 'postgres' as const,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  }

  beforeAll(async () => {
    admin = await new DataSource({ ...connection, database: process.env.DB_DATABASE }).initialize()
  })

  beforeEach(async () => {
    databaseName = `box_limits_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    ownsDatabase = true
    dataSource = await new DataSource({
      ...connection,
      database: databaseName,
      migrations: [Migration1741087887225],
    }).initialize()
    await dataSource.runMigrations()
    queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
  })

  afterEach(async () => {
    try {
      if (queryRunner && !queryRunner.isReleased) await queryRunner.release()
      if (dataSource?.isInitialized) await dataSource.destroy()
    } finally {
      if (ownsDatabase) {
        await admin.query(`DROP DATABASE "${databaseName}"`)
        ownsDatabase = false
      }
    }
  })

  afterAll(async () => {
    if (admin?.isInitialized) await admin.destroy()
  })

  async function seed(name: string, limits?: number[]): Promise<void> {
    await queryRunner.query('INSERT INTO organization (name, "createdBy") VALUES ($1, $2)', [name, 'owner'])
    if (limits) {
      await queryRunner.query(
        `UPDATE organization SET max_cpu_per_box = $2, max_memory_per_box = $3, max_disk_per_box = $4 WHERE name = $1`,
        [name, ...limits],
      )
    }
  }

  async function organization(name: string): Promise<Organization> {
    const [row] = await queryRunner.query(
      `SELECT *, max_cpu_per_box AS "maxCpuPerBox", max_memory_per_box AS "maxMemoryPerBox",
       max_disk_per_box AS "maxDiskPerBox" FROM organization WHERE name = $1`,
      [name],
    )
    return row
  }

  async function migrate(direction: 'up' | 'down'): Promise<void> {
    await queryRunner.startTransaction()
    try {
      await migration[direction](queryRunner)
      await queryRunner.commitTransaction()
    } catch (error) {
      await queryRunner.rollbackTransaction()
      throw error
    }
  }

  it('raises existing and new default organizations, matching the entity and serialized quota', async () => {
    await seed('existing')
    await migrate('up')
    await seed('new')

    for (const name of ['existing', 'new']) {
      const dto = OrganizationDto.fromOrganization(await organization(name))
      expect(dto).toMatchObject(maximum)
      for (const propertyName of Object.keys(maximum)) {
        const column = getMetadataArgsStorage().columns.find(
          (column) => column.target === Organization && column.propertyName === propertyName,
        )
        expect(column?.options.default).toBe(dto[propertyName])
      }
    }
  })

  it('preserves every non-default tuple and existing box resources across repeated upgrades', async () => {
    const exceptions = [
      [2, 4, 5],
      [32, 64, 200],
      [4, 8, 20],
      [2, 8, 10],
      [4, 16, 10],
      [0, -1, 0],
    ]
    await seed('existing')
    for (const [index, limits] of exceptions.entries()) await seed(`custom-${index}`, limits)
    const owner = await organization('existing')
    await queryRunner.query(
      `INSERT INTO box (id, "organizationId", name, region, "osUser", "authToken", cpu, mem, disk)
       VALUES ('box-1', $1, 'existing-box', 'region-1', 'boxlite', 'test-token', 2, 4, 10)`,
      [owner.id],
    )

    await migrate('up')
    await migrate('up')

    expect(await organization('existing')).toMatchObject(maximum)
    for (const [index, [cpu, memory, disk]] of exceptions.entries()) {
      expect(await organization(`custom-${index}`)).toMatchObject({
        maxCpuPerBox: cpu,
        maxMemoryPerBox: memory,
        maxDiskPerBox: disk,
      })
    }
    expect(await queryRunner.query('SELECT cpu, mem, disk FROM box')).toEqual([{ cpu: 2, mem: 4, disk: 10 }])
  })

  it('rolls back future defaults without lowering existing or subsequently customized quotas', async () => {
    await seed('existing')
    await migrate('up')
    await seed('customized-after-upgrade', [16, 48, 100])
    await migrate('down')
    await seed('after-rollback')

    expect(await organization('existing')).toMatchObject(maximum)
    expect(await organization('customized-after-upgrade')).toMatchObject({ ...maximum, maxMemoryPerBox: 48 })
    expect(await organization('after-rollback')).toMatchObject({
      maxCpuPerBox: 4,
      maxMemoryPerBox: 8,
      maxDiskPerBox: 10,
    })
  })

  it('admits the REST maximum and rejects each over-limit resource before persistence', async () => {
    await migrate('up')
    await seed('request-owner')
    const owner = await organization('request-owner')
    const insert = jest.fn(async (box) => box)
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service, {
      getValidatedOrDefaultRegion: jest.fn().mockResolvedValue({ id: 'region-1' }),
      getValidatedOrDefaultClass: jest.fn().mockReturnValue('small'),
      organizationService: { assertOrganizationIsNotSuspended: jest.fn() },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      runnerService: {
        getRandomAvailableRunner: jest
          .fn()
          .mockResolvedValue({ id: 'runner-1', draining: false, state: RunnerState.READY }),
      },
      boxRepository: { insert },
      eventEmitter: { emitAsync: jest.fn().mockResolvedValue(undefined) },
      toBoxDto: jest.fn((box) => box),
      imageAdmissionService: { assert: jest.fn(), spendColdPullBudget: jest.fn() },
      imageResolverService: { resolve: jest.fn().mockResolvedValue({ ref: 'example/app:latest', isOrgOwned: true }) },
    })
    const request = { image: 'example/app:latest', cpus: 16, memory_mib: 32768, disk_size_gb: 100 }
    await service.create(createBoxToCreateBox(request), owner, Context.user())
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ cpu: 16, mem: 32, disk: 100 }), undefined)

    for (const [overrides, error] of [
      [{ cpus: 17 }, 'cpu 17 exceeds the guest kernel limit of 16'],
      [{ memory_mib: 33792 }, 'memory 33GB exceeds the per-box limit of 32GB'],
      [{ disk_size_gb: 101 }, 'disk 101GB exceeds the per-box limit of 100GB'],
    ] as const) {
      insert.mockClear()
      await expect(
        service.create(createBoxToCreateBox({ ...request, ...overrides }), owner, Context.user()),
      ).rejects.toThrow(error)
      expect(insert).not.toHaveBeenCalled()
    }
  })
})
