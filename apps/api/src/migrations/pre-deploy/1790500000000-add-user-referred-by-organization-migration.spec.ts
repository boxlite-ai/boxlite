import { randomUUID } from 'node:crypto'
import { DataSource, QueryRunner } from 'typeorm'
import { AddUserReferredByOrganization1790500000000 } from './1790500000000-add-user-referred-by-organization-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `user_referral_${process.pid}_${randomUUID().replaceAll('-', '')}`

describeIfDatabase('AddUserReferredByOrganization1790500000000 (integration, real Postgres)', () => {
  let dataSource: DataSource

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [],
      synchronize: false,
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) return
    try {
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    } finally {
      await dataSource.destroy()
    }
  })

  const referralColumn = (queryRunner: QueryRunner) =>
    queryRunner.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'user' AND column_name = 'referredByOrganizationId'`,
      [schemaName],
    )

  const referralIndex = (queryRunner: QueryRunner) =>
    queryRunner.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'user_referred_by_organization_idx'`,
      [schemaName],
    )

  it('adds a nullable uuid column with a partial index and removes both on rollback', async () => {
    const queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    try {
      await queryRunner.query(`SET search_path TO "${schemaName}"`)
      await queryRunner.query(`CREATE TABLE "user" ("id" character varying PRIMARY KEY)`)
      await queryRunner.query(`INSERT INTO "user" ("id") VALUES ('existing-user')`)

      const migration = new AddUserReferredByOrganization1790500000000()
      await migration.up(queryRunner)

      expect(await referralColumn(queryRunner)).toEqual([
        { data_type: 'uuid', is_nullable: 'YES', column_default: null },
      ])
      expect(await queryRunner.query(`SELECT "referredByOrganizationId" FROM "user"`)).toEqual([
        { referredByOrganizationId: null },
      ])
      expect(await referralIndex(queryRunner)).toEqual([
        { indexdef: expect.stringContaining('WHERE ("referredByOrganizationId" IS NOT NULL)') },
      ])

      await migration.down(queryRunner)

      expect(await referralColumn(queryRunner)).toEqual([])
      expect(await referralIndex(queryRunner)).toEqual([])
    } finally {
      await queryRunner.release()
    }
  })
})
