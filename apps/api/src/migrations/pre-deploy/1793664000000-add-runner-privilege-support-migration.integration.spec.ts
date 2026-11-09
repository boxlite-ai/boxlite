import { randomUUID } from 'node:crypto'
import { DataSource, QueryRunner } from 'typeorm'
import { AddRunnerPrivilegeSupport1793664000000 } from './1793664000000-add-runner-privilege-support-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `runner_privilege_migration_${process.pid}_${randomUUID().replaceAll('-', '')}`

describeIfDatabase('runner privilege support migration (integration, real Postgres)', () => {
  let dataSource: DataSource
  let queryRunner: QueryRunner
  let ownsSchema = false

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
      installExtensions: false,
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.query(`SET search_path TO "${schemaName}"`)
    await queryRunner.query('CREATE TABLE "runner" ("id" text PRIMARY KEY)')
  })

  afterAll(async () => {
    await queryRunner?.release()
    if (!dataSource?.isInitialized) return
    try {
      if (ownsSchema) await dataSource.query(`DROP SCHEMA "${schemaName}" CASCADE`)
    } finally {
      await dataSource.destroy()
    }
  })

  it('defaults existing and newly registered runners to unsupported and stores reported support', async () => {
    await queryRunner.query('INSERT INTO "runner" ("id") VALUES ($1)', ['existing'])
    const migration = new AddRunnerPrivilegeSupport1793664000000()
    await migration.up(queryRunner)
    await queryRunner.query('INSERT INTO "runner" ("id") VALUES ($1)', ['new'])
    await queryRunner.query('INSERT INTO "runner" ("id", "supportsPrivileged") VALUES ($1, $2)', ['supported', true])

    expect(await queryRunner.query('SELECT "id", "supportsPrivileged" FROM "runner" ORDER BY "id"')).toEqual([
      { id: 'existing', supportsPrivileged: false },
      { id: 'new', supportsPrivileged: false },
      { id: 'supported', supportsPrivileged: true },
    ])

    await migration.down(queryRunner)
    expect(await queryRunner.query('SELECT * FROM "runner" ORDER BY "id"')).toEqual([
      { id: 'existing' },
      { id: 'new' },
      { id: 'supported' },
    ])
  })
})
