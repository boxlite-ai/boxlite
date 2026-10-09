import { randomUUID } from 'node:crypto'
import { DataSource, QueryRunner } from 'typeorm'
import { AddImageTagEvent1790600000000 } from './1790600000000-add-image-tag-event-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `image_tag_event_${process.pid}_${randomUUID().replaceAll('-', '')}`

describeIfDatabase('AddImageTagEvent1790600000000 (integration, real Postgres)', () => {
  let dataSource: DataSource
  let queryRunner: QueryRunner
  const migration = new AddImageTagEvent1790600000000()

  const insertImageWithVersions = async () => {
    const [{ id: imageId }] = await queryRunner.query(`INSERT INTO "image" DEFAULT VALUES RETURNING "id"`)
    const [{ id: from }] = await queryRunner.query(
      `INSERT INTO "image_version" ("imageId") VALUES ($1) RETURNING "id"`,
      [imageId],
    )
    const [{ id: to }] = await queryRunner.query(`INSERT INTO "image_version" ("imageId") VALUES ($1) RETURNING "id"`, [
      imageId,
    ])
    return { imageId, from, to }
  }

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
    await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    // `public` stays on the path for `uuid_generate_v4`, which the uuid-ossp
    // extension installs there.
    await queryRunner.query(`SET search_path TO "${schemaName}", public`)
    // Just the columns and the cascade the new table's references lean on; the
    // catalog migration that really creates these is not this spec's to run.
    await queryRunner.query(`CREATE TABLE "image" ("id" uuid PRIMARY KEY DEFAULT uuid_generate_v4())`)
    await queryRunner.query(
      `CREATE TABLE "image_version" ("id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "imageId" uuid NOT NULL REFERENCES "image"("id") ON DELETE CASCADE)`,
    )
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

  it('records who moved a tag by their identity provider subject, which is not a uuid', async () => {
    const { imageId, from, to } = await insertImageWithVersions()

    await queryRunner.query(
      `INSERT INTO "image_tag_event" ("imageId", "tagName", "fromVersionId", "toVersionId", "actorId") VALUES ($1, 'stable', $2, $3, 'auth0|6512bd43d9caa6e02c990b0a')`,
      [imageId, from, to],
    )

    const [{ actorId }] = await queryRunner.query(`SELECT "actorId" FROM "image_tag_event" WHERE "imageId" = $1`, [
      imageId,
    ])
    expect(actorId).toBe('auth0|6512bd43d9caa6e02c990b0a')
  })

  it('records a tag that did not exist before with no version it came from', async () => {
    const { imageId, to } = await insertImageWithVersions()

    await queryRunner.query(
      `INSERT INTO "image_tag_event" ("imageId", "tagName", "toVersionId") VALUES ($1, 'v1', $2)`,
      [imageId, to],
    )

    const [event] = await queryRunner.query(
      `SELECT "fromVersionId", "actorId", "createdAt" FROM "image_tag_event" WHERE "imageId" = $1`,
      [imageId],
    )
    expect(event.fromVersionId).toBeNull()
    expect(event.actorId).toBeNull()
    expect(event.createdAt).toBeInstanceOf(Date)
  })

  /**
   * The version references restrict, but not an image's own removal: its
   * cascade takes the versions and the events in one statement, and the
   * reference is checked once that statement is done.
   */
  it('lets an image with history be removed along with its versions', async () => {
    const { imageId, from, to } = await insertImageWithVersions()
    await queryRunner.query(
      `INSERT INTO "image_tag_event" ("imageId", "tagName", "fromVersionId", "toVersionId") VALUES ($1, 'stable', $2, $3)`,
      [imageId, from, to],
    )

    await queryRunner.query(`DELETE FROM "image" WHERE "id" = $1`, [imageId])

    const [{ count }] = await queryRunner.query(
      `SELECT count(*)::int AS count FROM "image_tag_event" WHERE "imageId" = $1`,
      [imageId],
    )
    expect(count).toBe(0)
  })

  it('refuses to remove a version an event still names while its image stays', async () => {
    const { imageId, from, to } = await insertImageWithVersions()
    await queryRunner.query(
      `INSERT INTO "image_tag_event" ("imageId", "tagName", "fromVersionId", "toVersionId") VALUES ($1, 'stable', $2, $3)`,
      [imageId, from, to],
    )

    await expect(queryRunner.query(`DELETE FROM "image_version" WHERE "id" = $1`, [to])).rejects.toMatchObject({
      code: '23503',
      constraint: 'image_tag_event_toVersionId_fk',
    })
  })

  it('reverses everything it created', async () => {
    await migration.down(queryRunner)

    const [{ count }] = await queryRunner.query(
      `SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'image_tag_event'`,
      [schemaName],
    )
    expect(count).toBe(0)
  })
})
