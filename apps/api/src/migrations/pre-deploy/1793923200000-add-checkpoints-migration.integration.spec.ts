import { randomUUID } from 'node:crypto'
import { DataSource, QueryRunner } from 'typeorm'
import { AddCheckpoints1793923200000 } from './1793923200000-add-checkpoints-migration'

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `checkpoint_migration_${process.pid}_${randomUUID().replaceAll('-', '')}`

describeWithDatabase('checkpoint migration (real PostgreSQL)', () => {
  let dataSource: DataSource
  let runner: QueryRunner
  const migration = new AddCheckpoints1793923200000()

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    runner = dataSource.createQueryRunner()
    await runner.connect()
  })

  beforeEach(async () => {
    await runner.query(`CREATE SCHEMA "${schema}"`)
    await runner.query(`CREATE TYPE "${schema}"."job_resourcetype_enum" AS ENUM ('BOX','ARTIFACT','BACKUP')`)
    await runner.query(`CREATE TABLE "${schema}"."box" ("id" varchar PRIMARY KEY)`)
    await runner.query(
      `CREATE TABLE "${schema}"."job" ("type" varchar, "resourceType" "${schema}"."job_resourcetype_enum", "completedAt" timestamptz)`,
    )
    await runner.startTransaction()
    try {
      await migration.up(runner)
      await runner.commitTransaction()
    } catch (error) {
      await runner.rollbackTransaction()
      throw error
    }
  })

  afterEach(async () => {
    await runner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  })
  afterAll(async () => {
    await runner?.release()
    await dataSource?.destroy()
  })

  it('adds the checkpoint table, source ownership marker and usable job namespace', async () => {
    expect(await runner.hasTable('checkpoint')).toBe(true)
    expect(await runner.hasColumn('box', 'checkpointJobId')).toBe(true)
    await runner.query(`INSERT INTO "job" ("type", "resourceType") VALUES ('UPLOAD_CHECKPOINT','CHECKPOINT')`)
    const [job] = await runner.query(`SELECT "resourceType" FROM "job"`)
    expect(job.resourceType).toBe('CHECKPOINT')
    const indexes = await runner.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='checkpoint'`,
      [schema],
    )
    expect(indexes.map((index: { indexname: string }) => index.indexname)).toEqual(
      expect.arrayContaining(['checkpoint_org_name_key', 'checkpoint_active_job_key']),
    )
  })

  it('refuses rollback while checkpoint jobs remain incomplete', async () => {
    await runner.query(`INSERT INTO "job" ("type", "resourceType") VALUES ('EXPORT_CHECKPOINT','BOX')`)
    await expect(migration.down(runner)).rejects.toThrow('finish their jobs')
    expect(await runner.hasTable('checkpoint')).toBe(true)
    await runner.query(`UPDATE "job" SET "completedAt"=now()`)
    await migration.down(runner)
    expect(await runner.hasTable('checkpoint')).toBe(false)
    expect(await runner.hasColumn('box', 'checkpointJobId')).toBe(false)
  })

  it('refuses rollback while archives are retained and keeps their historical source independent', async () => {
    await runner.query(
      `INSERT INTO "checkpoint" ("id","organizationId","name","sourceBoxId","sourceRunnerId","sourceState","arcPath","environment") VALUES ($1,$2,'retained','deleted-source',$3,'stopped','gs://bucket/archive','{}')`,
      [randomUUID(), randomUUID(), randomUUID()],
    )
    await expect(migration.down(runner)).rejects.toThrow('Delete checkpoints')
    expect(await runner.hasTable('checkpoint')).toBe(true)
  })
})
