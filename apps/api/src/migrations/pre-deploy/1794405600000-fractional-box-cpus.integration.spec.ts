import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { FractionalBoxCpus1794405600000 } from './1794405600000-fractional-box-cpus-migration'

const describeDatabase = process.env.DB_HOST ? describe : describe.skip

describeDatabase('fractional CPU migration (PostgreSQL)', () => {
  let db: DataSource
  let schema: string
  const migration = new FractionalBoxCpus1794405600000()
  const migrate = (direction: 'up' | 'down') => db.transaction((manager) => migration[direction](manager.queryRunner!))

  beforeEach(async () => {
    schema = `fractional_cpu_${randomUUID().replaceAll('-', '')}`
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    for (const table of ['box', 'warm_pool']) {
      await db.query(`CREATE TABLE "${table}" (id integer PRIMARY KEY, cpu integer NOT NULL DEFAULT 2)`)
      await db.query(`CREATE INDEX "${table}_cpu_test_idx" ON "${table}" (cpu)`)
      await db.query(`INSERT INTO "${table}" (id) VALUES (1)`)
    }
  })
  afterEach(async () => {
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })

  it('preserves integer values, defaults and indexes and stores exact CPU quantities', async () => {
    await migrate('up')
    for (const table of ['box', 'warm_pool']) {
      await db.query(`INSERT INTO "${table}" (id,cpu) VALUES (2,$1),(3,$2)`, [0.125, 1.001])
      await db.query(`INSERT INTO "${table}" (id) VALUES (4)`)
      expect(await db.query(`SELECT cpu FROM "${table}" ORDER BY id`)).toEqual([
        { cpu: 2 },
        { cpu: 0.125 },
        { cpu: 1.001 },
        { cpu: 2 },
      ])
    }
    const indexes = await db.query('SELECT indexname FROM pg_indexes WHERE schemaname=$1', [schema])
    expect(indexes).toEqual(
      expect.arrayContaining([{ indexname: 'box_cpu_test_idx' }, { indexname: 'warm_pool_cpu_test_idx' }]),
    )
  })

  it.each(['box', 'warm_pool'])('refuses lossy rollback when %s contains a fraction', async (table) => {
    await migrate('up')
    await db.query(`UPDATE "${table}" SET cpu=0.5`)
    await expect(migrate('down')).rejects.toThrow(/Cannot restore integer/)
    expect(await db.query(`SELECT cpu FROM "${table}"`)).toEqual([{ cpu: 0.5 }])
    await db.query(`UPDATE "${table}" SET cpu=2`)
    await migrate('down')
    const columns = await db.query(
      "SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND column_name='cpu'",
      [schema],
    )
    expect(columns).toEqual([{ data_type: 'integer' }, { data_type: 'integer' }])
  })

  it('fails within the lock timeout without partially converting columns', async () => {
    const holder = db.createQueryRunner()
    await holder.connect()
    await holder.startTransaction()
    try {
      await holder.query('LOCK TABLE "warm_pool" IN ACCESS EXCLUSIVE MODE')
      await expect(migrate('up')).rejects.toThrow(/lock timeout/)
      const columns = await db.query(
        "SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND column_name='cpu'",
        [schema],
      )
      expect(columns.every((column) => column.data_type === 'integer')).toBe(true)
    } finally {
      await holder.rollbackTransaction()
      await holder.release()
    }
  }, 15000)
})
