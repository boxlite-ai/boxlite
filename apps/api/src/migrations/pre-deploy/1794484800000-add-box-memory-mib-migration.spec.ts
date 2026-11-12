import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AddBoxMemoryMib1794484800000 } from './1794484800000-add-box-memory-mib-migration'

const describeDatabase = process.env.DB_HOST ? describe : describe.skip

describeDatabase('MiB memory migration (PostgreSQL)', () => {
  let db: DataSource
  let schema: string
  const migration = new AddBoxMemoryMib1794484800000()
  const migrate = (direction: 'up' | 'down') => db.transaction((manager) => migration[direction](manager.queryRunner!))

  beforeEach(async () => {
    schema = `memory_mib_${randomUUID().replaceAll('-', '')}`
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
    await db.query('CREATE TABLE box (id integer PRIMARY KEY, mem integer NOT NULL)')
    await db.query('INSERT INTO box VALUES (1, 2)')
    for (const table of ['checkpoint', 'checkpoint_operation']) {
      await db.query(`CREATE TABLE "${table}" (environment jsonb)`)
    }
  })
  afterEach(async () => {
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })

  it('backfills legacy GiB and accepts both exact and old-writer rows', async () => {
    await migrate('up')
    await db.query('INSERT INTO box (id, mem) VALUES (2, 1)')
    await db.query('INSERT INTO box VALUES (3, 1, 300)')
    expect(await db.query('SELECT mem, memory_mib FROM box ORDER BY id')).toEqual([
      { mem: 2, memory_mib: 2048 },
      { mem: 1, memory_mib: null },
      { mem: 1, memory_mib: 300 },
    ])
    await expect(migrate('down')).rejects.toThrow(/Cannot discard exact MiB/)
    await db.query('DELETE FROM box WHERE id=3')
    await migrate('down')
    expect(await db.query('SELECT * FROM box ORDER BY id')).toEqual([
      { id: 1, mem: 2 },
      { id: 2, mem: 1 },
    ])
  })

  it.each(['checkpoint', 'checkpoint_operation'])(
    'refuses rollback while %s retains exact allocations',
    async (table) => {
      await migrate('up')
      await db.query(`INSERT INTO "${table}" VALUES ($1)`, [{ mem: 1, memoryMib: 300 }])
      await expect(migrate('down')).rejects.toThrow(/retained in checkpoints/)
      expect(await db.query('SELECT memory_mib FROM box')).toEqual([{ memory_mib: 2048 }])
    },
  )

  it('times out waiting for a lock without changing the schema', async () => {
    const holder = db.createQueryRunner()
    await holder.connect()
    await holder.startTransaction()
    try {
      await holder.query('LOCK TABLE box IN ACCESS EXCLUSIVE MODE')
      await expect(migrate('up')).rejects.toThrow(/lock timeout/)
    } finally {
      await holder.rollbackTransaction()
      await holder.release()
    }
    expect(await db.query('SELECT * FROM box')).toEqual([{ id: 1, mem: 2 }])
  }, 15000)
})
