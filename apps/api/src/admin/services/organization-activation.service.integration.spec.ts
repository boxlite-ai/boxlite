import { Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DataSource, EntityManager } from 'typeorm'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { Box } from '../../box/entities/box.entity'
import { BoxLastActivity } from '../../box/entities/box-last-activity.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxRepository } from '../../box/repositories/box.repository'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { AddOrganizationActivationFacts1792490000000 } from '../../migrations/pre-deploy/1792490000000-add-organization-activation-facts-migration'
import { Organization } from '../../organization/entities/organization.entity'
import { OrganizationInvitation } from '../../organization/entities/organization-invitation.entity'
import { OrganizationRole } from '../../organization/entities/organization-role.entity'
import { OrganizationUser } from '../../organization/entities/organization-user.entity'
import { OrganizationService } from '../../organization/services/organization.service'
import { AdminOrganizationActivationService } from './organization-activation.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const databaseName = `activation_${process.pid}_${randomUUID().replaceAll('-', '')}`
const earlier = '2026-10-20T01:00:00.000Z'
const later = '2026-10-20T02:00:00.000Z'
const factsWrite = 'INSERT INTO organization_activation_facts'

describeIfDatabase('AdminOrganizationActivationService (real PostgreSQL, application updates)', () => {
  const connection = {
    type: 'postgres' as const,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  }
  const facts = new AddOrganizationActivationFacts1792490000000()
  let dataSource: DataSource
  let boxes: BoxRepository
  let organizations: OrganizationService
  let service: AdminOrganizationActivationService
  let ownsDatabase = false

  const migrate = async (direction: 'up' | 'down') => {
    const runner = dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
      await facts[direction](runner)
      await runner.commitTransaction()
    } catch (error) {
      await runner.rollbackTransaction()
      throw error
    } finally {
      await runner.release()
    }
  }
  const organization = async () =>
    (await organizations.create({ name: 'Lifecycle fixture' }, `creator-${randomUUID()}`, false, true)).id
  const legacyOrganization = async (manager = dataSource.manager) => {
    const [{ id }] = await manager.query(
      `INSERT INTO organization (name, "createdBy") VALUES ('Legacy fixture', 'fixture') RETURNING id`,
    )
    return id as string
  }
  const box = async (organizationId: string, createdAt = later) => {
    const entity = new Box('test-region', `box-${randomUUID().slice(0, 8)}`)
    entity.organizationId = organizationId
    entity.osUser = 'fixture'
    entity.labels = {}
    entity.createdAt = new Date(createdAt)
    return (await boxes.insert(entity)).id
  }
  const transition = async (id: string, state?: BoxState, desiredState?: BoxDesiredState) => {
    const updateData: Partial<Box> = {}
    if (state) updateData.state = state
    if (desiredState) updateData.desiredState = desiredState
    return boxes.update(id, { updateData })
  }
  const at = (written: Box) => written.updatedAt.toISOString()
  const factRows = async (id: string) =>
    dataSource.query('SELECT * FROM organization_activation_facts WHERE "organizationId" = $1', [id])
  const waitFor = async (check: () => Promise<boolean>, failure: string) => {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(failure)
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
      entities: [Organization, OrganizationInvitation, OrganizationRole, OrganizationUser, Box, BoxLastActivity],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: true,
    }).initialize()
    await migrate('up')
    boxes = new BoxRepository(
      dataSource,
      { emit: jest.fn() } as never,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never,
    )
    organizations = new OrganizationService(
      dataSource.getRepository(Organization),
      {} as never,
      { emitAsync: jest.fn() } as never,
      { get: () => undefined, getOrThrow: () => false } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
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
    await dataSource.query('DELETE FROM box_last_activity')
    await dataSource.query('DELETE FROM box')
    await dataSource.query('DELETE FROM organization')
  })
  afterEach(() => jest.restoreAllMocks())

  it('returns a committed Box start while another transaction holds the facts row', async () => {
    const id = await organization()
    const boxId = await box(id)
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const holder = dataSource.createQueryRunner()
    await holder.connect()
    await holder.startTransaction()
    let pending: Promise<Box> | undefined
    let deadline: NodeJS.Timeout | undefined
    try {
      await holder.query('SELECT 1 FROM organization_activation_facts WHERE "organizationId" = $1 FOR UPDATE', [id])
      pending = transition(boxId, BoxState.STARTED)
      const started = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('The Box start did not return while the facts row was locked')),
            3000,
          )
        }),
      ])
      const [row] = await dataSource.query('SELECT state FROM box WHERE id = $1', [boxId])
      expect([started.state, row.state]).toEqual([BoxState.STARTED, BoxState.STARTED])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Failed to record activity of box ${boxId}`))
      expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: null })
    } finally {
      clearTimeout(deadline)
      if (holder.isTransactionActive) await holder.rollbackTransaction()
      if (pending) await pending.catch(() => undefined)
      await holder.release()
    }
    await transition(boxId, BoxState.STOPPED, BoxDesiredState.STOPPED)
    const restarted = await transition(boxId, BoxState.STARTED, BoxDesiredState.STARTED)
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: at(restarted) })
  })

  it('creates facts with the first Box, keeps them after Box deletion and never recreates them', async () => {
    const id = await organization()
    expect(await factRows(id)).toEqual([])
    expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: null, lastBoxModifiedAt: null })
    await box(id, later)
    await box(id, earlier)
    const started = await transition(await box(id, earlier), BoxState.STARTED)
    await boxes.delete({ organizationId: id })
    expect(await dataSource.query('SELECT id FROM box')).toEqual([])
    expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: later, lastBoxModifiedAt: at(started) })

    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await dataSource.getRepository(Organization).delete(id)
    const orphan = await box(id, later)
    await transition(orphan, BoxState.STARTED)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('organization_activation_facts'))
    expect(await service.get(id)).toBeNull()
    expect(await factRows(id)).toEqual([])
  })

  it('records successful starts and restarts, not requests, stops, labels or repeated state writes', async () => {
    const id = await organization()
    const boxId = await box(id)
    await transition(boxId, BoxState.STARTING)
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: null })
    const started = await transition(boxId, BoxState.STARTED)
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: at(started) })
    await boxes.update(boxId, { updateData: { labels: { renamed: 'true' } } })
    await transition(boxId, BoxState.STARTED)
    await transition(boxId, BoxState.STOPPED, BoxDesiredState.STOPPED)
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: at(started) })
    const restarted = await transition(boxId, BoxState.STARTED, BoxDesiredState.STARTED)
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: at(restarted), lastBoxCreatedAt: later })
  })

  it('records deletion acceptance without advancing on completion or delayed cleanup', async () => {
    const id = await organization()
    const boxId = await box(id)
    await transition(boxId, BoxState.STARTED)
    const requested = await transition(boxId, undefined, BoxDesiredState.DESTROYED)
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: at(requested) })
    await transition(boxId, BoxState.DESTROYING)
    await transition(boxId, BoxState.DESTROYED)
    await boxes.delete({ id: boxId })
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: at(requested), lastBoxCreatedAt: later })
  })

  it('keeps a failed-delete request time when stale error rows are cleaned up', async () => {
    const id = await organization()
    const boxId = await box(id)
    const requested = await transition(boxId, BoxState.ERROR, BoxDesiredState.DESTROYED)
    await boxes.delete({ id: boxId })
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: at(requested) })
  })

  it('records warm claims but never attributes prewarming or transfers as new customer activity', async () => {
    const id = await organization()
    const boxId = await box(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION, earlier)
    await transition(boxId, BoxState.STARTED)
    expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: null, lastBoxModifiedAt: null })
    const claimed = await boxes.update(boxId, { updateData: { organizationId: id, createdAt: new Date(later) } })
    expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: later, lastBoxModifiedAt: at(claimed) })
    const destination = await organization()
    await boxes.update(boxId, { updateData: { organizationId: destination } })
    expect(await service.get(destination)).toMatchObject({ lastBoxCreatedAt: null, lastBoxModifiedAt: null })
    expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: later })
  })

  it('uses the claim commit time when a warm claim keeps the pool creation timestamp', async () => {
    const id = await organization()
    const boxId = await box(BOX_WARM_POOL_UNASSIGNED_ORGANIZATION, earlier)
    const claimed = await boxes.update(boxId, { updateData: { organizationId: id } })
    expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: at(claimed), lastBoxModifiedAt: null })
  })

  it('records nothing for a Box write that rolls back', async () => {
    const id = await organization()
    const boxId = await box(id, earlier)
    const duplicate = new Box('test-region', (await boxes.findOneByOrFail({ id: boxId })).name)
    duplicate.organizationId = id
    duplicate.osUser = 'fixture'
    duplicate.labels = {}
    duplicate.createdAt = new Date(later)
    await expect(boxes.insert(duplicate)).rejects.toMatchObject({ code: '23505' })
    expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: earlier })
  })

  it('never lets a delayed older update replace a newer time', async () => {
    const id = await organization()
    const first = await box(id)
    const second = await box(id)
    const transaction = dataSource.manager.transaction.bind(dataSource.manager) as (
      ...args: unknown[]
    ) => Promise<unknown>
    let reachDelay!: () => void
    let releaseDelay!: () => void
    const delayReached = new Promise<void>((resolve) => (reachDelay = resolve))
    const delayReleased = new Promise<void>((resolve) => (releaseDelay = resolve))
    let delayed = false
    // Pauses the first facts update inside its own transaction, as a slow process would.
    jest.spyOn(dataSource.manager, 'transaction').mockImplementation(((...args: unknown[]) => {
      const isolation = typeof args[0] === 'string' ? [args[0]] : []
      const run = args.find((arg) => typeof arg === 'function') as (manager: EntityManager) => Promise<unknown>
      return transaction(...isolation, async (manager: EntityManager) => {
        const query = manager.query.bind(manager)
        manager.query = async (sql: string, parameters?: unknown[]) => {
          if (!delayed && sql.startsWith(factsWrite)) {
            delayed = true
            reachDelay()
            await delayReleased
          }
          return query(sql, parameters)
        }
        return run(manager)
      })
    }) as never)

    const late = transition(first, BoxState.STARTED)
    await delayReached
    const newer = await transition(second, BoxState.STARTED)
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: at(newer) })
    releaseDelay()
    const older = await late
    expect(older.updatedAt.getTime()).toBeLessThan(newer.updatedAt.getTime())
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: at(newer) })
  })

  it('keeps the Box write when the facts update fails, and the next start records it', async () => {
    const id = await organization()
    const boxId = await box(id)
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await dataSource.query('ALTER TABLE organization_activation_facts RENAME TO organization_activation_facts_moved')
    let started: Box
    try {
      started = await transition(boxId, BoxState.STARTED)
    } finally {
      await dataSource.query('ALTER TABLE organization_activation_facts_moved RENAME TO organization_activation_facts')
    }
    expect(started.state).toBe(BoxState.STARTED)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Failed to record activity of box ${boxId}`))
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: null })
    await transition(boxId, BoxState.STOPPED, BoxDesiredState.STOPPED)
    const restarted = await transition(boxId, BoxState.STARTED, BoxDesiredState.STARTED)
    expect(await service.get(id)).toMatchObject({ lastBoxModifiedAt: at(restarted) })
  })

  it('installs no triggers, so writes that bypass the application are not recorded', async () => {
    expect(
      await dataSource.query(
        `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('box'::regclass, 'organization'::regclass)`,
      ),
    ).toEqual([])
    const id = await organization()
    const boxId = await box(id, earlier)
    await dataSource.query(`UPDATE box SET state = 'started' WHERE id = $1`, [boxId])
    expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: earlier, lastBoxModifiedAt: null })
  })

  it('backfills only retained creation maxima for existing organizations', async () => {
    // Without the facts table, the repository's follow-up updates fail and only log.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await migrate('down')
    const older = await legacyOrganization()
    const unknown = await legacyOrganization()
    await box(older, earlier)
    const retained = await box(older, later)
    await transition(retained, BoxState.STARTED)
    await migrate('up')
    expect(await service.get(older)).toMatchObject({ lastBoxCreatedAt: later, lastBoxModifiedAt: null })
    expect(await factRows(unknown)).toEqual([])
    expect(await service.get(unknown)).toMatchObject({ lastBoxCreatedAt: null, lastBoxModifiedAt: null })
  })

  it('records an organization the previous revision inserts during installation from its first Box', async () => {
    await migrate('down')
    const installer = dataSource.createQueryRunner()
    const writer = dataSource.createQueryRunner()
    await installer.connect()
    await writer.connect()
    await installer.startTransaction()
    let pending: Promise<string> | undefined
    try {
      await facts.up(installer)
      const [{ pid }] = await writer.query('SELECT pg_backend_pid() AS pid')
      pending = legacyOrganization(writer.manager)
      await waitFor(async () => {
        const [row] = await dataSource.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])
        return row.blocked
      }, 'The organization insert did not wait for the migration')
      await installer.commitTransaction()
      const id = await pending
      expect(await factRows(id)).toEqual([])
      await box(id, earlier)
      expect(await service.get(id)).toMatchObject({ lastBoxCreatedAt: earlier, lastBoxModifiedAt: null })
    } finally {
      if (installer.isTransactionActive) await installer.rollbackTransaction()
      if (pending) await pending.catch(() => undefined)
      await installer.release()
      await writer.release()
    }
  })
})
