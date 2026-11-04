import { randomUUID } from 'node:crypto'
import { DataSource, QueryRunner } from 'typeorm'
import { AddGuestPrivileged1792540800000 } from './1792540800000-add-guest-privileged-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `guest_privileged_${process.pid}_${randomUUID().replaceAll('-', '')}`

describeIfDatabase('guest privilege migration (integration, real Postgres)', () => {
  let dataSource: DataSource
  let queryRunner: QueryRunner

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
    await queryRunner.query(`SET search_path TO "${schemaName}"`)
    await queryRunner.query('CREATE TABLE "box" ("id" text PRIMARY KEY)')
  })

  afterAll(async () => {
    await queryRunner?.release()
    if (!dataSource?.isInitialized) return
    try {
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    } finally {
      await dataSource.destroy()
    }
  })

  it('keeps existing and ordinary boxes unprivileged and stores the explicit opt-in', async () => {
    await queryRunner.query('INSERT INTO "box" ("id") VALUES ($1)', ['existing'])
    await new AddGuestPrivileged1792540800000().up(queryRunner)
    await queryRunner.query('INSERT INTO "box" ("id") VALUES ($1)', ['ordinary'])
    await queryRunner.query('INSERT INTO "box" ("id", "privileged") VALUES ($1, $2)', ['docker', true])

    expect(await queryRunner.query('SELECT "id", "privileged" FROM "box" ORDER BY "id"')).toEqual([
      { id: 'docker', privileged: true },
      { id: 'existing', privileged: false },
      { id: 'ordinary', privileged: false },
    ])
  })
})
