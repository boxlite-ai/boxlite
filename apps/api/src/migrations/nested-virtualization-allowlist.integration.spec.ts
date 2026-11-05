import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../common/utils/naming-strategy.util'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationRole } from '../organization/entities/organization-role.entity'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationInvitation } from '../organization/entities/organization-invitation.entity'
import { OrganizationService } from '../organization/services/organization.service'
import { AddNestedVirtualizationAllowlist1793870400000 } from './pre-deploy/1793870400000-add-nested-virtualization-allowlist'

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
    Object.assign(service, { organizationRepository: organizations })
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
      await expect(migration.down(runner)).rejects.toThrow('Retire nested boxes')
      expect(await runner.hasColumn('organization', 'nestedVirtualizationEnabled')).toBe(true)
      expect(await runner.hasColumn('box', 'nestedVirtualization')).toBe(true)
    } finally {
      await runner.release()
    }
  })
  it('removes only new columns after nested boxes are retired', async () => {
    const runner = database.createQueryRunner()
    try {
      await migration.down(runner)
      expect(await runner.hasColumn('organization', 'nestedVirtualizationEnabled')).toBe(false)
      expect(await runner.hasColumn('box', 'nestedVirtualization')).toBe(false)
      expect(await database.query('SELECT id FROM "box"')).toEqual([{ id: boxId }])
    } finally {
      await runner.release()
    }
  })
})
