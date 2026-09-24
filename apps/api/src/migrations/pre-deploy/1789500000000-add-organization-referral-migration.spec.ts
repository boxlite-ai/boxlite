import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AddOrganizationReferral1789500000000 } from './1789500000000-add-organization-referral-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `organization_referral_${process.pid}_${randomUUID().replaceAll('-', '')}`
describeIfDatabase('AddOrganizationReferral1789500000000 (integration, real Postgres)', () => {
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

  it('adds a nullable, unique referral code and removes it on rollback', async () => {
    const queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    try {
      await queryRunner.query(`SET search_path TO "${schemaName}"`)
      await queryRunner.query(`CREATE TABLE "organization" ("id" uuid PRIMARY KEY)`)
      await queryRunner.query(`INSERT INTO "organization" ("id") VALUES ($1)`, [randomUUID()])

      const migration = new AddOrganizationReferral1789500000000()
      await migration.up(queryRunner)

      const [existing] = await queryRunner.query(`SELECT "referralCode" FROM "organization"`)
      expect(existing.referralCode).toBeNull()
      await queryRunner.query(`INSERT INTO "organization" ("id") VALUES ($1)`, [randomUUID()])
      await queryRunner.query(`INSERT INTO "organization" ("id", "referralCode") VALUES ($1, 'ABCD2345EF')`, [
        randomUUID(),
      ])
      await expect(
        queryRunner.query(`INSERT INTO "organization" ("id", "referralCode") VALUES ($1, 'ABCD2345EF')`, [
          randomUUID(),
        ]),
      ).rejects.toMatchObject({ code: '23505', constraint: 'organization_referral_code_uq' })
      await migration.down(queryRunner)
      const columns = await queryRunner.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'organization' AND column_name = 'referralCode'`,
        [schemaName],
      )
      expect(columns).toEqual([])
    } finally {
      await queryRunner.release()
    }
  })
})
