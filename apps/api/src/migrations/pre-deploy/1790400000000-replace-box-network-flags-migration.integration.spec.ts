import { randomUUID } from 'node:crypto'
import { DataSource, QueryRunner } from 'typeorm'
import { ReplaceBoxNetworkFlags1790400000000 } from './1790400000000-replace-box-network-flags-migration'
import { DropBoxNetworkFlags1790400000000 } from '../post-deploy/1790400000000-drop-box-network-flags-migration'

// The string-level specs pin the SQL; this one runs it. The sync trigger is
// plpgsql that only a database can execute, and the backfill's polarity
// (public → enabled, blockAll → disabled) is the kind of thing a typo flips.
const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `box_network_flags_${process.pid}_${randomUUID().replaceAll('-', '')}`

type FlagRow = { id: string; public: boolean; networkBlockAll: boolean; networkAllowList: string | null }
type PolicyRow = { id: string; inboundMode: string; outboundMode: string; outboundAllowNet: string[] | null }

describeIfDatabase('box network flags migrations (integration, real Postgres)', () => {
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
      schema: schemaName,
      entities: [],
      synchronize: false,
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.query(`SET search_path TO "${schemaName}"`)
    // Only the columns the migrations touch; the real table's other columns
    // play no part in the backfill or the trigger.
    await queryRunner.query(`
      CREATE TABLE "box" (
        "id" character varying(12) PRIMARY KEY,
        "public" boolean NOT NULL DEFAULT false,
        "networkBlockAll" boolean NOT NULL DEFAULT false,
        "networkAllowList" character varying
      )
    `)
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

  async function policy(id: string): Promise<PolicyRow> {
    const [row] = await queryRunner.query(
      `SELECT "id", "inboundMode", "outboundMode", "outboundAllowNet" FROM "box" WHERE "id" = $1`,
      [id],
    )
    return row
  }

  async function flags(id: string): Promise<FlagRow> {
    const [row] = await queryRunner.query(
      `SELECT "id", "public", "networkBlockAll", "networkAllowList" FROM "box" WHERE "id" = $1`,
      [id],
    )
    return row
  }

  async function columns(): Promise<string[]> {
    const rows: { column_name: string }[] = await queryRunner.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'box' ORDER BY column_name`,
      [schemaName],
    )
    return rows.map((row) => row.column_name)
  }

  const preDeploy = new ReplaceBoxNetworkFlags1790400000000()
  const postDeploy = new DropBoxNetworkFlags1790400000000()

  it('backfills every flag combination with the right polarity', async () => {
    const seeded: FlagRow[] = []
    for (const isPublic of [false, true]) {
      for (const blockAll of [false, true]) {
        for (const list of [null, 'api.openai.com, 10.0.0.0/8 ,']) {
          const id = `seed${seeded.length.toString().padStart(8, '0')}`
          await queryRunner.query(
            `INSERT INTO "box" ("id", "public", "networkBlockAll", "networkAllowList") VALUES ($1, $2, $3, $4)`,
            [id, isPublic, blockAll, list],
          )
          seeded.push({ id, public: isPublic, networkBlockAll: blockAll, networkAllowList: list })
        }
      }
    }

    await preDeploy.up(queryRunner)

    for (const row of seeded) {
      expect(await policy(row.id)).toEqual({
        id: row.id,
        inboundMode: row.public ? 'enabled' : 'disabled',
        outboundMode: row.networkBlockAll ? 'disabled' : 'enabled',
        outboundAllowNet: row.networkAllowList ? ['api.openai.com', '10.0.0.0/8'] : null,
      })
    }
  })

  // During the rolling deploy an old API instance writes flags while a new one
  // writes modes. Each side must see the other's writes in its own shape.
  it('keeps both shapes equal through inserts and updates from either API', async () => {
    await queryRunner.query(
      `INSERT INTO "box" ("id", "public", "networkBlockAll", "networkAllowList") VALUES ('oldapi000001', true, true, 'a.example, b.example')`,
    )
    expect(await policy('oldapi000001')).toMatchObject({
      inboundMode: 'enabled',
      outboundMode: 'disabled',
      outboundAllowNet: ['a.example', 'b.example'],
    })

    await queryRunner.query(
      `INSERT INTO "box" ("id", "inboundMode", "outboundMode", "outboundAllowNet") VALUES ('newapi000001', 'enabled', 'disabled', ARRAY['c.example'])`,
    )
    expect(await flags('newapi000001')).toMatchObject({
      public: true,
      networkBlockAll: true,
      networkAllowList: 'c.example',
    })

    await queryRunner.query(`INSERT INTO "box" ("id") VALUES ('defaults0001')`)
    expect(await flags('defaults0001')).toMatchObject({ public: false, networkBlockAll: false, networkAllowList: null })
    expect(await policy('defaults0001')).toMatchObject({
      inboundMode: 'disabled',
      outboundMode: 'enabled',
      outboundAllowNet: null,
    })

    await queryRunner.query(`UPDATE "box" SET "public" = false, "networkAllowList" = NULL WHERE "id" = 'oldapi000001'`)
    expect(await policy('oldapi000001')).toMatchObject({ inboundMode: 'disabled', outboundAllowNet: null })

    await queryRunner.query(
      `UPDATE "box" SET "inboundMode" = 'disabled', "outboundMode" = 'enabled', "outboundAllowNet" = NULL WHERE "id" = 'newapi000001'`,
    )
    expect(await flags('newapi000001')).toMatchObject({ public: false, networkBlockAll: false, networkAllowList: null })

    await queryRunner.query(
      `UPDATE "box" SET "outboundAllowNet" = ARRAY['x.example', 'y.example'] WHERE "id" = 'newapi000001'`,
    )
    expect(await flags('newapi000001')).toMatchObject({ networkAllowList: 'x.example,y.example' })
  })

  it('drops the flags and the trigger after deploy, keeping the policy rows', async () => {
    await postDeploy.up(queryRunner)

    expect(await columns()).toEqual(['id', 'inboundMode', 'outboundAllowNet', 'outboundMode'])
    const [{ count }] = await queryRunner.query(
      `SELECT count(*)::int AS count FROM pg_trigger WHERE tgname = 'box_network_policy_sync'`,
    )
    expect(count).toBe(0)
    expect(await policy('newapi000001')).toMatchObject({
      inboundMode: 'disabled',
      outboundMode: 'enabled',
      outboundAllowNet: ['x.example', 'y.example'],
    })
  })

  it('rolls both halves back to the flag columns', async () => {
    await postDeploy.down(queryRunner)
    expect(await flags('newapi000001')).toMatchObject({
      public: false,
      networkBlockAll: false,
      networkAllowList: 'x.example,y.example',
    })

    await preDeploy.down(queryRunner)
    expect(await columns()).toEqual(['id', 'networkAllowList', 'networkBlockAll', 'public'])
  })
})
