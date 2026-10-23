import { randomUUID } from 'node:crypto'
import { DataSource, QueryRunner } from 'typeorm'
import { Migration1741087887225 } from '../1741087887225-migration'
import { AddImageCatalog1787100000000 } from './1787100000000-add-image-catalog-migration'
import { AddImageCatalogApi1787400000000 } from './1787400000000-add-image-catalog-api-migration'
import { AddRegistryReadScope1790500000000 } from './1790500000000-add-registry-read-scope-migration'
import { AddImageWriteScope1790700000000 } from './1790700000000-add-image-write-scope-migration'
import { RenameMemberScopes1792728000000 } from './1792728000000-rename-member-scopes-migration'
import { AddTenantScopes1792497600000 } from './1792497600000-add-tenant-scopes-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const tables = ['api_key', 'organization_role'] as const
type ScopeTable = (typeof tables)[number]

describeIfDatabase('AddTenantScopes1792497600000 (integration, real Postgres)', () => {
  let admin: DataSource
  let dataSource: DataSource
  let queryRunner: QueryRunner
  let databaseName: string
  let ownsDatabase = false
  let scopesBefore: string[]
  const migration = new AddTenantScopes1792497600000()
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
    // The migration names public enum types explicitly, so a search_path cannot isolate it.
    databaseName = `tenant_scopes_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    ownsDatabase = true
    dataSource = await new DataSource({
      ...connection,
      database: databaseName,
      migrations: [
        Migration1741087887225,
        AddImageCatalog1787100000000,
        AddImageCatalogApi1787400000000,
        AddRegistryReadScope1790500000000,
        AddImageWriteScope1790700000000,
      ],
    }).initialize()
    await dataSource.runMigrations()
    queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    scopesBefore = await scopes('api_key')
    expect(await scopes('organization_role')).toEqual(scopesBefore)
    await seed('legacy', scopesBefore)
    await seed('unscoped', [])
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

  async function scopes(table: ScopeTable): Promise<string[]> {
    const rows = await queryRunner.query(
      `SELECT unnest(enum_range(NULL::"public"."${table}_permissions_enum"))::text AS scope`,
    )
    return rows.map((row: { scope: string }) => row.scope)
  }

  async function grants(table: ScopeTable): Promise<{ name: string; permissions: string[] }[]> {
    return queryRunner.query(`SELECT name, permissions::text[] AS permissions FROM "${table}" ORDER BY name`)
  }

  async function seed(name: string, permissions: string[]): Promise<void> {
    await queryRunner.query(
      `INSERT INTO api_key ("organizationId", "userId", name, "keyHash", permissions, "createdAt")
       VALUES ($1, 'owner', $2, $2, $3, now())`,
      [randomUUID(), name, permissions],
    )
    await queryRunner.query(`INSERT INTO organization_role (name, description, permissions) VALUES ($1, '', $2)`, [
      name,
      permissions,
    ])
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

  it('appends both scopes without granting existing keys or roles new permissions', async () => {
    await migrate('up')

    for (const table of tables) {
      expect(await scopes(table)).toEqual([...scopesBefore, 'read:tenant', 'write:tenant'])
      expect(await grants(table)).toEqual([
        { name: 'legacy', permissions: scopesBefore },
        { name: 'unscoped', permissions: [] },
      ])
    }

    // New enum values must be usable after the migration transaction commits.
    await seed('tenant', ['read:tenant', 'write:tenant'])
    for (const table of tables) {
      expect(await grants(table)).toContainEqual({ name: 'tenant', permissions: ['read:tenant', 'write:tenant'] })
    }
  })

  it('renames tenant grants to member grants and restores them on rollback', async () => {
    await migrate('up')
    await seed('mixed', ['read:tenant', 'write:boxes', 'write:tenant'])
    const rename = new RenameMemberScopes1792728000000()
    await rename.up(queryRunner)
    for (const table of tables) {
      expect(await scopes(table)).toEqual([...scopesBefore, 'read:members', 'write:members'])
      expect(await grants(table)).toContainEqual({
        name: 'mixed',
        permissions: ['read:members', 'write:boxes', 'write:members'],
      })
      expect(await grants(table)).toContainEqual({ name: 'unscoped', permissions: [] })
    }
    await rename.down(queryRunner)
    for (const table of tables) {
      expect(await scopes(table)).toEqual([...scopesBefore, 'read:tenant', 'write:tenant'])
      expect(await grants(table)).toContainEqual({
        name: 'mixed',
        permissions: ['read:tenant', 'write:boxes', 'write:tenant'],
      })
    }
  })

  it('can repeat the upgrade without changing enum order or persisted grants', async () => {
    await migrate('up')
    await seed('tenant', ['write:tenant'])
    await migrate('up')

    for (const table of tables) {
      expect(await scopes(table)).toEqual([...scopesBefore, 'read:tenant', 'write:tenant'])
      expect(await grants(table)).toEqual([
        { name: 'legacy', permissions: scopesBefore },
        { name: 'tenant', permissions: ['write:tenant'] },
        { name: 'unscoped', permissions: [] },
      ])
    }
  })

  it('rolls back both enums, removing only tenant grants and retaining old scope order', async () => {
    await migrate('up')
    await seed('mixed', ['read:tenant', ...scopesBefore, 'write:tenant'])
    await seed('read-only', ['read:tenant'])
    await seed('tenant-only', ['read:tenant', 'write:tenant'])
    await seed('write-only', ['write:tenant'])
    await migrate('down')

    for (const table of tables) {
      expect(await scopes(table)).toEqual(scopesBefore)
      expect(await grants(table)).toEqual([
        { name: 'legacy', permissions: scopesBefore },
        { name: 'mixed', permissions: scopesBefore },
        { name: 'read-only', permissions: [] },
        { name: 'tenant-only', permissions: [] },
        { name: 'unscoped', permissions: [] },
        { name: 'write-only', permissions: [] },
      ])
      for (const scope of ['read:tenant', 'write:tenant']) {
        await expect(
          queryRunner.query(`UPDATE "${table}" SET permissions = $1 WHERE name = 'unscoped'`, [[scope]]),
        ).rejects.toMatchObject({ driverError: { code: '22P02' } })
      }
    }
  })
})
