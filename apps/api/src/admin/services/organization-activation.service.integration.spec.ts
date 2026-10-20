import { randomUUID } from 'node:crypto'
import { DataSource, EntityManager } from 'typeorm'
import { Migration1741087887225 } from '../../migrations/1741087887225-migration'
import { AddBoxUsagePeriods1785250000000 } from '../../migrations/pre-deploy/1785250000000-add-box-usage-periods-migration'
import { AddOrganizationActivationFacts1792490000000 } from '../../migrations/pre-deploy/1792490000000-add-organization-activation-facts-migration'
import { AdminOrganizationActivationService } from './organization-activation.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const databaseName = `activation_${process.pid}_${randomUUID().replaceAll('-', '')}`
const poolOrganization = '00000000-0000-0000-0000-000000000000'
const earlier = '2026-10-20T01:00:00.000Z'
const later = '2026-10-20T02:00:00.000Z'

describeIfDatabase('AdminOrganizationActivationService (real PostgreSQL triggers)', () => {
  const connection = {
    type: 'postgres' as const,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  }
  const migration = new AddOrganizationActivationFacts1792490000000()
  let dataSource: DataSource
  let service: AdminOrganizationActivationService
  let ownsDatabase = false

  const migrate = async (direction: 'up' | 'down') => {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
      await migration[direction](runner)
      await runner.commitTransaction()
    } catch (error) {
      await runner.rollbackTransaction()
      throw error
    } finally {
      await runner.release()
    }
  }
  const organization = async (manager = dataSource.manager) => {
    const [{ id }] = await manager.query(
      `INSERT INTO organization (name, "createdBy") VALUES ('Activation fixture', 'fixture') RETURNING id`,
    )
    return id as string
  }
  const box = async (organizationId: string, createdAt = later, manager = dataSource.manager) => {
    const id = randomUUID().replaceAll('-', '').slice(0, 12)
    await manager.query(
      `INSERT INTO box (id, "organizationId", name, region, "osUser", "authToken", "createdAt")
       VALUES ($1, $2, $1, 'test-region', 'fixture', 'fixture-token', $3)`,
      [id, organizationId, createdAt],
    )
    return id
  }
  const period = async (
    organizationId: string,
    startAt: string,
    cpu: number | string,
    manager: EntityManager = dataSource.manager,
    archived = false,
  ) => {
    const table = archived ? 'box_usage_periods_archive' : 'box_usage_periods'
    await manager.query(
      `INSERT INTO ${table} ("boxId", "organizationId", "startAt", "endAt", cpu, gpu, mem, disk, region)
       VALUES ($1, $2, $3, $4, $5, 0, 2, 4, 'test-region')`,
      [randomUUID().slice(0, 12), organizationId, startAt, archived ? later : null, cpu],
    )
  }
  const expectBlocked = async (pid: number) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const [row] = await dataSource.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])
      if (row.blocked) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('The second writer did not wait for the first transaction')
  }

  beforeAll(async () => {
    const admin = await new DataSource({ ...connection, database: process.env.DB_DATABASE }).initialize()
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      ownsDatabase = true
    } finally {
      await admin.destroy()
    }
    dataSource = await new DataSource({
      ...connection,
      database: databaseName,
      migrations: [Migration1741087887225, AddBoxUsagePeriods1785250000000],
    }).initialize()
    await dataSource.runMigrations()
    await migrate('up')
    service = new AdminOrganizationActivationService(dataSource)
  }, 30000)

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy()
    if (!ownsDatabase) return
    const admin = await new DataSource({ ...connection, database: process.env.DB_DATABASE }).initialize()
    try {
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`)
    } finally {
      await admin.destroy()
    }
  })

  beforeEach(async () => {
    await dataSource.query('DELETE FROM box_usage_periods')
    await dataSource.query('DELETE FROM box_usage_periods_archive')
    await dataSource.query('DELETE FROM box')
    await dataSource.query('DELETE FROM organization')
  })

  it('tracks new organizations and preserves facts after all Boxes are deleted', async () => {
    const id = await organization()
    expect(await service.get(id)).toMatchObject({
      firstObservedBoxCreatedAt: null,
      firstRecordedComputeAt: null,
      boxHistoryComplete: true,
      computeHistoryComplete: false,
    })
    const boxId = await box(id)
    await box(id, earlier)
    await dataSource.query('DELETE FROM box WHERE "organizationId" = $1', [id])
    expect((await service.get(id))?.firstObservedBoxCreatedAt).toBe(earlier)
    expect(await dataSource.query('SELECT id FROM box WHERE id = $1', [boxId])).toEqual([])
    await dataSource.query('DELETE FROM organization WHERE id = $1', [id])
    expect(await service.get(id)).toBeNull()
    expect(
      await dataSource.query('SELECT * FROM organization_activation_facts WHERE "organizationId" = $1', [id]),
    ).toEqual([])
  })

  it('records warm-pool claim time without attributing prewarming to a customer', async () => {
    const id = await organization()
    const boxId = await box(poolOrganization, earlier)
    expect((await service.get(id))?.firstObservedBoxCreatedAt).toBeNull()
    await dataSource.query('UPDATE box SET "organizationId" = $1, "createdAt" = $2 WHERE id = $3', [id, later, boxId])
    expect(await service.get(id)).toMatchObject({
      firstObservedBoxCreatedAt: later,
      boxHistoryComplete: true,
    })
    const destination = await organization()
    await dataSource.query('UPDATE box SET "organizationId" = $1 WHERE id = $2', [destination, boxId])
    expect(await service.get(destination)).toMatchObject({
      firstObservedBoxCreatedAt: null,
      boxHistoryComplete: false,
    })
    expect((await service.get(id))?.firstObservedBoxCreatedAt).toBe(later)
  })

  it('uses observation time for a warm claim that does not replace the old creation timestamp', async () => {
    const id = await organization()
    const boxId = await box(poolOrganization, earlier)
    const [{ at: before }] = await dataSource.query('SELECT statement_timestamp() AS at')
    await dataSource.query('UPDATE box SET "organizationId" = $1 WHERE id = $2', [id, boxId])
    const result = (await service.get(id))!
    expect(Date.parse(result.firstObservedBoxCreatedAt!)).toBeGreaterThanOrEqual(before.getTime())
    expect(Date.parse(result.firstObservedBoxCreatedAt!)).toBeLessThanOrEqual(Date.parse(result.observedAt))
  })

  it('rolls creation and compute facts back with the source transaction', async () => {
    const id = await organization()
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
      await box(id, earlier, runner.manager)
      await period(id, earlier, 2, runner.manager)
      await runner.rollbackTransaction()
    } finally {
      await runner.release()
    }
    expect(await service.get(id)).toMatchObject({
      firstObservedBoxCreatedAt: null,
      firstRecordedComputeAt: null,
      boxHistoryComplete: true,
    })
    expect(await dataSource.query('SELECT id FROM box')).toEqual([])
  })

  it('serializes concurrent minima without losing an earlier committed creation', async () => {
    const id = await organization()
    const first = dataSource.createQueryRunner()
    const second = dataSource.createQueryRunner()
    await first.connect()
    await second.connect()
    await first.startTransaction()
    await second.startTransaction()
    let pending: Promise<string> | undefined
    try {
      await box(id, later, first.manager)
      const [{ pid }] = await second.query('SELECT pg_backend_pid() AS pid')
      pending = box(id, earlier, second.manager)
      // Observe the real row-lock dependency before releasing the first writer.
      await expectBlocked(pid)
      await first.commitTransaction()
      await pending
      await second.commitTransaction()
      expect((await service.get(id))?.firstObservedBoxCreatedAt).toBe(earlier)
    } finally {
      if (first.isTransactionActive) await first.rollbackTransaction()
      if (pending) await pending.catch(() => undefined)
      if (second.isTransactionActive) await second.rollbackTransaction()
      await first.release()
      await second.release()
    }
  })

  it('records only finite positive CPU periods and retains the minimum through archive/rollover', async () => {
    const id = await organization()
    for (const cpu of [0, -1, 'NaN', 'Infinity']) await period(id, earlier, cpu)
    await period('legacy-non-uuid', earlier, 2)
    await period(poolOrganization, earlier, 2)
    expect((await service.get(id))?.firstRecordedComputeAt).toBeNull()
    await period(id, later, 2)
    await period(id, earlier, 4)
    await dataSource.transaction(async (manager) => {
      await manager.query(`
        INSERT INTO box_usage_periods_archive
          ("boxId", "organizationId", "startAt", "endAt", cpu, gpu, mem, disk, region)
        SELECT "boxId", "organizationId", "startAt", now(), cpu, gpu, mem, disk, region FROM box_usage_periods
      `)
      await manager.query('DELETE FROM box_usage_periods')
    })
    await period(id, later, 2)
    expect(await service.get(id)).toMatchObject({
      firstRecordedComputeAt: earlier,
      computeHistoryComplete: false,
    })
  })

  it('backfills retained evidence without making preexisting organizations complete', async () => {
    await migrate('down')
    const older = await organization()
    const unknown = await organization()
    await box(older, later)
    await period(older, later, 2)
    await period(older, earlier, 2, dataSource.manager, true)
    await migrate('up')
    expect(await service.get(older)).toMatchObject({
      firstObservedBoxCreatedAt: later,
      firstRecordedComputeAt: earlier,
      boxHistoryComplete: false,
      computeHistoryComplete: false,
    })
    expect(await service.get(unknown)).toMatchObject({
      firstObservedBoxCreatedAt: null,
      firstRecordedComputeAt: null,
      boxHistoryComplete: false,
    })
    const fresh = await organization()
    expect((await service.get(fresh))?.boxHistoryComplete).toBe(true)
    await dataSource.query('DELETE FROM organization_activation_facts WHERE "organizationId" = $1', [fresh])
    expect((await service.get(fresh))?.boxHistoryComplete).toBe(false)
  })

  it('covers an old application insert waiting for migration installation to commit', async () => {
    await migrate('down')
    const installer = dataSource.createQueryRunner()
    const writer = dataSource.createQueryRunner()
    await installer.connect()
    await writer.connect()
    await installer.startTransaction()
    let pending: Promise<string> | undefined
    try {
      await migration.up(installer)
      const [{ pid }] = await writer.query('SELECT pg_backend_pid() AS pid')
      pending = organization(writer.manager)
      await expectBlocked(pid)
      await installer.commitTransaction()
      const id = await pending
      await box(id, earlier)
      expect(await service.get(id)).toMatchObject({
        boxHistoryComplete: true,
        firstObservedBoxCreatedAt: earlier,
      })
    } finally {
      if (installer.isTransactionActive) await installer.rollbackTransaction()
      if (pending) await pending.catch(() => undefined)
      await installer.release()
      await writer.release()
    }
  })
})
