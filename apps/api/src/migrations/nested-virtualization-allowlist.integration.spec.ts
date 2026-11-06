import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../common/utils/naming-strategy.util'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationRole } from '../organization/entities/organization-role.entity'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationInvitation } from '../organization/entities/organization-invitation.entity'
import { OrganizationService } from '../organization/services/organization.service'
import { AddNestedVirtualizationAllowlist1793870400000 } from './pre-deploy/1793870400000-add-nested-virtualization-allowlist-migration'
import PreDeployDataSource from './pre-deploy/data-source'
import { EncryptionService } from '../encryption/encryption.service'

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip
describeWithDatabase('Organization nesting allowlist storage (real PostgreSQL)', () => {
  const schema = `nested_org_${randomUUID().replaceAll('-', '')}`
  const boxId = randomUUID()
  let database: DataSource
  let organizations: Repository<Organization>
  let organizationId: string
  let service: OrganizationService
  const migration = new AddNestedVirtualizationAllowlist1793870400000()
  beforeAll(async () => {
    database = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [Organization, OrganizationRole, OrganizationUser, OrganizationInvitation],
      namingStrategy: new CustomNamingStrategy(),
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await database.query(`CREATE SCHEMA "${schema}"`)
    await database.synchronize()
    organizations = database.getRepository(Organization)
    organizationId = (await organizations.save({ name: 'allowlist test', createdBy: 'owner' })).id
    // Restore the pre-change absence of the columns before the production migration.
    await database.query('ALTER TABLE "organization" DROP COLUMN "nestedVirtualizationEnabled"')
    await database.query('CREATE TABLE "box" (id uuid PRIMARY KEY)')
    await database.query('INSERT INTO "box" (id) VALUES ($1)', [boxId])
    const runner = database.createQueryRunner()
    try {
      await migration.up(runner)
    } finally {
      await runner.release()
    }
    service = Object.create(OrganizationService.prototype)
    Object.assign(service, { organizationRepository: organizations, activeJobs: new Set() })
  })
  beforeEach(async () => {
    await database.query('UPDATE "box" SET "nestedVirtualization" = false')
    await organizations.update(organizationId, { nestedVirtualizationEnabled: false })
  })
  afterAll(async () => {
    if (!database?.isInitialized) return
    try {
      await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await database.destroy()
    }
  })
  it('keeps existing organizations and boxes ordinary', async () => {
    expect((await service.findOne(organizationId)).nestedVirtualizationEnabled).toBe(false)
    expect(
      (await database.query('SELECT "nestedVirtualization" FROM "box" WHERE id = $1', [boxId]))[0].nestedVirtualization,
    ).toBe(false)
  })
  // Cold coverage instrumentation imports the complete production migration chain.
  it('discovers the allowlist migration through the production pre-deploy loader', async () => {
    const source = new DataSource({
      ...database.options,
      entities: [],
      migrations: PreDeployDataSource.options.migrations,
    })
    try {
      await source.initialize()
      expect(source.migrations.map((entry) => entry.name ?? entry.constructor.name)).toContain(
        'AddNestedVirtualizationAllowlist1793870400000',
      )
    } finally {
      if (source.isInitialized) await source.destroy()
    }
  }, 30_000)

  it.each(['name', 'suspend', 'unsuspend', 'network', 'region', 'experiments', 'verification'])(
    'keeps an Admin revocation committed after the %s writer reads',
    async (operation) => {
      const encryption = new EncryptionService({ getOrThrow: () => 'nested-regression-fixture' } as any)
      const ciphertext = await encryption.encrypt('saved-header')
      await organizations.save({
        id: organizationId,
        nestedVirtualizationEnabled: true,
        suspended: true,
        suspensionReason: 'Please verify your email address',
        defaultRegionId: null,
        _experimentalConfig: {
          otel: { endpoint: 'https://example.invalid/otel', headers: { authorization: ciphertext } },
        },
      })
      const read = organizations.findOne.bind(organizations)
      const pausedRead = jest.spyOn(organizations, 'findOne').mockImplementationOnce(async (options) => {
        const stale = await read(options)
        await service.setNestedVirtualizationEnabled(organizationId, false)
        return stale
      })
      Object.assign(service, {
        encryptionService: encryption,
        validateOrganizationDefaultRegion: jest.fn().mockResolvedValue({ id: 'region-1' }),
      })
      try {
        if (operation === 'name') {
          const saved = await service.updateName(organizationId, ' renamed ')
          expect(saved.name).toBe('renamed')
          expect(saved.updatedAt).toEqual((await read({ where: { id: organizationId } })).updatedAt)
        } else if (operation === 'suspend') await service.suspend(organizationId, 'hold')
        else if (operation === 'unsuspend') await service.unsuspend(organizationId)
        else if (operation === 'network') await service.updateBoxDefaultLimitedNetworkEgress(organizationId, true)
        else if (operation === 'region') await service.setDefaultRegion(organizationId, 'region-1')
        else if (operation === 'experiments') {
          await service.updateExperimentalConfig(organizationId, {
            otel: {
              endpoint: 'https://example.invalid/new-otel',
              headers: { authorization: '********', extra: 'replacement' },
            },
          })
        } else {
          const manager = database.manager
          const find = jest.spyOn(manager, 'findOne').mockImplementationOnce(async () => {
            const stale = await read({ where: { id: organizationId } })
            await service.setNestedVirtualizationEnabled(organizationId, false)
            return { organization: stale } as any
          })
          try {
            await service.handleUserEmailVerifiedEvent({ entityManager: manager, userId: 'owner' } as any)
          } finally {
            find.mockRestore()
          }
        }
        const current = await read({ where: { id: organizationId } })
        expect(current.nestedVirtualizationEnabled).toBe(false)
        if (operation === 'name') expect(current.name).toBe('renamed')
        else if (operation === 'suspend') expect(current).toMatchObject({ suspended: true, suspensionReason: 'hold' })
        else if (operation === 'unsuspend' || operation === 'verification') expect(current.suspended).toBe(false)
        else if (operation === 'network') expect(current.boxLimitedNetworkEgress).toBe(true)
        else if (operation === 'region') expect(current.defaultRegionId).toBe('region-1')
        else {
          expect(current._experimentalConfig.otel.endpoint).toBe('https://example.invalid/new-otel')
          expect(current._experimentalConfig.otel.headers.authorization).toBe(ciphertext)
          expect(await encryption.decrypt(current._experimentalConfig.otel.headers.extra)).toBe('replacement')
        }
      } finally {
        pausedRead.mockRestore()
      }
    },
  )

  it('refuses rollback when an in-flight nested insert commits before DDL', async () => {
    const writer = database.createQueryRunner()
    const rollback = database.createQueryRunner()
    const insertedId = randomUUID()
    let outcome: Promise<unknown> | undefined
    try {
      await writer.startTransaction()
      await rollback.startTransaction()
      await writer.query('INSERT INTO "box" (id, "nestedVirtualization") VALUES ($1, true)', [insertedId])
      const [{ pid }] = await rollback.query('SELECT pg_backend_pid() AS pid')
      outcome = migration.down(rollback).then(
        () => undefined,
        (error) => error,
      )
      const deadline = Date.now() + 5000
      for (;;) {
        const [activity] = await database.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid])
        if (activity?.wait_event_type === 'Lock') break
        if (Date.now() >= deadline) throw new Error('Rollback did not reach the competing writer')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await writer.commitTransaction()
      expect(await outcome).toEqual(
        expect.objectContaining({ message: expect.stringContaining('Retire nested boxes') }),
      )
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction()
      if (outcome) await outcome
      if (rollback.isTransactionActive) await rollback.rollbackTransaction()
      await writer.release()
      await rollback.release()
      await database.query('DELETE FROM "box" WHERE id = $1', [insertedId])
    }
  })
  it('persists the Admin switch separately from owner experiments and saved boxes', async () => {
    const organization = await organizations.findOneByOrFail({ id: organizationId })
    organization._experimentalConfig = { nestedVirtualizationEnabled: true }
    await organizations.save(organization)
    expect((await service.findOne(organizationId)).nestedVirtualizationEnabled).toBe(false)
    await service.setNestedVirtualizationEnabled(organizationId, true)
    expect((await service.findOne(organizationId)).nestedVirtualizationEnabled).toBe(true)
    await database.query('UPDATE "box" SET "nestedVirtualization" = true WHERE id = $1', [boxId])
    await service.setNestedVirtualizationEnabled(organizationId, false)
    expect((await service.findOne(organizationId)).nestedVirtualizationEnabled).toBe(false)
    expect(
      (await database.query('SELECT "nestedVirtualization" FROM "box" WHERE id = $1', [boxId]))[0].nestedVirtualization,
    ).toBe(true)
  })
  it('returns 404 without inserting an unknown organization', async () => {
    const id = randomUUID()
    await expect(service.setNestedVirtualizationEnabled(id, true)).rejects.toMatchObject({ status: 404 })
    expect(await organizations.findOneBy({ id })).toBeNull()
  })
  it('refuses schema rollback while nested boxes exist', async () => {
    await database.query('UPDATE "box" SET "nestedVirtualization" = true')
    const runner = database.createQueryRunner()
    try {
      await runner.startTransaction()
      await expect(migration.down(runner)).rejects.toThrow('Retire nested boxes')
      expect(await runner.hasColumn('organization', 'nestedVirtualizationEnabled')).toBe(true)
      expect(await runner.hasColumn('box', 'nestedVirtualization')).toBe(true)
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await runner.release()
    }
  })
  it('removes only new columns after nested boxes are retired', async () => {
    const runner = database.createQueryRunner()
    try {
      await runner.startTransaction()
      await migration.down(runner)
      expect(await runner.hasColumn('organization', 'nestedVirtualizationEnabled')).toBe(false)
      expect(await runner.hasColumn('box', 'nestedVirtualization')).toBe(false)
      expect(await runner.query('SELECT id FROM "box"')).toEqual([{ id: boxId }])
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await runner.release()
    }
  })
})
