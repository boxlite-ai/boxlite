import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { Migration1741087887225 } from '../../migrations/1741087887225-migration'
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
      `INSERT INTO organization (name, "createdBy") VALUES ('Lifecycle fixture', 'fixture') RETURNING id`,
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
  const update = async (id: string, state: string | null, desiredState: string | null = null) => {
    const [[{ at }]] = await dataSource.query(
      `UPDATE box SET state = COALESCE($2::box_state_enum, state),
       "desiredState" = COALESCE($3::box_desiredstate_enum, "desiredState")
       WHERE id = $1 RETURNING statement_timestamp() AS at`,
      [id, state, desiredState],
    )
    return (at as Date).toISOString()
  }
  const read = async (id: string): Promise<Record<string, unknown>> => ({ ...(await service.get(id)) })
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
      migrations: [Migration1741087887225],
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
    await dataSource.query('DELETE FROM box')
    await dataSource.query('DELETE FROM organization')
  })

  it('keeps creation maxima after Box deletion and removes facts only with the organization', async () => {
    const id = await organization()
    expect(await service.get(id)).toMatchObject({
      lastBoxCreatedAt: null,
      lastBoxModifiedAt: null,
      boxHistoryComplete: true,
    })
    await box(id, later)
    await box(id, earlier)
    await dataSource.query('DELETE FROM box WHERE "organizationId" = $1', [id])
    expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: later, lastBoxModifiedAt: expect.any(String) })
    expect(await dataSource.query('SELECT id FROM box')).toEqual([])
    await dataSource.query('DELETE FROM organization WHERE id = $1', [id])
    expect(await service.get(id)).toBeNull()
    expect(
      await dataSource.query('SELECT * FROM organization_activation_facts WHERE "organizationId" = $1', [id]),
    ).toEqual([])
  })

  it('records successful starts and restarts, not requests, stops, labels or repeated state writes', async () => {
    const id = await organization()
    const boxId = await box(id)
    await update(boxId, 'starting')
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: null })
    const startedAt = await update(boxId, 'started')
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: startedAt })
    await dataSource.query(`UPDATE box SET name = 'renamed', "updatedAt" = now() WHERE id = $1`, [boxId])
    await update(boxId, 'started')
    await update(boxId, 'stopped', 'stopped')
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: startedAt })
    const restartedAt = await update(boxId, 'started', 'started')
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: restartedAt, lastBoxCreatedAt: later })
  })

  it('records deletion acceptance without advancing on completion or delayed cleanup', async () => {
    const id = await organization()
    const boxId = await box(id)
    await update(boxId, 'started')
    const deletedAt = await update(boxId, null, 'destroyed')
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: deletedAt })
    await update(boxId, 'destroying', 'destroyed')
    await update(boxId, 'destroyed', 'destroyed')
    await dataSource.query('DELETE FROM box WHERE id = $1', [boxId])
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: deletedAt, lastBoxCreatedAt: later })
  })

  it('covers direct destruction and physical deletion without prior intent', async () => {
    const id = await organization()
    const boxId = await box(id)
    const destroyedAt = await update(boxId, 'destroyed')
    await dataSource.query('DELETE FROM box WHERE id = $1', [boxId])
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: destroyedAt })
    const next = await box(id)
    const [[{ at }]] = await dataSource.query('DELETE FROM box WHERE id = $1 RETURNING statement_timestamp() AS at', [
      next,
    ])
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: at.toISOString() })
  })

  it('keeps a failed-delete request time when stale error rows are cleaned up', async () => {
    const id = await organization()
    const boxId = await box(id)
    const deletedAt = await update(boxId, 'error', 'destroyed')
    await dataSource.query('DELETE FROM box WHERE id = $1', [boxId])
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: deletedAt })
  })

  it('records warm claims but never attributes prewarming or transfers as new customer activity', async () => {
    const id = await organization()
    const boxId = await box(poolOrganization, earlier)
    await update(boxId, 'started')
    expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: null, lastBoxModifiedAt: null })
    const [[{ at }]] = await dataSource.query(
      'UPDATE box SET "organizationId" = $1, "createdAt" = $2 WHERE id = $3 RETURNING statement_timestamp() AS at',
      [id, later, boxId],
    )
    expect(await service.get(id)).toMatchObject({
      lastBoxCreatedAt: later,
      lastBoxModifiedAt: at.toISOString(),
      boxHistoryComplete: true,
    })
    const destination = await organization()
    await dataSource.query('UPDATE box SET "organizationId" = $1 WHERE id = $2', [destination, boxId])
    expect(await service.get(destination)).toMatchObject({
      lastBoxCreatedAt: null,
      lastBoxModifiedAt: null,
      boxHistoryComplete: false,
    })
    expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: later })
  })

  it('uses claim time when a warm claim retains the pool creation timestamp', async () => {
    const id = await organization()
    const boxId = await box(poolOrganization, earlier)
    const [[{ at }]] = await dataSource.query(
      'UPDATE box SET "organizationId" = $1 WHERE id = $2 RETURNING statement_timestamp() AS at',
      [id, boxId],
    )
    expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: at.toISOString(), lastBoxModifiedAt: null })
  })

  it('rolls creation, start and deletion facts back with their source writes', async () => {
    const id = await organization()
    await expect(
      dataSource.transaction(async (manager) => {
        const boxId = await box(id, later, manager)
        await manager.query("UPDATE box SET state = 'started' WHERE id = $1", [boxId])
        await manager.query('DELETE FROM box WHERE id = $1', [boxId])
        throw new Error('rollback fixture')
      }),
    ).rejects.toThrow('rollback fixture')
    expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: null, lastBoxModifiedAt: null })
  })

  it.each([
    [earlier, later],
    [later, earlier],
  ])('serializes concurrent maxima %s then %s', async (a, b) => {
    const id = await organization()
    const first = dataSource.createQueryRunner()
    const second = dataSource.createQueryRunner()
    await first.connect()
    await second.connect()
    await first.startTransaction()
    await second.startTransaction()
    let pending: Promise<string> | undefined
    try {
      await box(id, a, first.manager)
      const [{ pid }] = await second.query('SELECT pg_backend_pid() AS pid')
      pending = box(id, b, second.manager)
      await expectBlocked(pid)
      await first.commitTransaction()
      await pending
      await second.commitTransaction()
      expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: later })
    } finally {
      if (first.isTransactionActive) await first.rollbackTransaction()
      if (pending) await pending.catch(() => undefined)
      if (second.isTransactionActive) await second.rollbackTransaction()
      await first.release()
      await second.release()
    }
  })

  it('backfills creation maxima only and marks preexisting or missing history incomplete', async () => {
    await migrate('down')
    const older = await organization()
    const unknown = await organization()
    await box(older, earlier)
    const retained = await box(older, later)
    await update(retained, 'started')
    await migrate('up')
    expect(await service.get(older)).toMatchObject({
      lastBoxCreatedAt: later,
      lastBoxModifiedAt: null,
      boxHistoryComplete: false,
    })
    expect(await service.get(unknown)).toMatchObject({
      lastBoxCreatedAt: null,
      lastBoxModifiedAt: null,
      boxHistoryComplete: false,
    })
    const fresh = await organization()
    expect((await read(fresh)).boxHistoryComplete).toBe(true)
    await dataSource.query('DELETE FROM organization_activation_facts WHERE "organizationId" = $1', [fresh])
    expect(await service.get(fresh)).toMatchObject({
      lastBoxCreatedAt: null,
      lastBoxModifiedAt: null,
      boxHistoryComplete: false,
    })
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
      expect(await service.get(id)).toMatchObject({ boxHistoryComplete: true, lastBoxCreatedAt: earlier })
    } finally {
      if (installer.isTransactionActive) await installer.rollbackTransaction()
      if (pending) await pending.catch(() => undefined)
      await installer.release()
      await writer.release()
    }
  })
})
