import { randomUUID } from 'node:crypto'
import { DataSource, QueryRunner } from 'typeorm'
import { AddRegistryCredential1790400000000 } from './1790400000000-add-registry-credential-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `registry_credential_${process.pid}_${randomUUID().replaceAll('-', '')}`

const ORG_ID = randomUUID()
const OTHER_ORG_ID = randomUUID()

describeIfDatabase('AddRegistryCredential1790400000000 (integration, real Postgres)', () => {
  let dataSource: DataSource
  let queryRunner: QueryRunner
  const migration = new AddRegistryCredential1790400000000()

  const insert = (row: { organizationId?: string; registryHost?: string; repositoryPrefix?: string }) =>
    queryRunner.query(
      `INSERT INTO "registry_credential" ("organizationId", "kind", "registryHost", "repositoryPrefix", "username", "secretVersion")
       VALUES ($1, 'basic', $2, $3, 'robot', 'projects/1/secrets/registry-credential-x/versions/1')`,
      [row.organizationId ?? ORG_ID, row.registryHost ?? 'ghcr.io', row.repositoryPrefix ?? ''],
    )

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      entities: [],
      synchronize: false,
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    // `public` stays on the path for `uuid_generate_v4`, which the uuid-ossp
    // extension installs there.
    await queryRunner.query(`SET search_path TO "${schemaName}", public`)
    await migration.up(queryRunner)
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) return
    try {
      await queryRunner?.release()
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(() => queryRunner.query(`DELETE FROM "registry_credential"`))

  it('has no column a password could be written to', async () => {
    const columns = await queryRunner.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'registry_credential' ORDER BY column_name`,
      [schemaName],
    )

    // The whole set rather than a search for "password": a column added
    // later under any name has to be looked at before this list grows.
    expect(columns.map((column: { column_name: string }) => column.column_name)).toEqual([
      'createdAt',
      'createdBy',
      'id',
      'kind',
      'organizationId',
      'registryHost',
      'repositoryPrefix',
      'secretVersion',
      'updatedAt',
      'username',
    ])
  })

  it('accepts a whole host or a prefix of whole path segments', async () => {
    await insert({ repositoryPrefix: '' })
    await insert({ repositoryPrefix: 'acme/' })
    await insert({ repositoryPrefix: 'acme/team/' })

    const [{ count }] = await queryRunner.query(`SELECT count(*)::int AS count FROM "registry_credential"`)
    expect(count).toBe(3)
  })

  it.each(['acme', '/acme/', 'acme/team'])('refuses the prefix %j', async (repositoryPrefix) => {
    await expect(insert({ repositoryPrefix })).rejects.toMatchObject({
      code: '23514',
      constraint: 'registry_credential_prefix_shape',
    })
  })

  it('refuses a second credential for the same host and prefix in one organization', async () => {
    await insert({ repositoryPrefix: 'acme/' })

    await expect(insert({ repositoryPrefix: 'acme/' })).rejects.toMatchObject({
      code: '23505',
      constraint: 'registry_credential_org_host_prefix_unique',
    })
  })

  it('allows the same host under another prefix, or in another organization', async () => {
    await insert({ repositoryPrefix: 'acme/' })
    await insert({ repositoryPrefix: '' })
    await insert({ organizationId: OTHER_ORG_ID, repositoryPrefix: 'acme/' })

    const [{ count }] = await queryRunner.query(`SELECT count(*)::int AS count FROM "registry_credential"`)
    expect(count).toBe(3)
  })

  it('removes the table and its type on rollback', async () => {
    await migration.down(queryRunner)
    try {
      const remaining = await queryRunner.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'registry_credential'
         UNION ALL
         SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = 'registry_credential_kind_enum'`,
        [schemaName],
      )
      expect(remaining).toEqual([])
    } finally {
      await migration.up(queryRunner)
    }
  })
})
