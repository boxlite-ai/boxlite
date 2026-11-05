import { randomUUID } from 'node:crypto'
import { DataSource, type QueryRunner } from 'typeorm'
import { AddCloudAppScopes1793780000000 } from '../migrations/pre-deploy/1793780000000-add-cloud-app-scopes-migration'

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip

describeWithDatabase('Cloud App permission migration (real PostgreSQL)', () => {
  const schema = `app_scopes_${process.pid}_${randomUUID().replaceAll('-', '')}`
  let source: DataSource
  let runner: QueryRunner
  let realRunner: QueryRunner

  beforeAll(async () => {
    source = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    const deployed = await source.query(
      `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname IN ('api_key_permissions_enum', 'organization_role_permissions_enum') ORDER BY t.typname`,
    )
    console.info(
      'Existing platform permission enum types:',
      deployed.map((row: { typname: string }) => row.typname).join(', ') || 'none in the provided database',
    )
    await source.query(`CREATE SCHEMA "${schema}"`)
    for (const name of ['api_key_permissions_enum', 'organization_role_permissions_enum']) {
      await source.query(`CREATE TYPE "${schema}"."${name}" AS ENUM ('write:boxes')`)
    }
    await source.query(
      `CREATE TABLE "${schema}".api_key (id text PRIMARY KEY, permissions "${schema}".api_key_permissions_enum[] NOT NULL DEFAULT '{}')`,
    )
    realRunner = source.createQueryRunner()
    runner = {
      query: (sql: string, parameters?: unknown[]) =>
        realRunner.query(sql.replaceAll('"public".', `"${schema}".`), parameters),
    } as QueryRunner
  })

  afterAll(async () => {
    if (!source?.isInitialized) return
    try {
      await source.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await realRunner?.release()
      await source.destroy()
    }
  })

  it('adds App permissions without changing API key columns, indexes or existing grants', async () => {
    const columnsOfKey = () =>
      source.query(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'api_key' ORDER BY ordinal_position`,
        [schema],
      )
    const indexesOfKey = () =>
      source.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'api_key' ORDER BY indexname`,
        [schema],
      )
    const columnsBefore = await columnsOfKey()
    const indexesBefore = await indexesOfKey()
    await source.query(`INSERT INTO "${schema}".api_key (id, permissions) VALUES ('existing-key', '{write:boxes}')`)
    const migration = new AddCloudAppScopes1793780000000()
    await migration.up(runner)
    for (const name of ['api_key_permissions_enum', 'organization_role_permissions_enum']) {
      const labels: { label: string }[] = await source.query(
        `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2 ORDER BY e.enumsortorder`,
        [schema, name],
      )
      expect(labels.map((row) => row.label)).toEqual(['write:boxes', 'read:apps', 'write:apps', 'delete:apps'])
    }
    expect(await columnsOfKey()).toEqual(columnsBefore)
    expect(await indexesOfKey()).toEqual(indexesBefore)
    await source.query(`INSERT INTO "${schema}".api_key (id, permissions) VALUES ('new-key', '{read:apps,write:apps}')`)
    await migration.down()
    expect(
      await source.query(`SELECT id, permissions::text AS permissions FROM "${schema}".api_key ORDER BY id`),
    ).toEqual([
      { id: 'existing-key', permissions: '{write:boxes}' },
      { id: 'new-key', permissions: '{read:apps,write:apps}' },
    ])
    expect(await columnsOfKey()).toEqual(columnsBefore)
    expect(await indexesOfKey()).toEqual(indexesBefore)
    const labels = await source.query(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = 'api_key_permissions_enum'`,
      [schema],
    )
    expect(labels).toHaveLength(4)
  })
})
